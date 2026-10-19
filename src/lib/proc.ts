// subprocess.run on Bun.spawnSync. Node's spawnSync fails with ENOBUFS above 1 MB of output by
// default, and `git cat-file --batch` on a real upstream is already past that.
import { Fail } from "./fail.ts";
import { decode, decodeReplace } from "./text.ts";

export type Env = Record<string, string | undefined>;
export type SpawnOptions = { cwd?: string; input?: Uint8Array; env?: Env; capture?: boolean };
/** A finished process. `code` is null when a signal killed it. */
export type Finished = { code: number | null; stdout: Uint8Array; stderr: Uint8Array };

/** Run a command to the end. Without capture, it writes to our stdout and stderr. */
export function spawn(args: readonly string[], { cwd, input, env, capture = true }: SpawnOptions = {}): Finished {
  const result = Bun.spawnSync({
    cmd: [...args],
    stdin: input ?? "inherit",
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
  });
  const empty = new Uint8Array();
  return { code: result.exitCode, stdout: result.stdout ?? empty, stderr: result.stderr ?? empty };
}

const WEB_SCHEMES = /^(https?|ftps?)$/i;

export function redact(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*):\/\/([^\s/]*)@/gi, (_, scheme: string, userinfo: string) =>
    WEB_SCHEMES.test(scheme) ? `${scheme}://` : `${scheme}://${userinfo.split(":")[0]}@`);
}

/** Run a command and return its stdout, failing if it exits non-zero. */
export function run(args: readonly string[], options: SpawnOptions & { check?: boolean } = {}): Uint8Array {
  const result = spawn(args, options);
  if ((options.check ?? true) && result.code !== 0) {
    throw new Fail(redact(`${args.join(" ")} failed:\n${decodeReplace(result.stderr).trim()}`));
  }
  return result.stdout;
}

/** Run git with every pathspec taken literally, so a config path like `o*` names that folder and no other. */
export function git(args: readonly string[], options: SpawnOptions & { check?: boolean } = {}): string {
  const env = { ...(options.env ?? process.env), GIT_LITERAL_PATHSPECS: "1" };
  return decode(run(["git", ...args], { ...options, env })).trim();
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
