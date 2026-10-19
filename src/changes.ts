// Changes: a CHANGE.md with an intent and a list of edits, and the files those edits carry.
import { appendFileSync, chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Problem } from "./api.ts";
import { Book } from "./book.ts";
import { unifiedDiff } from "./lib/difflib.ts";
import { Fail } from "./lib/fail.ts";
import { exists, foldersWith, isSymlink, LINK, lexists, mkdirs, type Mode, readDisk, readText, writeDisk, writeText } from "./lib/fs.ts";
import { decodeReplace, lines } from "./lib/text.ts";

export const EDIT_KINDS = ["file", "add", "replace", "delete", "move", "copy"] as const;
type EditKind = (typeof EDIT_KINDS)[number];

export type Edit =
  | { kind: Exclude<EditKind, "move" | "copy">; path: string }
  | { kind: "move" | "copy"; path: string; dest: string };

export const CHANGE_NAME = /^[a-z0-9][a-z0-9-]*$/;

export const notAChangeName = (name: string) =>
  `${JSON.stringify(name)} isn't a valid change name; use lowercase letters, digits and hyphens, starting with a letter or digit`;

export function editText(e: Edit): string {
  return `${e.kind} ${e.path}` + ("dest" in e && e.dest ? ` -> ${e.dest}` : "");
}

export type Side = "base" | "ours";

export class Change {
  constructor(
    readonly name: string,
    readonly dir: string,
    public intent: string | null = "",
    public edits: Edit[] = [],
    readonly held: string[] = [],
  ) {}

  content(side: Side, path: string): string {
    return join(this.dir, side, `${path}.pb`);
  }

  read(side: Side, path: string): Uint8Array | null {
    const p = this.content(side, path);
    return lexists(p) ? readDisk(p).data : null;
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

const EDIT_LINE = /^- ([\p{L}\p{N}_]+) (.+?)(?: -> (.+))?$/su;
const OUTER_SLASHES = /^\/+|\/+$/g;

function unsafePath(raw: string): string | null {
  if (!raw.startsWith("/") && !raw.replace(OUTER_SLASHES, "").split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  return `${JSON.stringify(raw)} must be a path inside the tree: not absolute, with no empty, . or .. segment`;
}

function isEditKind(kind: string): kind is EditKind {
  return EDIT_KINDS.some((k) => k === kind);
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
      const m = EDIT_LINE.exec(line.trim());
      const kind = m?.[1];
      if (!m || kind === undefined || !isEditKind(kind)) throw new Fail(`${path}:${n}: expected \`- <${EDIT_KINDS.join("|")}> <path>\``);
      const [, , src = "", dest] = m;
      if ((kind === "move" || kind === "copy") !== Boolean(dest)) throw new Fail(`${path}:${n}: only move and copy take \`-> <path>\``);
      const unsafe = unsafePath(src) ?? (dest === undefined ? null : unsafePath(dest));
      if (unsafe) {
        change.held.push(line);
        reject(line.trim().slice(2), unsafe);
      } else {
        change.edits.push(
          kind === "move" || kind === "copy" ? { kind, path: src.replace(OUTER_SLASHES, ""), dest: (dest ?? "").replace(OUTER_SLASHES, "") } : { kind, path: src.replace(OUTER_SLASHES, "") },
        );
      }
    }
  }
  return change;
}

export function formatChange(change: Change): string {
  const edits = change.edits.map((e) => `- ${editText(e)}\n`).join("") + change.held.map((l) => `${l}\n`).join("");
  return `# ${change.name}\n\nintent: ${change.intent ?? "None"}\n\nedits:\n${edits}`;
}

export function saveChange(change: Change): void {
  mkdirs(change.dir);
  writeText(join(change.dir, "CHANGE.md"), formatChange(change));
}

export function readSeries(book: Book): string[] {
  const path = join(book.dir, "series");
  const names = exists(path) ? readText(path).split("\n").map((l) => l.trim()) : [];
  return names.filter((n) => n && !n.startsWith("#"));
}

export function appendSeries(book: Book, name: string): void {
  appendFileSync(join(book.dir, "series"), name + "\n");
}

export function readChanges(book: Book, problems: Problem[]): Change[] {
  const changes: Change[] = [];
  const series = readSeries(book);
  for (const name of series) {
    if (!CHANGE_NAME.test(name)) {
      problems.push({ problem: "invalid", file: "series", detail: notAChangeName(name), refuse: true });
      continue;
    }
    const path = join(book.dir, "changes", name, "CHANGE.md");
    if (!exists(path)) {
      problems.push({ problem: "invalid", file: "series", detail: `no change called ${name}` });
      continue;
    }
    changes.push(parseChange(path, (edit, detail) => problems.push({ problem: "invalid", file: `changes/${name}`, edit, detail, refuse: true })));
  }
  const listed = new Set(changes.map((c) => c.name));
  for (const name of foldersWith(join(book.dir, "changes"), "CHANGE.md")) {
    if (listed.has(name) || series.includes(name)) continue;
    problems.push(
      CHANGE_NAME.test(name)
        ? { problem: "invalid", file: "series", detail: `change ${name} is not in the series` }
        : { problem: "invalid", file: "series", detail: notAChangeName(name), refuse: true },
    );
  }
  for (const c of changes) {
    if (!c.intent) problems.push({ problem: "invalid", file: `changes/${c.name}`, detail: "it has no intent" });
  }
  return changes;
}

export async function cmdShow(args: { change: string }) {
  const book = await Book.find();
  const path = join(book.dir, "changes", args.change, "CHANGE.md");
  if (!CHANGE_NAME.test(args.change) || !exists(path)) throw new Fail(`no change called ${args.change}`);
  const rejected: string[] = [];
  const c = parseChange(path, (edit, detail) => rejected.push(`invalid ${edit}: ${detail}\n`));
  process.stdout.write(`${c.name}: ${c.intent}\n\n`);
  process.stdout.write(rejected.join(""));
  for (const e of c.edits) {
    if (e.kind === "file") {
      const base = lines(decodeReplace(c.read("base", e.path) ?? new Uint8Array()));
      const ours = lines(decodeReplace(c.read("ours", e.path) ?? new Uint8Array()));
      process.stdout.write(unifiedDiff(base, ours, `upstream/${e.path}`, `ours/${e.path}`));
    } else if (e.kind === "add" || e.kind === "replace") {
      process.stdout.write(`${editText(e)} (${(c.read("ours", e.path) ?? new Uint8Array()).length} bytes)\n`);
    } else process.stdout.write(editText(e) + "\n");
  }
  return 0;
}

