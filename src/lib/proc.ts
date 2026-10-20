// subprocess.run on Bun.spawnSync. Node's spawnSync fails with ENOBUFS above 1 MB of output by
// default, and `git cat-file --batch` on a real upstream is already past that.
import { Fail } from "./fail.ts";
import { decode, decodeReplace, withoutFinalNewline } from "./text.ts";

export type Env = Record<string, string | undefined>;
export type SpawnOptions = { cwd?: string; input?: Uint8Array; env?: Env; timeout?: number };
/** A finished process. `code` is null when a signal killed it, as it does when `timeout` runs out. */
export type Finished = { code: number | null; stdout: Uint8Array; stderr: Uint8Array; timedOut: boolean };

export function spawn(args: readonly string[], { cwd, input, env, timeout }: SpawnOptions = {}): Finished {
  const result = Bun.spawnSync({
    cmd: [...args],
    stdin: input ?? "inherit",
    stdout: "pipe",
    stderr: "pipe",
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
    ...(timeout === undefined ? {} : { timeout, killSignal: "SIGKILL" as const, detached: true }),
  });
  // The kill reaches only the child. Its own group, which `detached` made, takes the rest with it.
  if (timeout !== undefined && result.exitedDueToTimeout === true) {
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch {}
  }
  const empty = new Uint8Array();
  return { code: result.exitCode, stdout: result.stdout ?? empty, stderr: result.stderr ?? empty, timedOut: result.exitedDueToTimeout === true };
}

const WEB_SCHEMES = /(^|\+)(https?|ftps?)$/i;
const AUTHORITY = /\b([a-z][a-z0-9+.-]*):\/\/(?=([^/]*))/gi;

type Chars = { from: number; char: string }[];

// Git percent-decodes a non-web url once before it splits it. A `%` without two hex digits stays literal.
function decodeOnce(raw: string): Chars {
  const out: Chars = [];
  for (let i = 0; i < raw.length; i++) {
    const hex = raw[i] === "%" ? raw.slice(i + 1, i + 3) : "";
    if (/^[0-9a-f]{2}$/i.test(hex)) {
      out.push({ from: i, char: String.fromCharCode(parseInt(hex, 16)) });
      i += 2;
    } else out.push({ from: i, char: raw[i]! });
  }
  return out;
}

/** The raw span to hide when the url holds a password, or null when patchbook keeps it. */
function secret(scheme: string, authority: string): [number, number] | null {
  const at = authority.lastIndexOf("@");
  if (WEB_SCHEMES.test(scheme)) return at > 0 ? [0, at + 1] : null;
  const chars = decodeOnce(authority);
  const end = chars.findIndex(({ char }) => char === "/");
  const decoded = end < 0 ? chars : chars.slice(0, end);
  const lastAt = decoded.findLastIndex(({ char }) => char === "@");
  const colon = decoded.findIndex(({ char }, i) => char === ":" && i < lastAt);
  return colon < 0 ? null : [decoded[colon]!.from, decoded[lastAt]!.from];
}

/** Each `scheme://` in the text, with the absolute span of its password, or null when patchbook keeps it. */
function* authorities(text: string): Generator<[number, number] | null> {
  for (const m of text.matchAll(AUTHORITY)) {
    const cut = secret(m[1]!, m[2]!);
    const start = m.index + m[0].length;
    yield cut === null ? null : [start + cut[0], start + cut[1]];
  }
}

/** User info runs to the last `@` before the first `/`, so a password may hold spaces, `#` or `?`. */
export function redact(text: string): string {
  let out = "";
  let at = 0;
  for (const cut of authorities(text)) {
    if (cut === null) continue;
    out += text.slice(at, cut[0]);
    at = Math.max(at, cut[1]);
  }
  return out + text.slice(at);
}

export function refuseCredentials(url: string): void {
  if (authorities(url).next().value != null) {
    throw new Fail(`${redact(url)} has credentials that patchbook would not keep. Give git the password through a credential helper instead. See: git help credential`);
  }
}

/** Run a command and return its stdout, failing if it exits non-zero. */
export function run(args: readonly string[], options: SpawnOptions & { check?: boolean } = {}): Uint8Array {
  const result = spawn(args, options);
  if ((options.check ?? true) && result.code !== 0) {
    throw new Fail(redact(`${args.join(" ")} failed:\n${decodeReplace(result.stderr).trim()}`));
  }
  return result.stdout;
}

/** Run git with every pathspec taken literally, so a config path like `o*` names that folder and no other.
 * Returns its stdout without the final `\n` git ends a value with. A path can start or end with whitespace, so nothing else is cut, and `-z` output, which ends in a NUL, is whole. */
export function git(args: readonly string[], options: SpawnOptions & { check?: boolean } = {}): string {
  const env = { ...(options.env ?? process.env), GIT_LITERAL_PATHSPECS: "1" };
  return withoutFinalNewline(decode(run(["git", ...args], { ...options, env })));
}

/** text as one word for POSIX sh, in a command patchbook prints for the user to run. A word of only letters,
 * digits and `@%+:,./_-` stays bare, and anything else goes in single quotes. That includes `=`, which zsh
 * expands at the start of a word. */
export function shellQuote(text: string): string {
  if (/^[\w@%+:,./-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

/** `shutil.which`. */
export const which = (name: string): string | null => Bun.which(name);
