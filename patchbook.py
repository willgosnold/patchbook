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
import shlex
import shutil
import subprocess
import sys
import tempfile
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

PB = ".patchbook"
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


# Settings


USER_CONFIG = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "patchbook" / "config.toml"
# name: (env var, default, where it can be set). The most specific wins: the env var, then the
# project's .patchbook/config.toml, then the user's config, then the default.
SETTINGS = {
    "intent.provider": ("PATCHBOOK_PROVIDER", None, "claude or codex: the CLI that writes intents (default: claude if installed)"),
    "intent.model": ("PATCHBOOK_MODEL", None, "the model that writes intents (default: the provider's)"),
    "intent.effort": ("PATCHBOOK_EFFORT", None, "its reasoning effort (default: the provider's)"),
    "hook.enabled": ("PATCHBOOK_HOOK", True, "record and build on each commit"),
    "start.install_skill": ("PATCHBOOK_SKILL", True, "clone and init install the patchbook-update skill"),
    "start.agents": (None, ["claude-code", "codex"], "the agents clone and init install the skill for"),
    "store.path": ("PATCHBOOK_HOME", None, "where upstreams are kept (user config only)"),
}
USER_ONLY = {"store.path"}


def read_toml(path):
    return tomllib.loads(path.read_text()) if path.exists() else {}


def lookup(config, name):
    section, key = name.split(".")
    return config.get(section, {}).get(key)


def parse_value(name, raw):
    default = SETTINGS[name][1]
    if isinstance(default, bool):
        if raw.lower() not in ("1", "0", "true", "false", "yes", "no", "on", "off"):
            raise Fail(f"{name} is true or false, not {raw!r}")
        return raw.lower() in ("1", "true", "yes", "on")
    if isinstance(default, list):
        return [v for v in re.split(r"[,\s]+", raw) if v]
    return raw


def setting(name, book=None):
    """A setting's value and where it came from: env, project, user or default."""
    env, default, _ = SETTINGS[name]
    if env and os.environ.get(env) not in (None, ""):
        return parse_value(name, os.environ[env]), "env"
    if book is not None and name not in USER_ONLY and lookup(book.config, name) is not None:
        return lookup(book.config, name), "project"
    if lookup(read_toml(USER_CONFIG), name) is not None:
        return lookup(read_toml(USER_CONFIG), name), "user"
    return default, "default"


def store_dir():
    path = setting("store.path")[0]
    base = Path(path).expanduser() if path else Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "patchbook"
    return base / "upstreams"


def toml_value(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, list):
        return "[" + ", ".join(json.dumps(x) for x in v) + "]"
    return json.dumps(v)


def set_toml(path, name, value):
    """Set or remove (value None) one key in a TOML file, keeping its other lines and comments."""
    section, key = name.split(".")
    lines = path.read_text().split("\n") if path.exists() else []
    head = next((i for i, l in enumerate(lines) if l.strip() == f"[{section}]"), None)
    if head is None:
        if value is not None:
            lines = (lines + [""] if lines and lines[-1].strip() else lines) + [f"[{section}]", f"{key} = {toml_value(value)}"]
    else:
        end = next((i for i in range(head + 1, len(lines)) if lines[i].lstrip().startswith("[")), len(lines))
        at = next((i for i in range(head + 1, end) if re.match(rf"\s*{re.escape(key)}\s*=", lines[i])), None)
        if at is not None:
            if value is None:
                del lines[at]
            else:
                lines[at] = f"{key} = {toml_value(value)}"
        elif value is not None:
            lines.insert(head + 1, f"{key} = {toml_value(value)}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).rstrip("\n") + "\n")


def cmd_config(args):
    try:
        book = Book.find()
    except Fail:
        book = None
    if args.name and args.name not in SETTINGS:
        raise Fail(f"no setting {args.name}. Settings: {', '.join(SETTINGS)}")
    if args.project and args.name in USER_ONLY:
        raise Fail(f"{args.name} can only be set in the user config")
    if args.project and book is None:
        raise Fail("--project needs a patchbook here or above")
    path = book.dir / "config.toml" if args.project else USER_CONFIG
    if args.unset:
        set_toml(path, args.name, None)
        return 0
    if args.value is not None:
        value = parse_value(args.name, args.value)
        if args.name == "intent.provider" and value not in PROVIDERS:
            raise Fail(f"intent.provider is one of {', '.join(PROVIDERS)}")
        set_toml(path, args.name, value)
        print(f"{args.name} = {toml_value(value)} in {path}")
        return 0
    if not args.name:
        print(f"user config: {USER_CONFIG}" + (f"\nproject config: {book.dir / 'config.toml'}" if book else ""))
    for name in [args.name] if args.name else SETTINGS:
        value, source = setting(name, book)
        if name.startswith("intent."):  # what will actually be used, defaults filled in
            sources = {}
            provider, model, effort = intent_settings(book, quiet=True, sources=sources)
            value = {"intent.provider": provider, "intent.model": model, "intent.effort": effort}[name]
            source = sources.get(name, "default")
        if name == "store.path" and value is None:
            value = str(store_dir().parent)
        env = SETTINGS[name][0]
        shown = toml_value(value) if value is not None else "(not set)"
        print(f"{name:<20} {shown:<28} {source}" + (f"  [{env}]" if env and not args.name else ""))
    return 0


# The repo and its upstreams


def default_name(remote, path):
    tail = path.rstrip("/").rsplit("/", 1)[-1] if path else remote.rstrip("/").rsplit("/", 1)[-1]
    return tail.removesuffix(".git") or "upstream"


class Upstream:
    """One upstream repo, or a folder of one, mounted at a folder of the staged tree."""

    def __init__(self, book, spec, legacy):
        self.book = book
        self.remote = spec["remote"]
        self.path = spec.get("path", "").strip("/")
        self.branch = spec.get("branch", "main")
        self.name = spec.get("name") or default_name(self.remote, self.path)
        self.mount = spec.get("mount", "" if legacy else self.name).strip("/")
        self.vendor = book.root / spec["vendor"] if spec.get("vendor") else None
        self.remote_name = spec.get("remote_name", "upstream")
        # A fork's own upstream is the repo itself. The others are fetched into a cache.
        self.in_repo = book.layout == "fork" and self.mount == ""

    def key(self, rel):
        return f"{self.mount}/{rel}" if self.mount else rel

    def mounted(self, files):
        return {self.key(p): v for p, v in files.items()}

    def pin(self):
        return self.book.lock().get(self.name) or {}

    def git_dir(self):
        if self.in_repo:
            return self.book.root
        readable = re.sub(r"[^A-Za-z0-9]+", "-", re.sub(r"^\w+://|\.git$", "", self.remote)).strip("-")[-60:]
        d = store_dir() / f"{readable}-{hashlib.sha1(self.remote.encode()).hexdigest()[:8]}"
        if not d.exists():
            d.parent.mkdir(parents=True, exist_ok=True)
            git("init", "--quiet", "--bare", str(d), cwd=d.parent)
        return d

    def source(self):
        return self.remote_name if self.in_repo else self.remote

    def fetch(self, ref):
        depth = [] if self.in_repo else ["--depth=1"]
        git("fetch", "--quiet", *depth, self.source(), ref, cwd=self.git_dir())
        return git("rev-parse", "FETCH_HEAD^{commit}", cwd=self.git_dir())

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
            raise Fail(f"upstream {self.name} has no branch {self.branch}")
        return out.split()[0]

    def files(self, commit):
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
        rel = self.vendor.relative_to(self.book.root).as_posix()
        files = index_files(self.book.root, rel)
        tree = files.pop(None)
        return {p[len(rel) + 1:]: v for p, v in files.items()}, tree

    def staged(self):
        """Upstream's files at the pin, mounted. A vendored copy must match the pin exactly."""
        pin = self.pin()
        if not pin.get("tree"):
            raise Fail(f"upstream {self.name} has no pin yet. Run: patchbook sync {self.name}")
        if self.vendor:
            files, tree = self.vendor_tree()
            if tree != pin["tree"]:
                raise Fail(
                    f"{self.vendor.relative_to(self.book.root)} (tree {tree[:7]}) differs from the pin (tree {pin['tree'][:7]}). "
                    "Never edit the vendored copy. Record the change in the patchbook, or run sync."
                )
        else:
            files = self.files(pin["commit"])
        return self.mounted(files)


class Book:
    def __init__(self, root):
        self.root = root
        self.dir = root / PB
        self.config = tomllib.loads((self.dir / "config.toml").read_text())
        self.layout = {"vendor": "folder"}.get(self.config.get("layout", "fork"), self.config.get("layout", "fork"))
        if self.layout not in ("folder", "fork"):
            raise Fail(f"layout must be folder or fork, not {self.layout!r}")
        raw = self.config.get("upstream")
        if not raw:
            raise Fail("config.toml has no [[upstream]]")
        self.legacy = isinstance(raw, dict)
        self.upstreams = [Upstream(self, spec, self.legacy) for spec in ([raw] if self.legacy else raw)]
        self._check_mounts()
        if self.layout == "folder":
            out = self.config.get("output", {})
            self.out_from = out.get("from", "").strip("/")
            self.out_dir = root / out["to"]
        self.hooks = self._load_hooks()

    def _check_mounts(self):
        names = [u.name for u in self.upstreams]
        if len(set(names)) != len(names):
            raise Fail("two upstreams share a name")
        roots = [u for u in self.upstreams if not u.mount]
        if len(roots) > 1:
            raise Fail("only one upstream can mount at the root")
        if self.layout == "fork" and not roots:
            raise Fail("a fork needs its own upstream mounted at the root (mount = \"\")")
        for a in self.upstreams:
            for b in self.upstreams:
                if a is not b and a.mount and under(b.mount, a.mount):
                    raise Fail(f"upstreams {a.name} and {b.name} mount at overlapping folders")

    @classmethod
    def find(cls, start=None):
        here = Path(start or Path.cwd()).resolve()
        for d in (here, *here.parents):
            if (d / PB / "config.toml").exists():
                install_hook(d)
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

    def upstream(self, name):
        for u in self.upstreams:
            if u.name == name:
                return u
        raise Fail(f"no upstream called {name}; there are: {', '.join(u.name for u in self.upstreams)}")

    def upstream_for(self, path):
        """The upstream a staged path belongs to: the deepest mount it is under."""
        found = [u for u in self.upstreams if not u.mount or under(path, u.mount)]
        return max(found, key=lambda u: len(u.mount)) if found else None

    # The lock: {upstream name: {commit, tree}}

    def lock(self):
        path = self.dir / "upstream.lock"
        if not path.exists():
            return {}
        data = json.loads(path.read_text())
        if "commit" in data:  # one upstream, from before upstreams had names
            return {self.upstreams[0].name: data}
        return data

    def write_lock(self, name, commit, tree):
        data = self.lock()
        data[name] = {"commit": commit, "tree": tree}
        (self.dir / "upstream.lock").write_text(json.dumps(dict(sorted(data.items())), indent=2) + "\n")

    def pins(self):
        return ", ".join(f"{name} {pin['commit'][:7]}" for name, pin in sorted(self.lock().items()))

    def staged_upstream(self):
        staged = {}
        for u in self.upstreams:
            files = u.staged()
            clash = next((p for p in files if p in staged), None)
            if clash:
                raise Fail(f"{clash} comes from two upstreams; give {u.name} its own mount")
            staged.update(files)
        return staged

    # The output on disk

    def output_root(self):
        return self.out_dir if self.layout == "folder" else self.root

    def current_output(self):
        """{output path: (bytes, mode)} as it is on disk now: tracked files and untracked ones git doesn't ignore."""
        root = self.output_root()
        if not root.exists():
            return {}
        rel = root.relative_to(self.root).as_posix() if root != self.root else ""
        args = ["ls-files", "-z", "-co", "--exclude-standard"] + (["--", rel] if rel else [])
        # In a fork the output is the repo root, minus the patchbook and any vendored copies.
        kept = [PB] + [u.vendor.relative_to(self.root).as_posix() for u in self.upstreams if u.vendor]
        out = {}
        for path in filter(None, git(*args, cwd=self.root).split("\0")):
            p = self.root / path
            if not os.path.lexists(p):
                continue
            key = path[len(rel) + 1:] if rel else path
            if self.layout == "fork" and any(under(key, k) for k in kept):
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
        if mode == LINK or (mode is None and p.is_symlink()):  # a symlink is stored as one
            write_disk(p, data, LINK)
            return
        p.parent.mkdir(parents=True, exist_ok=True)
        if p.is_symlink():
            p.unlink()
        p.write_bytes(data)
        if mode in (0o644, 0o755):
            p.chmod(mode)

    def drop(self, side, path):
        p = self.content(side, path)
        if os.path.lexists(p):
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
    if book.layout == "folder":
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
            mode = upstream[src[2]][1] if src[2] in upstream else read_disk(c.content("ours", src[2]))[1]
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


def patch_blocks(rules, out_path, rel, text, entries, used, unmatched, problems, owners=None):
    """Swap each block that has an entry for its patched text. If owners is a list, it gets, for each
    output line, the index of the upstream block it came from, or None for the lines between blocks."""
    lines = text.split("\n")
    spans = block_spans(lines)
    out, prev, applied = [], 0, 0

    def emit(chunk, owner):
        out.extend(chunk)
        if owners is not None:
            owners.extend([owner] * len(chunk))

    for i, (start, end) in enumerate(spans):
        block = "\n".join(lines[start:end])
        h = block_hash(block)
        where = {"file": rel, "output": out_path, "line": start + 1, "hash": h}
        emit(lines[prev:start], None)
        prev = end
        entry = entries.get(h)
        if entry is None:
            unmatched.append({"line": start + 1, "hash": h, "upstream": block})
            terms = rules.terms(out_path, block)
            if terms:
                problems.append({"problem": "missing", **where, "terms": terms, "upstream": block})
            emit(lines[start:end], i)
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
            emit(patched.split("\n"), i)
        elif i + 1 < len(spans):
            prev = spans[i + 1][0]  # drop the blank lines after a deleted block
    emit(lines[prev:], None)
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
    print(f"built {len(a.out)} files from {book.pins()} with {a.applied} edits")
    if args.commit:
        commit_build(book)
    return 0


def commit_build(book):
    root = book.root
    git("add", "-A", cwd=root)
    tree = git("write-tree", cwd=root)
    parents = ["-p", "HEAD"]
    own = next((u for u in book.upstreams if u.in_repo), None)
    if own:
        commit = own.pin()["commit"]
        ancestor = subprocess.run(["git", "merge-base", "--is-ancestor", commit, "HEAD"], cwd=root).returncode == 0
        if not ancestor:
            parents += ["-p", commit]
    if git("rev-parse", "HEAD^{tree}", cwd=root) == tree and len(parents) == 2:
        print("nothing to commit")
        return
    message = f"Build from upstream {book.pins()}"
    commit = git("commit-tree", tree, *parents, "-m", message, cwd=root)
    git("update-ref", "HEAD", commit, cwd=root)
    print(f"committed {commit[:7]}: {message}")


# Status


def cmd_status(args):
    book = Book.find()
    a = assemble(book)
    last_sync = book.dir / "last-sync.json"
    report = json.loads(last_sync.read_text()) if last_sync.exists() else None
    if args.json:
        print(json.dumps({"upstreams": book.lock(), "applied": a.applied, "problems": a.problems,
                          "last_sync": report}, indent=2))
    else:
        for p in a.problems:
            print(describe(p))
        counts = {}
        for p in a.problems:
            counts[p["problem"]] = counts.get(p["problem"], 0) + 1
        summary = ", ".join(f"{n} {k}" for k, n in sorted(counts.items())) or "no problems"
        print(f"{a.applied} edits apply at {book.pins()}; {summary}")
    return 1 if a.problems else 0


# Check and sync


def cmd_check(args):
    book = Book.find()
    result = {"moved": False, "upstreams": {}}
    for u in book.upstreams:
        pin = u.pin()
        head = u.head()
        r = {"pinned": pin.get("commit"), "head": head, "moved": False, "files": []}
        if head != pin.get("commit"):
            u.fetch(head)
            if u.tree_of(head) != pin.get("tree"):
                old = u.mounted(u.files(pin["commit"])) if pin.get("tree") else {}
                r["moved"] = True
                r["files"] = upstream_delta(old, u.mounted(u.files(head)))
        result["upstreams"][u.name] = r
        result["moved"] = result["moved"] or r["moved"]
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
    if args.ref and not args.name and len(book.upstreams) > 1:
        raise Fail("name the upstream to sync to a ref: patchbook sync <name> <ref>")
    targets = [book.upstream(args.name)] if args.name else book.upstreams
    problems = []
    changes = read_changes(book, problems)
    reports = {}
    for u in targets:
        report = sync_upstream(book, u, args.ref, changes)
        if report:
            reports[u.name] = report
    if reports:
        (book.dir / "last-sync.json").write_text(json.dumps({"upstreams": reports}, indent=2) + "\n")
        print("Next: patchbook status")
    return 0


def sync_upstream(book, u, ref, changes):
    """Move one upstream's pin and carry every change on its files forward. Returns the report, or None."""
    pin = u.pin()
    commit = u.fetch(ref or u.branch)
    tree = u.tree_of(commit)
    if tree == pin.get("tree"):
        print(f"{u.name}: upstream at {commit[:7]} matches the pin (tree {tree[:7]}). Nothing to do.")
        return None
    raw = u.files(commit)
    old = u.mounted(u.files(pin["commit"])) if pin.get("tree") else {}
    new = u.mounted(raw)
    report = {"from": pin.get("commit"), "to": commit, "upstream": upstream_delta(old, new),
              "merged": [], "conflicts": [], "gone": [], "replaced_upstream_changed": []}

    if u.vendor:
        if u.vendor.exists():
            shutil.rmtree(u.vendor)
        for p, (data, mode) in raw.items():
            write_disk(u.vendor / p, data, mode)
        _, actual = u.vendor_tree()
        if actual != tree:
            raise Fail(f"the vendored copy of {u.name} hashes to {actual}, not upstream's {tree}. "
                       "Does a .gitignore hide upstream files?")

    added = [p for p in new if p not in old]
    for c in changes:
        for e in c.edits:
            if book.upstream_for(e.path) is not u:
                continue
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

    book.write_lock(u.name, commit, tree)
    print(f"{u.name}: pinned {commit[:7]}. {len(report['upstream'])} upstream files changed, "
          f"{len(report['merged'])} of ours merged cleanly, {len(report['conflicts'])} conflicts, "
          f"{len(report['gone'])} gone.")
    return report


# Record


def cmd_record(args):
    book = Book.find()
    a = assemble(book)
    current = book.current_output()
    problems = []
    changes = {c.name: c for c in read_changes(book, problems)}
    file_owner = {e.path: c for c in changes.values() for e in c.edits if e.kind == "file"}
    has_blocks = {p.relative_to(book.dir / "blocks").as_posix()[: -len(".entries")]
                  for p in (book.dir / "blocks").rglob("*.entries")}
    prefix = book.out_from + "/" if book.layout == "folder" and book.out_from else ""
    # Only files edited by hand since the last build. Others differ because the patchbook changed.
    edited = hand_edits(book, a.out)
    if not edited:
        print("no hand edits to the output since the last build; nothing to record")
        return 0

    # Sort the edits. Paragraph edits update block entries. Edits to files a change already owns go
    # to that change. The rest go to the change being recorded.
    rules = Rules(book, set(a.sources))
    new, paragraphs, notes = [], {}, []
    for p in edited:
        now, built, src = current.get(p), a.out.get(p), a.sources.get(p)
        if built is None or (src[0] == "up" and src[1] not in has_blocks and (now is None or src[1] not in file_owner)):
            new.append(p)
        elif src[0] == "up" and src[1] in has_blocks and now is not None:
            plan = plan_paragraphs(book, rules, src[1], p, a.upstream[src[1]][0].decode(), built[0], now[0])
            if isinstance(plan, str):
                notes.append(f"skipped  {p}: {plan}")
            else:
                paragraphs[p] = plan

    name, intent = args.change, args.intent
    needs_intent = any(e["intent"] is None for plan in paragraphs.values() for e in plan["entries"].values())
    named = bool(new)
    if (named and (not name or (name not in changes and not intent))) or (needs_intent and not intent and not
                                                                           (name in changes)):
        diff = pending_diff(a, current, new) + "".join(
            "".join(difflib.unified_diff((e["upstream"] + "\n").splitlines(True), (e["patched"] + "\n").splitlines(True),
                                         f"upstream/{p}", f"disk/{p}"))
            for p, plan in paragraphs.items() for e in plan["entries"].values() if e["intent"] is None)
        name, intent = write_intent(book, changes, diff, name, named)
        print(f"{name}: {intent}" if named and name not in changes else f"adding to {name}" if named else f"intent: {intent}")
    elif needs_intent and not intent:
        intent = changes[name].intent
    for p, plan in paragraphs.items():
        for e in plan["entries"].values():
            if e["intent"] is None:
                e["intent"] = intent
        save_paragraphs(book, plan)
        notes.extend(f"entry    {p} [{h}] {what}" for h, what in plan["notes"])

    name = name or "unnamed"
    target = changes.get(name)
    if target is None:
        target = Change(name, book.dir / "changes" / name, intent)
    elif args.intent:
        target.intent = args.intent
    touched = {target.name: target}

    for p in edited:
        if p in paragraphs or (a.sources.get(p) and a.sources[p][0] == "up" and a.sources[p][1] in has_blocks
                               and current.get(p) is not None):
            continue
        now, built = current.get(p), a.out.get(p)
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
            c = file_owner.get(rel, target)
            if rel not in file_owner:
                c.edits.append(Edit("file", rel))
                c.write("base", rel, a.upstream[rel][0])
            c.write("ours", rel, now[0])
            touched[c.name] = c
            notes.append(f"file     {p}" + (f" (in {c.name})" if c is not target else ""))

    for c in touched.values():
        if c.edits or c is not target:
            save_change(c)
    if target.edits and target.name not in read_series(book):
        with (book.dir / "series").open("a") as f:
            f.write(target.name + "\n")
    print("\n".join(notes))
    # The recorded output is now what the patchbook builds, so it no longer counts as a hand edit.
    lock = read_build_lock(book)
    if lock is not None:
        after = assemble(book).out
        for p in edited:
            if p in after and current.get(p) == after[p]:
                lock[p] = blob_oid(after[p][0])
            elif p not in after and p not in current:
                lock.pop(p, None)
        build_lock_path(book).write_text("".join(f"{oid} {p}\n" for p, oid in sorted(lock.items())))
    return 0


def plan_paragraphs(book, rules, rel, out_path, upstream_text, built, now):
    """Work out the block entry updates that make the build produce `now` for a file with block entries.

    Returns {"path", "entries", "notes"}, where entries is the whole new set (an intent of None means
    the entry still needs one), or a reason the edit can't be recorded this way.
    """
    if not (is_text(built) and is_text(now)):
        return "it isn't text"
    entries = read_entries(entries_path(book, rel))
    lines = upstream_text.split("\n")
    spans = block_spans(lines)
    owners = []
    text, _ = patch_blocks(rules, out_path, rel, upstream_text, entries, set(), [], [], owners)
    if text.encode() != built:
        return "a hook changes it after its block entries apply; edit the entries directly"
    old, new = text.split("\n"), now.decode().split("\n")
    every = difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes()
    ops = [op for op in every if op[0] != "equal"]

    # Each edit belongs to the blocks whose lines it touches, or, between blocks, to the block before it.
    blame = []
    for tag, i1, i2, j1, j2 in ops:
        inside = {owners[k] for k in range(i1, i2) if owners[k] is not None}
        if not inside:
            before = next((owners[k] for k in range(i1 - 1, -1, -1) if owners[k] is not None), None)
            after = next((owners[k] for k in range(i2, len(owners)) if owners[k] is not None), None)
            inside = {before if before is not None else after} - {None}
        if not inside:
            return "it has no blocks to attach the edit to"
        blame.append((inside, i1, i2, j1, j2))
    touched = sorted(set().union(*(b[0] for b in blame)))

    # Neighbouring touched blocks form one group: the first block takes the group's new text.
    groups, shown = [], [k for k in range(len(spans)) if k in owners]
    for k in touched:
        if groups and shown.index(k) == shown.index(groups[-1][-1]) + 1:
            groups[-1].append(k)
        else:
            groups.append([k])
    result = dict(entries)
    notes = []
    for group in groups:
        mine = [b for b in blame if b[0] & set(group)]
        own = [n for n, o in enumerate(owners) if o in group]
        bs, be = min([own[0]] + [b[1] for b in mine]), max([own[-1] + 1] + [b[2] for b in mine])
        js = min([map_line(every, bs, len(new))] + [b[3] for b in mine])
        je = max([map_line(every, be, len(new))] + [b[4] for b in mine])
        chunk = new[js:je]
        while chunk and not chunk[0].strip():
            chunk.pop(0)
        while chunk and not chunk[-1].strip():
            chunk.pop()
        for k, piece in zip(group, ["\n".join(chunk)] + [""] * (len(group) - 1)):
            upstream = "\n".join(lines[spans[k][0]:spans[k][1]])
            h = block_hash(upstream)
            entry = entries.get(h)
            if entry:  # keep its placeholders where their values still appear
                for m in PLACEHOLDER_HINT.finditer(entry["patched"]):
                    value = rules.expand(m.group(0), [], {})
                    if value != m.group(0) and value in piece:
                        piece = piece.replace(value, m.group(0))
            if piece == upstream and (not entry or entry["kind"] != "keep"):
                if entry:
                    del result[h]
                    notes.append((h, "removed: the paragraph is upstream's again"))
                continue
            if entry and entry["kind"] != "keep":
                result[h] = {**entry, "patched": piece}
                notes.append((h, "updated"))
            else:
                result[h] = {"hash": h, "kind": "policy", "rules": "", "intent": None, "upstream": upstream, "patched": piece}
                notes.append((h, "added"))

    check, _ = patch_blocks(rules, out_path, rel, upstream_text, {h: {**e, "intent": e["intent"] or "-"} for h, e in result.items()},
                            set(), [], [])
    if check.encode() != now:
        return "the edit doesn't map onto whole paragraphs; edit its block entries directly"
    return {"path": entries_path(book, rel), "entries": result, "notes": notes}


def map_line(ops, i, end):
    """The line of the new text that line i of the old text lines up with."""
    for tag, i1, i2, j1, j2 in ops:
        if i1 <= i < i2:
            return j1 + (i - i1) if tag == "equal" else j1
    return end


def save_paragraphs(book, plan):
    path = plan["path"]
    if plan["entries"]:
        path.write_text("\n".join(format_entry(e) for e in plan["entries"].values()))
    elif path.exists():
        path.unlink()


PLACEHOLDER_HINT = re.compile(r"\{\{\w+:[^}]+\}\}")


# Writing intents with a model


PROVIDERS = {
    "claude": {"model": "claude-haiku-5-5", "effort": "medium"},
    "codex": {"model": "gpt-6-luna", "effort": "high"},
}
INTENT_PROMPT = """You name and describe a change someone made to their copy of an upstream repo.
The change is kept as a patch over upstream. When upstream changes, an agent redoes the change from
its intent alone, so the intent must say what the change does and why, in one or two plain
sentences, without line numbers or code. Don't describe upstream.

Existing changes, one per line as `name: intent`:
{changes}

{instruction}

Reply with only a JSON object: {{"change": "<name>", "intent": "<intent>"}}

The edits, as diffs from what the patchbook builds to what is on disk now:
{diff}
"""


def pending_diff(a, current, paths):
    """The edits on disk to these output paths, as one text for a model to read."""
    parts = []
    for p in paths:
        now, built = current.get(p), a.out.get(p)
        old = built[0] if built else b""
        new = now[0] if now else b""
        if not (is_text(old) and is_text(new)):
            parts.append(f"binary file {p} {'added' if not built else 'deleted' if not now else 'changed'}\n")
            continue
        parts.extend(difflib.unified_diff(old.decode().splitlines(keepends=True), new.decode().splitlines(keepends=True),
                                          f"built/{p}" if built else "/dev/null", f"disk/{p}" if now else "/dev/null"))
    text = "".join(parts)
    return text[:40000] + ("\n[diff truncated]\n" if len(text) > 40000 else "")


def intent_settings(book, quiet=False, sources=None):
    """The provider, model and effort for writing intents.

    A model or effort set alongside a different provider is for that provider, so it's skipped.
    """
    provider, source = setting("intent.provider", book)
    if sources is not None:
        sources["intent.provider"] = source
    if not provider:
        found = [p for p in PROVIDERS if shutil.which(p)]
        if not found and not quiet:
            raise Fail("writing an intent needs the claude or codex CLI. Install one, or pass --intent.")
        provider = found[0] if found else "claude"
    if provider not in PROVIDERS:
        raise Fail(f"intent.provider is one of {', '.join(PROVIDERS)}, not {provider!r}")
    layers = [("env", None), ("project", book.config if book else {}), ("user", read_toml(USER_CONFIG))]
    chosen = dict(PROVIDERS[provider])
    for key in ("model", "effort"):
        for source, config in layers:
            if source == "env":
                value = os.environ.get(SETTINGS[f"intent.{key}"][0])
            else:
                if source == "project" and book is None:
                    continue
                value = lookup(config, f"intent.{key}")
                if value and lookup(config, "intent.provider") not in (None, provider):
                    value = None
            if value:
                chosen[key] = value
                if sources is not None:
                    sources[f"intent.{key}"] = source
                break
    return provider, chosen["model"], chosen["effort"]


def ask_model(provider, model, effort, prompt):
    with tempfile.TemporaryDirectory() as tmp:
        if provider == "claude":
            cmd = ["claude", "-p", "--model", model, "--effort", effort]
        else:
            cmd = ["codex", "exec", "-m", model, "-c", f"model_reasoning_effort={effort}",
                   "--skip-git-repo-check", "-s", "read-only", "-C", tmp, "-"]
        result = subprocess.run(cmd, cwd=tmp, input=prompt.encode(), capture_output=True)
    if result.returncode != 0:
        raise Fail(f"{provider} failed: {result.stderr.decode(errors='replace').strip()[-500:]}. Pass --intent instead.")
    return result.stdout.decode(errors="replace")


def write_intent(book, changes, diff, name=None, named=True):
    """Ask the chosen model for the change's name and intent. Returns (name, intent)."""
    provider, model, effort = intent_settings(book)
    listed = "\n".join(f"{c.name}: {c.intent}" for c in changes.values()) or "(none yet)"
    if not named:
        name = "paragraphs"
        instruction = ("These edits rewrite paragraphs in place; each changed paragraph keeps this intent. "
                       "Write the intent, and reply with the name paragraphs.")
    elif name:
        instruction = f"The change is new and called {name}. Write its intent, and reply with that name."
    else:
        instruction = ("If these edits serve the purpose of one existing change, reply with that change's name and "
                       "its intent unchanged. Otherwise give a new short kebab-case name and write its intent.")
    reply = ask_model(provider, model, effort, INTENT_PROMPT.format(changes=listed, instruction=instruction, diff=diff))
    m = re.search(r"\{.*\}", reply, re.DOTALL)
    try:
        answer = json.loads(m.group(0)) if m else {}
    except json.JSONDecodeError:
        answer = {}
    chosen, intent = answer.get("change", ""), " ".join(str(answer.get("intent", "")).split())
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", chosen or "") or not intent:
        raise Fail(f"{provider} didn't return a usable name and intent:\n{reply.strip()[:500]}\nPass a name and --intent instead.")
    if name and chosen != name:
        chosen = name
    if chosen in changes and named:
        intent = changes[chosen].intent
    return (chosen if named else None), intent


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


# Reading an upstream


def cmd_upstream(args):
    """Read an upstream at its pin, from the store: list its files, print one, export them, or diff the last sync."""
    book = Book.find()
    u = book.upstream(args.name)
    pin = u.pin()
    if not pin.get("tree"):
        raise Fail(f"upstream {u.name} has no pin yet. Run: patchbook sync {u.name}")
    if args.diff or args.since:
        last = book.dir / "last-sync.json"
        report = json.loads(last.read_text()).get("upstreams", {}).get(u.name, {}) if last.exists() else {}
        old = args.since or report.get("from")
        if not old:
            raise Fail(f"no earlier pin of {u.name} to compare with; pass --since <commit>")
        u.have(old)
        u.have(pin["commit"])
        where = "/".join(p for p in (u.path, args.path) if p)
        relative = [f"--relative={u.path}/"] if u.path else []
        sys.stdout.write(run(["git", "diff", "--no-color", *relative, old, pin["commit"], "--", *([where] if where else [])],
                             u.git_dir()).decode(errors="replace"))
        return 0
    files = u.files(pin["commit"])
    if args.export:
        dest = Path(args.export).resolve()
        for path, (data, mode) in files.items():
            write_disk(dest / path, data, mode)
        print(f"wrote {len(files)} files of {u.name} at {pin['commit'][:7]} to {dest}")
        return 0
    if args.path:
        if args.path not in files:
            raise Fail(f"{u.name} has no {args.path} at {pin['commit'][:7]}")
        sys.stdout.buffer.write(files[args.path][0])
        return 0
    print("\n".join(sorted(files)))
    return 0


# Recording on commit


HOOK_MARK = "# Installed by patchbook."


def install_hook(root, verbose=False):
    """Install the pre-commit hook, unless the repo already has a pre-commit hook of its own."""
    path = Path(git("rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit", cwd=root))
    if path.exists():
        if HOOK_MARK not in path.read_text(errors="replace") and verbose:
            print(f"patchbook: {path} is another tool's hook; add `patchbook hook run` to it to record on commit.",
                  file=sys.stderr)
        return
    me = shlex.quote(str(Path(__file__).resolve()))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"""#!/bin/sh
{HOOK_MARK} On each commit, it records hand edits to the build output in the
# patchbook, rebuilds, and stages both. Skip it once with: PATCHBOOK_HOOK=0 git commit
[ "$PATCHBOOK_HOOK" = 0 ] && exit 0
if [ -f {me} ]; then exec {shlex.quote(sys.executable)} {me} hook run; fi
if command -v patchbook >/dev/null; then exec patchbook hook run; fi
echo "patchbook isn't installed, so this commit doesn't record hand edits." >&2
""")
    path.chmod(0o755)
    print(f"patchbook: installed a pre-commit hook that records and builds on each commit", file=sys.stderr)


def dirty(root):
    """{path: blob id, or None if deleted} for every path git status lists."""
    out = {}
    entries = run(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], root).decode().split("\0")
    paths = []
    for e in entries:
        if len(e) > 3 and e[2] == " ":
            paths.append(e[3:])
    for path in paths:
        f = root / path
        out[path] = blob_oid(read_disk(f)[0]) if os.path.lexists(f) and not f.is_dir() else None
    return out


def cmd_hook(args):
    if args.action == "install":
        install_hook(Path(git("rev-parse", "--show-toplevel", cwd=Path.cwd())), verbose=True)
        return 0
    book = Book.find()
    if not setting("hook.enabled", book)[0]:
        return 0
    before = dirty(book.root)
    a = assemble(book)
    edited = hand_edits(book, a.out)
    if edited:
        cmd_record(argparse.Namespace(change=None, intent=os.environ.get("PATCHBOOK_INTENT")))
        a = assemble(book)
    if a.problems:
        print(f"patchbook: {len(a.problems)} problems, so the output wasn't rebuilt. `patchbook status` lists them.",
              file=sys.stderr)
    else:
        left = hand_edits(book, a.out)
        if left:
            raise Fail("couldn't record these hand edits:\n  " + "\n  ".join(left) +
                       "\nMove them into the patchbook yourself, or skip the hook once with PATCHBOOK_HOOK=0.")
        if a.out != book.current_output():
            write_output(book, a.out)
            print(f"patchbook: built from {book.pins()}", file=sys.stderr)
    after = dirty(book.root)
    out_rel = book.output_root().relative_to(book.root).as_posix()
    stage = sorted({p for p in set(before) | set(after) if before.get(p) != after.get(p)} |
                   {(f"{out_rel}/{p}" if out_rel != "." else p) for p in edited})
    if stage:
        git("add", "-A", "--", *stage, cwd=book.root)
    return 0


SKILL = ["npx", "-y", "skills", "add", "willgosnold/patchbook", "--skill", "patchbook-update", "-y"]
SCHEDULE = 'To keep up with upstream, add a daily T3 scheduled task in this project: "Use the patchbook-update skill."'


def install_skill(book):
    """Install the update skill for agents in the repo. Returns whether it did."""
    if not setting("start.install_skill", book)[0]:
        return False
    cmd = SKILL + [x for agent in setting("start.agents", book)[0] for x in ("-a", agent)]
    if not shutil.which("npx") or subprocess.run(cmd, cwd=book.root, capture_output=True).returncode != 0:
        print(f"patchbook: couldn't install the update skill. Run it yourself: {shlex.join(cmd)}", file=sys.stderr)
        return False
    return True


# Starting a patchbook, and following another upstream


def upstream_toml(name, remote, path, branch, mount, vendor=None):
    lines = ["[[upstream]]", f'name = "{name}"', f'remote = "{remote}"']
    if path:
        lines.append(f'path = "{path}"')
    lines += [f'branch = "{branch}"', f'mount = "{mount}"']
    if vendor:
        lines.append(f'vendor = "{vendor}"')
    return "\n".join(lines) + "\n"


def write_config(root, layout, upstream, output=None):
    d = root / PB
    d.mkdir(exist_ok=True)
    text = f'layout = "{layout}"\n\n' + upstream
    if output:
        text += f'\n[output]\nfrom = "{output[0]}"\nto = "{output[1]}"\n'
    (d / "config.toml").write_text(text)
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
    name = default_name(args.url, "")
    write_config(dest, "fork", upstream_toml(name, args.url, "", branch, ""))
    book = Book(dest)
    book.write_lock(name, commit, git("rev-parse", "HEAD^{tree}", cwd=dest))
    write_build_lock(book, book.current_output())
    install_hook(dest)
    if install_skill(book):
        os.chdir(dest)
        cmd_record(argparse.Namespace(change="patchbook-update-skill", intent=(
            "Install the patchbook-update skill, so an agent can pull upstream and carry these changes forward.")))
    git("add", "-A", cwd=dest)
    git("commit", "--quiet", "-m", f"Start a patchbook at upstream {commit[:7]}", cwd=dest, env=no_hook())
    print(f"cloned {args.url} into {dest}, pinned at {commit[:7]}.\n"
          "Make your changes and commit: the hook records them in the patchbook and rebuilds.\n"
          f"{SCHEDULE}\n"
          f"To publish it: gh repo create <name> --private --source {dest} --push")
    return 0


def cmd_init(args):
    root = Path(git("rev-parse", "--show-toplevel", cwd=Path.cwd()))
    if (root / PB / "config.toml").exists():
        raise Fail(f"{root} already has a patchbook. To follow another upstream: patchbook track")
    name = args.name or default_name(args.upstream, args.path)
    if args.output_to:
        write_config(root, "folder", upstream_toml(name, args.upstream, args.path, args.branch, "", args.vendor),
                     (args.output_from, args.output_to))
        book = Book(root)
        sync_upstream(book, book.upstreams[0], args.branch, [])
        install_hook(root)
        install_skill(book)
        print(f"Next: patchbook build, then commit.\n{SCHEDULE}")
        return 0
    write_config(root, "fork", upstream_toml(name, args.upstream, args.path, args.branch, ""))
    if "upstream" not in git("remote", cwd=root).split():
        git("remote", "add", "upstream", args.upstream, cwd=root)
    git("fetch", "--quiet", "upstream", args.branch, cwd=root)
    base = git("merge-base", "HEAD", "FETCH_HEAD", cwd=root)
    book = Book(root)
    book.write_lock(name, base, book.upstreams[0].tree_of(base))
    install_hook(root)
    install_skill(book)
    print(f"pinned upstream at {base[:7]}, where this repo branched from it.\n"
          "Capture your existing changes with `patchbook record`, then `patchbook build`, and commit.\n" + SCHEDULE)
    return 0


def cmd_track(args):
    """Follow one more upstream, mounted at its own folder of the staged tree."""
    book = Book.find()
    if any(u.name == args.name for u in book.upstreams):
        raise Fail(f"already following an upstream called {args.name}")
    config = book.dir / "config.toml"
    text = config.read_text()
    if book.legacy:  # name the first upstream, keeping it at the root
        first = book.upstreams[0]
        text = re.sub(r"^\[upstream\]$", f'[[upstream]]\nname = "{first.name}"\nmount = ""', text, count=1, flags=re.MULTILINE)
        book.write_lock(first.name, **book.lock()[first.name])
    mount = args.name if args.mount is None else args.mount
    config.write_text(text.rstrip("\n") + "\n\n" + upstream_toml(args.name, args.url, args.path, args.branch, mount, args.vendor))
    book = Book(book.root)
    sync_upstream(book, book.upstream(args.name), args.branch, [])
    where = f"{mount}/" if mount else "the root"
    print(f"Its files appear at {where} of the staged tree. Ship what you need with edits (move, copy), then build.")
    return 0


def no_hook():
    return {**os.environ, "PATCHBOOK_HOOK": "0"}


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
    p.add_argument("--name", help="what to call it (default: the last part of --path or the URL)")
    p.add_argument("--branch", default="main")
    p.add_argument("--path", default="", help="the upstream folder to follow, if not the whole repo")
    p.add_argument("--output-to", help="build into this folder instead of over the repo (the folder layout)")
    p.add_argument("--output-from", default="", help="folder layout: the staged folder that ships")
    p.add_argument("--vendor", help="also keep a byte-for-byte copy of upstream in this folder")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("track", help="follow another upstream, mounted at its own folder")
    p.add_argument("name")
    p.add_argument("url")
    p.add_argument("--branch", default="main")
    p.add_argument("--path", default="", help="the upstream folder to follow, if not the whole repo")
    p.add_argument("--mount", help="the staged folder its files appear under (default: its name)")
    p.add_argument("--vendor", help="also keep a byte-for-byte copy in this folder")
    p.set_defaults(func=cmd_track)

    p = sub.add_parser("upstream", help="read an upstream at its pin: list, print, export, or diff the last sync")
    p.add_argument("name")
    p.add_argument("path", nargs="?", help="a path inside the upstream, as upstream has it")
    p.add_argument("--diff", action="store_true", help="what upstream changed in the last sync")
    p.add_argument("--since", help="what upstream changed since this commit")
    p.add_argument("--export", metavar="DIR", help="write every file at the pin into DIR")
    p.set_defaults(func=cmd_upstream)

    p = sub.add_parser("check", help="has any upstream moved? exits 10 if so")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("sync", help="move the pins to upstream and carry every change forward")
    p.add_argument("name", nargs="?", help="only this upstream")
    p.add_argument("ref", nargs="?", help="a branch, tag or commit (default: the upstream's branch)")
    p.set_defaults(func=cmd_sync)

    p = sub.add_parser("status", help="list what is broken")
    p.add_argument("--json", action="store_true", help="machine-readable, with block text")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("build", help="apply the patchbook to the pinned upstreams and write the output")
    p.add_argument("--force", action="store_true", help="overwrite output files edited since the last build")
    p.add_argument("--commit", action="store_true", help="commit the result; in a fork, as a merge of upstream")
    p.set_defaults(func=cmd_build)

    p = sub.add_parser("record", help="move edits made to the output into a change")
    p.add_argument("change", nargs="?", help="the change to add them to (default: the model picks or names one)")
    p.add_argument("--intent", help="what the change is for (default: the model writes it)")
    p.set_defaults(func=cmd_record)

    p = sub.add_parser("hook", help="install the pre-commit hook, or run it")
    p.add_argument("action", choices=["install", "run"])
    p.set_defaults(func=cmd_hook)

    p = sub.add_parser("config", help="show settings and where each comes from, or set one")
    p.add_argument("name", nargs="?", help="a setting, such as intent.provider")
    p.add_argument("value", nargs="?")
    p.add_argument("--project", action="store_true", help="set it in this project's .patchbook/config.toml, not yours")
    p.add_argument("--unset", action="store_true", help="remove it, so the next layer's value applies")
    p.set_defaults(func=cmd_config)

    p = sub.add_parser("show", help="print a change, with its file edits as diffs")
    p.add_argument("change")
    p.set_defaults(func=cmd_show)

    p = sub.add_parser("blocks", help="print an upstream file's blocks with their hashes")
    p.add_argument("file", help="its staged path, such as skills/arena/SKILL.md")
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
