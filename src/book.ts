// The repo, its config and its upstreams.
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Hooks, Problem } from "./api.ts";
import { installHook } from "./githook.ts";
import { SequenceMatcher } from "./lib/difflib.ts";
import { Fail } from "./lib/fail.ts";
import { exists, type File, isDir, isMode, isSymlink, lexists, pjoin, readDisk, readText, relative, resolve, writeText } from "./lib/fs.ts";
import { dumps, loads } from "./lib/json.ts";
import { git } from "./lib/proc.ts";
import { length, type PyValue, sortedBy, strRepr } from "./lib/py.ts";
import { isTable, parseToml, type Table } from "./settings.ts";
import { stagedFolder, Upstream } from "./store.ts";

export const PB = ".patchbook";
export const GIT = ".git";

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
/** git's `is_ntfs_dotgit`, applied after each backslash as fsck does. */
const ntfsDotGit = (segment: string) => segment.split("\\").some((part) => /^(?:\.git|git~1)[. ]*(?::|$)/i.test(part));
/** Whether a part of path is a name git reads as `.git`. git's fsck warns `hasDotgit` on each one on every platform, and git refuses to stage most of them. */
const namesGit = (path: string) => path.split("/").some((segment) => hfsDotGit(segment) || ntfsDotGit(segment));

const leftOut = new Map<string, Set<string>>();

export function noticeLeftOut(): void {
  if (leftOut.size === 0) return;
  const total = Array.from(leftOut.values()).reduce((n, paths) => n + paths.size, 0);
  const folders = sortedBy(leftOut, ([folder]) => folder).map(([folder, paths]) => `${folder} (${paths.size})`).join(", ");
  leftOut.clear();
  process.stderr.write(`patchbook: left ${total} upstream files out of the build because they would land in a vendored copy: ${folders}.\n`);
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
  const scored = HOOKS.map((h) => [new SequenceMatcher(name, h).ratio(), h] as const).sort((x, y) => y[0] - x[0]);
  const [ratio, best] = scored[0]!;
  return ratio >= 0.6 ? `; did you mean \`${best}\`?` : `. The hooks are ${HOOKS.join(", ")}.`;
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
    if (!isHookName(name)) throw hookFail(path, `\`${name}\` isn't a hook${suggest(name)}`);
    if (typeof fn !== "function") throw hookFail(path, `\`${name}\` must be a function`);
    const call = (...args: unknown[]): unknown => fn(...args);
    switch (name) {
      case "placeholder":
        hooks.placeholder = (kind, key) => {
          const value = call(kind, key);
          if (value === null || value === undefined || typeof value === "string") return value;
          throw hookFail(path, `placeholder(${strRepr(kind)}, ${strRepr(key)}) returned ${typeof value}, not a string`);
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
            throw hookFail(path, `check returned ${JSON.stringify(p)}, not a problem like { problem: "check", file, detail }`);
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
  const shown = strRepr(to);
  if (rel === ".") throw new Fail(`[output] to ${shown} is the repo root. Name a folder inside the repo.`);
  if (under(rel, "..")) throw new Fail(`[output] to ${shown} is outside the repo. Name a folder inside it.`);
  if (under(rel, PB)) throw new Fail(`[output] to ${shown} is inside ${PB}. patchbook never builds into ${PB}, so those files would never land. Change [output] to.`);
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

  private constructor(readonly root: string, candidate?: string) {
    this.dir = join(root, PB);
    this.config = parseToml(candidate ?? readText(join(this.dir, "config.toml")), join(this.dir, "config.toml"));
    const kind = Object.hasOwn(this.config, "layout") ? this.config["layout"] : "fork";
    if (kind !== "folder" && kind !== "fork") {
      throw new Fail(`layout must be folder or fork, not ${typeof kind === "string" ? strRepr(kind) : JSON.stringify(kind)}`);
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

  static validate(root: string, config: string): void {
    new Book(root, config);
  }

  static async open(root: string): Promise<Book> {
    const book = new Book(root);
    book.hooks = await loadHooks(book.dir);
    return book;
  }

  static async find(start?: string): Promise<Book> {
    const here = resolve(start ?? process.cwd());
    for (let d = here; ; d = join(d, "..")) {
      if (exists(join(d, PB, "config.toml"))) {
        installHook(d);
        return Book.open(d);
      }
      if (d === "/") break;
    }
    throw new Fail(`no ${PB}/config.toml here or above. Start one with \`patchbook clone\` or \`patchbook init\`.`);
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
      const own = out === null ? undefined : under(out, PB) ? PB : namesGit(out) ? GIT : undefined;
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
    return under(inRepo.toLowerCase(), PB) ? { place: PB, refuse: true } : namesGit(inRepo) ? { place: GIT, refuse: true } : null;
  }

  reservedHolding(staged: string): Reserved | null {
    const output = this.outputOf(staged);
    return output === null ? null : this.reservedOutput(output);
  }

  private vendors(): string[] {
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
      if ((!u.mount || under(path, u.mount)) && (best === null || length(u.mount) > length(best.mount))) best = u;
    }
    return best;
  }

  /** The lock: {upstream name: {commit, tree}}, as the file has it. */
  lock(): Map<string, PyValue> {
    const path = join(this.dir, "upstream.lock");
    if (!exists(path)) return new Map();
    const data = loads(readText(path));
    if (!(data instanceof Map)) throw new Fail(`${path} isn't a JSON object`);
    return data;
  }

  writeLock(name: string, commit: string, tree: string): void {
    const data = this.lock();
    data.set(name, new Map([["commit", commit], ["tree", tree]]));
    const ordered = new Map(sortedBy(data, ([k]) => k));
    writeText(join(this.dir, "upstream.lock"), dumps(ordered, 2) + "\n");
  }

  pins(): string {
    return sortedBy(this.lock(), ([k]) => k)
      .map(([name, pin]) => {
        const commit = pin instanceof Map ? pin.get("commit") : undefined;
        if (typeof commit !== "string") throw new Fail(`upstream.lock: ${name} has no commit`);
        return `${name} ${commit.slice(0, 7)}`;
      })
      .join(", ");
  }

  stagedUpstream(): Map<string, File> {
    const staged = new Map<string, File>();
    for (const u of this.upstreams) {
      const files = this.buildable(u.staged());
      const clash = Array.from(files.keys()).find((p) => staged.has(p));
      if (clash) throw new Fail(`${clash} comes from two upstreams; give ${u.name} its own mount`);
      for (const [p, f] of files) staged.set(p, f);
    }
    return staged;
  }

  /** Pass `noted = false` for a tree the build will not use, so the notice counts only what it leaves out. */
  buildable(files: ReadonlyMap<string, File>, noted = true): Map<string, File> {
    const kept = new Map<string, File>();
    for (const [p, f] of files) {
      const vendored = this.vendorHolding(p);
      if (vendored !== null) {
        if (noted) leftOut.set(vendored, (leftOut.get(vendored) ?? new Set()).add(p));
      }
      else if (!this.isPatchbook(p)) kept.set(p, f);
    }
    return kept;
  }

  isReserved(path: string): boolean {
    return this.isPatchbook(path) || this.heldBy(path) !== null;
  }

  private isPatchbook(path: string): boolean {
    return this.layout.kind === "fork" && under(path, PB);
  }

  outputRoot(): string {
    return this.layout.kind === "folder" ? this.layout.dir : this.root;
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
}

