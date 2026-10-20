// Block entries: a paragraph of an upstream file, keyed by the hash of its text, with its patched text.
// An entry for one of several identical paragraphs also names which one it is.
// Also the rules a block is checked against: [[check]] patterns, placeholders and the hooks.
import type { InBlock, InOutput, Nearest, Occurrence, Problem } from "./api.ts";
import { Book, type Check, escape } from "./book.ts";
import { Fail } from "./lib/fail.ts";
import { pjoin, readText } from "./lib/fs.ts";
import { sha256 } from "./lib/hash.ts";
import { lineChanges, similarity } from "./lib/match.ts";
import { list, readJson, type Shape, ShapeError, shown, string, table } from "./lib/shape.ts";
import { verbatim } from "./lib/term.ts";
import { byCodePoint, decode, quote } from "./lib/text.ts";

export const ENTRY_FIELDS = ["kind", "rules", "intent"] as const;
export const ENTRY_KINDS = ["translation", "policy", "keep"];
export const PLACEHOLDER_HINT = /\{\{[\p{L}\p{N}_]+:[^}]+\}\}/gu;
const FENCE = /^\s*(`{3,}|~{3,})/;
const ENTRY_HEAD = /^=== entry ([0-9a-f]{12})(?: ([1-9][0-9]*) of ([1-9][0-9]*) between ([0-9a-f]{12}))?$/;

/** An entry with `at` patches only that occurrence of its paragraph. One without patches every occurrence that has no entry of its own. */
export type Entry = { hash: string; at?: Occurrence; kind: string; rules: string; intent: string; upstream: string; patched: string };
/** A block of a file: lines [start, end), its text with no CR at the line ends, the hash of that text, and which of the file's
 * blocks with that text it is. */
export type Block = { start: number; end: number; text: string; hash: string } & Occurrence;
/** A block with no entry, which an orphaned entry may have become. */
export type Unmatched = { line: number; hash: string; upstream: string };

export function blockHash(block: string): string {
  return sha256(block).slice(0, 12);
}

/** How an entries file names an entry: its hash, then the occurrence it patches, if it patches only one. */
export const entryKey = (hash: string, at?: Occurrence): string => (at ? `${hash} ${at.nth} of ${at.of} between ${at.between}` : hash);

/** The key of the entry that patches a block: the block's own, else the one for its text. */
export function keyFor(entries: ReadonlyMap<string, unknown>, b: Block): string | undefined {
  const own = entryKey(b.hash, b);
  return entries.has(own) ? own : entries.has(b.hash) ? b.hash : undefined;
}

const cr = (line: string): string => (line.endsWith("\r") ? "\r" : "");

/** The line that closes the frontmatter, or -1. A CRLF file's frontmatter has a CR on every line up to the closing one. */
function frontmatterClose(lines: readonly string[]): number {
  if (lines[0] === "---") return lines.indexOf("---", 1);
  if (lines[0] !== "---\r") return -1;
  for (let i = 1; i < lines.length && cr(lines[i]!); i++) if (lines[i] === "---\r") return i;
  return -1;
}

/** Line ranges of a file's blocks: the frontmatter, then each run of non-blank lines.
 *
 * Blank lines inside a Markdown code fence don't end a block. */
export function blockSpans(lines: readonly string[]): [number, number][] {
  const spans: [number, number][] = [];
  let first = 0;
  const close = frontmatterClose(lines);
  if (close !== -1) {
    first = close + 1;
    spans.push([0, first]);
  }
  let start: number | null = null;
  let fence: string | null = null;
  for (let i = first; i < lines.length; i++) {
    const line = lines[i]!;
    const stripped = line.trim();
    const m = FENCE.exec(line);
    if (fence === null && m) fence = m[1]!;
    else if (fence && stripped && [...stripped].every((c) => c === fence![0]) && stripped.length >= fence.length) fence = null;
    if (stripped || fence) start ??= i;
    else if (start !== null) {
      spans.push([start, i]);
      start = null;
    }
  }
  if (start !== null) spans.push([start, lines.length]);
  return spans;
}

export function blocksOf(lines: readonly string[]): Block[] {
  const blocks = blockSpans(lines).map(([start, end]) => {
    const text = lines.slice(start, end).map((line) => line.slice(0, line.length - cr(line).length)).join("\n");
    return { start, end, text, hash: blockHash(text), nth: 1, of: 1, between: "" };
  });
  // Upstream can move identical paragraphs and keep their count, so the stretch to the identical ones on each side tells them apart.
  const hashes = (from: number, to: number) => blocks.slice(from, to).map((b) => b.hash).join(" ");
  for (const same of Map.groupBy(blocks.keys(), (k) => blocks[k]!.hash).values()) {
    if (same.length < 2) continue;
    for (const [i, k] of same.entries()) {
      const between = blockHash(`${hashes((same[i - 1] ?? -1) + 1, k)} | ${hashes(k + 1, same[i + 1] ?? blocks.length)}`);
      Object.assign(blocks[k]!, { nth: i + 1, of: same.length, between });
    }
  }
  return blocks;
}

/** The blocks an edit from `lines` to `to` changes, and the block on each side of each change, which an insert may be next to. */
function touched(lines: readonly string[], to: readonly string[], blocks: readonly Block[]): Set<Block> {
  const found = new Set<Block>();
  for (const [i1, i2] of lineChanges(lines, to)) {
    const inside = blocks.filter((b) => b.start < i2 && i1 < b.end);
    for (const b of [blocks.findLast((b) => b.end <= i1), ...inside, blocks.find((b) => b.start >= i2)]) if (b) found.add(b);
  }
  return found;
}

/** Whether a merge keeps a different number of copies of a paragraph than `ours` adds or removes, unless upstream already made the
 * same change and the merge kept it. `git merge-file` reads a moved paragraph as a delete and an insert, so it can bring back a
 * paragraph ours deletes, or keep one copy where both sides insert the same paragraph in one place, without a conflict. Only text
 * that both base and `theirs` hold is counted. Other text is an edit, which a merge combines, and two edits that meet conflict. */
function recounts(base: readonly Block[], ours: readonly Block[], theirs: readonly Block[], merged: readonly Block[]): boolean {
  const counts = (blocks: readonly Block[]) => {
    const found = new Map<string, number>();
    for (const b of blocks) found.set(b.hash, (found.get(b.hash) ?? 0) + 1);
    return found;
  };
  const [b, o, t, m] = [counts(base), counts(ours), counts(theirs), counts(merged)];
  const n = (found: Map<string, number>, hash: string) => found.get(hash) ?? 0;
  return [...b.keys()].filter((hash) => t.has(hash)).some((hash) => {
    const change = n(o, hash) - n(b, hash);
    const kept = n(m, hash) - n(t, hash);
    return change !== kept && !(n(t, hash) - n(b, hash) === change && kept === 0);
  });
}

export type Lost = "count" | "copy";

/** How a clean merge of `ours` onto `theirs` loses ours's edit, if it does: `count` when it keeps a different number of copies of a
 * paragraph than ours adds or removes, and `copy` when it edits other copies of a repeated paragraph than ours edits in `base`, or
 * leaves out the edit. Copies are told apart as occurrence entries are, so `copy` holds once upstream moves what lies around an
 * edited copy. */
export function lostEdit(base: string, ours: string, theirs: string, merged: string): Lost | null {
  const [old, fresh] = [base.split("\n"), theirs.split("\n")];
  const [oldBlocks, freshBlocks] = [blocksOf(old), blocksOf(fresh)];
  if (recounts(oldBlocks, blocksOf(ours.split("\n")), freshBlocks, blocksOf(merged.split("\n")))) return "count";
  const repeated = new Set([...oldBlocks, ...freshBlocks].filter((b) => b.of > 1).map((b) => b.hash));
  if (!repeated.size) return null;
  const keys = (lines: string[], to: string, blocks: Block[]) =>
    [...touched(lines, to.split("\n"), blocks)].filter((b) => repeated.has(b.hash)).map((b) => entryKey(b.hash, b)).sort(byCodePoint).join("\n");
  return keys(old, ours, oldBlocks) === keys(fresh, merged, freshBlocks) ? null : "copy";
}

export function entriesPath(book: Book, rel: string): string {
  return book.data("blocks", `${rel}.entries`);
}

/** Parse an entries file into {key: entry}, keyed as entryKey names them. Field problems are left for checkEntry. */
export function readEntries(path: string): Map<string, Entry> {
  type Draft = { [K in "hash" | (typeof ENTRY_FIELDS)[number]]: string } & { at?: Occurrence; upstream: string[]; patched: string[] };
  const drafts = new Map<string, Draft>();
  let entry: Draft | null = null;
  let section: "fields" | "upstream" | "patched" = "fields";
  let lastField: string | null = null;
  for (const [i, line] of readText(path).split("\n").entries()) {
    const n = i + 1;
    const m = ENTRY_HEAD.exec(line);
    if (m) {
      const at = m[2] ? { nth: Number(m[2]), of: Number(m[3]), between: m[4]! } : undefined;
      const key = entryKey(m[1]!, at);
      if (drafts.has(key)) throw new Fail(`${path}:${n}: duplicate entry ${key}`);
      entry = { hash: m[1]!, ...(at && { at }), kind: "", rules: "", intent: "", upstream: [], patched: [] };
      drafts.set(key, entry);
      section = "fields";
      lastField = null;
    } else if (entry === null) {
      if (line.trim()) throw new Fail(`${path}:${n}: text before the first entry`);
    } else if (line === "--- upstream" || line === "--- patched") section = line === "--- upstream" ? "upstream" : "patched";
    else if (section === "fields") {
      const sep = line.indexOf(": ");
      const name = sep === -1 ? line : line.slice(0, sep);
      const field = ENTRY_FIELDS.find((f) => f === name);
      if (field && sep !== -1) {
        entry[field] = line.slice(sep + 2).trim();
        lastField = field;
      } else if (line.trim() && lastField === "intent") entry.intent += " " + line.trim();
      else if (line.trim()) throw new Fail(`${path}:${n}: expected one of ${ENTRY_FIELDS.join(", ")}`);
    } else entry[section].push(line);
  }
  return new Map(
    Array.from(drafts, ([h, d]) => [h, { ...d, upstream: d.upstream.join("\n").replace(/^\n+|\n+$/g, ""), patched: d.patched.join("\n").replace(/^\n+|\n+$/g, "") }]),
  );
}

export function formatEntry(e: Entry): string {
  return `=== entry ${entryKey(e.hash, e.at)}\n` + ENTRY_FIELDS.map((f) => `${f}: ${e[f]}\n`).join("")
    + `--- upstream\n${e.upstream}\n--- patched\n${e.patched}\n`;
}

export function checkEntry(e: Entry): string | null {
  if (blockHash(e.upstream) !== e.hash) return "its upstream text does not match its hash";
  if (!ENTRY_KINDS.includes(e.kind)) return `kind must be one of ${ENTRY_KINDS.join(", ")}`;
  if (!e.intent) return "it has no intent; fill it with `patchbook intent`";
  if (e.kind === "translation" && !e.rules) return "a translation must name its rules";
  if (e.kind === "keep" && e.patched !== e.upstream) return "a keep entry must leave the block unchanged";
  return null;
}

export function nearest(text: string, candidates: readonly Unmatched[], limit = 2): Nearest[] {
  const scored = candidates
    .map((c) => [similarity(text, c.upstream), c] as const)
    .sort((x, y) => y[0] - x[0]);
  return scored.slice(0, limit).filter(([s]) => s >= 0.4).map(([s, c]) => ({ line: c.line, hash: c.hash, similarity: s }));
}

export function orphan(rel: string, entry: Entry, candidates: readonly Unmatched[]): Problem {
  return {
    problem: "orphan", file: rel, hash: entry.hash, ...(entry.at && { occurrence: entry.at }), kind: entry.kind, rules: entry.rules,
    intent: entry.intent, upstream: entry.upstream, patched: entry.patched, nearest: nearest(entry.upstream, candidates),
  };
}

const VALUE: Shape<string> = (v, at) => {
  if (Array.isArray(v)) return list(string)(v, at).join(", ");
  if (typeof v === "string") return v;
  throw new ShapeError(at, `must be a string or a list of strings, not ${shown(v)}`);
};

const PLACEHOLDERS: Shape<Map<string, string>> = (v, at) =>
  new Map(Object.entries(table(v, at)).filter(([k]) => !k.startsWith("_")).map(([k, x]) => [k, VALUE(x, quote(k))]));

export function parsePlaceholders(text: string, file: string): Map<string, string> {
  return readJson(text, PLACEHOLDERS, file);
}

export class Rules {
  private readonly placeholder: RegExp | null;
  private readonly loaded = new Map<string, Map<string, string>>();

  constructor(private readonly book: Book, readonly outputs: ReadonlySet<string>) {
    const kinds = Array.from(book.placeholders.keys());
    this.placeholder = kinds.length ? new RegExp(`\\{\\{(${kinds.map(escape).join("|")}):([^}]+)\\}\\}`, "gu") : null;
  }

  private checksOf(outPath: string): Check[] {
    return this.book.checks.filter((c) => c.files.some((r) => r.test(outPath)) && !c.exclude.some((r) => r.test(outPath)));
  }

  watches(outPath: string): boolean {
    return this.book.hooks.blockTerms !== undefined || this.checksOf(outPath).length > 0;
  }

  terms(outPath: string, block: string): string[] {
    const found = new Set<string>();
    for (const c of this.checksOf(outPath)) {
      for (const m of block.matchAll(c.pattern)) found.add(m[0]);
    }
    const hook = this.book.hooks.blockTerms;
    if (hook) for (const t of hook(outPath, block, this.outputs)) found.add(t);
    return [...found].sort(byCodePoint);
  }

  private source(kind: string): Map<string, string> {
    let values = this.loaded.get(kind);
    if (values) return values;
    values = new Map();
    const spec = this.book.placeholders.get(kind);
    if (spec?.file != null) {
      const text = readText(pjoin(this.book.root, spec.file));
      if (spec.format === "sections") {
        const lines = new Map<string, string[]>();
        let name: string | null = null;
        for (const line of text.split("\n")) {
          if (line.startsWith("## ")) {
            name = line.slice(3).trim();
            lines.set(name, []);
          } else if (name) lines.get(name)!.push(line);
        }
        for (const [k, v] of lines) values.set(k, v.join("\n").trim());
      } else values = parsePlaceholders(text, spec.file);
    }
    this.loaded.set(kind, values);
    return values;
  }

  /** Whether the text holds a placeholder of a configured kind. */
  uses(text: string): boolean {
    return this.placeholder !== null && text.search(this.placeholder) !== -1;
  }

  /** Fill in `{{kind:name}}`, reporting each placeholder it can't fill. */
  expand(text: string, report: (detail: string) => void): string {
    if (!this.placeholder) return text;
    const hook = this.book.hooks.placeholder;
    return text.replace(this.placeholder, (m: string, kind: string, name: string) => {
      const value = (hook ? hook(kind, name) : null) ?? this.source(kind).get(name);
      if (value === undefined) {
        report(`unknown ${kind} ${quote(name)}`);
        return m;
      }
      return value;
    });
  }
}

export function leakScan(rules: Rules, outPath: string, text: string, problems: Problem[], where: InOutput): void {
  for (const b of blocksOf(text.split("\n"))) {
    const terms = rules.terms(outPath, b.text);
    if (terms.length) problems.push({ problem: "leak", ...where, line: b.start + 1, terms });
  }
}

/** Swap each block that has an entry for its patched text, with the line ends of the block it replaces. If owners is given, it
 * gets, for each output line, the index of the upstream block it came from, or null for the lines between blocks. */
export function patchBlocks(args: {
  rules: Rules;
  outPath: string;
  rel: string;
  text: string;
  entries: ReadonlyMap<string, Entry>;
  used?: Set<string>;
  unmatched?: Unmatched[];
  problems?: Problem[];
  owners?: (number | null)[];
}): { text: string; applied: number } {
  const { rules, outPath, rel, text, entries, used = new Set(), unmatched = [], problems = [], owners } = args;
  if (!entries.size && owners === undefined && !rules.watches(outPath)) return { text, applied: 0 };
  const lines = text.split("\n");
  const blocks = blocksOf(lines);
  const out: string[] = [];
  let prev = 0;
  let applied = 0;
  const emit = (chunk: readonly string[], owner: number | null) => {
    for (const line of chunk) {
      out.push(line);
      owners?.push(owner);
    }
  };
  for (const [i, b] of blocks.entries()) {
    const { start, end } = b;
    const where: InBlock = { file: rel, output: outPath, line: start + 1, hash: b.hash };
    emit(lines.slice(prev, start), null);
    prev = end;
    const key = keyFor(entries, b);
    if (key === undefined) {
      unmatched.push({ line: start + 1, hash: b.hash, upstream: b.text });
      const terms = rules.terms(outPath, b.text);
      if (terms.length) problems.push({ problem: "missing", ...where, terms, upstream: b.text });
      emit(lines.slice(start, end), i);
      continue;
    }
    const entry = entries.get(key)!;
    used.add(key);
    const error = checkEntry(entry);
    if (error) problems.push({ problem: "invalid", ...where, detail: error });
    applied++;
    const patched = rules.expand(entry.patched, (detail) => problems.push({ problem: "placeholder", ...where, detail }));
    if (entry.kind !== "keep") {
      const terms = rules.terms(outPath, patched);
      if (terms.length) problems.push({ problem: "leak", ...where, terms });
    }
    const eol = (last: boolean) => cr(lines[last ? end - 1 : start]!);
    if (patched) emit(patched.split("\n").map((line, j, all) => line + eol(j === all.length - 1)), i);
    else if (i + 1 < blocks.length) prev = blocks[i + 1]!.start; // drop the blank lines after a deleted block
  }
  emit(lines.slice(prev), null);
  return { text: out.join("\n"), applied };
}

export async function cmdBlocks(args: { file: string }) {
  const book = await Book.find();
  const file = book.stagedUpstream().get(args.file);
  if (!file) throw new Fail(`upstream has no ${args.file}`);
  for (const b of blocksOf(decode(file.data).split("\n"))) {
    verbatim(`=== line ${b.start + 1} [${b.of > 1 ? entryKey(b.hash, b) : b.hash}]\n${b.text}\n\n`);
  }
  return 0;
}
