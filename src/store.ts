// The upstreams: one bare repo per remote in the user's store, fetched shallowly, read at the pin.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { Book, PB, refuseClimbingPaths, refuseExportedGit } from "./book.ts";
import { Fail } from "./lib/fail.ts";
import { exists, type File, isDir, isSymlink, lexists, mkdirs, type Mode, normMode, pjoin, readDisk, relative, resolve, writeDisk } from "./lib/fs.ts";
import { sha1 } from "./lib/hash.ts";
import { git, redact, run, spawn } from "./lib/proc.ts";
import { say, verbatim, warn } from "./lib/term.ts";
import { byCodePoint, decode, decodeReplace, encode, quote } from "./lib/text.ts";
import { storeDir, type Table } from "./settings.ts";
import { readLastSync } from "./sync.ts";

export type Pin = { commit?: string; tree?: string };
type Files = Map<string, File>;

export function defaultName(remote: string, path: string): string {
  const tail = (path ? rstrip(path) : rstrip(remote)).split("/").at(-1) ?? "";
  return (tail.endsWith(".git") ? tail.slice(0, -4) : tail) || "upstream";
}

const rstrip = (s: string) => s.replace(/\/+$/, "");

/** git's url_is_local_not_ssh, the rule fetch and ls-remote use. `git clone` also takes an existing folder named like `a:b` as local; this does not. */
function isLocalPath(remote: string): boolean {
  const colon = remote.indexOf(":");
  return !remote.includes("://") && (colon === -1 || remote.slice(0, colon).includes("/"));
}

const namesNoHelper = (remote: string): boolean => isLocalPath(remote) || remote.startsWith("file://");

export function absoluteRemote(remote: string): string {
  return remote && !remote.startsWith("-") && isLocalPath(remote) ? posix.resolve(remote) : remote;
}

function field(spec: Table, key: string, fallback: string): string {
  const value = Object.hasOwn(spec, key) ? spec[key] : fallback;
  if (typeof value !== "string") throw new Fail(`an [[upstream]]'s ${key} is a string, not ${quote(value)}`);
  return value;
}

/** A folder of the staged tree, normalised so every later comparison sees one spelling: `""` is the root. */
export function stagedFolder(raw: string, what: string): string {
  const folder = posix.normalize(raw);
  if (raw.startsWith("/") || folder === ".." || folder.startsWith("../")) {
    throw new Fail(`${what} ${quote(raw)} must be a folder inside the staged tree, not an absolute path or one that climbs out with ..`);
  }
  return folder === "." || folder === "./" ? "" : folder.replace(/^\/+|\/+$/g, "");
}

/** One upstream repo, or a folder of one, mounted at a folder of the staged tree. */
export class Upstream {
  readonly remote: string;
  readonly path: string;
  readonly branch: string;
  readonly name: string;
  readonly mount: string;
  readonly vendor: string | null;

  constructor(readonly book: Book, spec: Table) {
    this.remote = field(spec, "remote", "");
    if (!this.remote) throw new Fail("an [[upstream]] needs a remote");
    this.path = field(spec, "path", "").replace(/^\/+|\/+$/g, "");
    this.branch = field(spec, "branch", "main");
    this.name = field(spec, "name", "") || defaultName(this.remote, this.path);
    if (this.remote.startsWith("-")) {
      throw new Fail(`upstream ${this.name}'s remote ${quote(redact(this.remote))} starts with "-", so git would read it as an option.`);
    }
    const transport = /^(ssh|git)::/.exec(this.remote)?.[1];
    if (transport) {
      throw new Fail(
        `upstream ${this.name}'s remote ${quote(redact(this.remote))} names git's own ${transport} transport as a remote helper. `
          + `git ships no git-remote-${transport} and allows ${transport} always, so it would run whatever git-remote-${transport} is on PATH. Write ${transport}:// instead.`,
      );
    }
    if (isLocalPath(this.remote) && !posix.isAbsolute(this.remote)) {
      throw new Fail(
        `upstream ${this.name}'s remote ${quote(redact(this.remote))} is a relative path, so it names a different repo from each folder. `
          + "Set remote in .patchbook/config.toml to an absolute path or a URL.",
      );
    }
    this.mount = stagedFolder(field(spec, "mount", this.name), `the mount of ${this.name}`);
    const vendor = field(spec, "vendor", "");
    this.vendor = vendor ? pjoin(book.root, vendor) : null;
  }

  /** A fork's own upstream is the repo itself. The others are fetched into the store. */
  get inRepo(): boolean {
    return this.book.layout.kind === "fork" && this.mount === "";
  }

  key(rel: string): string {
    return this.mount ? `${this.mount}/${rel}` : rel;
  }

  mounted(files: Files): Files {
    return new Map(Array.from(files, ([p, f]) => [this.key(p), f]));
  }

  pin(): Pin {
    const found = this.book.lock().find((p) => p.name === this.name);
    return found ? { commit: found.commit, tree: found.tree } : {};
  }

  gitDir(): string {
    if (this.inRepo) return this.book.root;
    const bare = this.remote.replace(/^[\p{L}\p{N}_]+:\/\/|\.git$/gu, "");
    const readable = bare.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(-60);
    const d = pjoin(storeDir(), `${readable}-${sha1(encode(this.remote)).slice(0, 8)}`);
    if (!exists(d)) {
      mkdirs(dirname(d));
      git(["init", "--quiet", "--bare", d], { cwd: dirname(d) });
    }
    return d;
  }

  source(): string {
    return this.remote;
  }

  fetch(ref: string): string {
    const cwd = this.gitDir();
    // --depth on a full clone would make the user's repo shallow at the pin.
    const shallow = !this.inRepo || git(["rev-parse", "--is-shallow-repository"], { cwd }) === "true" ? ["--depth=1"] : [];
    const landing = `refs/patchbook/tmp/${process.pid}-${randomUUID()}`;
    try {
      this.onRemote(["fetch", "--quiet", "--no-tags", ...shallow, "--end-of-options", this.source(), `+${ref}:${landing}`], `git fetch ${quote(redact(this.source()))} ${ref}`, cwd);
      return git(["rev-parse", `${landing}^{commit}`], { cwd });
    } finally {
      spawn(["git", "update-ref", "-d", landing], { cwd });
    }
  }

  has(commit: string): boolean {
    return spawn(["git", "cat-file", "-e", `${commit}^{commit}`], { cwd: this.gitDir() }).code === 0;
  }

  have(commit: string): void {
    if (!this.has(commit)) this.fetch(commit);
  }

  /** Only a pin gets a ref, so a head that was only looked at stays prunable. */
  keep(commit: string): string {
    this.have(commit);
    if (!this.kept(commit)) git(["update-ref", `refs/pins/${commit}`, commit], { cwd: this.gitDir() });
    return commit;
  }

  kept(commit: string): boolean {
    const held = spawn(["git", "rev-parse", "--verify", "--quiet", `refs/pins/${commit}`], { cwd: this.gitDir() });
    return decode(held.stdout).trim() === commit;
  }

  /** Undo `keep` for a commit that did not become the pin. */
  unkeep(commit: string): void {
    spawn(["git", "update-ref", "-d", `refs/pins/${commit}`], { cwd: this.gitDir() });
  }

  /** `keep` for a pin that is read: a store that cannot take the ref still serves the read, with a warning. */
  heal(commit: string): string {
    this.have(commit);
    try {
      this.keep(commit);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      warn(`patchbook: couldn't keep ${commit.slice(0, 7)} in ${this.inRepo ? "this repo" : "the store"}, so git gc may prune it. ${e.message}\n`);
    }
    return commit;
  }

  /** `heal` for a pin the caller does not need the files of: one the store lacks is left alone, never fetched just to keep it. Says whether the store had it. */
  healIfHeld(commit: string): boolean {
    const held = this.has(commit);
    if (held) this.heal(commit);
    return held;
  }

  pastPins(): string[] {
    const log = spawn(["git", "log", "-m", "--first-parent", "-p", "-U0", "--format=", "--", `${PB}/upstream.lock`], { cwd: this.book.root });
    return log.code === 0 ? Array.from(decode(log.stdout).matchAll(/^[-+]\s*"commit": "([0-9a-f]{40})"/gm), (m) => m[1]!) : [];
  }

  mergedPastPin(): Merged[] {
    const pin = this.pin();
    if (!this.inRepo || !pin.commit || !this.has(pin.commit)) return [];
    const root = this.book.root;
    const walk = [`refs/remotes/upstream/${this.branch}`, `^${pin.commit}`, ...this.pastPins().map((c) => `^${c}`)];
    const upstream = spawn(["git", "rev-list", "--stdin", "--ignore-missing"], { cwd: root, input: encode(walk.join("\n") + "\n") });
    if (upstream.code !== 0) return [];
    const newer = new Set(decode(upstream.stdout).split("\n").filter(Boolean));
    const merging = spawn(["git", "rev-parse", "--quiet", "--verify", "MERGE_HEAD"], { cwd: root }).code === 0 ? ["MERGE_HEAD"] : [];
    const held = spawn(["git", "log", "--topo-order", "--format=%H%x09%s", "HEAD", ...merging, `^${pin.commit}`], { cwd: root });
    if (held.code !== 0) return [];
    const merged = decode(held.stdout).split("\n").filter(Boolean).map((line) => {
      const [commit = "", subject = ""] = line.split("\t");
      return { commit, subject };
    }).filter((m) => newer.has(m.commit));
    const changesNothing = merged.length > 0 && this.treeOf(merged[0]!.commit) === pin.tree;
    return changesNothing ? [] : merged;
  }

  treeOf(commit: string): string {
    return git(["rev-parse", this.path ? `${commit}:${this.path}` : `${commit}^{tree}`], { cwd: this.gitDir() });
  }

  head(): string {
    const ref = `refs/heads/${this.branch}`;
    const out = this.onRemote(["ls-remote", "--end-of-options", this.source(), ref], `git ls-remote ${quote(redact(this.source()))} ${ref}`, this.gitDir());
    if (!out) throw new Fail(`upstream ${this.name} has no branch ${this.branch}`);
    return out.split("\t", 1)[0]!;
  }

  /**
   * A repo chose the remote, as it chooses a submodule URL, so a remote that can name a helper gets git's rule for those: a helper git does not ship
   * runs only if the user allows it, with protocol.<name>.allow or protocol.allow set to always, or with GIT_ALLOW_PROTOCOL.
   * ext:: runs only through GIT_ALLOW_PROTOCOL.
   */
  private onRemote(args: string[], asTyped: string, cwd: string): string {
    const done = namesNoHelper(this.source())
      ? spawn(["git", ...args], { cwd })
      : spawn(["git", "-c", "protocol.ext.allow=never", ...args], { cwd, env: { ...process.env, GIT_PROTOCOL_FROM_USER: "0" } });
    if (done.code !== 0) throw new Fail(redact(`${asTyped} failed:\n${decodeReplace(done.stderr).trim()}`));
    return decode(done.stdout).trim();
  }

  /** Upstream's files at a commit, relative to the upstream path. */
  files(commit: string): Files {
    this.have(commit);
    const files = treeFiles(this.gitDir(), commit, this.path);
    refuseClimbingPaths(this.name, files.keys());
    return files;
  }

  /** Hash the vendored copy as git would commit it, and read its files. */
  vendorTree(vendor: string): { files: Files; tree: string } {
    const rel = relative(this.book.root, vendor);
    const { files, tree } = indexFiles(this.book.root, rel);
    return { files: new Map(Array.from(files, ([p, f]) => [p.slice(rel.length + 1), f])), tree };
  }

  /** The vendored copy's files, once the copy on disk is known to hash to the pin's tree. */
  vendoredCopy(vendor: string, pinTree: string): Files {
    const rel = relative(this.book.root, vendor);
    if (lexists(vendor) && (isSymlink(vendor) || !isDir(vendor))) {
      throw new Fail(`the vendored copy of ${this.name} (${rel}) is a ${isSymlink(vendor) ? "link" : "file"}, not a folder. Delete it, then run: patchbook sync ${this.name}.`);
    }
    const hidden = () => {
      const rule = hidingRule(this.book.root, rel);
      if (rule === null) return;
      throw new Fail(
        `${rule.source} hides the vendored copy of ${this.name} (${rel}), by the rule ${rule.pattern} at ${rule.source}:${rule.line}. `
          + `Git can't track a copy it never sees, so change that rule, or move the vendor folder of upstream ${this.name} in .patchbook/config.toml.`,
      );
    };
    let found: ReturnType<Upstream["vendorTree"]>;
    try {
      found = this.vendorTree(vendor);
    } catch (e) {
      if (e instanceof Fail) hidden();
      throw e;
    }
    if (found.tree !== pinTree) {
      if (found.files.size === 0) {
        hidden();
        throw new Fail(`the vendored copy of ${this.name} (${rel}) is empty or missing. Run: patchbook sync ${this.name}, or delete the vendor line of upstream ${this.name} in .patchbook/config.toml.`);
      }
      throw new Fail(
        `${rel} (tree ${found.tree.slice(0, 7)}) differs from the pin (tree ${pinTree.slice(0, 7)}). `
          + "Never edit the vendored copy. Record the change in the patchbook, or run sync.",
      );
    }
    return found.files;
  }

  /** Upstream's files at the pin, mounted. A vendored copy must match the pin exactly. */
  staged(): Files {
    const pin = this.pin();
    if (!pin.tree) throw new Fail(`upstream ${this.name} has no pin yet. Run: patchbook sync ${this.name}`);
    let files: Files;
    if (this.vendor) {
      files = this.vendoredCopy(this.vendor, pin.tree);
      if (pin.commit) this.healIfHeld(pin.commit);
    } else files = this.files(this.heal(pinned(this, pin)));
    return this.mounted(files);
  }
}

export type Merged = { commit: string; subject: string };

export function refuseMergedUpstream(book: Book, by: "hook" | "build"): void {
  for (const u of book.upstreams) {
    const merged = u.mergedPastPin();
    if (!merged.length) continue;
    const shown = merged.slice(0, 3).map((m) => `${m.commit.slice(0, 7)} ${m.subject}`);
    if (merged.length > shown.length) shown.push(`and ${merged.length - shown.length} more`);
    const sync = `Undo the merge, or run \`patchbook sync ${u.name}\``;
    const then = by === "hook" ? " and commit again with its changes staged, or skip the hook once with PATCHBOOK_HOOK=0."
      : " and then `patchbook build`. If that refuses over unrecorded edits to the output, `patchbook build --force` drops them.";
    throw new Fail(`${u.name} commits newer than the pin were merged in directly:\n  ${shown.join("\n  ")}\n`
      + "A merge skips the patchbook, so they would be recorded as hand edits. " + sync + then);
  }
}

/** The pin's commit, which every pin with a tree has. */
export function pinned(u: Upstream, pin: Pin): string {
  if (!pin.commit) throw new Fail(`upstream ${u.name}'s pin in upstream.lock has no commit`);
  return pin.commit;
}

function treeEntries(gd: string, tree: string, path: string): { rel: string; mode: Mode; oid: string }[] {
  const args = ["ls-tree", "-r", "-z", "--full-tree", tree, ...(path ? ["--", path] : [])];
  const entries: { rel: string; mode: Mode; oid: string }[] = [];
  for (const item of decode(run(["git", "--literal-pathspecs", ...args], { cwd: gd })).split("\0")) {
    if (!item) continue;
    const tab = item.indexOf("\t");
    const [mode = "", kind, oid = ""] = item.slice(0, tab).split(" ");
    const found = item.slice(tab + 1);
    if (kind !== "blob") continue; // submodules are not copied
    entries.push({ rel: path ? found.slice(path.length + 1) : found, mode: normMode(parseInt(mode, 8)), oid });
  }
  return entries;
}

function readEntries(gd: string, entries: { rel: string; mode: Mode; oid: string }[]): Files {
  const blobs = readBlobs(gd, entries.map((e) => e.oid));
  return new Map(entries.map(({ rel, mode, oid }) => [rel, { data: blobs.get(oid)!, mode }]));
}

export function treeFiles(gd: string, tree: string, path: string): Files {
  return readEntries(gd, treeEntries(gd, tree, path));
}

class TreeBlob {
  bytes: Uint8Array | undefined;
  constructor(readonly gd: string, readonly oid: string, readonly mode: Mode) {}

  get data(): Uint8Array {
    return (this.bytes ??= readBlobs(this.gd, [this.oid]).get(this.oid)!);
  }
}

/** Like `treeFiles`, but reads bytes on demand and keeps git's ids, when they are the SHA-1 `blobOid` gives. */
export function treeBlobs(gd: string, tree: string, path: string): Files {
  const entries = treeEntries(gd, tree, path);
  if (entries.some((e) => e.oid.length !== 40)) return readEntries(gd, entries);
  return new Map(entries.map(({ rel, mode, oid }) => [rel, new TreeBlob(gd, oid, mode)]));
}

export function readBlobsOf(files: Iterable<File>): void {
  const unread = Array.from(files).filter((f): f is TreeBlob => f instanceof TreeBlob && f.bytes === undefined);
  for (const [gd, group] of Map.groupBy(unread, (f) => f.gd)) {
    const blobs = readBlobs(gd, group.map((f) => f.oid));
    for (const f of group) f.bytes = blobs.get(f.oid)!;
  }
}

export function readBlobs(gd: string, oids: string[]): Map<string, Uint8Array> {
  const blobs = new Map<string, Uint8Array>();
  if (oids.length === 0) return blobs;
  const out = run(["git", "cat-file", "--batch"], { cwd: gd, input: encode(oids.join("\n") + "\n") });
  let i = 0;
  for (const oid of oids) {
    const nl = out.indexOf(10, i);
    const header = decode(out.subarray(i, nl));
    const size = Number(header.split(" ")[2]);
    if (nl === -1 || !Number.isInteger(size)) throw new Error(`git cat-file --batch said: ${header}`);
    blobs.set(oid, out.subarray(nl + 1, nl + 1 + size));
    i = nl + 1 + size + 1;
  }
  return blobs;
}

/** What git would commit under rel, and its tree id. */
export function indexFiles(root: string, rel: string): { files: Files; tree: string } {
  const tmp = mkdtempSync(join(tmpdir(), "tmp"));
  let tree: string;
  let staged: string;
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
    git(["read-tree", "--empty"], { cwd: root, env });
    if (lexists(join(root, rel))) git(["add", "--", rel], { cwd: root, env });
    staged = git(["ls-files", "-s", "-z", "--", rel], { cwd: root, env });
    tree = git(staged ? ["write-tree", `--prefix=${rel}/`] : ["write-tree"], { cwd: root, env });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const files: Files = new Map();
  for (const item of staged.split("\0")) {
    if (!item) continue;
    const tab = item.indexOf("\t");
    const path = item.slice(tab + 1);
    const mode = parseInt(item.slice(0, item.indexOf(" ")), 8);
    files.set(path, { data: readDisk(join(root, path)).data, mode: normMode(mode) });
  }
  return { files, tree };
}

/** The ignore rule that hides every file under rel from git, if one does. */
function hidingRule(root: string, rel: string): { source: string; line: string; pattern: string } | null {
  const tmp = mkdtempSync(join(tmpdir(), "tmp"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
    const files = (flags: string[]) => decode(run(["git", "ls-files", "-o", ...flags, "--exclude-standard", "-z", "--", rel], { cwd: root, env })).split("\0")[0];
    const hidden = files(["-i"]);
    if (!hidden || files([])) return null;
    // Not git(): check-ignore refuses the literal pathspec magic git() sets, and it reads hidden as a path, not a pattern.
    const found = /^(.+):(\d+):(.*)\t/.exec(decode(run(["git", "check-ignore", "-v", "--no-index", "--", hidden], { cwd: root, check: false })));
    return found ? { source: found[1]!, line: found[2]!, pattern: found[3]! } : null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The tree git has staged under the folder rel, which is the empty tree when it holds nothing there. Null when the index holds a file at rel itself, which no tree matches. */
export function stagedTree(root: string, rel: string): string | null {
  const tmp = mkdtempSync(join(tmpdir(), "tmp"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
    const entries = run(["git", "--literal-pathspecs", "ls-files", "-s", "-z", "--", rel], { cwd: root });
    if (decode(entries).split("\0").some((item) => item.slice(item.indexOf("\t") + 1) === rel)) return null;
    git(["read-tree", "--empty"], { cwd: root, env });
    if (entries.length) run(["git", "update-index", "-z", "--index-info"], { cwd: root, env, input: entries });
    return git(entries.length ? ["write-tree", `--prefix=${rel}/`] : ["write-tree"], { cwd: root, env });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Read an upstream at its pin, from the store: list its files, print one, export them, or diff the last sync. */
export async function cmdUpstream(args: { name: string; path: string | null; diff: boolean; since: string | null; export: string | null }) {
  const book = await Book.find();
  const u = book.upstream(args.name);
  const pin = u.pin();
  if (!pin.tree) throw new Fail(`upstream ${u.name} has no pin yet. Run: patchbook sync ${u.name}`);
  const commit = u.heal(pinned(u, pin));
  if (args.diff || args.since) {
    const old = args.since || readLastSync(book)?.upstreams.find((r) => r.name === u.name)?.from || "";
    if (!old) throw new Fail(`no earlier pin of ${u.name} to compare with; pass --since <commit>`);
    if (args.since) u.have(old);
    else u.heal(old);
    const where = [u.path, args.path].filter((p) => p).join("/");
    const rel = u.path ? [`--relative=${u.path}/`] : [];
    const diff = run(["git", "diff", "--no-color", ...rel, old, commit, "--", ...(where ? [where] : [])], { cwd: u.gitDir() });
    verbatim(decodeReplace(diff));
    return 0;
  }
  const files = u.files(commit);
  if (args.export) {
    const dest = resolve(args.export);
    refuseExportedGit(u.name, dest, files.keys());
    if (lexists(dest) && !(isDir(dest) && readdirSync(dest).length === 0)) throw new Fail(`can't export upstream ${u.name} into ${dest}, which already exists and isn't empty. Name a new or empty folder. Nothing was changed.`);
    for (const [path, file] of files) writeDisk(join(dest, path), file);
    say(`wrote ${files.size} files of ${u.name} at ${commit.slice(0, 7)} to ${dest}\n`);
    return 0;
  }
  if (args.path) {
    const file = files.get(args.path);
    if (!file) throw new Fail(`${u.name} has no ${args.path} at ${commit.slice(0, 7)}`);
    verbatim(file.data);
    return 0;
  }
  say([...files.keys()].sort(byCodePoint).join("\n") + "\n");
  return 0;
}
