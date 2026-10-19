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

const WEB_SCHEMES = /^(https?|ftps?)$/i;

export function redact(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*):\/\/([^\s/]*)@/gi, (_, scheme: string, userinfo: string) =>
    WEB_SCHEMES.test(scheme) ? `${scheme}://` : `${scheme}://${userinfo.split(":")[0]}@`);
}

export function refuseCredentials(url: string): void {
  const shown = redact(url);
  if (shown !== url) {
    throw new Fail(`${shown} has credentials that patchbook would not keep. Give git the password through a credential helper instead. See: git help credential`);
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
