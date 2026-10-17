// Changes: a CHANGE.md with an intent and a list of edits, and the files those edits carry.
import { appendFileSync, chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Problem } from "./assemble.ts";
import { Book } from "./book.ts";
import { unifiedDiff } from "./lib/difflib.ts";
import { Fail } from "./lib/fail.ts";
import { exists, foldersWith, isSymlink, LINK, lexists, mkdirs, type Mode, readDisk, readText, writeDisk, writeText } from "./lib/fs.ts";
import { splitlines, strip, W } from "./lib/py.ts";
import { decodeReplace } from "./lib/text.ts";

export const EDIT_KINDS = ["file", "add", "replace", "delete", "move", "copy"] as const;
type EditKind = (typeof EDIT_KINDS)[number];

export type Edit =
  | { kind: Exclude<EditKind, "move" | "copy">; path: string }
  | { kind: "move" | "copy"; path: string; dest: string };

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

const EDIT_LINE = new RegExp(`^- ([${W}]+) (.+?)(?: -> (.+))?$`, "su");

function isEditKind(kind: string): kind is EditKind {
  return EDIT_KINDS.some((k) => k === kind);
}

export function parseChange(path: string): Change {
  const change = new Change(basename(dirname(path)), dirname(path));
  let section: "intent" | "edits" | null = null;
  for (const [i, line] of readText(path).split("\n").entries()) {
    const n = i + 1;
    if (line.startsWith("# ") && section === null) continue;
    if (line.startsWith("intent:")) {
      section = "intent";
      change.intent = strip(line.slice("intent:".length));
    } else if (strip(line) === "edits:") section = "edits";
    else if (section === "intent" && strip(line)) change.intent += " " + strip(line);
    else if (section === "edits" && strip(line)) {
      const m = EDIT_LINE.exec(strip(line));
      const kind = m?.[1];
      if (!m || kind === undefined || !isEditKind(kind)) throw new Fail(`${path}:${n}: expected \`- <${EDIT_KINDS.join("|")}> <path>\``);
      const [, , src = "", dest] = m;
      if ((kind === "move" || kind === "copy") !== Boolean(dest)) throw new Fail(`${path}:${n}: only move and copy take \`-> <path>\``);
      change.edits.push(
        kind === "move" || kind === "copy" ? { kind, path: strip(src, "/"), dest: strip(dest ?? "", "/") } : { kind, path: strip(src, "/") },
      );
    }
  }
  return change;
}

export function formatChange(change: Change): string {
  const edits = change.edits.map((e) => `- ${editText(e)}\n`).join("");
  return `# ${change.name}\n\nintent: ${change.intent ?? "None"}\n\nedits:\n${edits}`;
}

export function saveChange(change: Change): void {
  mkdirs(change.dir);
  writeText(join(change.dir, "CHANGE.md"), formatChange(change));
}

export function readSeries(book: Book): string[] {
  const path = join(book.dir, "series");
  const names = exists(path) ? readText(path).split("\n").map((l) => strip(l)) : [];
  return names.filter((n) => n && !n.startsWith("#"));
}

export function appendSeries(book: Book, name: string): void {
  appendFileSync(join(book.dir, "series"), name + "\n");
}

export function readChanges(book: Book, problems: Problem[]): Change[] {
  const changes: Change[] = [];
  for (const name of readSeries(book)) {
    const path = join(book.dir, "changes", name, "CHANGE.md");
    if (!exists(path)) {
      problems.push({ problem: "invalid", file: "series", detail: `no change called ${name}` });
      continue;
    }
    changes.push(parseChange(path));
  }
  const listed = new Set(changes.map((c) => c.name));
  for (const name of foldersWith(join(book.dir, "changes"), "CHANGE.md")) {
    if (!listed.has(name)) problems.push({ problem: "invalid", file: "series", detail: `change ${name} is not in the series` });
  }
  for (const c of changes) {
    if (!c.intent) problems.push({ problem: "invalid", file: `changes/${c.name}`, detail: "it has no intent" });
  }
  return changes;
}

export async function cmdShow(args: { change: string }) {
  const book = await Book.find();
  const path = join(book.dir, "changes", args.change, "CHANGE.md");
  if (!exists(path)) throw new Fail(`no change called ${args.change}`);
  const c = parseChange(path);
  process.stdout.write(`${c.name}: ${c.intent}\n\n`);
  for (const e of c.edits) {
    if (e.kind === "file") {
      const base = splitlines(decodeReplace(c.read("base", e.path) ?? new Uint8Array()), true);
      const ours = splitlines(decodeReplace(c.read("ours", e.path) ?? new Uint8Array()), true);
      process.stdout.write(unifiedDiff(base, ours, `upstream/${e.path}`, `ours/${e.path}`));
    } else if (e.kind === "add" || e.kind === "replace") {
      process.stdout.write(`${editText(e)} (${(c.read("ours", e.path) ?? new Uint8Array()).length} bytes)\n`);
    } else process.stdout.write(editText(e) + "\n");
  }
  return 0;
}

