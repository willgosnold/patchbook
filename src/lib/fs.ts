// Files as pathlib reads and writes them: text with universal newlines, and bytes with a mode.
import {
  accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative as rel, resolve as absolute } from "node:path";
import { compareParts } from "./py.ts";
import { bytesEqual, decode, decodeReplace, encode } from "./text.ts";

export const LINK = 0o120000;
export type Mode = 0o644 | 0o755 | typeof LINK;
/** A file as git stores it: its bytes, or a symlink's target, and its mode. */
export type File = { data: Uint8Array; mode: Mode };

export function normMode(mode: number): Mode {
  if (mode === LINK) return LINK;
  return mode & 0o111 ? 0o755 : 0o644;
}

export function isMode(mode: unknown): mode is Mode {
  return mode === 0o644 || mode === 0o755 || mode === LINK;
}

export function sameFile(a: File | undefined, b: File | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.mode === b.mode && bytesEqual(a.data, b.data);
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
export const writeText = (p: string, text: string) => writeFileSync(p, encode(text));
export const readBytes = (p: string): Uint8Array => readFileSync(p);
export const mkdirs = (p: string) => mkdirSync(p, { recursive: true });

export function readDisk(p: string): File {
  if (isSymlink(p)) return { data: encode(readlinkSync(p)), mode: LINK };
  return { data: readFileSync(p), mode: executable(p) ? 0o755 : 0o644 };
}

export function writeDisk(p: string, { data, mode }: File): void {
  mkdirs(dirname(p));
  if (isSymlink(p) || existsSync(p)) unlinkSync(p);
  if (mode === LINK) symlinkSync(decode(data), p);
  else {
    writeFileSync(p, data);
    chmodSync(p, mode);
  }
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

/** Everything under dir that isn't a folder, relative to dir, and any folder in it that can't be read, since it may hold more. */
export function nonFolders(dir: string): string[] {
  const unreadable: string[] = [];
  const files = rglob(dir, "", unreadable).filter((p) => !isRealDir(join(dir, p)));
  return [...files, ...unreadable];
}

/** Removes dir and the folders in it, deepest first. A rmdir fails on a file, so none is lost. */
export function rmFolders(dir: string): void {
  for (const p of rglob(dir, "").reverse()) rmdirSync(join(dir, p));
  rmdirSync(dir);
}
