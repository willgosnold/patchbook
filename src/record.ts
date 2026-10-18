// Recording hand edits to the output: as block entries, as edits to a change that owns the file, or as a new change.
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Problem } from "./api.ts";
import { assemble, type Assembly, blockFiles, describe, handEdits, readBuildLock, type Source, writeBuildLines } from "./assemble.ts";
import { blockHash, blockSpans, type Entry, entriesPath, formatEntry, patchBlocks, PLACEHOLDER_HINT, readEntries, Rules } from "./blocks.ts";
import { Book } from "./book.ts";
import { appendSeries, CHANGE_NAME, Change, notAChangeName, readChanges, readSeries, saveChange } from "./changes.ts";
import { installHookOrWarn } from "./githook.ts";
import { nameFromIntent, oneLine, pendingDiff, writeIntent } from "./intent.ts";
import { type Opcode, SequenceMatcher, unifiedDiff } from "./lib/difflib.ts";
import { Fail } from "./lib/fail.ts";
import { exists, type File, LINK, type Mode, sameFile, writeText } from "./lib/fs.ts";
import { blobOid } from "./lib/hash.ts";
import { replace, splitlines, strip } from "./lib/py.ts";
import { bytesEqual, decode, decodeReplace, encode, isText } from "./lib/text.ts";

/** An entry a recording makes. A null intent means it still needs one. */
type Draft = Omit<Entry, "intent"> & { intent: string | null };
type Plan = { path: string; entries: Map<string, Draft>; notes: [string, string][] };

/** The mode to write for an edited file's own copy: a link follows `now`, and a regular file over a recorded link is a plain file. Otherwise the copy keeps its mode. */
function recordedMode(now: Mode, built: Mode): Mode | undefined {
  if (now === LINK) return LINK;
  return built === LINK ? 0o644 : undefined;
}

type Copy = { change: Change; staged: string };

type Destination = { kind: "owned"; change: Change } | { kind: "recorded"; base: File };

type Data = {
  "add": { staged: string; now: File };
  "delete-upstream": { staged: string };
  "unadd": Copy;
  "unreplace": Copy;
  "update-ours": Copy & { now: File; built: File };
  "file-edit": { rel: string; now: File; to: Destination };
  "paragraph-edit": { plan: Plan };
  "skip": { reason: string };
};

type Kind = keyof Data;
export type Edited<K extends Kind = Kind> = { [P in K]: { kind: P; path: string } & Data[P] }[K];

type Need = { named: boolean; drafts: readonly Draft[] };
const NOTHING: Need = { named: false, drafts: [] };
const NAMED: Need = { named: true, drafts: [] };

type Recording = { target: Change | null; intent: string | null };
type Done = { touched: Change | null; notes: readonly string[] };

type Row<K extends Kind> = { needs(e: Edited<K>): Need; apply(e: Edited<K>, r: Recording): Done };

const KINDS: { readonly [K in Kind]: Row<K> } = {
  "add": {
    needs: () => NAMED,
    apply: (e, r) => {
      const c = r.target!;
      c.edits.push({ kind: "add", path: e.staged });
      c.write("ours", e.staged, e.now.data, e.now.mode);
      return { touched: c, notes: [`add      ${e.path}`] };
    },
  },
  "delete-upstream": {
    needs: () => NAMED,
    apply: (e, r) => {
      const c = r.target!;
      c.edits.push({ kind: "delete", path: e.staged });
      return { touched: c, notes: [`delete   ${e.path}`] };
    },
  },
  "unadd": { needs: () => NOTHING, apply: unadd },
  "unreplace": { needs: () => NOTHING, apply: unadd },
  "update-ours": {
    needs: () => NOTHING,
    apply: (e) => {
      e.change.write("ours", e.staged, e.now.data, recordedMode(e.now.mode, e.built.mode));
      return { touched: e.change, notes: [`update   ${e.path} (in ${e.change.name})`] };
    },
  },
  "file-edit": {
    needs: (e) => (e.to.kind === "recorded" ? NAMED : NOTHING),
    apply: (e, r) => {
      if (e.to.kind === "owned") {
        const c = e.to.change;
        c.write("ours", e.rel, e.now.data);
        return { touched: c, notes: [`file     ${e.path}` + (c !== r.target ? ` (in ${c.name})` : "")] };
      }
      const c = r.target!;
      c.edits.push({ kind: "file", path: e.rel });
      c.write("base", e.rel, e.to.base.data);
      c.write("ours", e.rel, e.now.data);
      return { touched: c, notes: [`file     ${e.path}`] };
    },
  },
  "paragraph-edit": {
    needs: (e) => ({ named: false, drafts: Array.from(e.plan.entries.values()).filter((d) => d.intent === null) }),
    apply: (e, r) => {
      for (const d of e.plan.entries.values()) d.intent ??= r.intent;
      saveParagraphs(e.plan);
      return { touched: null, notes: e.plan.notes.map(([h, what]) => `entry    ${e.path} [${h}] ${what}`) };
    },
  },
  "skip": { needs: () => NOTHING, apply: (e) => ({ touched: null, notes: [`skipped  ${e.path}: ${e.reason}`] }) },
};

const row = <K extends Kind>(e: Edited<K>): Row<K> => KINDS[e.kind];

export const needOf = (e: Edited): Need => row(e).needs(e);

function unadd(e: Edited<"unadd" | "unreplace">): Done {
  e.change.edits = e.change.edits.filter((x) => !(x.kind === "add" && x.path === e.staged));
  e.change.drop("ours", e.staged);
  return { touched: e.change, notes: [`unadd    ${e.path} (from ${e.change.name})`] };
}

export type Snapshot = {
  out: ReadonlyMap<string, File>;
  sources: ReadonlyMap<string, Source>;
  upstream: ReadonlyMap<string, File>;
  current: ReadonlyMap<string, File>;
  changes: ReadonlyMap<string, Change>;
  owners: ReadonlyMap<string, Change>;
  blocks: ReadonlySet<string>;
  prefix: string;
  plan(rel: string, path: string, built: File, now: File): Plan | string;
};

/** When more than one output built from one copy changes, none is recorded, since each would overwrite the copy the others wrote. */
export function classify(s: Snapshot, paths: readonly string[]): Edited[] {
  const sharers = new Map<string, string[]>();
  for (const p of paths) {
    const copy = copyOf(s, p);
    if (copy) sharers.set(copy.key, [...(sharers.get(copy.key) ?? []), p]);
  }
  return paths.map((path) => {
    const copy = copyOf(s, path);
    const others = copy ? sharers.get(copy.key)!.filter((p) => p !== path) : [];
    if (!copy || !others.length) return classifyOne(s, path);
    return { kind: "skip", path, reason: `${copy.said} also builds ${others.join(", ")}, which this record changes too; ${copy.fix}` };
  });
}

/** The copy an edit to this output is recorded into. Deleting an upstream output only deletes that path, so it shares nothing. */
function copyOf(s: Snapshot, path: string): { key: string; said: string; fix: string } | null {
  const src = s.out.has(path) ? s.sources.get(path) : undefined;
  if (src?.kind === "ours") return { key: `changes/${src.change}/${src.path}`, said: `its copy in ${src.change}`, fix: "edit that copy directly" };
  if (src?.kind === "up" && s.current.has(path)) return { key: `upstream/${src.path}`, said: `upstream's ${src.path}`, fix: "edit only one of them" };
  return null;
}

function classifyOne(s: Snapshot, path: string): Edited {
  const now = s.current.get(path);
  const built = s.out.get(path);
  const src = s.sources.get(path);
  if (built === undefined) {
    if (now === undefined) throw new Error(`${path} is neither built nor on disk`);
    if (src !== undefined) return { kind: "skip", path, reason: "a hook leaves it out of the build; change the hook to keep it" };
    return { kind: "add", path, staged: s.prefix + path, now };
  }
  if (src === undefined) throw new Error(`${path} is built from nothing`);
  if (src.kind === "ours") {
    const change = s.changes.get(src.change)!;
    const copy = { path, change, staged: src.path };
    if (now === undefined) return { kind: change.edits.some((e) => e.kind === "add" && e.path === src.path) ? "unadd" : "unreplace", ...copy };
    if (decodeReplace(change.read("ours", src.path) ?? new Uint8Array()).search(PLACEHOLDER_HINT) !== -1) {
      return { kind: "skip", path, reason: `its copy in ${change.name} uses placeholders; edit that copy directly` };
    }
    return { kind: "update-ours", ...copy, now, built };
  }
  if (now === undefined) return { kind: "delete-upstream", path, staged: s.prefix + path };
  if (s.blocks.has(src.path)) {
    const plan = s.plan(src.path, path, built, now);
    return typeof plan === "string" ? { kind: "skip", path, reason: plan } : { kind: "paragraph-edit", path, plan };
  }
  const owner = s.owners.get(src.path);
  const to: Destination = owner ? { kind: "owned", change: owner } : { kind: "recorded", base: s.upstream.get(src.path)! };
  return { kind: "file-edit", path, rel: src.path, now, to };
}

function snapshot(book: Book, a: Assembly, current: ReadonlyMap<string, File>, changes: ReadonlyMap<string, Change>): Snapshot {
  const owners = new Map<string, Change>();
  for (const c of changes.values()) for (const e of c.edits) if (e.kind === "file") owners.set(e.path, c);
  const rules = new Rules(book, new Set(a.sources.keys()));
  return {
    out: a.out, sources: a.sources, upstream: a.upstream, current, changes, owners,
    blocks: new Set(blockFiles(book)),
    prefix: book.layout.kind === "folder" && book.layout.from ? book.layout.from + "/" : "",
    plan: (rel, path, built, now) => planParagraphs(book, rules, rel, path, decode(a.upstream.get(rel)!.data), built.data, now.data),
  };
}

type Asked = { named: string[]; drafts: [string, Draft][] };

function asked(edits: readonly Edited[]): Asked {
  const ask: Asked = { named: [], drafts: [] };
  for (const e of edits) {
    const need = needOf(e);
    if (need.named) ask.named.push(e.path);
    for (const d of need.drafts) ask.drafts.push([e.path, d]);
  }
  return ask;
}

type Naming = { name: string | null; intent: string | null; said: string | null };

function nameAndIntent(
  ask: Asked, name: string | null, given: string | null, changes: ReadonlyMap<string, Change>,
  model: (name: string | null, named: boolean) => [string | null, string | null],
): Naming {
  if (name && !CHANGE_NAME.test(name)) throw new Fail(notAChangeName(name));
  const named = ask.named.length > 0;
  if (given) {
    if (!named || name) return { name, intent: given, said: null };
    const derived = nameFromIntent(given, changes);
    return { name: derived, intent: given, said: `${derived}: ${given}` };
  }
  const known = name === null ? undefined : changes.get(name);
  if (known) return { name, intent: known.intent, said: null };
  if (!named && !ask.drafts.length) return { name, intent: null, said: null };
  const [chosen, intent] = model(name, named);
  if (!named) return { name: null, intent, said: `intent: ${intent}` };
  return { name: chosen, intent, said: chosen !== null && changes.has(chosen) ? `adding to ${chosen}` : `${chosen}: ${intent}` };
}

function modelDiff(a: Assembly, current: ReadonlyMap<string, File>, ask: Asked): string {
  return pendingDiff(a, current, ask.named) + ask.drafts
    .map(([p, e]) => unifiedDiff(splitlines(e.upstream + "\n", true), splitlines(e.patched + "\n", true), `upstream/${p}`, `disk/${p}`))
    .join("");
}

export type RecordResult = { text: string };

export async function cmdRecord(args: { change: string | null; intent: string | null; current?: Map<string, File>; edits?: string[]; only?: (path: string) => boolean }) {
  const book = await Book.find();
  if (args.current === undefined) installHookOrWarn(book);
  process.stdout.write(record(book, args.change, args.intent, args).text);
  return 0;
}

export function record(book: Book, change: string | null, intent: string | null, opts: { current?: Map<string, File>; edits?: string[]; only?: (path: string) => boolean } = {}): RecordResult {
  const problems: Problem[] = [];
  const changes = new Map(readChanges(book, problems).map((c) => [c.name, c]));
  const badName = problems.find((p) => p.file === "series" && "refuse" in p);
  if (badName) throw new Fail(`refusing to record: ${describe(badName)}\nRename it to lowercase letters, digits and dashes in series and changes/ first.`);
  const a = assemble(book);
  const current = opts.current ?? book.currentOutput();
  // Only files edited by hand since the last build. Others differ because the patchbook changed.
  const edited = (opts.edits ?? handEdits(book, a.out, current)).filter(opts.only ?? (() => true));
  if (!edited.length) return { text: "no hand edits to the output since the last build; nothing to record\n" };
  refuseLinkTurnedFile(a, current, edited);
  const s = snapshot(book, a, current, changes);
  const edits = classify(s, edited);

  const given = intent === null ? null : oneLine(intent) || null;
  const ask = asked(edits);
  const naming = nameAndIntent(ask, change, given, changes, (n, named) => writeIntent(book, changes, modelDiff(a, current, ask), n, named));
  const target = naming.name ? changes.get(naming.name) ?? new Change(naming.name, join(book.dir, "changes", naming.name), naming.intent) : null;
  if (target && given) target.intent = given;

  const touched = new Map<string, Change>(target ? [[target.name, target]] : []);
  const notes: string[] = [];
  for (const e of edits) {
    const done = row(e).apply(e, { target, intent: naming.intent });
    if (done.touched) touched.set(done.touched.name, done.touched);
    notes.push(...done.notes);
  }
  for (const c of touched.values()) if (c.edits.length || c !== target) saveChange(c);
  if (target?.edits.length && !readSeries(book).includes(target.name)) appendSeries(book, target.name);
  // The recorded output is now what the patchbook builds, so it no longer counts as a hand edit.
  const lock = readBuildLock(book);
  if (lock !== null) {
    const after = assemble(book).out;
    for (const p of edited) {
      const built = after.get(p);
      if (built !== undefined && sameFile(current.get(p), built, book.tracksExecBit())) lock.set(p, blobOid(built.data));
      else if (built === undefined && !current.has(p)) lock.delete(p);
    }
    writeBuildLines(book, lock);
  }
  return { text: (naming.said !== null ? naming.said + "\n" : "") + notes.join("\n") + "\n" };
}

/** An upstream link keeps its type in the build, so a regular file over it would be written back as a link. */
function refuseLinkTurnedFile(a: ReturnType<typeof assemble>, current: ReadonlyMap<string, File>, edited: readonly string[]): void {
  const turned = edited.filter((p) => {
    const src = a.sources.get(p);
    return src !== undefined && a.out.get(p)?.mode === LINK && a.upstream.get(src.path)?.mode === LINK
      && current.get(p) !== undefined && current.get(p)!.mode !== LINK;
  });
  if (turned.length) {
    throw new Fail(turned.map((p) => `${p} is a link upstream, and a regular file now`).join("\n")
      + "\npatchbook can't record a link turned into a file yet (#133).");
  }
}

/** Work out the block entry updates that make the build produce `now` for a file with block entries.
 *
 * Returns the whole new set of entries, or a reason the edit can't be recorded this way. */
function planParagraphs(
  book: Book, rules: Rules, rel: string, outPath: string, upstreamText: string, built: Uint8Array, now: Uint8Array,
): Plan | string {
  if (!(isText(built) && isText(now))) return "it isn't text";
  const entries = readEntries(entriesPath(book, rel));
  const lines = upstreamText.split("\n");
  const spans = blockSpans(lines);
  const owners: (number | null)[] = [];
  const { text } = patchBlocks({ rules, outPath, rel, text: upstreamText, entries, owners });
  if (!bytesEqual(encode(text), built)) return "a hook changes it after its block entries apply; edit the entries directly";
  const old = text.split("\n");
  const fresh = decode(now).split("\n");
  const every = new SequenceMatcher(old, fresh, false).getOpcodes();

  // Each edit belongs to the blocks whose lines it touches, or, between blocks, to the block before it.
  const blame: { inside: Set<number>; i1: number; i2: number; j1: number; j2: number }[] = [];
  for (const [tag, i1, i2, j1, j2] of every) {
    if (tag === "equal") continue;
    const inside = new Set(owners.slice(i1, i2).filter((o) => o !== null));
    if (!inside.size) {
      const before = owners.slice(0, i1).findLast((o) => o !== null) ?? null;
      const after = owners.slice(i2).find((o) => o !== null) ?? null;
      const near = before ?? after;
      if (near !== null) inside.add(near);
    }
    if (!inside.size) return "it has no blocks to attach the edit to";
    blame.push({ inside, i1, i2, j1, j2 });
  }
  const touched = Array.from(new Set(blame.flatMap((b) => [...b.inside]))).sort((x, y) => x - y);

  // Neighbouring touched blocks form one group: the first block takes the group's new text.
  const groups: number[][] = [];
  const shown = spans.map((_, k) => k).filter((k) => owners.includes(k));
  for (const k of touched) {
    const last = groups.at(-1);
    if (last && shown.indexOf(k) === shown.indexOf(last.at(-1)!) + 1) last.push(k);
    else groups.push([k]);
  }
  const result = new Map<string, Draft>(entries);
  const notes: [string, string][] = [];
  for (const group of groups) {
    const mine = blame.filter((b) => group.some((k) => b.inside.has(k)));
    const own = owners.flatMap((o, n) => (o !== null && group.includes(o) ? [n] : []));
    const bs = Math.min(own[0]!, ...mine.map((b) => b.i1));
    const be = Math.max(own.at(-1)! + 1, ...mine.map((b) => b.i2));
    const js = Math.min(mapLine(every, bs, fresh.length), ...mine.map((b) => b.j1));
    const je = Math.max(mapLine(every, be, fresh.length), ...mine.map((b) => b.j2));
    const chunk = fresh.slice(js, je);
    while (chunk.length && !strip(chunk[0]!)) chunk.shift();
    while (chunk.length && !strip(chunk.at(-1)!)) chunk.pop();
    for (const [i, k] of group.entries()) {
      let piece = i === 0 ? chunk.join("\n") : "";
      const [start, end] = spans[k]!;
      const upstream = lines.slice(start, end).join("\n");
      const h = blockHash(upstream);
      const entry = entries.get(h);
      if (entry) { // keep its placeholders where their values still appear
        for (const [hint] of entry.patched.matchAll(PLACEHOLDER_HINT)) {
          const value = rules.expand(hint, () => {});
          if (value !== hint && piece.includes(value)) piece = replace(piece, value, hint);
        }
      }
      if (piece === upstream && (!entry || entry.kind !== "keep")) {
        if (entry) {
          result.delete(h);
          notes.push([h, "removed: the paragraph is upstream's again"]);
        }
        continue;
      }
      if (entry && entry.kind !== "keep") {
        result.set(h, { ...entry, patched: piece });
        notes.push([h, "updated"]);
      } else {
        result.set(h, { hash: h, kind: "policy", rules: "", intent: null, upstream, patched: piece });
        notes.push([h, "added"]);
      }
    }
  }

  const filled = new Map(Array.from(result, ([h, e]) => [h, { ...e, intent: e.intent || "-" }]));
  const check = patchBlocks({ rules, outPath, rel, text: upstreamText, entries: filled }).text;
  if (!bytesEqual(encode(check), now)) return "the edit doesn't map onto whole paragraphs; edit its block entries directly";
  return { path: entriesPath(book, rel), entries: result, notes };
}

/** The line of the new text that line i of the old text lines up with. */
function mapLine(ops: readonly Opcode[], i: number, end: number): number {
  for (const [tag, i1, i2, j1] of ops) {
    if (i1 <= i && i < i2) return tag === "equal" ? j1 + (i - i1) : j1;
  }
  return end;
}

function saveParagraphs(plan: Plan): void {
  if (plan.entries.size) {
    writeText(plan.path, Array.from(plan.entries.values(), (e) => formatEntry({ ...e, intent: e.intent ?? "None" })).join("\n"));
  } else if (exists(plan.path)) unlinkSync(plan.path);
}
