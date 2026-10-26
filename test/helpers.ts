import { test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { shellQuote } from "../src/lib/proc.ts";

type Env = Record<string, string>;

export const TOOL = resolve(import.meta.dir, "..", "src", "cli.ts");
export const TIMEOUT = 120_000;

export function splitWords(line: string): string[] {
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

// The implementation under test, as a command line. Defaults to the TypeScript one.
export const CMD = splitWords(process.env["PATCHBOOK_CMD"] || [process.execPath, TOOL].map(shellQuote).join(" "));

let crashBinary: string | undefined;

// Against a binary, this builds a second one, so the binary under test never carries crash.ts.
export function crashCmd(): string[] {
  if (!process.env["PATCHBOOK_CMD"]) return [process.execPath, "--preload", resolve(import.meta.dir, "crash-preload.ts"), TOOL];
  if (!crashBinary) {
    const dir = mkdtempSync(join(tmpdir(), "crash"));
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    crashBinary = join(dir, "patchbook");
    sh([process.execPath, resolve(import.meta.dir, "crash-build.ts"), "build", crashBinary], { cwd: dir });
  }
  return [crashBinary];
}

/** Takes off the indentation every non-blank line shares, and empties a blank line. */
export function dedent(text: string): string {
  const lines = text.split("\n").map((line) => (/^[ \t]*$/.test(line) ? "" : line));
  const margins = lines.filter(Boolean).map((line) => /^[ \t]*/.exec(line)![0]);
  let margin = margins[0] ?? "";
  for (const other of margins) while (!other.startsWith(margin)) margin = margin.slice(0, -1);
  return lines.map((line) => line.slice(margin.length)).join("\n");
}

export function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string, env: Env, timeout?: number): Run {
  const r = Bun.spawnSync(args, { cwd, env, stdin: "inherit", stdout: "pipe", stderr: "pipe", ...(timeout === undefined ? {} : { timeout }) });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function definedEnv(env: Record<string, string | undefined>): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

// The default environment for sh(): the caller's, plus a git identity, no global or system git config and no system
// attributes (GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM, GIT_ATTR_NOSYSTEM), git's messages in English
// (LC_ALL=C), and the commit hook and the skill install off (PATCHBOOK_HOOK=0, PATCHBOOK_SKILL=0), so a test turns
// them on only when it means to.
function baseEnv(): Env {
  return {
    ...definedEnv(process.env),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
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
    writeFileSync(p, dedent(text).replace(/^\n+/, ""));
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

/** A fake claude CLI that keeps the prompt it got in `tmp`, names the change shout, and gives it, and every quoted name the prompt asks to rewrite, the same intent. */
export const fakeClaude = (tmp: string): string => `#!/bin/sh
cat > ${tmp}/prompt.txt
keys=$(sed -n 's/^For \\("[^"]*"\\):.*/\\1: "Shout the second line.", /p' ${tmp}/prompt.txt | tr -d '\\n')
echo "{\\"change\\": \\"shout\\", \\"intent\\": \\"Shout the second line.\\", \\"intents\\": {$keys\\"shout\\": \\"Shout the second line.\\"}}"
`;

export class Case {
  readonly tmp: string;
  readonly env: Env;

  constructor() {
    this.tmp = mkdtempSync(join(tmpdir(), "tmp"));
    this.env = { ...baseEnv(), PATCHBOOK_HOME: join(this.tmp, "store") };
    const binDir = join(this.tmp, "bin");
    mkdirSync(binDir);
    const fake = join(binDir, "claude");
    writeFileSync(fake, fakeClaude(this.tmp));
    chmodSync(fake, 0o755);
    // The pre-commit hook runs `patchbook` from PATH.
    const shim = join(binDir, "patchbook");
    writeFileSync(shim, `#!/bin/sh\nexec ${CMD.map(shellQuote).join(" ")} "$@"\n`);
    chmodSync(shim, 0o755);
    Object.assign(this.env, { PATH: `${binDir}:${process.env["PATH"]}`, XDG_CONFIG_HOME: join(this.tmp, "config") });
  }

  cleanup(): void {
    rmSync(this.tmp, { recursive: true, force: true });
  }

  /** `timeout` kills a run that hangs, which shows as exit -1. */
  pb(args: string[], opts: { cwd: string; code?: number | null; timeout?: number }): Run {
    const env = this.env["PATCHBOOK_HOOK"] === "0" ? { ...this.env, PATCHBOOK_HOOK: "" } : this.env;
    const r = run([...CMD, ...args], opts.cwd, env, opts.timeout);
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
