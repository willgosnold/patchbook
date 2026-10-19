import { test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

type Env = Record<string, string>;

export const TOOL = resolve(import.meta.dir, "..", "src", "cli.ts");
export const TIMEOUT = 120_000;

export function shlexSplit(line: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      if (cur !== null) out.push(cur);
      cur = null;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new Error("No closing quotation");
      cur = (cur ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      cur ??= "";
      for (i++; ; i++) {
        if (i >= line.length) throw new Error("No closing quotation");
        const d = line[i]!;
        if (d === '"') break;
        const next = line[i + 1];
        if (d === "\\" && (next === '"' || next === "\\")) {
          cur += next;
          i++;
        } else {
          cur += d;
        }
      }
    } else if (c === "\\") {
      if (i + 1 >= line.length) throw new Error("No escaped character");
      cur = (cur ?? "") + line[++i];
    } else {
      cur = (cur ?? "") + c;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

export function shlexQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'"'"'`)}'`;
}

// The implementation under test, as a command line. Defaults to the TypeScript one.
export const CMD = shlexSplit(process.env["PATCHBOOK_CMD"] || [process.execPath, TOOL].map(shlexQuote).join(" "));

// Python's textwrap.dedent: blank lines are emptied, then the common leading whitespace is removed.
export function dedent(text: string): string {
  text = text.replace(/^[ \t]+(?=\n|$)/gm, "");
  let margin: string | null = null;
  for (const m of text.matchAll(/^([ \t]*)[^ \t\n]/gm)) {
    const indent = m[1]!;
    if (margin === null) {
      margin = indent;
    } else if (indent.startsWith(margin)) {
      continue;
    } else if (margin.startsWith(indent)) {
      margin = indent;
    } else {
      let n = 0;
      while (margin[n] === indent[n]) n++;
      margin = margin.slice(0, n);
    }
  }
  return margin ? text.replace(new RegExp(`^${margin}`, "gm"), "") : text;
}

// Python's str.replace: every occurrence, and the replacement is literal.
export function replace(text: string, old: string, repl: string): string {
  return text.split(old).join(repl);
}

export function lstrip(text: string, chars?: string): string {
  let i = 0;
  while (i < text.length && (chars === undefined ? /\s/.test(text[i]!) : chars.includes(text[i]!))) i++;
  return text.slice(i);
}

export function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

// Python's str.partition head: everything before the first separator.
export function partitionHead(text: string, sep: string): string {
  const i = text.indexOf(sep);
  return i < 0 ? text : text.slice(0, i);
}

// Python's json.dumps with its default separators and ASCII escaping.
export function jsonDumps(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jsonDumps).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).map(([k, v]) => `${jsonDumps(k)}: ${jsonDumps(v)}`).join(", ")}}`;
  }
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// Python's Path.mkdir(parents=True): fails when the directory already exists.
export function mkdirNew(path: string): void {
  if (existsSync(path)) throw new Error(`File exists: ${path}`);
  mkdirSync(path, { recursive: true });
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string, env: Env): Run {
  const r = Bun.spawnSync(args, { cwd, env, stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function definedEnv(env: Record<string, string | undefined>): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

// The default environment for sh(): the caller's, plus a git identity, no global git config
// (GIT_CONFIG_GLOBAL=/dev/null), git's messages in English (LC_ALL=C), and the commit hook and the skill
// install off (PATCHBOOK_HOOK=0, PATCHBOOK_SKILL=0), so a test turns them on only when it means to.
function baseEnv(): Env {
  return {
    ...definedEnv(process.env),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    GIT_CONFIG_GLOBAL: "/dev/null",
    LC_ALL: "C",
    PATCHBOOK_HOOK: "0",
    PATCHBOOK_SKILL: "0",
  };
}

export function sh(args: string[], opts: { cwd: string; check?: boolean; env?: Env }): Run {
  const r = run(args, opts.cwd, opts.env ?? baseEnv());
  if (opts.check !== false && r.code !== 0) {
    throw new Error(`Command '${args.join(" ")}' returned non-zero exit status ${r.code}.\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}

export class Repo {
  constructor(readonly path: string) {
    mkdirSync(path, { recursive: true });
    if (!existsSync(join(path, ".git"))) sh(["git", "init", "-q", "-b", "main"], { cwd: path });
  }

  write(rel: string, text: string, mode = 0o644): void {
    const p = join(this.path, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, lstrip(dedent(text), "\n"));
    chmodSync(p, mode);
  }

  read(rel: string): string {
    return readFileSync(join(this.path, rel), "utf8");
  }

  rm(rel: string): void {
    rmSync(join(this.path, rel));
  }

  commit(message = "change"): string {
    sh(["git", "add", "-A"], { cwd: this.path });
    sh(["git", "commit", "-q", "-m", message], { cwd: this.path });
    return sh(["git", "rev-parse", "HEAD"], { cwd: this.path }).stdout.trim();
  }
}

export class Case {
  readonly tmp: string;
  readonly env: Env;

  constructor() {
    this.tmp = mkdtempSync(join(tmpdir(), "tmp"));
    this.env = { ...baseEnv(), PATCHBOOK_HOME: join(this.tmp, "store") };
    // A fake claude CLI that names the change and writes its intent, and keeps the prompt it got.
    const binDir = join(this.tmp, "bin");
    mkdirSync(binDir);
    const fake = join(binDir, "claude");
    writeFileSync(fake, `#!/bin/sh\ncat > ${this.tmp}/prompt.txt\necho '{"change": "shout", "intent": "Shout the second line."}'\n`);
    chmodSync(fake, 0o755);
    // The pre-commit hook runs `patchbook` from PATH.
    const shim = join(binDir, "patchbook");
    writeFileSync(shim, `#!/bin/sh\nexec ${CMD.map(shlexQuote).join(" ")} "$@"\n`);
    chmodSync(shim, 0o755);
    Object.assign(this.env, { PATH: `${binDir}:${process.env["PATH"]}`, XDG_CONFIG_HOME: join(this.tmp, "config") });
  }

  cleanup(): void {
    rmSync(this.tmp, { recursive: true, force: true });
  }

  pb(args: string[], opts: { cwd: string; code?: number | null }): Run {
    const env = this.env["PATCHBOOK_HOOK"] === "0" ? { ...this.env, PATCHBOOK_HOOK: "" } : this.env;
    const r = run([...CMD, ...args], opts.cwd, env);
    const code = opts.code === undefined ? 0 : opts.code;
    if (code !== null && r.code !== code) {
      throw new Error(`expected exit ${code}, got ${r.code}: patchbook ${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
    }
    return r;
  }
}

export const isRoot = process.getuid?.() === 0;

/**
 * A test that needs the OS to refuse a read or write (chmod a-w, 0o444, 0o000). Root ignores file
 * permissions, so it skips there. Pass the case class to get a fresh one, cleaned up after the body.
 */
export function permissionTest(name: string, body: () => void): void;
export function permissionTest<C extends Case>(name: string, body: (t: C) => void, make: new () => C): void;
export function permissionTest<C extends Case>(name: string, body: (t: C) => void, make?: new () => C): void {
  test.skipIf(isRoot)(name, () => {
    if (!make) return (body as () => void)();
    const t = new make();
    try {
      body(t);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}
