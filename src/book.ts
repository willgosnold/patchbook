// The repo, its config and its upstreams.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Problem } from "./assemble.ts";
import { installHook } from "./githook.ts";
import { SequenceMatcher } from "./lib/difflib.ts";
import { Fail } from "./lib/fail.ts";
import { exists, type File, isMode, lexists, pjoin, readDisk, readText, relative, resolve, writeText } from "./lib/fs.ts";
import { dumps, loads } from "./lib/json.ts";
import { git } from "./lib/proc.ts";
import { length, type PyValue, sortedBy, strip, strRepr } from "./lib/py.ts";
import { isTable, parseToml, type Table } from "./settings.ts";
import { Upstream } from "./store.ts";

export const PB = ".patchbook";

export function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

/** What a repo's `.patchbook/hooks.ts` can export. Patchbook calls each by name. */
export interface Hooks {
  /** The value of `{{kind:name}}`, or null to look it up in the config's placeholder source. */
  placeholder?(kind: string, name: string): string | null | undefined;
  /** Text in a block that needs an entry, beyond what the config's `[[check]]` patterns find. */
  blockTerms?(path: string, block: string, outputs: ReadonlySet<string>): Iterable<string>;
  /** Change the output, path by path, before it's checked and written. */
  finish?(out: Map<string, { data: Uint8Array; mode: number }>): void;
  /** Problems with the output that the config can't express. */
  check?(outputs: ReadonlyMap<string, Uint8Array>): Extract<Problem, { problem: "check" }>[];
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
            if (isTable(p) && p["problem"] === "check" && typeof p["file"] === "string" && typeof p["detail"] === "string") {
              return { problem: "check", file: p["file"], detail: p["detail"] };
            }
            throw hookFail(path, `check returned ${JSON.stringify(p)}, not { problem: "check", file, detail }`);
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

function isIterable(value: unknown): value is Iterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.iterator in value;
}

/** A `[[check]]`: the output files it covers and the pattern a block mustn't match without an entry. */
export type Check = { files: RegExp[]; exclude: RegExp[]; pattern: RegExp };
export type Placeholder = { file: string | null; format: string };
export type Layout = { kind: "fork" } | { kind: "folder"; from: string; dir: string };

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

  private constructor(readonly root: string) {
    this.dir = join(root, PB);
    this.config = parseToml(readText(join(this.dir, "config.toml")), join(this.dir, "config.toml"));
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
    this.checkMounts(kind);
    if (kind === "folder") {
      const out = Object.hasOwn(this.config, "output") ? this.config["output"] : {};
      if (!isTable(out) || !Object.hasOwn(out, "to")) throw new Fail("a folder layout needs [output] with to = <folder>");
      const from = strip(text(out, "from", "", "[output] from"), "/");
      this.layout = { kind, from, dir: pjoin(root, text(out, "to", "", "[output] to")) };
    } else this.layout = { kind };
    this.readChecks();
    this.readPlaceholders();
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

  private checkMounts(kind: Layout["kind"]): void {
    const names = this.upstreams.map((u) => u.name);
    if (new Set(names).size !== names.length) throw new Fail("two upstreams share a name");
    const roots = this.upstreams.filter((u) => !u.mount);
    if (roots.length > 1) throw new Fail("only one upstream can mount at the root");
    if (kind === "fork" && roots.length === 0) throw new Fail('a fork needs its own upstream mounted at the root (mount = "")');
    for (const a of this.upstreams) {
      for (const b of this.upstreams) {
        if (a !== b && a.mount && under(b.mount, a.mount)) throw new Fail(`upstreams ${a.name} and ${b.name} mount at overlapping folders`);
      }
    }
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
      const files = u.staged();
      const clash = Array.from(files.keys()).find((p) => staged.has(p));
      if (clash) throw new Fail(`${clash} comes from two upstreams; give ${u.name} its own mount`);
      for (const [p, f] of files) staged.set(p, f);
    }
    return staged;
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
    // In a fork the output is the repo root, minus the patchbook and any vendored copies.
    const kept = [PB, ...this.upstreams.flatMap((u) => (u.vendor ? [relative(this.root, u.vendor)] : []))];
    const listed = git(["ls-files", "-z", "-co", "--exclude-standard", ...(rel ? ["--", rel] : [])], { cwd: this.root });
    for (const path of listed.split("\0")) {
      if (!path) continue;
      const p = join(this.root, path);
      if (!lexists(p)) continue;
      const key = rel ? path.slice(rel.length + 1) : path;
      if (this.layout.kind === "fork" && kept.some((k) => under(key, k))) continue;
      out.set(key, readDisk(p));
    }
    return out;
  }
}

