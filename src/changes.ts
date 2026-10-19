// Changes: a CHANGE.md with an intent and a list of edits, and the files those edits carry.
import { appendFileSync, chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Problem } from "./api.ts";
import { Book } from "./book.ts";
import { unifiedDiff } from "./lib/diff.ts";
import { Fail } from "./lib/fail.ts";
import { exists, type File, foldersWith, isDir, isSymlink, LINK, lexists, mkdirs, type Mode, readDisk, readText, relative, writeDisk, writeText } from "./lib/fs.ts";
import { escaped, say, verbatim } from "./lib/term.ts";
import { decode, encode } from "./lib/text.ts";

export const EDIT_KINDS = ["file", "add", "replace", "delete", "move", "copy"] as const;
type EditKind = (typeof EDIT_KINDS)[number];

export type Edit =
  | { kind: Exclude<EditKind, "move" | "copy">; path: string }
  | { kind: "move" | "copy"; path: string; dest: string };

export const CHANGE_NAME = /^[a-z0-9][a-z0-9-]*$/;

export const notAChangeName = (name: string) =>
  `${JSON.stringify(name)} isn't a valid change name; use lowercase letters, digits and hyphens, starting with a letter or digit`;

const ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, "\\": 92 };

function quotePath(path: string): string {
  let out = '"';
  for (const ch of path) {
    if (ch === '"' || ch === "\\") out += "\\" + ch;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (/\p{Cc}/u.test(ch)) for (const byte of encode(ch)) out += "\\" + byte.toString(8).padStart(3, "0");
    else out += ch;
  }
  return out + '"';
}

/** The quoted path that starts at `start` in `text`, and where its closing quote ends; null if it is not closed, holds an escape git does not write, or is not UTF-8 without a NUL. */
function readQuoted(text: string, start: number): { path: string; end: number } | null {
  const bytes: number[] = [];
  for (let i = start + 1; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    i += ch.length;
    if (ch === '"') {
      try {
        const path = decode(Uint8Array.from(bytes));
        return path.includes("\0") ? null : { path, end: i };
      } catch {
        return null;
      }
    }
    if (ch !== "\\") bytes.push(...encode(ch));
    else {
      const octal = /^[0-3][0-7]{2}/.exec(text.slice(i, i + 3))?.[0];
      const named = ESCAPES[text[i] ?? ""];
      if (octal !== undefined) bytes.push(parseInt(octal, 8));
      else if (named !== undefined) bytes.push(named);
      else return null;
      i += octal === undefined ? 1 : 3;
    }
  }
  return null;
}

function pathText(path: string, place: "single" | "source" | "dest"): string {
  try {
    const read = readPath(place === "source" ? path + ARROW : path, 0, "", place === "dest");
    if (read.path === path && read.end === path.length) return path;
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
  }
  return quotePath(path);
}

export function editText(e: Edit): string {
  return "dest" in e ? `${e.kind} ${pathText(e.path, "source")} -> ${pathText(e.dest, "dest")}` : `${e.kind} ${pathText(e.path, "single")}`;
}

export type Side = "base" | "ours";

export class Change {
  constructor(
    readonly name: string,
    readonly dir: string,
    public intent: string = "",
    public edits: Edit[] = [],
    readonly held: string[] = [],
  ) {}

  /** A link above a copy would take its read or write somewhere else: into another copy, or out of the patchbook. A recorded
   * symlink stored as `<path>.pb` is one, when an output folder shares its name. */
  content(side: Side, path: string): string {
    const parts = [side, ...path.split("/").slice(0, -1)];
    const link = parts.map((_, i) => join(this.dir, ...parts.slice(0, i + 1))).find(isSymlink);
    if (link) {
      throw new Fail(`${relative(join(this.dir, "../../.."), link)} is a link, and the copy of ${path} sits under it, so patchbook would read or write it through the link. `
        + "If an output link and an output folder share its name, rename one of them. Otherwise replace the link with a copy of what it points to.");
    }
    return join(this.dir, side, `${path}.pb`);
  }

  file(side: Side, path: string): File | null {
    const p = this.content(side, path);
    return lexists(p) ? readDisk(p) : null;
  }

  read(side: Side, path: string): Uint8Array | null {
    return this.file(side, path)?.data ?? null;
  }

  write(side: Side, path: string, data: Uint8Array, mode?: Mode): void {
    const p = this.content(side, path);
    if (mode === LINK || (mode === undefined && isSymlink(p))) {
      writeDisk(p, { data, mode: LINK }); // a symlink is stored as one
      return;
    }
    mkdirs(dirname(p));
    if (isSymlink(p)) unlinkSync(p);
    writeFileSync(p, data);
    if (mode !== undefined) chmodSync(p, mode);
  }

  drop(side: Side, path: string): void {
    const p = this.content(side, path);
    if (lexists(p)) unlinkSync(p);
  }
}

const EDIT_START = /^- ([\p{L}\p{N}_]+) /u;
const ARROW = " -> ";

function unsafePath(path: string): string | null {
  if (!path.includes("\\") && !path.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  return `${JSON.stringify(path)} must be a path inside the tree: not absolute, with no empty, . or .. segment, no slash at the end and no backslash`;
}

function isEditKind(kind: string): kind is EditKind {
  return EDIT_KINDS.some((k) => k === kind);
}

const malformed = (where: string) =>
  new Fail(`${where}: a quoted path is malformed; close it with a quote, put nothing after it, and write only \\" \\\\ \\t \\n and \\ooo (three octal digits of a UTF-8 byte) after a backslash`);

function readPath(rest: string, from: number, where: string, isDest = false): { path: string; end: number } {
  if (rest[from] === '"') {
    const quoted = readQuoted(rest, from);
    if (!quoted) throw malformed(where);
    return quoted;
  }
  const stop = isDest ? -1 : rest.indexOf(ARROW, from + 1);
  const end = stop < 0 ? rest.length : stop;
  const path = rest.slice(from, end);
  if (path === "") throw new Fail(`${where}: expected \`- <${EDIT_KINDS.join("|")}> <path>\``);
  if (/^\s|\s$/.test(path)) throw new Fail(`${where}: the path ${JSON.stringify(path)} starts or ends with whitespace; write it in double quotes: ${quotePath(path)}`);
  if (/\p{Cc}/u.test(path)) throw new Fail(`${where}: a bare path can't hold a control character; write it in double quotes: ${quotePath(path)}`);
  return { path, end };
}

/** Read a CHANGE.md. An edit whose path is not a clean path inside the tree is left out of `edits`, kept as written in `held`, and given to `reject`. */
export function parseChange(path: string, reject: (edit: string, detail: string) => void): Change {
  const change = new Change(basename(dirname(path)), dirname(path));
  let section: "intent" | "edits" | null = null;
  for (const [i, line] of readText(path).split("\n").entries()) {
    const n = i + 1;
    if (line.startsWith("# ") && section === null) continue;
    if (line.startsWith("intent:")) {
      section = "intent";
      change.intent = line.slice("intent:".length).trim();
    } else if (line.trim() === "edits:") section = "edits";
    else if (section === "intent" && line.trim()) change.intent += " " + line.trim();
    else if (section === "edits" && line.trim()) {
      const where = `${path}:${n}`;
      const m = EDIT_START.exec(line);
      const kind = m?.[1];
      if (!m || kind === undefined || !isEditKind(kind)) throw new Fail(`${where}: expected \`- <${EDIT_KINDS.join("|")}> <path>\``);
      const rest = line.slice(m[0].length);
      const src = readPath(rest, 0, where);
      const arrow = rest.startsWith(ARROW, src.end) ? src.end + ARROW.length : null;
      if (arrow === null && src.end !== rest.length) throw malformed(where);
      const dest = arrow === null ? undefined : readPath(rest, arrow, where, true);
      if (dest && dest.end !== rest.length) throw malformed(where);
      if ((kind === "move" || kind === "copy") !== (dest !== undefined)) throw new Fail(`${where}: only move and copy take \`-> <path>\``);
      const unsafe = unsafePath(src.path) ?? (dest === undefined ? null : unsafePath(dest.path));
      if (unsafe) {
        change.held.push(line);
        reject(line.slice(2), unsafe);
      } else {
        change.edits.push(kind === "move" || kind === "copy" ? { kind, path: src.path, dest: dest?.path ?? "" } : { kind, path: src.path });
      }
    }
  }
  return change;
}

export function formatChange(change: Change): string {
  const edits = change.edits.map((e) => `- ${editText(e)}\n`).join("") + change.held.map((l) => `${l}\n`).join("");
  return `# ${change.name}\n\nintent: ${change.intent}\n\nedits:\n${edits}`;
}

export function saveChange(change: Change): void {
  mkdirs(change.dir);
  writeText(join(change.dir, "CHANGE.md"), formatChange(change));
}

export function readSeries(book: Book): string[] {
  const path = book.data("series");
  const names = exists(path) ? readText(path).split("\n").map((l) => l.trim()) : [];
  return names.filter((n) => n && !n.startsWith("#"));
}

export function appendSeries(book: Book, name: string): void {
  appendFileSync(book.data("series"), name + "\n");
}

export function readChanges(book: Book, problems: Problem[], names: readonly string[] = readSeries(book)): Change[] {
  const changes: Change[] = [];
  for (const name of names) {
    if (!CHANGE_NAME.test(name)) {
      problems.push({ problem: "invalid", file: "series", detail: notAChangeName(name), refuse: true });
      continue;
    }
    const path = book.data("changes", name, "CHANGE.md");
    if (!exists(path)) {
      problems.push({ problem: "invalid", file: "series", detail: `no change called ${name}` });
      continue;
    }
    changes.push(parseChange(path, (edit, detail) => problems.push({ problem: "invalid", file: `changes/${name}`, edit, detail, refuse: true })));
  }
  const listed = new Set(changes.map((c) => c.name));
  for (const name of foldersWith(book.data("changes"), "CHANGE.md")) {
    if (listed.has(name) || names.includes(name)) continue;
    problems.push(
      CHANGE_NAME.test(name)
        ? { problem: "invalid", file: "series", detail: `change ${name} is not in the series` }
        : { problem: "invalid", file: "series", detail: notAChangeName(name), refuse: true },
    );
  }
  for (const c of changes) {
    if (!c.intent) problems.push({ problem: "invalid", file: `changes/${c.name}`, detail: `it has no intent; fill it with \`patchbook intent ${c.name}\`` });
  }
  return changes;
}

export class Roster {
  private constructor(
    readonly parsed: ReadonlyMap<string, Change>,
    private readonly names: ReadonlySet<string>,
    private readonly dir: string,
  ) {}

  static read(book: Book, problems: Problem[] = []): Roster {
    const names = readSeries(book);
    const parsed = new Map(readChanges(book, problems, names).map((c) => [c.name, c]));
    return new Roster(parsed, new Set(names), join(book.dir, "changes"));
  }

  known(name: string): boolean {
    return this.names.has(name);
  }

  stray(name: string): "folder" | "other" | null {
    const path = join(this.dir, name);
    if (this.known(name) || !lexists(path)) return null;
    return isDir(path) ? "folder" : "other";
  }

  free(base: string): string {
    let name = base;
    for (let n = 2; this.parsed.has(name) || this.stray(name); n++) name = `${base}-${n}`;
    return name;
  }
}

export async function cmdShow(args: { change: string }) {
  const book = await Book.find();
  const path = book.data("changes", args.change, "CHANGE.md");
  if (!CHANGE_NAME.test(args.change) || !exists(path)) throw new Fail(`no change called ${args.change}`);
  const rejected: string[] = [];
  const c = parseChange(path, (edit, detail) => rejected.push(`invalid ${edit}: ${detail}\n`));
  say(`${c.name}: ${c.intent}\n\n`);
  say(rejected.join(""));
  for (const e of c.edits) {
    if (e.kind === "file") {
      const base = c.read("base", e.path) ?? new Uint8Array();
      const ours = c.read("ours", e.path) ?? new Uint8Array();
      verbatim(unifiedDiff(base, ours, escaped(`upstream/${e.path}`), escaped(`ours/${e.path}`)));
    } else if (e.kind === "add" || e.kind === "replace") {
      say(`${editText(e)} (${(c.read("ours", e.path) ?? new Uint8Array()).length} bytes)\n`);
    } else say(editText(e) + "\n");
  }
  return 0;
}

