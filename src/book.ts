// The repo, its config and its upstreams.
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Hooks, Problem, UpstreamLock, UpstreamPin } from "./api.ts";
import { Fail } from "./lib/fail.ts";
import {
  exists, type File, GITLINK, isDir, isMode, isSymlink, lexists, LINK, mkdirs, type Mode, normMode, parseGitMode, pjoin, readDisk, readText, relative, resolve,
  rglob, type Seen, writeText,
} from "./lib/fs.ts";
import { similarity } from "./lib/match.ts";
import { git, run, spawn } from "./lib/proc.ts";
import { jsonText, named, object, oid, readJson, type Shape, string, versioned } from "./lib/shape.ts";
import { warn } from "./lib/term.ts";
import { byCodePoint, decode, quote } from "./lib/text.ts";
import { isTable, parseToml, type Table } from "./settings.ts";
import { stagedFolder, treeBlobs, Upstream } from "./store.ts";

export const PB = ".patchbook";

export class NoBook extends Fail {}
export const GIT = ".git";

const placeholderFiles = (book: Book) =>
  Array.from(book.placeholders.values(), (s) => s.file).filter((f) => f !== null).map((f) => pjoin(book.root, f));
const inOutput = (book: Book, f: string) => under(f, book.outputRoot()) && !book.isReserved(relative(book.outputRoot(), f));

/** A placeholder file in the output is output, so it isn't listed here but in `placeholderOutputs`. */
export function buildInputs(book: Book): string[] {
  return [
    ...["blocks", "changes", "series", "build.lock", "config.toml", "upstream.lock", "hooks.ts"].map((p) => `${PB}/${p}`),
    ...placeholderFiles(book).filter((f) => under(f, book.root) && f !== book.root && !inOutput(book, f)).map((f) => relative(book.root, f)),
  ];
}

/** Placeholder files in the output, relative to it. The build reads their working copies. */
export function placeholderOutputs(book: Book): string[] {
  return placeholderFiles(book).filter((f) => f !== book.outputRoot() && inOutput(book, f)).map((f) => relative(book.outputRoot(), f));
}

export function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

const underOrRoot = (path: string, folder: string) => folder === "" || under(path, folder);
const joinPath = (...parts: string[]) => parts.filter(Boolean).join("/");
const shown = (folder: string) => folder || "the repo root";
/** Code points HFS+ ignores in a name, so `.g\u200cit` is `.git` on a Mac (`next_hfs_char` in git's utf8.c). */
const HFS_IGNORED = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
/** git's `is_hfs_dotgit`, which stops reading at U+FFFE or U+FFFF. */
const hfsDotGit = (segment: string) => /^\.git(?:$|[\ufffe\uffff])/i.test(segment.replace(HFS_IGNORED, ""));
/** What Windows ignores after a name: trailing dots and spaces, then an alternate stream. */
const NTFS_TAIL = "[. ]*(?::|$)";
/** git's `is_ntfs_dotgit`, applied after each backslash as fsck does. */
const NTFS_DOT_GIT = new RegExp(`^(?:\\.git|git~1)${NTFS_TAIL}`, "i");
const ntfsDotGit = (segment: string) => segment.split("\\").some((part) => NTFS_DOT_GIT.test(part));
const NTFS_DOT_PATCHBOOK = new RegExp(`^\\.patchbook${NTFS_TAIL}`, "iu");
/** Whether `path` is `.patchbook` or under it, in a spelling Windows or a Mac reads as the same folder. */
const inPatchbook = (path: string) => NTFS_DOT_PATCHBOOK.test(path.split("/")[0]!.split("\\")[0]!);
export function refuseFoldedUpstream(paths: Iterable<string>): void {
  const folded = Array.from(paths).find((p) => inPatchbook(p) && !under(p, PB));
  if (folded !== undefined) {
    throw new Fail(`upstream has ${folded}, which is ${PB} on macOS and Windows. patchbook can't fork an upstream with a folder that is ${PB} on macOS and Windows.`);
  }
}
/** Whether a part of path is a name git reads as `.git`. git's fsck warns `hasDotgit` on each one on every platform, and git refuses to stage most of them. */
const namesGit = (path: string) => path.split("/").some((segment) => hfsDotGit(segment) || ntfsDotGit(segment));

const leftOut = new Map<string, Set<string>>();

export function noticeLeftOut(): void {
  if (leftOut.size === 0) return;
  const total = Array.from(leftOut.values()).reduce((n, paths) => n + paths.size, 0);
  const folders = [...leftOut].sort(([a], [b]) => byCodePoint(a, b)).map(([folder, paths]) => `${folder} (${paths.size})`).join(", ");
  leftOut.clear();
  warn(`patchbook: left ${total} upstream files out of the build because they would land in a vendored copy: ${folders}.\n`);
}

const HOOKS = ["placeholder", "blockTerms", "finish", "check"] as const;
type HookName = (typeof HOOKS)[number];

function isHookName(name: string): name is HookName {
  return HOOKS.some((h) => h === name);
}

function hookFail(path: string, what: string): Fail {
  return new Fail(`${path}: ${what}`);
}

function suggest(name: string): string {
  const scored = HOOKS.map((h) => [similarity(name, h), h] as const).sort((x, y) => y[0] - x[0]);
  const [score, best] = scored[0]!;
  return score >= 0.6 ? `; did you mean \`${best}\`?` : `. The hooks are ${HOOKS.join(", ")}.`;
}

/** Load hooks.ts, checking each export is a hook, and what each hook returns. */
async function loadHooks(dir: string): Promise<Hooks> {
  const path = join(dir, "hooks.ts");
  if (!exists(path)) {
    if (exists(join(dir, "hooks.py"))) {
      throw new Fail(`${PB}/hooks.py is Python, and patchbook now runs ${PB}/hooks.ts instead. Port it: the hooks keep their names, except block_terms, which becomes blockTerms.`);
    }
    return {};
  }
  const module: unknown = await import(pathToFileURL(path).href);
  const hooks: Hooks = {};
  if (typeof module !== "object" || module === null) return hooks;
  for (const [name, fn] of Object.entries(module)) {
    if (!isHookName(name)) throw hookFail(path, `${quote(name)} isn't a hook${suggest(name)}`);
    if (typeof fn !== "function") throw hookFail(path, `\`${name}\` must be a function`);
    const call = (...args: unknown[]): unknown => fn(...args);
    switch (name) {
      case "placeholder":
        hooks.placeholder = (kind, key) => {
          const value = call(kind, key);
          if (value === null || value === undefined || typeof value === "string") return value;
          throw hookFail(path, `placeholder(${quote(kind)}, ${quote(key)}) returned ${typeof value}, not a string`);
        };
        break;
      case "blockTerms":
        hooks.blockTerms = (file, block, outputs) => {
          const found = call(file, block, outputs);
          const terms = isIterable(found) ? Array.from(found) : null;
          if (terms === null || !terms.every((t) => typeof t === "string")) throw hookFail(path, "blockTerms must return strings");
          return terms;
        };
        break;
      case "finish":
        hooks.finish = (out) => {
          call(out);
          for (const [p, f] of out) {
            if (!(f.data instanceof Uint8Array) || !isMode(f.mode)) {
              throw hookFail(path, `finish left ${p} without bytes and a mode of 0o644, 0o755 or 0o120000`);
            }
          }
        };
        break;
      case "check":
        hooks.check = (outputs) => {
          const found = call(outputs);
          if (!isIterable(found)) throw hookFail(path, "check must return a list of problems");
          return Array.from(found, (p) => {
            if (isProblem(p)) return p;
            throw hookFail(path, `check returned ${quote(p)}, not a problem like { problem: "check", file, detail }`);
          });
        };
        break;
      default: {
        const _exhaustive: never = name;
        return _exhaustive;
      }
    }
  }
  return hooks;
}

/** Strings count: Python iterated one into its characters. */
function isIterable(value: unknown): value is Iterable<unknown> {
  return typeof value === "string" || (typeof value === "object" && value !== null && Symbol.iterator in value);
}

/** Only the `problem` kind is checked. The rest of the fields are the hook's to get right, as in Python. */
function isProblem(value: unknown): value is Problem {
  return isTable(value) && typeof value["problem"] === "string";
}

/** A `[[check]]`: the output files it covers and the pattern a block mustn't match without an entry. */
export type Check = { files: RegExp[]; exclude: RegExp[]; pattern: RegExp };
export type Placeholder = { file: string | null; format: string };
export type Reserved = { place: string; refuse: boolean };
export type Layout = { kind: "fork" } | { kind: "folder"; from: string; dir: string };
/** Where the output is read from: the index the commit hook sees, or the working tree as `git add -A` would stage it. */
export type OutputSource = "index" | "disk";

/** How `path` spells the repo root: its outermost ancestor that resolves into the repo, or null when that one is a link into a folder of the repo. */
function repoAsSpelled(realRoot: string, path: string): string | null {
  let outermost = path;
  for (let up = path; ; up = dirname(up)) {
    if (!under(relative(realRoot, resolve(up)), "..")) outermost = up;
    if (up === dirname(up)) break;
  }
  return resolve(outermost) === realRoot ? outermost : null;
}

/** The repo-relative folder `to` names once links above the repo are resolved, after the checks that keep a build inside it. */
function checkOutputIsSafeToWipe(root: string, to: string, vendors: readonly string[]): string {
  const dir = pjoin(root, to);
  const rel = relative(resolve(root), resolve(dir));
  const shown = quote(to);
  if (rel === ".") throw new Fail(`[output] to ${shown} is the repo root. Name a folder inside the repo.`);
  if (under(rel, "..")) throw new Fail(`[output] to ${shown} is outside the repo. Name a folder inside it.`);
  if (inPatchbook(rel)) throw new Fail(`[output] to ${shown} is inside ${PB}. patchbook never builds into ${PB}, so those files would never land. Change [output] to.`);
  if (lexists(dir) && !exists(dir)) throw new Fail(`[output] to ${shown} is a link to nothing. Name a folder inside the repo.`);
  if (isSymlink(dir)) throw new Fail(`[output] to ${shown} is a link, and a build would replace it with a folder. Name the folder it points to.`);
  if (exists(dir) && !isDir(dir)) throw new Fail(`[output] to ${shown} is not a folder. Name a folder inside the repo.`);
  const repo = repoAsSpelled(resolve(root), dirname(dir));
  for (let up = dirname(dir); up !== repo && up !== dirname(up); up = dirname(up)) {
    const name = repo === null ? up : relative(repo, up);
    if (lexists(up) && !exists(up)) throw new Fail(`[output] to ${shown} is under ${name}, which is a link to nothing. Name a folder inside the repo.`);
    if (isSymlink(up)) throw new Fail(`[output] to ${shown} is under ${name}, which is a link. Name a folder that is not behind a link.`);
    if (exists(up) && !isDir(up)) throw new Fail(`[output] to ${shown} is under ${name}, which is not a folder. Name a folder inside the repo.`);
  }
  for (const v of vendors) {
    const vendor = relative(resolve(root), resolve(pjoin(root, v)));
    if (vendor === ".") throw new Fail(`[output] to ${shown} overlaps the vendored copy, which is the repo root. Name another folder.`);
    if (under(rel, vendor)) throw new Fail(`[output] to ${shown} overlaps the vendored copy ${vendor}. Name another folder.`);
  }
  return rel;
}

/** Whether one name, not a path, is a name git reads as `.git`. */
export const segmentNamesGit = (segment: string): boolean => hfsDotGit(segment) || ntfsDotGit(segment);

/** Why a sync must never replace `vendor` (an absolute path), or null. Links above it are resolved, but not the last name: a sync moves or deletes a link there, never what it points to. */
export function unsafeVendor(root: string, vendor: string): string | null {
  const rel = relative(resolve(root), join(resolve(dirname(vendor)), basename(vendor)));
  if (rel === ".") return "is the repo root";
  if (under(rel, "..")) return "is outside the repo";
  if (under(rel.toLowerCase(), PB)) return `is inside ${PB}`;
  if (rel.split("/").some(segmentNamesGit)) return `is inside ${GIT}`;
  // resolve() keeps a link that leads nowhere as a plain name, so the copy would look like it stays in the repo.
  const repo = repoAsSpelled(resolve(root), dirname(vendor));
  for (let up = dirname(vendor); up !== repo && up !== dirname(up); up = dirname(up)) {
    if (lexists(up) && !exists(up)) return `is under ${repo === null ? up : relative(repo, up)}, which is a link to nothing`;
  }
  return null;
}

/** What a walk of the vendored copy stopped at: a `.git`, or a folder it couldn't list and so couldn't clear. Paths are inside `dir`, "" for `dir` itself. */
type Stop = { kind: "git" | "unreadable"; path: string };

/** The first `.git` in any letter case in `dir`, or the first folder that can't be listed. Links are not followed. A folder that is missing, or not a folder, holds nothing. */
function findGit(dir: string): Stop | null {
  if (isSymlink(dir)) return null;
  const todo = [""];
  for (let here = todo.pop(); here !== undefined; here = todo.pop()) {
    let entries;
    try {
      entries = readdirSync(join(dir, here), { withFileTypes: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return { kind: "unreadable", path: here };
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const hit = entries.find((e) => segmentNamesGit(e.name));
    if (hit) return { kind: "git", path: joinPath(here, hit.name) };
    for (const e of entries.reverse()) if (e.isDirectory()) todo.push(joinPath(here, e.name));
  }
  return null;
}

/**
 * A `.git` inside the vendored copy is the user's: syncUpstream refuses an upstream tree that holds one (git mktree can store it), and a sync would move this one away and delete it.
 * A folder the walk can't read might hold one, so it refuses too. `journal` is set when the copy is a killed sync's, which finishing would delete.
 * `copy` is where to look when the vendored copy has been moved aside. The message still names `vendor`.
 */
export function refuseNestedGit(root: string, name: string, vendor: string, journal?: string, copy = vendor): void {
  const stop = findGit(copy);
  if (stop === null) return;
  const folder = relative(root, vendor);
  const at = joinPath(folder, stop.path);
  const stalled = journal ? `${journal} holds a sync of ${name} that stopped partway, and the vendored copy (${folder})` : `the vendored copy of ${name} (${folder})`;
  if (stop.kind === "unreadable") {
    const then = journal
      ? `Finishing the sync would delete one. Make it readable, then sync again. The sync stays where it is until then.`
      : `Every sync replaces the copy and would delete one. Make it readable, move it out of the folder, or change vendor for ${name}.`;
    throw new Fail(`${stalled} can't be searched for a git repo of your own, since patchbook can't read ${at}. ${then}`);
  }
  const then = journal
    ? "Finishing the sync would delete it. Move it out of the folder, then sync again. The sync stays where it is until then."
    : `Every sync replaces the copy and would delete it. Move it out of the folder, or change vendor for ${name}.`;
  throw new Fail(`${stalled} holds ${at}, a git repo of its own. ${then}`);
}

function refuseGit(name: string, files: Iterable<string>, then: string): void {
  for (const p of files) {
    if (p.split("/").some(segmentNamesGit)) throw new Fail(`upstream ${name} holds ${p}, which git reads as ${GIT}, ${then} Nothing was changed.`);
  }
}

/** Refuses an upstream tree path with a part of `..`, `.` or nothing: `git mktree` can store one, and joined onto a folder it lands outside it. Runs where an upstream's tree is read, before any write. */
export function refuseClimbingPaths(name: string, files: Iterable<string>): void {
  for (const p of files) {
    const part = p.split("/").find((s) => s === ".." || s === "." || s === "");
    if (part !== undefined) throw new Fail(`upstream ${name} holds ${p}, which has a part named ${quote(part)}, so a write could land outside the folder it belongs in. Nothing was changed.`);
  }
}

/** Refuses an upstream whose files hold a name git reads as `.git`: the copy would hold a repo of its own, and no sync could finish over it. Runs before the journal and any write. */
export function refuseUpstreamGit(name: string, vendor: string, files: Iterable<string>): void {
  refuseGit(name, files, `so it can't be vendored into ${vendor}.`);
}

/** Refuses an upstream whose files hold a name git reads as `.git`: an export would write a repo config the upstream controls into `dest`. Runs before any write. */
export function refuseExportedGit(name: string, dest: string, files: Iterable<string>): void {
  refuseGit(name, files, `so it can't be exported into ${dest}.`);
}

/** Refuses a staged path of upstream `u` that holds a name git reads as `.git`: the build would write a repo config the upstream controls into the user's tree. */
function refuseBuiltGit(u: Upstream, staged: string): void {
  refuseGit(u.name, [u.mount ? staged.slice(u.mount.length + 1) : staged], "so a build would put a git repo of its own in your tree.");
}

/** patchbook reads and writes through whatever sits at these paths, so a link takes that out of the repo, or to another part of
 * the patchbook, while a review of the patchbook shows only the link. */
function refuseLinked(root: string, links: string[], hint = ""): void {
  if (links.length) {
    throw new Fail(links.map((p) => `${relative(root, p)} is a link`).join(", ")
      + `. patchbook reads and writes the patchbook through it, so replace the link with a copy of what it points to${hint}.`);
  }
}


/** `**` matches any number of folders, `*` and `?` stay within one. */
export function globRe(pattern: string): RegExp {
  const chars = Array.from(pattern);
  let out = "";
  for (let i = 0; i < chars.length; ) {
    const ahead = chars.slice(i, i + 3).join("");
    if (ahead === "**/") [out, i] = [out + "(?:[^\\n]*/)?", i + 3];
    else if (ahead.startsWith("**")) [out, i] = [out + "[^\\n]*", i + 2];
    else if (chars[i] === "*") [out, i] = [out + "[^/]*", i + 1];
    else if (chars[i] === "?") [out, i] = [out + "[^/]", i + 1];
    else [out, i] = [out + escape(chars[i]!), i + 1];
  }
  return new RegExp(`^(?:${out})$`, "u");
}

/** Escape regex syntax characters, and only those, so the result also compiles under the u flag. */
export const escape = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

function strings(value: unknown, what: string): string[] {
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
  throw new Fail(`config.toml: ${what} is a list of strings`);
}

function text(table: Table, key: string, fallback: string, what: string): string {
  const value = Object.hasOwn(table, key) ? table[key] : fallback;
  if (typeof value !== "string") throw new Fail(`config.toml: ${what} is a string`);
  return value;
}

const LOCK: Shape<UpstreamLock> = versioned(1, { upstreams: named(object({ name: string, commit: oid, tree: oid })) });
const LOCK_FIX = 'It holds {"version": 1, "upstreams": [{"name": ..., "commit": ..., "tree": ...}]}, one entry per upstream, sorted by name.';

export function parseLock(text: string): UpstreamPin[] {
  return readJson(text, LOCK, `${PB}/upstream.lock`, LOCK_FIX).upstreams;
}

export function lockText(pins: readonly UpstreamPin[]): string {
  return jsonText(LOCK({ version: 1, upstreams: pins.toSorted((a, b) => byCodePoint(a.name, b.name)) }, ""));
}

export class Book {
  readonly dir: string;
  readonly config: Table;
  readonly layout: Layout;
  readonly upstreams: Upstream[];
  readonly checks: Check[] = [];
  /** `[[check]]` patterns that don't compile, reported by every build and status. */
  readonly badChecks: Problem[] = [];
  readonly placeholders = new Map<string, Placeholder>();
  hooks: Hooks = {};
  private fileMode: boolean | undefined;
  private linksRefused = false;

  private constructor(readonly root: string, config: string) {
    this.dir = join(root, PB);
    this.config = parseToml(config, join(this.dir, "config.toml"));
    const kind = Object.hasOwn(this.config, "layout") ? this.config["layout"] : "fork";
    if (kind !== "folder" && kind !== "fork") {
      throw new Fail(`layout must be folder or fork, not ${quote(kind)}`);
    }
    const raw = this.config["upstream"];
    if (isTable(raw)) throw new Fail("config.toml has a single [upstream] table. Use [[upstream]] with a name instead.");
    if (!Array.isArray(raw) || raw.length === 0) throw new Fail("config.toml has no [[upstream]]");
    this.upstreams = raw.map((spec) => {
      if (!isTable(spec)) throw new Fail("config.toml: each [[upstream]] is a table");
      return new Upstream(this, spec);
    });
    if (kind === "folder") {
      const out = Object.hasOwn(this.config, "output") ? this.config["output"] : {};
      if (!isTable(out) || !Object.hasOwn(out, "to")) throw new Fail("a folder layout needs [output] with to = <folder>");
      const from = stagedFolder(text(out, "from", "", "[output] from"), "[output] from");
      const to = text(out, "to", "", "[output] to");
      this.layout = { kind, from, dir: pjoin(root, checkOutputIsSafeToWipe(root, to, this.vendors())) };
    } else this.layout = { kind };
    this.checkMounts();
    this.readChecks();
    this.readPlaceholders();
  }

  static async fromText(root: string, config: string): Promise<Book> {
    refuseLinked(root, [join(root, PB)].filter(isSymlink));
    const book = new Book(root, config);
    book.hooks = await loadHooks(book.dir);
    return book;
  }

  static async open(root: string): Promise<Book> {
    return Book.fromText(root, readText(join(root, PB, "config.toml")));
  }

  /** The folder with the nearest `.patchbook/config.toml`, here or above, without loading it. */
  static root(start?: string): string | null {
    for (let d = resolve(start ?? process.cwd()); ; d = join(d, "..")) {
      if (exists(join(d, PB, "config.toml"))) return d;
      if (d === "/") return null;
    }
  }

  static async find(start?: string): Promise<Book> {
    const root = Book.root(start);
    if (root === null) throw new NoBook(`no ${PB}/config.toml here or above. Start one with \`patchbook clone\` or \`patchbook init\`.`);
    return Book.open(root);
  }

  /** A path in what patchbook records: `blocks/`, `changes/`, `series` and `build.lock`. The first call refuses links there, and every call
   * refuses a link in a folder above the path, so a name from a journal can't lead out of the repo. The last part may be a link, since
   * writing it replaces it. */
  data(...parts: string[]): string {
    if (!this.linksRefused) this.refuseLinks();
    const path = join(this.dir, ...parts);
    const above = relative(this.dir, dirname(path)).split("/").filter(Boolean);
    refuseLinked(this.root, above.map((_, i) => join(this.dir, ...above.slice(0, i + 1))).filter(isSymlink));
    return path;
  }

  /** Before the first path in them is read or written, since a record writes paths no read reached, such as a new change. A recorded
   * symlink is the one link allowed: a `.pb` copy in a change's `base` or `ours`, which the record replaces, and which no copy sits under
   * (`Change.content`). */
  refuseLinks(hint = ""): void {
    const at = (name: string) => join(this.dir, name);
    const inside = (dir: string) => (isSymlink(dir) ? [] : rglob(dir, "").map((p) => join(dir, p)));
    const recorded = (p: string) => {
      const [, side, ...path] = relative(at("changes"), p).split("/");
      return (side === "base" || side === "ours") && path.length > 0 && p.endsWith(".pb");
    };
    const linked = [
      ...["blocks", "changes", "series", "build.lock"].map(at),
      ...inside(at("blocks")),
      ...inside(at("changes")).filter((p) => !recorded(p)),
    ].filter(isSymlink);
    refuseLinked(this.root, linked, hint);
    this.linksRefused = true;
  }

  /** `init`, `sync`, `track` and `config --project` write these through a link, so they call this before they write anything. */
  refuseLinkedTop(): void {
    const journals = isDir(this.dir) ? readdirSync(this.dir).filter((name) => name.startsWith("sync-")) : [];
    const top = ["config.toml", "upstream.lock", "last-sync.json", "retired.md", ...journals];
    refuseLinked(this.root, top.map((name) => join(this.dir, name)).filter(isSymlink));
  }

  private checkMounts(): void {
    const names = this.upstreams.map((u) => u.name);
    if (new Set(names).size !== names.length) throw new Fail("two upstreams share a name");
    const roots = this.upstreams.filter((u) => !u.mount);
    if (roots.length > 1) throw new Fail("only one upstream can mount at the root");
    if (this.layout.kind === "fork" && roots.length === 0) throw new Fail('a fork needs its own upstream mounted at the root (mount = "")');
    for (const a of this.upstreams) {
      for (const b of this.upstreams) {
        if (a !== b && a.mount && under(b.mount, a.mount)) throw new Fail(`upstreams ${a.name} and ${b.name} mount at overlapping folders`);
      }
    }
    for (const u of this.upstreams) {
      const out = this.outputFolder(u);
      const own = out === null ? undefined : inPatchbook(out) ? PB : namesGit(out) ? GIT : undefined;
      if (own) {
        const where = this.layout.kind === "fork" ? `mounts at ${shown(u.mount)}` : `builds into ${shown(out ?? "")}`;
        throw new Fail(`${u.name} ${where}, inside ${own}. patchbook never builds into ${own}, so those files would never land. Change ${this.outputKnob(u)}.`);
      }
    }
    this.checkVendors();
  }

  private checkVendors(): void {
    for (const a of this.upstreams) {
      if (!a.vendor) continue;
      const vendored = this.folderOf(a.vendor);
      const unsafe = unsafeVendor(this.root, a.vendor);
      if (unsafe) {
        throw new Fail(`the vendored copy of ${a.name} (${vendored || "."}) ${unsafe}. Every sync replaces it. Change vendor for ${a.name} to a folder inside the repo, other than ${PB} and ${GIT}.`);
      }
      const written = "A build writes there, but a vendored copy must match upstream exactly.";
      const own = this.outputFolder(a);
      if (own !== null && (underOrRoot(own, vendored) || underOrRoot(vendored, own))) {
        const change = this.layout.kind === "fork" ? `${a.mount ? "vendor or mount" : "vendor"} for ${a.name}` : `vendor for ${a.name} or [output] to`;
        throw new Fail(
          `the vendored copy of ${a.name} (${shown(vendored)}) overlaps the folder ${a.name} builds into (${shown(own)}). ${written} Change ${change}.`,
        );
      }
      for (const b of this.upstreams.slice(0, this.upstreams.indexOf(a))) {
        const other = b.vendor ? this.folderOf(b.vendor) : null;
        if (other !== null && (underOrRoot(other, vendored) || underOrRoot(vendored, other))) {
          throw new Fail(
            `the vendored copy of ${a.name} (${shown(vendored)}) overlaps the vendored copy of ${b.name} (${shown(other)}). The outer copy would hold the inner one's files, and a vendored copy must match upstream exactly. Change vendor for ${b.name} or ${a.name}.`,
          );
        }
      }
      for (const b of this.upstreams) {
        const out = a === b ? null : this.outputFolder(b);
        if (out !== null && underOrRoot(out, vendored)) {
          throw new Fail(
            `the vendored copy of ${a.name} (${shown(vendored)}) contains the folder ${b.name} builds into (${shown(out)}). ${written} Change vendor for ${a.name} or ${this.outputKnob(b)}.`,
          );
        }
      }
    }
  }

  private folderOf(path: string): string {
    const rel = relative(this.root, path);
    return rel === "." ? "" : rel;
  }

  /** What the user can change to move the output folder: in the folder layout `init` has no mount, so it is `[output] to`. */
  private outputKnob(u: Upstream): string {
    return this.layout.kind === "fork" ? `mount for ${u.name}` : "[output] to";
  }

  private outputFolder(u: Upstream): string | null {
    if (this.layout.kind === "fork") return u.mount;
    const { from, dir } = this.layout;
    const to = this.folderOf(dir);
    if (!from || under(u.mount, from)) return joinPath(to, from ? u.mount.slice(from.length + 1) : u.mount);
    return underOrRoot(from, u.mount) ? to : null;
  }

  private inRepo(outputPath: string): string {
    return this.layout.kind === "folder" ? joinPath(this.folderOf(this.layout.dir), outputPath) : outputPath;
  }

  private heldBy(outputPath: string): string | null {
    const inRepo = this.inRepo(outputPath);
    return this.vendors().find((v) => underOrRoot(inRepo, v)) ?? null;
  }

  private outputOf(staged: string): string | null {
    if (this.layout.kind === "fork") return staged;
    const { from } = this.layout;
    if (from && !staged.startsWith(from + "/")) return null;
    return from ? staged.slice(from.length + 1) : staged;
  }

  vendorHolding(staged: string): string | null {
    const output = this.outputOf(staged);
    return output === null ? null : this.heldBy(output);
  }

  /** Where an output path can't be written. A vendored copy is skipped with a warning, `.patchbook` and `.git` are refused. */
  reservedOutput(output: string): Reserved | null {
    const vendored = this.heldBy(output);
    if (vendored !== null) return { place: `the vendored copy ${vendored}`, refuse: false };
    const inRepo = this.inRepo(output);
    return inPatchbook(inRepo) ? { place: PB, refuse: true } : namesGit(inRepo) ? { place: GIT, refuse: true } : null;
  }

  reservedHolding(staged: string): Reserved | null {
    const output = this.outputOf(staged);
    return output === null ? null : this.reservedOutput(output);
  }

  vendors(): string[] {
    return this.upstreams.flatMap((u) => (u.vendor ? [this.folderOf(u.vendor)] : []));
  }

  private readChecks(): void {
    const checks = Object.hasOwn(this.config, "check") ? this.config["check"] : [];
    if (!Array.isArray(checks)) throw new Fail("config.toml: check is a list of [[check]] tables");
    for (const c of checks) {
      if (!isTable(c) || typeof c["pattern"] !== "string") throw new Fail("config.toml: each [[check]] needs a pattern");
      const files = strings(Object.hasOwn(c, "files") ? c["files"] : ["**"], "a check's files").map(globRe);
      const exclude = strings(Object.hasOwn(c, "exclude") ? c["exclude"] : [], "a check's exclude").map(globRe);
      try {
        this.checks.push({ files, exclude, pattern: new RegExp(c["pattern"], "gu") });
      } catch (e) {
        const name = typeof c["name"] === "string" ? c["name"] : c["pattern"];
        this.badChecks.push({ problem: "invalid", file: "config.toml", detail: `check ${name}: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }

  private readPlaceholders(): void {
    const sources = Object.hasOwn(this.config, "placeholders") ? this.config["placeholders"] : {};
    if (!isTable(sources)) throw new Fail("config.toml: placeholders is a table of [placeholders.<kind>]");
    for (const [kind, spec] of Object.entries(sources)) {
      if (!isTable(spec)) throw new Fail(`config.toml: [placeholders.${kind}] is a table`);
      const file = Object.hasOwn(spec, "file") ? text(spec, "file", "", `[placeholders.${kind}] file`) : null;
      if (file !== null && under(relative(resolve(this.root), resolve(pjoin(this.root, file))), "..")) {
        throw new Fail(`[placeholders.${kind}] file ${quote(file)} is outside the repo. Name a file inside it.`);
      }
      this.placeholders.set(kind, { file, format: text(spec, "format", "json", `[placeholders.${kind}] format`) });
    }
  }

  upstream(name: string): Upstream {
    const found = this.upstreams.find((u) => u.name === name);
    if (!found) throw new Fail(`no upstream called ${name}; there are: ${this.upstreams.map((u) => u.name).join(", ")}`);
    return found;
  }

  /** The upstream a staged path belongs to: the deepest mount it is under. */
  upstreamFor(path: string): Upstream | null {
    let best: Upstream | null = null;
    for (const u of this.upstreams) {
      if ((!u.mount || under(path, u.mount)) && (best === null || u.mount.length > best.mount.length)) best = u;
    }
    return best;
  }

  lock(): UpstreamPin[] {
    const path = join(this.dir, "upstream.lock");
    if (!exists(path)) return [];
    return parseLock(readText(path))
      .filter((p) => this.upstreams.some((u) => u.name === p.name))
      .toSorted((a, b) => byCodePoint(a.name, b.name));
  }

  writeLock(name: string, commit: string, tree: string): void {
    this.saveLock([...this.lock().filter((p) => p.name !== name), { name, commit, tree }]);
  }

  dropPin(name: string): void {
    const pins = this.lock();
    if (pins.some((p) => p.name === name)) this.saveLock(pins.filter((p) => p.name !== name));
  }

  private saveLock(pins: readonly UpstreamPin[]): void {
    mkdirs(this.dir);
    writeText(join(this.dir, "upstream.lock"), lockText(pins));
  }

  pins(): string {
    return this.lock().map((p) => `${p.name} ${p.commit.slice(0, 7)}`).join(", ");
  }

  stagedUpstream(): Map<string, File> {
    const staged = new Map<string, File>();
    for (const u of this.upstreams) {
      const files = this.buildable(u, u.staged());
      const clash = Array.from(files.keys()).find((p) => staged.has(p));
      if (clash) throw new Fail(`${clash} comes from two upstreams; give ${u.name} its own mount`);
      for (const [p, f] of files) staged.set(p, f);
    }
    return staged;
  }

  /** Pass `noted = false` for a tree the build will not use, so the notice counts only what it leaves out and neither a path git reads as `.git` nor a folder that reads as `.patchbook` is refused. */
  buildable(u: Upstream, files: ReadonlyMap<string, File>, noted = true): Map<string, File> {
    if (noted && this.layout.kind === "fork") refuseFoldedUpstream(files.keys());
    const kept = new Map<string, File>();
    for (const [p, f] of files) {
      const vendored = this.vendorHolding(p);
      if (vendored !== null) {
        if (noted) leftOut.set(vendored, (leftOut.get(vendored) ?? new Set()).add(p));
      }
      else if (!this.isPatchbook(p)) {
        if (noted) refuseBuiltGit(u, p);
        kept.set(p, f);
      }
    }
    return kept;
  }

  isReserved(path: string): boolean {
    return this.isPatchbook(path) || this.heldBy(path) !== null;
  }

  isPatchbook(path: string): boolean {
    return this.layout.kind === "fork" && under(path, PB);
  }

  outputRoot(): string {
    return this.layout.kind === "folder" ? this.layout.dir : this.root;
  }

  tracksExecBit(): boolean {
    return (this.fileMode ??= git(["config", "--type=bool", "--default=true", "core.fileMode"], { cwd: this.root }) === "true");
  }

  /** The output as it is on disk now: tracked files and untracked ones git doesn't ignore. */
  currentOutput(): Map<string, File> {
    const root = this.outputRoot();
    const out = new Map<string, File>();
    if (!exists(root)) return out;
    const rel = root !== this.root ? relative(this.root, root) : "";
    const listed = git(["ls-files", "-z", "-co", "--exclude-standard", ...(rel ? ["--", rel] : [])], { cwd: this.root });
    for (const path of listed.split("\0")) {
      if (!path) continue;
      const p = join(this.root, path);
      const folderNow = isDir(p) && !isSymlink(p);
      if (!lexists(p) || folderNow) continue;
      const key = rel ? path.slice(rel.length + 1) : path;
      if (this.isReserved(key)) continue;
      out.set(key, readDisk(p));
    }
    return out;
  }

  /** The output from `source`, each file marked with whether its exec bit is the user's. Under core.fileMode=false a
   * disk read takes the index's mode, which is what `git add -A` stages. Each file is marked in place, since a copy
   * would read the bytes of a staged file that `treeBlobs` reads only when asked. */
  seen(source: OutputSource): Map<string, Seen> {
    const files = source === "index" ? this.stagedOutput() : this.currentOutput();
    if (this.tracksExecBit()) return new Map(Array.from(files, ([p, f]) => [p, Object.assign(f, { chosen: true })]));
    const index = source === "index" ? new Map(Array.from(files, ([p, f]) => [p, f.mode])) : this.indexModes();
    const since = this.stagedChanges();
    const regular = (mode: Mode | null | undefined) => (mode === 0o644 || mode === 0o755 ? mode : undefined);
    return new Map(Array.from(files, ([p, f]) => {
      const c = since.get(p);
      const chosen = c !== undefined && regular(c.staged) !== undefined && c.staged !== (regular(c.head) ?? 0o644);
      return [p, Object.assign(f, { mode: f.mode === LINK ? LINK : regular(index.get(p)) ?? 0o644, chosen })];
    }));
  }

  private indexModes(): Map<string, Mode> {
    const root = this.outputRoot();
    const rel = root !== this.root ? relative(this.root, root) : "";
    const modes = new Map<string, Mode>();
    for (const entry of decode(run(["git", "--literal-pathspecs", "ls-files", "-s", "-z", ...(rel ? ["--", rel] : [])], { cwd: this.root })).split("\0")) {
      const tab = entry.indexOf("\t");
      const mode = parseGitMode(entry.slice(0, tab).split(" ")[0]!);
      if (tab > 0 && mode !== undefined) modes.set(rel ? entry.slice(tab + rel.length + 2) : entry.slice(tab + 1), mode);
    }
    return modes;
  }

  /** The output a commit takes: the index as `write-tree` sees it, so paths only marked with `git add -N` are left out. */
  stagedOutput(): Map<string, File> {
    const root = this.outputRoot();
    const tree = git(["write-tree"], { cwd: this.root });
    const files = treeBlobs(this.root, tree, root !== this.root ? relative(this.root, root) : "");
    return new Map(Array.from(files).filter(([p]) => !this.isReserved(p)));
  }

  stagedChanges(): Map<string, { head: Mode | null; staged: Mode | null }> {
    const root = this.outputRoot();
    const rel = root !== this.root ? relative(this.root, root) : "";
    const head = spawn(["git", "rev-parse", "-q", "--verify", "HEAD^{tree}"], { cwd: this.root });
    const base = head.code === 0 ? decode(head.stdout).trim() : git(["hash-object", "-t", "tree", "--stdin"], { cwd: this.root, input: new Uint8Array() });
    const diff = ["--literal-pathspecs", "diff-index", "--cached", "--raw", "-z", "--no-renames", base, ...(rel ? ["--", rel] : [])];
    const fields = decode(run(["git", ...diff], { cwd: this.root })).split("\0");
    const changes = new Map<string, { head: Mode | null; staged: Mode | null }>();
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [was = 0, now = 0] = fields[i]!.slice(1).split(" ", 2).map((m) => parseInt(m, 8));
      const key = rel ? fields[i + 1]!.slice(rel.length + 1) : fields[i + 1]!;
      if (was === GITLINK || now === GITLINK || this.isReserved(key)) continue;
      changes.set(key, { head: was ? normMode(was) : null, staged: now ? normMode(now) : null });
    }
    return changes;
  }
}

