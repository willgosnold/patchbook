// Files as pathlib reads and writes them: text with universal newlines, and bytes with a mode.
import {
  accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative as rel, resolve as absolute } from "node:path";
import { getSystemErrorMessage } from "node:util";
import { Fail } from "./fail.ts";
import { compareParts } from "./py.ts";
import { bytesEqual, decode, decodeReplace, encode } from "./text.ts";

export const LINK = 0o120000;
export const GITLINK = 0o160000;
export type Mode = 0o644 | 0o755 | typeof LINK;
/** A file as git stores it: its bytes, or a symlink's target, and its mode. */
export type File = { data: Uint8Array; mode: Mode };

export function normMode(mode: number): Mode {
  if (mode === LINK) return LINK;
  return mode & 0o111 ? 0o755 : 0o644;
}

const GIT_MODES = new Map<string, Mode>([["100644", 0o644], ["100755", 0o755], ["120000", LINK]]);

export const gitMode = (mode: Mode): string => Array.from(GIT_MODES).find(([, m]) => m === mode)![0];
/** Whether a change's ours copy has a mode of its own, one that differs from its base copy's. */
export const setsMode = (ours: File, base: File): boolean => ours.mode !== base.mode;

/** The mode an output gets from a change's copy. It follows upstream's until the copy sets one of its own, which a base copy at upstream's mode marks. */
export const outputMode = (ours: File, base: File | null, up: File | undefined): Mode =>
  up === undefined || (base !== null && setsMode(ours, base)) ? ours.mode : up.mode;
export const parseGitMode = (name: string): Mode | undefined => GIT_MODES.get(name);

/** A file of the output as a commit would take it. `chosen` says whether its exec bit is the user's: always under
 * core.fileMode=true; under false, only when the index holds a mode `git add` alone wouldn't give (HEAD's, or 644 for a
 * new path). An unchosen bit says nothing about the mode the user wants, so it stands for the build's. */
export type Seen = File & { readonly chosen: boolean };

/** The mode the user means an output to have once `now` is recorded: `now`'s own when its bit was chosen, else the
 * build's. A link, or a change between a link and a file, is always meant. */
export const meantMode = (now: Seen, built: Mode | undefined): Mode =>
  now.chosen || built === undefined || now.mode === LINK || built === LINK ? now.mode : built;

/** A change's copies of one output, by mode. null for a copy the change doesn't have. */
export type CopyModes = { ours: Mode | null; base: Mode | null };

/** The copy modes a recording of `now` leaves, given the build's mode, upstream's mode and the copies the change had.
 * outputMode at the returned modes, over upstream's, is meantMode(now, built). A copy the build already turns into the
 * meant mode is left as it is, so a copy that follows upstream keeps following it. */
export function recordedModes(now: Seen, built: Mode | undefined, up: Mode | undefined, had: CopyModes): { ours: Mode; base: Mode | null } {
  const meant = meantMode(now, built);
  if (had.ours !== null && meant === built) return { ours: had.ours, base: had.base };
  if (up === undefined || meant === LINK || up === LINK) return { ours: meant, base: had.base };
  return { ours: meant, base: had.base !== null || meant !== up ? up : null };
}

export function isMode(mode: unknown): mode is Mode {
  return mode === 0o644 || mode === 0o755 || mode === LINK;
}

export const sameMode = (a: Mode, b: Mode, tracksExecBit = true) => a === b || (!tracksExecBit && a !== LINK && b !== LINK);

export function sameFile(a: File | undefined, b: File | undefined, tracksExecBit = true): boolean {
  if (a === undefined || b === undefined) return a === b;
  return sameMode(a.mode, b.mode, tracksExecBit) && bytesEqual(a.data, b.data);
}

/** `Path(a) / b`: joined and normalised, with no trailing slash. An absolute part drops the ones before it. */
export function pjoin(...parts: string[]): string {
  const p = join(...parts.slice(Math.max(0, parts.findLastIndex((part) => part.startsWith("/")))));
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/** `b.relative_to(a).as_posix()`: `.` for the same path. */
export const relative = (from: string, to: string) => rel(from, to) || ".";

/** `Path(p).resolve()`: absolute, with symlinks resolved as far as the path exists. */
export function resolve(p: string): string {
  const abs = absolute(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(resolve(parent), basename(abs));
  }
}

export function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export const exists = (p: string) => existsSync(p);

export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const universal = (text: string) => text.replace(/\r\n?/g, "\n");

/** `path.read_text()`: strict UTF-8, with `\r\n` and `\r` read as `\n`. */
export const readText = (p: string) => universal(decode(readFileSync(p)));
/** `path.read_text(errors="replace")`. */
export const readTextReplace = (p: string) => universal(decodeReplace(readFileSync(p)));

/** A write the filesystem refused. It is a `Fail`, so the CLI prints it, and it keeps the errno, so a caller that can go on without the file still catches it as an errno error. */
export class WriteFail extends Fail {
  constructor(path: string, readonly errno: number) {
    super(`couldn't write ${path}: ${getSystemErrorMessage(errno)}`);
  }
}

type FsError = Error & { errno: number; syscall: string; path: string; dest?: string };

/** Only an error from a filesystem call carries both a syscall and a path. A failed spawn or a bug in patchbook does not, so it still surfaces as itself. */
const isFsError = (e: unknown): e is FsError =>
  e instanceof Error && "errno" in e && typeof e.errno === "number" && "syscall" in e && typeof e.syscall === "string" && "path" in e && typeof e.path === "string";

function writing<T>(write: () => T): T {
  try {
    return write();
  } catch (e) {
    if (!isFsError(e)) throw e;
    throw new WriteFail(e.dest ?? e.path, e.errno);
  }
}

export const writeText = (p: string, text: string) => writing(() => writeFileSync(p, encode(text)));
export const readBytes = (p: string): Uint8Array => readFileSync(p);
export const writeBytes = (p: string, data: Uint8Array) => writeFileSync(p, data);
export const mkdirs = (p: string) => mkdirSync(p, { recursive: true });

export function readDisk(p: string): File {
  if (isSymlink(p)) return { data: encode(readlinkSync(p)), mode: LINK };
  return { data: readFileSync(p), mode: executable(p) ? 0o755 : 0o644 };
}

export function writeDisk(p: string, { data, mode }: File): void {
  writing(() => {
    mkdirs(dirname(p));
    if (isSymlink(p) || existsSync(p)) unlinkSync(p);
    if (mode === LINK) symlinkSync(decode(data), p);
    else {
      writeFileSync(p, data);
      chmodSync(p, mode);
    }
  });
}

/** `sorted(Path(dir).rglob("*" + suffix))`, relative to dir, in pathlib's order: by path component. A folder it can't read is skipped, and listed in `unreadable` when given. */
export function rglob(dir: string, suffix: string, unreadable?: string[]): string[] {
  const found: string[][] = [];
  const walk = (parts: string[]) => {
    let names: string[];
    try {
      names = readdirSync(join(dir, ...parts));
    } catch {
      unreadable?.push(parts.join("/") || ".");
      return;
    }
    for (const name of names) {
      const here = [...parts, name];
      if (name.endsWith(suffix)) found.push(here);
      if (lstatSync(join(dir, ...here)).isDirectory()) walk(here);
    }
  };
  walk([]);
  return found.sort(compareParts).map((parts) => parts.join("/"));
}

/** The folders in dir that hold `name`, as `sorted(Path(dir).glob("*" + "/" + name))` orders them. */
export function foldersWith(dir: string, name: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => lexists(join(dir, n, name))).sort((a, b) => compareParts([a], [b]));
}

export const isEmptyDir = (p: string) => readdirSync(p).length === 0;

export function isRealDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Everything under dir that isn't a folder, relative to dir. A folder it can't read, which may hold more, goes in `unreadable` when given. */
export function nonFolders(dir: string, unreadable?: string[]): string[] {
  return rglob(dir, "", unreadable).filter((p) => !isRealDir(join(dir, p)));
}

/** Removes dir and the folders in it, deepest first. A rmdir fails on a file, so none is lost. */
export function rmFolders(dir: string): void {
  for (const p of rglob(dir, "").reverse()) rmdirSync(join(dir, p));
  rmdirSync(dir);
}
