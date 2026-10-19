import { chmodSync, lstatSync, readdirSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { type File, isDir, isSymlink, LINK, lexists, mkdirs, readDisk, sameFile, writeDisk } from "./lib/fs.ts";

const isFolder = (p: string) => isDir(p) && !isSymlink(p);

/** A file as it was, with its own permission bits: `File` keeps only the 644 or 755 git stores. */
type Held = { file: File; bits: number };

const grab = (p: string): Held => ({ file: readDisk(p), bits: lstatSync(p).mode & 0o7777 });

const modeOf = (dir: string) => lstatSync(dir).mode & 0o7777;

type Found = { files: Map<string, Held>; folders: Map<string, number>; unread: Set<string>; links: Set<string> };

const found = (): Found => ({ files: new Map(), folders: new Map(), unread: new Set(), links: new Set() });

/** What it can't read it leaves alone, as `rglob` does, so a restore neither rewrites nor removes it. */
function walk(dir: string, into: Found): void {
  let names: string[];
  try {
    names = readdirSync(dir);
    into.folders.set(dir, modeOf(dir));
  } catch {
    into.unread.add(dir);
    return;
  }
  for (const name of names) {
    const p = join(dir, name);
    if (isFolder(p)) {
      walk(p, into);
      continue;
    }
    if (isSymlink(p)) into.links.add(p);
    try {
      into.files.set(p, grab(p));
    } catch {
      into.unread.add(p);
    }
  }
}

/** The links in a folder tree, which a restore can't undo a write through. A folder that is itself a link has none to report. */
export function linksUnder(dir: string): string[] {
  const into = found();
  if (isFolder(dir)) walk(dir, into);
  return [...into.links];
}

export class Undo {
  private readonly files = new Map<string, Held | null>();
  private readonly folders = new Map<string, number>();
  private readonly unread = new Set<string>();
  private readonly trees: string[] = [];
  private readonly made = new Set<string>();

  hold(path: string): void {
    if (this.files.has(path) || this.trees.some((t) => path === t || path.startsWith(t + sep))) return;
    if (isFolder(path)) {
      const seen = found();
      walk(path, seen);
      for (const [p, f] of seen.files) if (!this.files.has(p)) this.files.set(p, f);
      for (const [dir, mode] of seen.folders) this.folders.set(dir, mode);
      for (const p of seen.unread) this.unread.add(p);
      this.trees.push(path);
      return;
    }
    this.files.set(path, lexists(path) ? grab(path) : null);
    let up = dirname(path);
    for (; !lexists(up); up = dirname(up)) this.made.add(up);
    for (; isFolder(up); up = dirname(up)) {
      this.folders.set(up, modeOf(up));
      if (dirname(up) === up) break;
    }
  }

  restore(): string[] {
    const stuck: string[] = [];
    const attempt = (p: string, step: () => void) => {
      try {
        step();
      } catch {
        stuck.push(p);
      }
    };
    for (const tree of this.trees) this.sweep(tree, attempt);
    for (const dir of this.folders.keys()) attempt(dir, () => mkdirs(dir));
    for (const [p, was] of this.files) {
      attempt(p, () => {
        if (isFolder(p)) rmSync(p, { recursive: true });
        if (was === null) {
          if (lexists(p)) unlinkSync(p);
        } else if (!sameFile(lexists(p) ? readDisk(p) : undefined, was.file) || (was.file.mode !== LINK && modeOf(p) !== was.bits)) {
          writeDisk(p, was.file);
          if (was.file.mode !== LINK) chmodSync(p, was.bits);
        }
      });
    }
    for (const dir of [...this.made].sort((a, b) => b.length - a.length)) attempt(dir, () => lexists(dir) && rmdirSync(dir));
    // Last and deepest first: a folder that was read-only can take its files back only until it is read-only again.
    for (const [dir, mode] of [...this.folders].sort(([a], [b]) => b.length - a.length)) {
      attempt(dir, () => isFolder(dir) && modeOf(dir) !== mode && chmodSync(dir, mode));
    }
    return stuck;
  }

  private sweep(dir: string, attempt: (p: string, step: () => void) => void): void {
    attempt(dir, () => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (this.unread.has(p)) continue;
        if (!isFolder(p)) {
          if (!this.files.has(p)) attempt(p, () => unlinkSync(p));
        } else if (this.folders.has(p)) this.sweep(p, attempt);
        else attempt(p, () => rmSync(p, { recursive: true }));
      }
    });
  }
}
