// Block entries: a paragraph of an upstream file, keyed by the hash of its text, with its patched text.
// Also the rules a block is checked against: [[check]] patterns, placeholders and the hooks.
import { join } from "node:path";
import type { InBlock, InOutput, Nearest, Problem } from "./api.ts";
import { Book, escape } from "./book.ts";
import { SequenceMatcher } from "./lib/difflib.ts";
import { Fail } from "./lib/fail.ts";
import { pjoin, readText } from "./lib/fs.ts";
import { sha256 } from "./lib/hash.ts";
import { loads } from "./lib/json.ts";
import { length, round2, S, sorted, str, strip, strRepr, W } from "./lib/py.ts";
import { decode } from "./lib/text.ts";

export const ENTRY_FIELDS = ["kind", "rules", "intent"] as const;
export const ENTRY_KINDS = ["translation", "policy", "keep"];
export const PLACEHOLDER_HINT = new RegExp(`\\{\\{[${W}]+:[^}]+\\}\\}`, "gu");
const FENCE = new RegExp(`^[${S}]*(\`{3,}|~{3,})`, "u");
const ENTRY_HEAD = /^=== entry ([0-9a-f]{12})$/;

export type Entry = { hash: string; kind: string; rules: string; intent: string; upstream: string; patched: string };
/** A block with no entry, which an orphaned entry may have become. */
export type Unmatched = { line: number; hash: string; upstream: string };

export function blockHash(block: string): string {
  return sha256(block).slice(0, 12);
}

/** Line ranges of a file's blocks: the frontmatter, then each run of non-blank lines.
 *
 * Blank lines inside a Markdown code fence don't end a block. */
export function blockSpans(lines: readonly string[]): [number, number][] {
  const spans: [number, number][] = [];
  let first = 0;
  if (lines.length && lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close !== -1) {
      first = close + 1;
      spans.push([0, first]);
    }
  }
  let start: number | null = null;
  let fence: string | null = null;
  for (let i = first; i < lines.length; i++) {
    const line = lines[i]!;
    const stripped = strip(line);
    const m = FENCE.exec(line);
    if (fence === null && m) fence = m[1]!;
    else if (fence && stripped && [...stripped].every((c) => c === fence![0]) && length(stripped) >= length(fence)) fence = null;
    if (stripped || fence) start ??= i;
    else if (start !== null) {
      spans.push([start, i]);
      start = null;
    }
  }
  if (start !== null) spans.push([start, lines.length]);
  return spans;
}

export function entriesPath(book: Book, rel: string): string {
  return join(book.dir, "blocks", `${rel}.entries`);
}

/** Parse an entries file into {hash: entry}. Field problems are left for checkEntry. */
export function readEntries(path: string): Map<string, Entry> {
  type Draft = { [K in "hash" | (typeof ENTRY_FIELDS)[number]]: string } & { upstream: string[]; patched: string[] };
  const drafts = new Map<string, Draft>();
  let entry: Draft | null = null;
  let section: "fields" | "upstream" | "patched" = "fields";
  let lastField: string | null = null;
  for (const [i, line] of readText(path).split("\n").entries()) {
    const n = i + 1;
    const m = ENTRY_HEAD.exec(line);
    if (m) {
      const hash = m[1]!;
      if (drafts.has(hash)) throw new Fail(`${path}:${n}: duplicate entry ${hash}`);
      entry = { hash, kind: "", rules: "", intent: "", upstream: [], patched: [] };
      drafts.set(hash, entry);
      section = "fields";
      lastField = null;
    } else if (entry === null) {
      if (strip(line)) throw new Fail(`${path}:${n}: text before the first entry`);
    } else if (line === "--- upstream" || line === "--- patched") section = line === "--- upstream" ? "upstream" : "patched";
    else if (section === "fields") {
      const sep = line.indexOf(": ");
      const name = sep === -1 ? line : line.slice(0, sep);
      const field = ENTRY_FIELDS.find((f) => f === name);
      if (field && sep !== -1) {
        entry[field] = strip(line.slice(sep + 2));
        lastField = field;
      } else if (strip(line) && lastField === "intent") entry.intent += " " + strip(line);
      else if (strip(line)) throw new Fail(`${path}:${n}: expected one of ${ENTRY_FIELDS.join(", ")}`);
    } else entry[section].push(line);
  }
  return new Map(
    Array.from(drafts, ([h, d]) => [h, { ...d, upstream: strip(d.upstream.join("\n"), "\n"), patched: strip(d.patched.join("\n"), "\n") }]),
  );
}

export function formatEntry(e: Entry): string {
  return `=== entry ${e.hash}\n` + ENTRY_FIELDS.map((f) => `${f}: ${e[f]}\n`).join("")
    + `--- upstream\n${e.upstream}\n--- patched\n${e.patched}\n`;
}

export function checkEntry(e: Entry): string | null {
  if (blockHash(e.upstream) !== e.hash) return "its upstream text does not match its hash";
  if (!ENTRY_KINDS.includes(e.kind)) return `kind must be one of ${ENTRY_KINDS.join(", ")}`;
  if (!e.intent) return "it has no intent";
  if (e.kind === "translation" && !e.rules) return "a translation must name its rules";
  if (e.kind === "keep" && e.patched !== e.upstream) return "a keep entry must leave the block unchanged";
  return null;
}

export function nearest(text: string, candidates: readonly Unmatched[], limit = 2): Nearest[] {
  const scored = candidates
    .map((c) => [new SequenceMatcher<string>(text, c.upstream).ratio(), c] as const)
    .sort((x, y) => y[0] - x[0]);
  return scored.slice(0, limit).filter(([r]) => r >= 0.4).map(([r, c]) => ({ line: c.line, hash: c.hash, similarity: round2(r).value }));
}

export function orphan(rel: string, entry: Entry, candidates: readonly Unmatched[]): Problem {
  return {
    problem: "orphan", file: rel, hash: entry.hash, kind: entry.kind, rules: entry.rules, intent: entry.intent,
    upstream: entry.upstream, patched: entry.patched, nearest: nearest(entry.upstream, candidates),
  };
}

export class Rules {
  private readonly placeholder: RegExp | null;
  private readonly loaded = new Map<string, Map<string, string>>();

  constructor(private readonly book: Book, readonly outputs: ReadonlySet<string>) {
    const kinds = Array.from(book.placeholders.keys());
    this.placeholder = kinds.length ? new RegExp(`\\{\\{(${kinds.map(escape).join("|")}):([^}]+)\\}\\}`, "gu") : null;
  }

  terms(outPath: string, block: string): string[] {
    const found = new Set<string>();
    for (const c of this.book.checks) {
      if (c.files.some((r) => r.test(outPath)) && !c.exclude.some((r) => r.test(outPath))) {
        for (const m of block.matchAll(c.pattern)) found.add(m[0]);
      }
    }
    const hook = this.book.hooks.blockTerms;
    if (hook) for (const t of hook(outPath, block, this.outputs)) found.add(t);
    return sorted(found);
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
            name = strip(line.slice(3));
            lines.set(name, []);
          } else if (name) lines.get(name)!.push(line);
        }
        for (const [k, v] of lines) values.set(k, strip(v.join("\n")));
      } else {
        const raw = loads(text);
        if (!(raw instanceof Map)) throw new Fail(`${spec.file} must hold a JSON object`);
        for (const [k, v] of raw) if (!k.startsWith("_")) values.set(k, Array.isArray(v) ? v.map(str).join(", ") : str(v));
      }
    }
    this.loaded.set(kind, values);
    return values;
  }

  /** Fill in `{{kind:name}}`, reporting each placeholder it can't fill. */
  expand(text: string, report: (detail: string) => void): string {
    if (!this.placeholder) return text;
    const hook = this.book.hooks.placeholder;
    return text.replace(this.placeholder, (m: string, kind: string, name: string) => {
      const value = (hook ? hook(kind, name) : null) ?? this.source(kind).get(name);
      if (value === undefined) {
        report(`unknown ${kind} ${strRepr(name)}`);
        return m;
      }
      return value;
    });
  }
}

export function leakScan(rules: Rules, outPath: string, text: string, problems: Problem[], where: InOutput): void {
  const lines = text.split("\n");
  for (const [start, end] of blockSpans(lines)) {
    const terms = rules.terms(outPath, lines.slice(start, end).join("\n"));
    if (terms.length) problems.push({ problem: "leak", ...where, line: start + 1, terms });
  }
}

/** Swap each block that has an entry for its patched text. If owners is given, it gets, for each output
 * line, the index of the upstream block it came from, or null for the lines between blocks. */
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
  const lines = text.split("\n");
  const spans = blockSpans(lines);
  const out: string[] = [];
  let prev = 0;
  let applied = 0;
  const emit = (chunk: readonly string[], owner: number | null) => {
    for (const line of chunk) {
      out.push(line);
      owners?.push(owner);
    }
  };
  for (const [i, [start, end]] of spans.entries()) {
    const block = lines.slice(start, end).join("\n");
    const h = blockHash(block);
    const where: InBlock = { file: rel, output: outPath, line: start + 1, hash: h };
    emit(lines.slice(prev, start), null);
    prev = end;
    const entry = entries.get(h);
    if (entry === undefined) {
      unmatched.push({ line: start + 1, hash: h, upstream: block });
      const terms = rules.terms(outPath, block);
      if (terms.length) problems.push({ problem: "missing", ...where, terms, upstream: block });
      emit(lines.slice(start, end), i);
      continue;
    }
    used.add(h);
    const error = checkEntry(entry);
    if (error) problems.push({ problem: "invalid", ...where, detail: error });
    applied++;
    const patched = rules.expand(entry.patched, (detail) => problems.push({ problem: "placeholder", ...where, detail }));
    if (entry.kind !== "keep") {
      const terms = rules.terms(outPath, patched);
      if (terms.length) problems.push({ problem: "leak", ...where, terms });
    }
    if (patched) emit(patched.split("\n"), i);
    else if (i + 1 < spans.length) prev = spans[i + 1]![0]; // drop the blank lines after a deleted block
  }
  emit(lines.slice(prev), null);
  return { text: out.join("\n"), applied };
}

export async function cmdBlocks(args: { file: string }) {
  const book = await Book.find();
  const file = book.stagedUpstream().get(args.file);
  if (!file) throw new Fail(`upstream has no ${args.file}`);
  const lines = decode(file.data).split("\n");
  for (const [start, end] of blockSpans(lines)) {
    const block = lines.slice(start, end).join("\n");
    process.stdout.write(`=== line ${start + 1} [${blockHash(block)}]\n${block}\n\n`);
  }
  return 0;
}
