// subprocess.run on Bun.spawnSync. Node's spawnSync fails with ENOBUFS above 1 MB of output by
// default, and `git cat-file --batch` on a real upstream is already past that.
import { Fail } from "./fail.ts";
import { strip } from "./py.ts";
import { decode, decodeReplace } from "./text.ts";

export type Env = Record<string, string | undefined>;
export type SpawnOptions = { cwd?: string; input?: Uint8Array; env?: Env; capture?: boolean; timeout?: number };
/** A finished process. `code` is null when a signal killed it, as it does when `timeout` runs out. */
export type Finished = { code: number | null; stdout: Uint8Array; stderr: Uint8Array; timedOut: boolean };

/** Run a command to the end. Without capture, it writes to our stdout and stderr. */
export function spawn(args: readonly string[], { cwd, input, env, capture = true, timeout }: SpawnOptions = {}): Finished {
  const result = Bun.spawnSync({
    cmd: [...args],
    stdin: input ?? "inherit",
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
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

type Authority = { scheme: string; start: number; userinfo: string | null };

function* authorities(text: string): Generator<Authority> {
  for (const m of text.matchAll(AUTHORITY)) {
    const authority = m[2]!;
    const at = authority.lastIndexOf("@");
    yield { scheme: m[1]!, start: m.index + m[0].length, userinfo: at < 0 ? null : authority.slice(0, at) };
  }
}

const dropsCredentials = (scheme: string, userinfo: string): boolean =>
  WEB_SCHEMES.test(scheme) ? userinfo !== "" : userinfo.includes(":");

/** User info runs to the last `@` before the first `/`, so a password may hold spaces, `#` or `?`. */
export function redact(text: string): string {
  const cuts: [number, number][] = [];
  for (const { scheme, start, userinfo } of authorities(text)) {
    if (userinfo === null) continue;
    if (WEB_SCHEMES.test(scheme)) cuts.push([start, start + userinfo.length + 1]);
    else if (userinfo.includes(":")) cuts.push([start + userinfo.indexOf(":"), start + userinfo.length]);
  }
  let out = "";
  let at = 0;
  for (const [from, to] of cuts) {
    out += text.slice(at, from);
    at = Math.max(at, to);
  }
  return out + text.slice(at);
}

export function refuseCredentials(url: string): void {
  const first = authorities(url).next().value;
  if (first?.userinfo != null && dropsCredentials(first.scheme, first.userinfo)) {
    throw new Fail(`${redact(url)} has credentials that patchbook would not keep. Give git the password through a credential helper instead. See: git help credential`);
  }
}

/** Run a command and return its stdout, failing if it exits non-zero. */
export function run(args: readonly string[], options: SpawnOptions & { check?: boolean } = {}): Uint8Array {
  const result = spawn(args, options);
  if ((options.check ?? true) && result.code !== 0) {
    throw new Fail(redact(`${args.join(" ")} failed:\n${strip(decodeReplace(result.stderr))}`));
  }
  return result.stdout;
}

/** Run git with every pathspec taken literally, so a config path like `o*` names that folder and no other. */
export function git(args: readonly string[], options: SpawnOptions & { check?: boolean } = {}): string {
  const env = { ...(options.env ?? process.env), GIT_LITERAL_PATHSPECS: "1" };
  return strip(decode(run(["git", ...args], { ...options, env })));
}

/** `shutil.which`. */
export const which = (name: string): string | null => Bun.which(name);
