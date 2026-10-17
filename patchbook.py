#!/usr/bin/env python3
"""Keep your changes to an upstream repo, each with its intent, and keep pulling from upstream.

See DESIGN.md. Commands: clone, init, check, sync, status, build, record, show, blocks, scaffold.
"""

import argparse
import difflib
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

PB = ".patchbook"
CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "patchbook"
EXIT_MOVED = 10
LINK = 0o120000

CONFLICT_MARKER = re.compile(r"^(<{7}|>{7})( |$)", re.MULTILINE)
FENCE = re.compile(r"^\s*(`{3,}|~{3,})")
ENTRY_HEAD = re.compile(r"^=== entry ([0-9a-f]{12})$")
ENTRY_FIELDS = ("kind", "rules", "intent")
ENTRY_KINDS = ("translation", "policy", "keep")
EDIT_KINDS = ("file", "add", "replace", "delete", "move", "copy")
CONTENT_EDITS = ("file",)
STRUCTURAL_EDITS = ("add", "replace", "delete", "move", "copy")


class Fail(Exception):
    pass


def run(args, cwd, input=None, check=True, env=None):
    """Run a command and return its stdout as bytes."""
    result = subprocess.run(args, cwd=cwd, input=input, capture_output=True, env=env)
    if check and result.returncode != 0:
        raise Fail(f"{' '.join(map(str, args))} failed:\n{result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def git(*args, cwd, input=None, check=True, env=None):
    return run(["git", *args], cwd, input=input, check=check, env=env).decode().strip()


def blob_oid(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def is_text(data):
    if b"\0" in data:
        return False
    try:
        data.decode()
    except UnicodeDecodeError:
        return False
    return True


def glob_re(pattern):
    """`**/` matches any number of folders, `*` and `?` stay within one."""
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif pattern.startswith("**", i):
            out, i = out + ".*", i + 2
        elif pattern[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif pattern[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(pattern[i]), i + 1
    return re.compile(out + r"\Z")


def under(path, prefix):
    return path == prefix or path.startswith(prefix + "/")


# The repo and its upstream


class Book:
    def __init__(self, root):
        self.root = root
        self.dir = root / PB
        self.config = tomllib.loads((self.dir / "config.toml").read_text())
        self.layout = self.config.get("layout", "fork")
        if self.layout not in ("vendor", "fork"):
            raise Fail(f"layout must be vendor or fork, not {self.layout!r}")
        up = self.config["upstream"]
        self.remote = up["remote"]
        self.path = up.get("path", "").strip("/")
        self.branch = up.get("branch", "main")
        self.remote_name = up.get("remote_name", "upstream")
        if self.layout == "vendor":
            self.vendor = root / up["vendor"]
            out = self.config.get("output", {})
            self.out_from = out.get("from", "").strip("/")
            self.out_dir = root / out["to"]
        self.hooks = self._load_hooks()

    @classmethod
    def find(cls, start=None):
        here = Path(start or Path.cwd()).resolve()
        for d in (here, *here.parents):
            if (d / PB / "config.toml").exists():
                return cls(d)
        raise Fail(f"no {PB}/config.toml here or above. Start one with `patchbook clone` or `patchbook init`.")

    def _load_hooks(self):
        path = self.dir / "hooks.py"
        if not path.exists():
            return None
        spec = importlib.util.spec_from_file_location("patchbook_hooks", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def hook(self, name):
        return getattr(self.hooks, name, None) if self.hooks else None

    # The lock

    def lock(self):
        return json.loads((self.dir / "upstream.lock").read_text())

    def write_lock(self, commit, tree):
        (self.dir / "upstream.lock").write_text(json.dumps({"commit": commit, "tree": tree}, indent=2) + "\n")

    # Git access to upstream: the fork itself, or a cache for a vendored copy

    def git_dir(self):
        if self.layout == "fork":
            return self.root
        d = CACHE / hashlib.sha1(self.remote.encode()).hexdigest()[:16]
        if not d.exists():
            d.parent.mkdir(parents=True, exist_ok=True)
            git("init", "--quiet", "--bare", str(d), cwd=d.parent)
        return d

    def source(self):
        return self.remote_name if self.layout == "fork" else self.remote

    def fetch(self, ref):
        gd = self.git_dir()
        depth = [] if self.layout == "fork" else ["--depth=1"]
        git("fetch", "--quiet", *depth, self.source(), ref, cwd=gd)
        return git("rev-parse", "FETCH_HEAD^{commit}", cwd=gd)

    def have(self, commit):
        found = subprocess.run(["git", "cat-file", "-e", f"{commit}^{{commit}}"], cwd=self.git_dir(), capture_output=True)
        if found.returncode != 0:
            self.fetch(commit)

    def tree_of(self, commit):
        spec = f"{commit}:{self.path}" if self.path else f"{commit}^{{tree}}"
        return git("rev-parse", spec, cwd=self.git_dir())

    def head(self):
        out = git("ls-remote", self.source(), f"refs/heads/{self.branch}", cwd=self.git_dir())
        if not out:
            raise Fail(f"upstream has no branch {self.branch}")
        return out.split()[0]

    def upstream_files(self, commit):
        """{path: (bytes, mode)} for upstream's files at a commit, relative to the upstream path."""
        self.have(commit)
        gd = self.git_dir()
        args = ["ls-tree", "-r", "-z", "--full-tree", commit]
        if self.path:
            args += ["--", self.path]
        listing = run(["git", *args], gd).decode()
        entries = []
        for item in filter(None, listing.split("\0")):
            meta, path = item.split("\t", 1)
            mode, kind, oid = meta.split()
            if kind != "blob":
                continue  # submodules are not copied
            rel = path[len(self.path) + 1:] if self.path else path
            entries.append((rel, int(mode, 8), oid))
        blobs = read_blobs(gd, [oid for _, _, oid in entries])
        return {rel: (blobs[oid], norm_mode(mode)) for rel, mode, oid in entries}

    def vendor_tree(self):
        """Hash the vendored copy as git would commit it, and read its files."""
        files = index_files(self.root, self.vendor.relative_to(self.root).as_posix())
        prefix = self.vendor.relative_to(self.root).as_posix() + "/"
        tree = files.pop(None)
        return {p[len(prefix):]: v for p, v in files.items()}, tree

    def staged_upstream(self):
        """Upstream's files at the pin. A vendored copy must match the pin exactly."""
        lock = self.lock()
        if self.layout == "vendor":
            files, tree = self.vendor_tree()
            if tree != lock["tree"]:
                raise Fail(
                    f"{self.vendor.relative_to(self.root)} (tree {tree[:7]}) differs from the pin (tree {lock['tree'][:7]}). "
                    "Never edit the vendored copy. Record the change in the patchbook, or run sync."
                )
            return files
        return self.upstream_files(lock["commit"])

    # The output on disk

    def output_root(self):
        return self.out_dir if self.layout == "vendor" else self.root

    def current_output(self):
        """{output path: (bytes, mode)} as it is on disk now: tracked files and untracked ones git doesn't ignore."""
        root = self.output_root()
        if not root.exists():
            return {}
        rel = root.relative_to(self.root).as_posix() if root != self.root else ""
        args = ["ls-files", "-z", "-co", "--exclude-standard"] + (["--", rel] if rel else [])
        out = {}
        for path in filter(None, git(*args, cwd=self.root).split("\0")):
            p = self.root / path
            if not os.path.lexists(p):
                continue
            key = path[len(rel) + 1:] if rel else path
            if self.layout == "fork" and under(key, PB):
                continue
            out[key] = read_disk(p)
        return out


def norm_mode(mode):
    if mode == LINK:
        return LINK
    return 0o755 if mode & 0o111 else 0o644


def read_disk(path):
    if path.is_symlink():
        return os.readlink(path).encode(), LINK
    return path.read_bytes(), 0o755 if os.access(path, os.X_OK) else 0o644


def write_disk(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or path.exists():
        path.unlink()
    if mode == LINK:
        os.symlink(data.decode(), path)
    else:
        path.write_bytes(data)
        path.chmod(mode)


def read_blobs(gd, oids):
    if not oids:
        return {}
    out = run(["git", "cat-file", "--batch"], gd, input=("\n".join(oids) + "\n").encode())
    blobs, i = {}, 0
    for oid in oids:
        nl = out.index(b"\n", i)
        size = int(out[i:nl].split()[2])
        blobs[oid] = out[nl + 1:nl + 1 + size]
        i = nl + 1 + size + 1
    return blobs


def index_files(root, rel):
    """{path: (bytes, mode)} for what git would commit under rel, plus {None: tree id}."""
    with tempfile.TemporaryDirectory() as tmp:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(tmp) / "index")}
        git("read-tree", "--empty", cwd=root, env=env)
        git("add", "--", rel, cwd=root, env=env)
        tree = git("write-tree", f"--prefix={rel}/", cwd=root, env=env)
        staged = git("ls-files", "-s", "-z", "--", rel, cwd=root, env=env)
    files = {None: tree}
    for item in filter(None, staged.split("\0")):
        meta, path = item.split("\t", 1)
        mode = int(meta.split()[0], 8)
        data, _ = read_disk(root / path)
        files[path] = (data, norm_mode(mode))
    return files


# Changes


@dataclass
class Edit:
    kind: str
    path: str
    dest: str = None

    def __str__(self):
        return f"{self.kind} {self.path}" + (f" -> {self.dest}" if self.dest else "")


@dataclass
class Change:
    name: str
    dir: Path
    intent: str = ""
    edits: list = field(default_factory=list)

    def content(self, side, path):
        return self.dir / side / f"{path}.pb"

    def read(self, side, path):
        p = self.content(side, path)
        return read_disk(p)[0] if os.path.lexists(p) else None

    def write(self, side, path, data, mode=None):
        p = self.content(side, path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        if mode in (0o644, 0o755):
            p.chmod(mode)

    def drop(self, side, path):
        p = self.content(side, path)
        if p.exists():
            p.unlink()


def parse_change(path):
    name = path.parent.name
    change = Change(name, path.parent)
    section = None
    for n, line in enumerate(path.read_text().split("\n"), 1):
        if line.startswith("# ") and section is None:
            continue
        if line.startswith("intent:"):
            section, change.intent = "intent", line[len("intent:"):].strip()
        elif line.strip() == "edits:":
            section = "edits"
        elif section == "intent" and line.strip():
            change.intent += " " + line.strip()
        elif section == "edits" and line.strip():
            m = re.match(r"^- (\w+) (.+?)(?: -> (.+))?$", line.strip())
            if not m or m.group(1) not in EDIT_KINDS:
                raise Fail(f"{path}:{n}: expected `- <{'|'.join(EDIT_KINDS)}> <path>`")
            kind, src, dest = m.groups()
            if (kind in ("move", "copy")) != bool(dest):
                raise Fail(f"{path}:{n}: only move and copy take `-> <path>`")
            change.edits.append(Edit(kind, src.strip("/"), dest and dest.strip("/")))
    return change


def format_change(change):
    edits = "".join(f"- {e}\n" for e in change.edits)
    return f"# {change.name}\n\nintent: {change.intent}\n\nedits:\n{edits}"


def save_change(change):
    change.dir.mkdir(parents=True, exist_ok=True)
    (change.dir / "CHANGE.md").write_text(format_change(change))


def read_series(book):
    path = book.dir / "series"
    names = [l.strip() for l in path.read_text().split("\n")] if path.exists() else []
    return [n for n in names if n and not n.startswith("#")]


def read_changes(book, problems):
    changes = []
    for name in read_series(book):
        path = book.dir / "changes" / name / "CHANGE.md"
        if not path.exists():
            problems.append({"problem": "invalid", "file": f"series", "detail": f"no change called {name}"})
            continue
        changes.append(parse_change(path))
    listed = {c.name for c in changes}
    for path in sorted((book.dir / "changes").glob("*/CHANGE.md")):
        if path.parent.name not in listed:
            problems.append({"problem": "invalid", "file": "series", "detail": f"change {path.parent.name} is not in the series"})
    for c in changes:
        if not c.intent:
            problems.append({"problem": "invalid", "file": f"changes/{c.name}", "detail": "it has no intent"})
    return changes


# Block entries


def block_hash(block):
    return hashlib.sha256(block.encode()).hexdigest()[:12]


def block_spans(lines):
    """Line ranges of a file's blocks: the frontmatter, then each run of non-blank lines.

    Blank lines inside a Markdown code fence don't end a block.
    """
    spans, first = [], 0
    if lines and lines[0] == "---" and "---" in lines[1:]:
        first = lines.index("---", 1) + 1
        spans.append((0, first))
    start, fence = None, None
    for i in range(first, len(lines)):
        stripped = lines[i].strip()
        m = FENCE.match(lines[i])
        if fence is None and m:
            fence = m.group(1)
        elif fence and set(stripped) == {fence[0]} and len(stripped) >= len(fence):
            fence = None
        if stripped or fence:
            start = i if start is None else start
        elif start is not None:
            spans.append((start, i))
            start = None
    if start is not None:
        spans.append((start, len(lines)))
    return spans


def entries_path(book, rel):
    return book.dir / "blocks" / f"{rel}.entries"


def read_entries(path):
    """Parse an entries file into {hash: entry}. Field problems are left for check_entry."""
    entries, entry, section, last_field = {}, None, None, None
    for n, line in enumerate(path.read_text().split("\n"), 1):
        m = ENTRY_HEAD.match(line)
        if m:
            if m.group(1) in entries:
                raise Fail(f"{path}:{n}: duplicate entry {m.group(1)}")
            entry = entries[m.group(1)] = {"hash": m.group(1), "line": n, "upstream": [], "patched": []}
            entry.update((f, "") for f in ENTRY_FIELDS)
            section, last_field = "fields", None
        elif entry is None:
            if line.strip():
                raise Fail(f"{path}:{n}: text before the first entry")
        elif line in ("--- upstream", "--- patched"):
            section = line[4:]
        elif section == "fields":
            name, sep, value = line.partition(": ")
            if name in ENTRY_FIELDS and sep:
                entry[name] = value.strip()
                last_field = name
            elif line.strip() and last_field == "intent":
                entry["intent"] += " " + line.strip()
            elif line.strip():
                raise Fail(f"{path}:{n}: expected one of {', '.join(ENTRY_FIELDS)}")
        else:
            entry[section].append(line)
    for entry in entries.values():
        for section in ("upstream", "patched"):
            entry[section] = "\n".join(entry[section]).strip("\n")
    return entries


def format_entry(entry):
    return (
        f"=== entry {entry['hash']}\n"
        + "".join(f"{f}: {entry[f]}\n" for f in ENTRY_FIELDS)
        + f"--- upstream\n{entry['upstream']}\n--- patched\n{entry['patched']}\n"
    )


def check_entry(entry):
    if block_hash(entry["upstream"]) != entry["hash"]:
        return "its upstream text does not match its hash"
    if entry["kind"] not in ENTRY_KINDS:
        return f"kind must be one of {', '.join(ENTRY_KINDS)}"
    if not entry["intent"]:
        return "it has no intent"
    if entry["kind"] == "translation" and not entry["rules"]:
        return "a translation must name its rules"
    if entry["kind"] == "keep" and entry["patched"] != entry["upstream"]:
        return "a keep entry must leave the block unchanged"
    return None


def nearest(text, candidates, limit=2):
    scored = sorted(
        ((difflib.SequenceMatcher(None, text, c["upstream"]).ratio(), c) for c in candidates),
        key=lambda pair: -pair[0],
    )
    return [{"line": c["line"], "hash": c["hash"], "similarity": round(r, 2)} for r, c in scored[:limit] if r >= 0.4]


def orphan(rel, entry, candidates):
    return {
        "problem": "orphan", "file": rel, "hash": entry["hash"], "kind": entry["kind"],
        "rules": entry["rules"], "intent": entry["intent"], "upstream": entry["upstream"],
        "patched": entry["patched"], "nearest": nearest(entry["upstream"], candidates),
    }


# Placeholders and checks


class Rules:
    def __init__(self, book, outputs):
        self.book = book
        self.outputs = outputs
        self.checks = [
            {**c, "_files": [glob_re(g) for g in c.get("files", ["**"])],
             "_exclude": [glob_re(g) for g in c.get("exclude", [])], "_re": re.compile(c["pattern"])}
            for c in book.config.get("check", [])
        ]
        self.sources = book.config.get("placeholders", {})
        self.placeholder = re.compile(
            r"\{\{(" + "|".join(map(re.escape, self.sources)) + r"):([^}]+)\}\}") if self.sources else None
        self._loaded = {}
        self.block_terms_hook = book.hook("block_terms")

    def terms(self, out_path, block):
        found = set()
        for c in self.checks:
            if any(r.match(out_path) for r in c["_files"]) and not any(r.match(out_path) for r in c["_exclude"]):
                found |= {m.group(0) for m in c["_re"].finditer(block)}
        if self.block_terms_hook:
            found |= set(self.block_terms_hook(out_path, block, self.outputs))
        return sorted(found)

    def _source(self, kind):
        if kind not in self._loaded:
            spec = self.sources[kind]
            values = {}
            if "file" in spec:
                text = (self.book.root / spec["file"]).read_text()
                if spec.get("format", "json") == "sections":
                    name = None
                    for line in text.split("\n"):
                        if line.startswith("## "):
                            name = line[3:].strip()
                            values[name] = []
                        elif name:
                            values[name].append(line)
                    values = {k: "\n".join(v).strip() for k, v in values.items()}
                else:
                    raw = json.loads(text)
                    values = {k: ", ".join(map(str, v)) if isinstance(v, list) else str(v)
                              for k, v in raw.items() if not k.startswith("_")}
            self._loaded[kind] = values
        return self._loaded[kind]

    def expand(self, text, problems, where):
        if not self.placeholder:
            return text
        hook = self.book.hook("placeholder")

        def fill(m):
            kind, name = m.group(1), m.group(2)
            value = hook(kind, name) if hook else None
            if value is None:
                value = self._source(kind).get(name)
            if value is None:
                problems.append({"problem": "placeholder", **where, "detail": f"unknown {kind} {name!r}"})
                return m.group(0)
            return value
        return self.placeholder.sub(fill, text)


# Assembling the output


@dataclass
class Assembly:
    out: dict          # output path -> (bytes, mode)
    sources: dict      # output path -> ("up", upstream path) or ("ours", change name, staged path)
    problems: list
    applied: int
    staged: dict       # staged path -> source, before choosing the output
    upstream: dict     # upstream path -> (bytes, mode) at the pin


def apply_structure(changes, upstream, problems):
    """Apply add, replace, delete, move and copy to a map of staged path -> source."""
    tree = {p: ("up", p) for p in upstream}
    for c in changes:
        for e in c.edits:
            if e.kind not in STRUCTURAL_EDITS:
                continue
            where = {"file": f"changes/{c.name}", "edit": str(e)}
            matched = [p for p in tree if under(p, e.path)]
            if e.kind == "add":
                if matched:
                    problems.append({"problem": "invalid", **where, "detail": f"{e.path} already exists; use replace"})
                elif c.read("ours", e.path) is None:
                    problems.append({"problem": "invalid", **where, "detail": "its ours copy is missing"})
                else:
                    tree[e.path] = ("ours", c.name, e.path)
            elif e.kind == "replace":
                if e.path not in tree:
                    problems.append({"problem": "gone", **where, "detail": f"{e.path} no longer exists"})
                elif c.read("ours", e.path) is None:
                    problems.append({"problem": "invalid", **where, "detail": "its ours copy is missing"})
                else:
                    tree[e.path] = ("ours", c.name, e.path)
            elif not matched:
                problems.append({"problem": "gone", **where, "detail": f"{e.path} no longer exists"})
            else:
                moved = {e.dest + p[len(e.path):]: tree[p] for p in matched} if e.dest else {}
                clash = [p for p in moved if p in tree and not under(p, e.path)]
                if clash:
                    problems.append({"problem": "invalid", **where, "detail": f"{clash[0]} already exists"})
                    continue
                if e.kind in ("delete", "move"):
                    for p in matched:
                        del tree[p]
                tree.update(moved)
    return tree


def assemble(book):
    upstream = book.staged_upstream()
    problems, applied = [], 0
    changes = read_changes(book, problems)
    by_name = {c.name: c for c in changes}

    # Content edits, keyed by upstream path. One owner per path.
    content = dict(upstream)
    owner = {}
    for c in changes:
        for e in c.edits:
            if e.kind != "file":
                continue
            where = {"file": e.path, "change": c.name}
            if e.path in owner:
                problems.append({"problem": "invalid", **where, "detail": f"{owner[e.path]} already owns it"})
                continue
            owner[e.path] = f"change {c.name}"
            if e.path not in upstream:
                problems.append({"problem": "gone", **where, "detail": "upstream no longer has it"})
                continue
            base, ours = c.read("base", e.path), c.read("ours", e.path)
            if base is None or ours is None:
                problems.append({"problem": "invalid", **where, "detail": "its base or ours copy is missing"})
                continue
            if base != upstream[e.path][0]:
                problems.append({"problem": "stale", **where, "detail": "its base differs from upstream at the pin; run sync"})
            if is_text(ours) and CONFLICT_MARKER.search(ours.decode()):
                problems.append({"problem": "conflict", **where, "detail": "ours has conflict markers"})
            content[e.path] = (ours, upstream[e.path][1])
            applied += 1
    blocks = {}
    for p in sorted((book.dir / "blocks").rglob("*.entries")):
        rel = p.relative_to(book.dir / "blocks").as_posix()[: -len(".entries")]
        if rel in owner:
            problems.append({"problem": "invalid", "file": rel, "detail": f"{owner[rel]} owns it, so it can't have block entries"})
            continue
        blocks[rel] = read_entries(p)

    staged = apply_structure(changes, upstream, problems)
    if book.layout == "vendor":
        prefix = book.out_from
        selected = {(p[len(prefix) + 1:] if prefix else p): s for p, s in staged.items() if not prefix or p.startswith(prefix + "/")}
    else:
        selected = dict(staged)
    rules = Rules(book, set(selected))

    out, used = {}, {rel: set() for rel in blocks}
    unmatched = {rel: [] for rel in blocks}
    for out_path, src in sorted(selected.items()):
        if src[0] == "up":
            rel = src[1]
            data, mode = content[rel]
            where = {"file": rel, "output": out_path}
            if mode == LINK or not is_text(data):
                if rel in blocks:
                    problems.append({"problem": "invalid", **where, "detail": "block entries need a text file; use a replace edit"})
                out[out_path] = (data, mode)
                continue
            if rel in owner:
                text = rules.expand(data.decode(), problems, where)
                leak_scan(rules, out_path, text, problems, where)
            else:
                text, n = patch_blocks(rules, out_path, rel, data.decode(), blocks.get(rel, {}),
                                       used.setdefault(rel, set()), unmatched.setdefault(rel, []), problems)
                applied += n
            out[out_path] = (text.encode(), mode)
        else:
            c = by_name[src[1]]
            data = c.read("ours", src[2])
            mode = upstream[src[2]][1] if src[2] in upstream else norm_mode(os.stat(c.content("ours", src[2])).st_mode)
            where = {"file": f"changes/{c.name}", "output": out_path}
            if is_text(data):
                text = rules.expand(data.decode(), problems, where)
                leak_scan(rules, out_path, text, problems, where)
                data = text.encode()
            out[out_path] = (data, mode)
    for rel, entries in blocks.items():
        for h, entry in entries.items():
            if h not in used.get(rel, ()):
                problems.append(orphan(rel, entry, unmatched.get(rel, [])))

    finish = book.hook("finish")
    if finish:
        finish(out)
    check = book.hook("check")
    if check:
        problems.extend(check({p: d for p, (d, _) in out.items()}))
    for p, (data, mode) in out.items():
        if mode != LINK and is_text(data) and CONFLICT_MARKER.search(data.decode()):
            problems.append({"problem": "conflict", "file": p, "detail": "conflict marker in the output"})
    return Assembly(out, selected, problems, applied, staged, upstream)


def leak_scan(rules, out_path, text, problems, where):
    lines = text.split("\n")
    for start, end in block_spans(lines):
        terms = rules.terms(out_path, "\n".join(lines[start:end]))
        if terms:
            problems.append({"problem": "leak", **where, "line": start + 1, "terms": terms})


def patch_blocks(rules, out_path, rel, text, entries, used, unmatched, problems):
    lines = text.split("\n")
    spans = block_spans(lines)
    out, prev, applied = [], 0, 0
    for i, (start, end) in enumerate(spans):
        block = "\n".join(lines[start:end])
        h = block_hash(block)
        where = {"file": rel, "output": out_path, "line": start + 1, "hash": h}
        out.extend(lines[prev:start])
        prev = end
        entry = entries.get(h)
        if entry is None:
            unmatched.append({"line": start + 1, "hash": h, "upstream": block})
            terms = rules.terms(out_path, block)
            if terms:
                problems.append({"problem": "missing", **where, "terms": terms, "upstream": block})
            out.extend(lines[start:end])
            continue
        used.add(h)
        error = check_entry(entry)
        if error:
            problems.append({"problem": "invalid", **where, "detail": error})
        applied += 1
        patched = rules.expand(entry["patched"], problems, where)
        if entry["kind"] != "keep":
            terms = rules.terms(out_path, patched)
            if terms:
                problems.append({"problem": "leak", **where, "terms": terms})
        if patched:
            out.extend(patched.split("\n"))
        elif i + 1 < len(spans):
            prev = spans[i + 1][0]  # drop the blank lines after a deleted block
    out.extend(lines[prev:])
    return "\n".join(out), applied


def describe(p):
    at = p.get("file", "?") + (f":{p['line']}" if p.get("line") else "") + (f" [{p['hash']}]" if p.get("hash") else "")
    if p.get("output") and p["output"] != p.get("file"):
        at += f" (output {p['output']})"
    kind = p["problem"]
    if kind == "missing":
        return f"missing   {at} needs an entry ({', '.join(p['terms'])})"
    if kind == "leak":
        return f"leak      {at} still says {', '.join(p['terms'])}"
    if kind == "orphan":
        near = ", ".join(f"line {n['line']} [{n['hash']}] {n['similarity']}" for n in p["nearest"]) or "none"
        return f"orphan    {p['file']} [{p['hash']}] intent: {p['intent']}\n          nearest new blocks: {near}"
    extra = f" {p['edit']}" if p.get("edit") else ""
    return f"{kind:<9} {at}{extra}: {p.get('detail', '')}"


# Build


def build_lock_path(book):
    return book.dir / "build.lock"


def read_build_lock(book):
    path = build_lock_path(book)
    if not path.exists():
        return None
    entries = {}
    for line in path.read_text().split("\n"):
        if line.strip():
            oid, _, p = line.partition(" ")
            entries[p] = oid
    return entries


def oids(files):
    return {p: blob_oid(d) for p, (d, _) in files.items()}


def hand_edits(book, new_out):
    """Output paths changed on disk since the last build, other than to what this build writes."""
    current = oids(book.current_output())
    new = oids(new_out)
    last = read_build_lock(book)
    if last is None:  # never built here: only files the build would overwrite or delete count
        return sorted(p for p in current if current[p] != new.get(p))
    return sorted(p for p in set(current) | set(last)
                  if current.get(p) != last.get(p) and current.get(p) != new.get(p))


def write_output(book, out):
    root = book.output_root()
    current = book.current_output()
    for p in current:
        if p not in out:
            (root / p).unlink()
            parent = (root / p).parent
            while parent != root and parent.exists() and not any(parent.iterdir()):
                parent.rmdir()
                parent = parent.parent
    for p, (data, mode) in out.items():
        if current.get(p) != (data, mode):
            write_disk(root / p, data, mode)
    write_build_lock(book, out)


def write_build_lock(book, out):
    build_lock_path(book).write_text("".join(f"{oid} {p}\n" for p, oid in sorted(oids(out).items())))


def cmd_build(args):
    book = Book.find()
    a = assemble(book)
    if a.problems:
        for p in a.problems:
            print(describe(p), file=sys.stderr)
        raise Fail(f"{len(a.problems)} problems; nothing built. `patchbook status` lists them.")
    edited = hand_edits(book, a.out)
    if edited and not args.force:
        shown = "\n  ".join(edited[:20]) + ("\n  ..." if len(edited) > 20 else "")
        raise Fail(f"these output files changed since the last build:\n  {shown}\n"
                   "Move the edits into the patchbook with `patchbook record`, or pass --force to discard them.")
    write_output(book, a.out)
    lock = book.lock()
    print(f"built {len(a.out)} files from {lock['commit'][:7]} with {a.applied} edits")
    if args.commit:
        commit_build(book, lock)
    return 0


def commit_build(book, lock):
    root = book.root
    git("add", "-A", cwd=root)
    tree = git("write-tree", cwd=root)
    parents = ["-p", "HEAD"]
    if book.layout == "fork":
        ancestor = subprocess.run(["git", "merge-base", "--is-ancestor", lock["commit"], "HEAD"], cwd=root).returncode == 0
        if not ancestor:
            parents += ["-p", lock["commit"]]
    if git("rev-parse", "HEAD^{tree}", cwd=root) == tree and len(parents) == 2:
        print("nothing to commit")
        return
    message = f"Build from upstream {lock['commit'][:7]}"
    commit = git("commit-tree", tree, *parents, "-m", message, cwd=root)
    git("update-ref", "HEAD", commit, cwd=root)
    print(f"committed {commit[:7]}: {message}")


# Status


def cmd_status(args):
    book = Book.find()
    a = assemble(book)
    lock = book.lock()
    last_sync = book.dir / "last-sync.json"
    report = json.loads(last_sync.read_text()) if last_sync.exists() else None
    if args.json:
        print(json.dumps({"upstream": lock["commit"], "applied": a.applied, "problems": a.problems,
                          "last_sync": report}, indent=2))
    else:
        for p in a.problems:
            print(describe(p))
        counts = {}
        for p in a.problems:
            counts[p["problem"]] = counts.get(p["problem"], 0) + 1
        summary = ", ".join(f"{n} {k}" for k, n in sorted(counts.items())) or "no problems"
        print(f"{a.applied} edits apply at {lock['commit'][:7]}; {summary}")
    return 1 if a.problems else 0


# Check and sync


def cmd_check(args):
    book = Book.find()
    lock = book.lock()
    head = book.head()
    result = {"pinned": lock["commit"], "head": head, "moved": False, "files": []}
    if head != lock["commit"]:
        book.fetch(head)
        if book.tree_of(head) != lock["tree"]:
            old, new = book.upstream_files(lock["commit"]), book.upstream_files(head)
            result["moved"] = True
            result["files"] = upstream_delta(old, new)
    print(json.dumps(result, indent=2))
    return EXIT_MOVED if result["moved"] else 0


def upstream_delta(old, new):
    out = []
    for p in sorted(set(old) | set(new)):
        if p not in new:
            out.append(f"deleted {p}")
        elif p not in old:
            out.append(f"added {p}")
        elif old[p] != new[p]:
            out.append(f"changed {p}")
    return out


def merge_file(ours, base, theirs):
    with tempfile.TemporaryDirectory() as tmp:
        paths = []
        for name, data in (("ours", ours), ("base", base), ("upstream", theirs)):
            p = Path(tmp) / name
            p.write_bytes(data)
            paths.append(str(p))
        result = subprocess.run(["git", "merge-file", "-p", "-L", "ours", "-L", "base", "-L", "upstream", *paths],
                                capture_output=True)
        if result.returncode < 0 or result.returncode > 127:
            raise Fail(f"git merge-file failed: {result.stderr.decode(errors='replace')}")
        return result.stdout, result.returncode


def cmd_sync(args):
    book = Book.find()
    lock = book.lock()
    commit = book.fetch(args.ref or book.branch)
    tree = book.tree_of(commit)
    if tree == lock["tree"]:
        print(f"upstream at {commit[:7]} matches the pin (tree {tree[:7]}). Nothing to do.")
        return 0
    old = book.upstream_files(lock["commit"]) if lock["tree"] else {}
    new = book.upstream_files(commit)
    problems = []
    changes = read_changes(book, problems)
    report = {"from": lock["commit"], "to": commit, "upstream": upstream_delta(old, new),
              "merged": [], "conflicts": [], "gone": [], "replaced_upstream_changed": []}

    if book.layout == "vendor":
        if book.vendor.exists():
            shutil.rmtree(book.vendor)
        for p, (data, mode) in new.items():
            write_disk(book.vendor / p, data, mode)
        _, actual = book.vendor_tree()
        if actual != tree:
            raise Fail(f"the vendored copy hashes to {actual}, not upstream's {tree}. Does a .gitignore hide upstream files?")

    added = [p for p in new if p not in old]
    for c in changes:
        for e in c.edits:
            if e.kind == "replace" and e.path in old and old.get(e.path) != new.get(e.path):
                report["replaced_upstream_changed"].append(f"{c.name}: {e.path}")
            if e.kind != "file":
                continue
            base, ours = c.read("base", e.path), c.read("ours", e.path)
            if e.path not in new:
                guesses = sorted(added, key=lambda p: -difflib.SequenceMatcher(None, p, e.path).ratio())[:3]
                report["gone"].append({"change": c.name, "path": e.path, "maybe": guesses})
                continue
            theirs = new[e.path][0]
            if theirs == base:
                continue
            if not (is_text(base) and is_text(ours) and is_text(theirs)):
                report["conflicts"].append({"change": c.name, "path": e.path, "detail": "binary file changed upstream"})
                continue
            merged, conflicts = merge_file(ours, base, theirs)
            c.write("ours", e.path, merged)
            c.write("base", e.path, theirs)
            key = "conflicts" if conflicts else "merged"
            report[key].append({"change": c.name, "path": e.path, **({"count": conflicts} if conflicts else {})})

    book.write_lock(commit, tree)
    (book.dir / "last-sync.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"pinned upstream {commit[:7]}: {len(report['upstream'])} upstream files changed, "
          f"{len(report['merged'])} of ours merged cleanly, {len(report['conflicts'])} conflicts, "
          f"{len(report['gone'])} gone. Next: patchbook status")
    return 0


# Record


def cmd_record(args):
    book = Book.find()
    a = assemble(book)
    current = book.current_output()
    problems = []
    changes = {c.name: c for c in read_changes(book, problems)}
    target = changes.get(args.change)
    if target is None:
        if not args.intent:
            raise Fail(f"{args.change} is a new change; give it --intent")
        target = Change(args.change, book.dir / "changes" / args.change, args.intent)
    elif args.intent:
        target.intent = args.intent
    file_owner = {e.path: c for c in changes.values() for e in c.edits if e.kind == "file"}
    has_blocks = {p.relative_to(book.dir / "blocks").as_posix()[: -len(".entries")]
                  for p in (book.dir / "blocks").rglob("*.entries")}
    prefix = book.out_from + "/" if book.layout == "vendor" and book.out_from else ""
    touched, notes = {target.name: target}, []

    for p in sorted(set(current) | set(a.out)):
        now, built = current.get(p), a.out.get(p)
        if now == built:
            continue
        src = a.sources.get(p)
        if built is None:
            target.edits.append(Edit("add", prefix + p))
            target.write("ours", prefix + p, now[0], now[1])
            notes.append(f"add      {p}")
        elif now is None:
            if src[0] == "ours":
                c = changes[src[1]]
                c.edits = [e for e in c.edits if not (e.kind == "add" and e.path == src[2])]
                c.drop("ours", src[2])
                touched[c.name] = c
                notes.append(f"unadd    {p} (from {c.name})")
            else:
                target.edits.append(Edit("delete", prefix + p))
                notes.append(f"delete   {p}")
        elif src[0] == "ours":
            c = changes[src[1]]
            if PLACEHOLDER_HINT.search(c.read("ours", src[2]).decode(errors="replace")):
                notes.append(f"skipped  {p}: its copy in {c.name} uses placeholders; edit that copy directly")
                continue
            c.write("ours", src[2], now[0])
            touched[c.name] = c
            notes.append(f"update   {p} (in {c.name})")
        else:
            rel = src[1]
            if rel in has_blocks:
                notes.append(f"skipped  {p}: it has block entries; edit those instead")
                continue
            c = file_owner.get(rel, target)
            if rel not in file_owner:
                c.edits.append(Edit("file", rel))
                c.write("base", rel, a.upstream[rel][0])
            c.write("ours", rel, now[0])
            touched[c.name] = c
            notes.append(f"file     {p}" + (f" (in {c.name})" if c is not target else ""))

    if not notes:
        print("the output matches the patchbook; nothing to record")
        return 0
    for c in touched.values():
        if c.edits or c is not target:
            save_change(c)
    if target.edits and target.name not in read_series(book):
        with (book.dir / "series").open("a") as f:
            f.write(target.name + "\n")
    print("\n".join(notes))
    return 0


PLACEHOLDER_HINT = re.compile(r"\{\{\w+:[^}]+\}\}")


# Show, blocks, scaffold


def cmd_show(args):
    book = Book.find()
    path = book.dir / "changes" / args.change / "CHANGE.md"
    if not path.exists():
        raise Fail(f"no change called {args.change}")
    c = parse_change(path)
    print(f"{c.name}: {c.intent}\n")
    for e in c.edits:
        if e.kind == "file":
            base = (c.read("base", e.path) or b"").decode(errors="replace").splitlines(keepends=True)
            ours = (c.read("ours", e.path) or b"").decode(errors="replace").splitlines(keepends=True)
            sys.stdout.writelines(difflib.unified_diff(base, ours, f"upstream/{e.path}", f"ours/{e.path}"))
        elif e.kind in ("add", "replace"):
            data = c.read("ours", e.path) or b""
            print(f"{e} ({len(data)} bytes)")
        else:
            print(e)
    return 0


def cmd_blocks(args):
    book = Book.find()
    upstream = book.staged_upstream()
    if args.file not in upstream:
        raise Fail(f"upstream has no {args.file}")
    lines = upstream[args.file][0].decode().split("\n")
    for start, end in block_spans(lines):
        block = "\n".join(lines[start:end])
        print(f"=== line {start + 1} [{block_hash(block)}]\n{block}\n")
    return 0


def cmd_scaffold(args):
    """Append a skeleton entry for each missing block, to be filled in by hand or by an agent."""
    book = Book.find()
    a = assemble(book)
    missing = [p for p in a.problems if p["problem"] == "missing" and (not args.file or p["file"] in args.file)]
    by_file = {}
    for p in missing:
        by_file.setdefault(p["file"], []).append(p)
    for rel, found in by_file.items():
        path = entries_path(book, rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        existing = path.read_text().rstrip("\n") + "\n\n" if path.exists() else ""
        skeletons = [
            format_entry({"hash": p["hash"], "kind": "translation", "rules": "", "intent": "",
                          "upstream": p["upstream"], "patched": p["upstream"]})
            for p in found
        ]
        path.write_text(existing + "\n".join(skeletons))
    print(f"scaffolded {len(missing)} entries in {len(by_file)} files")
    return 0


# Starting a patchbook


def write_config(root, layout, remote, path, branch, vendor=None, out_from=None, out_to=None):
    d = root / PB
    d.mkdir(exist_ok=True)
    lines = [f'layout = "{layout}"', "", "[upstream]", f'remote = "{remote}"']
    if path:
        lines.append(f'path = "{path}"')
    lines.append(f'branch = "{branch}"')
    if vendor:
        lines += [f'vendor = "{vendor}"', "", "[output]", f'from = "{out_from or ""}"', f'to = "{out_to}"']
    (d / "config.toml").write_text("\n".join(lines) + "\n")
    (d / "series").write_text("")
    (d / "retired.md").write_text("# Retired changes\n\nChanges dropped because upstream made them unnecessary or impossible, and why.\n")


def cmd_clone(args):
    dest = Path(args.dir or Path(args.url.rstrip("/")).name.removesuffix(".git")).resolve()
    if dest.exists():
        raise Fail(f"{dest} already exists")
    clone = ["clone", "--quiet", "--origin", "upstream"] + (["--branch", args.branch] if args.branch else [])
    git(*clone, args.url, str(dest), cwd=dest.parent)
    branch = git("branch", "--show-current", cwd=dest)
    commit = git("rev-parse", "HEAD", cwd=dest)
    write_config(dest, "fork", args.url, "", branch)
    book = Book(dest)
    book.write_lock(commit, git("rev-parse", "HEAD^{tree}", cwd=dest))
    write_build_lock(book, book.current_output())
    git("add", PB, cwd=dest)
    git("commit", "--quiet", "-m", f"Start a patchbook at upstream {commit[:7]}", cwd=dest)
    print(f"cloned {args.url} into {dest}, pinned at {commit[:7]}.\n"
          f"Make your changes, then `patchbook record <change> --intent '...'`.\n"
          f"To publish it: gh repo create <name> --private --source {dest} --push")
    return 0


def cmd_init(args):
    root = Path(git("rev-parse", "--show-toplevel", cwd=Path.cwd()))
    if (root / PB / "config.toml").exists():
        raise Fail(f"{root} already has a patchbook")
    if args.vendor:
        if not args.output_to:
            raise Fail("--vendor needs --output-to, the folder the build writes")
        write_config(root, "vendor", args.upstream, args.path, args.branch, args.vendor, args.output_from, args.output_to)
        book = Book(root)
        book.write_lock("0" * 40, "")
        args.ref = args.branch
        cmd_sync(args)
        print("Next: patchbook build")
        return 0
    write_config(root, "fork", args.upstream, args.path, args.branch)
    if git("remote", cwd=root).split().count("upstream") == 0:
        git("remote", "add", "upstream", args.upstream, cwd=root)
    git("fetch", "--quiet", "upstream", args.branch, cwd=root)
    base = git("merge-base", "HEAD", "FETCH_HEAD", cwd=root)
    book = Book(root)
    book.write_lock(base, book.tree_of(base))
    print(f"pinned upstream at {base[:7]}, where this repo branched from it.\n"
          "Capture your existing changes with `patchbook record <change> --intent '...'`, then `patchbook build`.")
    return 0


def main():
    parser = argparse.ArgumentParser(prog="patchbook", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("clone", help="fork an upstream repo, with its history, and start a patchbook")
    p.add_argument("url")
    p.add_argument("dir", nargs="?")
    p.add_argument("--branch")
    p.set_defaults(func=cmd_clone)

    p = sub.add_parser("init", help="start a patchbook in this repo")
    p.add_argument("--upstream", required=True, help="upstream's git URL")
    p.add_argument("--branch", default="main")
    p.add_argument("--path", default="", help="the upstream folder to follow, if not the whole repo")
    p.add_argument("--vendor", help="vendor layout: copy upstream into this folder")
    p.add_argument("--output-from", default="", help="vendor layout: the staged folder that ships")
    p.add_argument("--output-to", help="vendor layout: the folder the build writes")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("check", help="has upstream moved? exits 10 if so")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("sync", help="move the pin to an upstream ref and carry every change forward")
    p.add_argument("ref", nargs="?")
    p.set_defaults(func=cmd_sync)

    p = sub.add_parser("status", help="list what is broken")
    p.add_argument("--json", action="store_true", help="machine-readable, with block text")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("build", help="apply the patchbook to the pinned upstream and write the output")
    p.add_argument("--force", action="store_true", help="overwrite output files edited since the last build")
    p.add_argument("--commit", action="store_true", help="commit the result; in a fork, as a merge of upstream")
    p.set_defaults(func=cmd_build)

    p = sub.add_parser("record", help="move edits made to the output into a change")
    p.add_argument("change")
    p.add_argument("--intent")
    p.set_defaults(func=cmd_record)

    p = sub.add_parser("show", help="print a change, with its file edits as diffs")
    p.add_argument("change")
    p.set_defaults(func=cmd_show)

    p = sub.add_parser("blocks", help="print an upstream file's blocks with their hashes")
    p.add_argument("file")
    p.set_defaults(func=cmd_blocks)

    p = sub.add_parser("scaffold", help="append skeleton block entries for missing blocks")
    p.add_argument("file", nargs="*")
    p.set_defaults(func=cmd_scaffold)

    args = parser.parse_args()
    try:
        sys.exit(args.func(args) or 0)
    except Fail as e:
        print(f"patchbook: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
