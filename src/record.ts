// Recording hand edits to the output: as block entries, as edits to a change that owns the file, or as a new change.
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { assemble, handEdits, readBuildLock, writeBuildLines } from "./assemble.ts";
import { blockHash, blockSpans, type Entry, entriesPath, formatEntry, patchBlocks, PLACEHOLDER_HINT, readEntries, Rules } from "./blocks.ts";
import { Book } from "./book.ts";
import { appendSeries, CHANGE_NAME, Change, notAChangeName, readChanges, readSeries, saveChange } from "./changes.ts";
import { nameFromIntent, oneLine, pendingDiff, writeIntent } from "./intent.ts";
import { type Opcode, SequenceMatcher, unifiedDiff } from "./lib/difflib.ts";
import { Fail } from "./lib/fail.ts";
import { exists, rglob, sameFile, writeText } from "./lib/fs.ts";
import { blobOid } from "./lib/hash.ts";
import { replace, splitlines, strip } from "./lib/py.ts";
import { bytesEqual, decode, decodeReplace, encode, isText } from "./lib/text.ts";

/** An entry a recording makes. A null intent means it still needs one. */
type Draft = Omit<Entry, "intent"> & { intent: string | null };
type Plan = { path: string; entries: Map<string, Draft>; notes: [string, string][] };

export async function cmdRecord(args: { change: string | null; intent: string | null }) {
  if (args.change !== null && !CHANGE_NAME.test(args.change)) throw new Fail(notAChangeName(args.change));
  const book = await Book.find();
  const a = assemble(book);
  const current = book.currentOutput();
  const changes = new Map(readChanges(book, []).map((c) => [c.name, c]));
  const fileOwner = new Map<string, Change>();
  for (const c of changes.values()) for (const e of c.edits) if (e.kind === "file") fileOwner.set(e.path, c);
  const hasBlocks = new Set(rglob(join(book.dir, "blocks"), ".entries").map((p) => p.slice(0, -".entries".length)));
  const prefix = book.layout.kind === "folder" && book.layout.from ? book.layout.from + "/" : "";
  // Only files edited by hand since the last build. Others differ because the patchbook changed.
  const edited = handEdits(book, a.out);
  if (!edited.length) {
    process.stdout.write("no hand edits to the output since the last build; nothing to record\n");
    return 0;
  }
  const blocked = (p: string) => {
    const src = a.sources.get(p);
    return src?.kind === "up" && hasBlocks.has(src.path) && current.has(p);
  };

  // Sort the edits. Paragraph edits update block entries. Edits to files a change already owns go
  // to that change. The rest go to the change being recorded.
  const rules = new Rules(book, new Set(a.sources.keys()));
  const fresh: string[] = [];
  const paragraphs = new Map<string, Plan>();
  const notes: string[] = [];
  for (const p of edited) {
    const now = current.get(p);
    const built = a.out.get(p);
    const src = a.sources.get(p);
    if (built === undefined || (src?.kind === "up" && !hasBlocks.has(src.path) && (now === undefined || !fileOwner.has(src.path)))) {
      fresh.push(p);
    } else if (src?.kind === "up" && now !== undefined && blocked(p)) {
      const upstream = decode(a.upstream.get(src.path)!.data);
      const plan = planParagraphs(book, rules, src.path, p, upstream, built.data, now.data);
      if (typeof plan === "string") notes.push(`skipped  ${p}: ${plan}`);
      else paragraphs.set(p, plan);
    }
  }

  let name = args.change;
  const given = args.intent === null ? null : oneLine(args.intent) || null;
  let intent = given;
  const pending = Array.from(paragraphs, ([p, plan]) => Array.from(plan.entries.values(), (e) => [p, e] as const)).flat()
    .filter(([, e]) => e.intent === null);
  const needsIntent = pending.length > 0;
  const named = fresh.length > 0;
  if (named && !name && intent) {
    name = nameFromIntent(intent, changes);
    process.stdout.write(`${name}: ${intent}\n`);
  }
  if ((named && (!name || (!changes.has(name) && !intent))) || (needsIntent && !intent && !(name !== null && changes.has(name)))) {
    const diff = pendingDiff(a, current, fresh) + pending
      .map(([p, e]) => unifiedDiff(splitlines(e.upstream + "\n", true), splitlines(e.patched + "\n", true), `upstream/${p}`, `disk/${p}`))
      .join("");
    [name, intent] = writeIntent(book, changes, diff, name, named);
    const known = name !== null && changes.has(name);
    process.stdout.write((named && !known ? `${name}: ${intent}` : named ? `adding to ${name}` : `intent: ${intent}`) + "\n");
  } else if (needsIntent && !intent) intent = changes.get(name!)!.intent;
  for (const [p, plan] of paragraphs) {
    for (const e of plan.entries.values()) e.intent ??= intent;
    saveParagraphs(plan);
    notes.push(...plan.notes.map(([h, what]) => `entry    ${p} [${h}] ${what}`));
  }

  let chosen = name || "unnamed";
  if (!name && given) for (let n = 2; changes.has(chosen); n++) chosen = `unnamed-${n}`;
  const existing = changes.get(chosen);
  const target = existing ?? new Change(chosen, join(book.dir, "changes", chosen), intent);
  if (existing && given) target.intent = given;
  const touched = new Map([[target.name, target]]);

  for (const p of edited) {
    if (paragraphs.has(p) || blocked(p)) continue;
    const now = current.get(p);
    const built = a.out.get(p);
    const src = a.sources.get(p);
    if (built === undefined) {
      if (now === undefined) throw new Error(`${p} is neither built nor on disk`);
      target.edits.push({ kind: "add", path: prefix + p });
      target.write("ours", prefix + p, now.data, now.mode);
      notes.push(`add      ${p}`);
    } else if (src === undefined) {
      throw new Error(`${p} is built from nothing`);
    } else if (now === undefined) {
      if (src.kind === "ours") {
        const c = changes.get(src.change)!;
        c.edits = c.edits.filter((e) => !(e.kind === "add" && e.path === src.path));
        c.drop("ours", src.path);
        touched.set(c.name, c);
        notes.push(`unadd    ${p} (from ${c.name})`);
      } else {
        target.edits.push({ kind: "delete", path: prefix + p });
        notes.push(`delete   ${p}`);
      }
    } else if (src.kind === "ours") {
      const c = changes.get(src.change)!;
      if (decodeReplace(c.read("ours", src.path) ?? new Uint8Array()).search(PLACEHOLDER_HINT) !== -1) {
        notes.push(`skipped  ${p}: its copy in ${c.name} uses placeholders; edit that copy directly`);
        continue;
      }
      c.write("ours", src.path, now.data);
      touched.set(c.name, c);
      notes.push(`update   ${p} (in ${c.name})`);
    } else {
      const rel = src.path;
      const c = fileOwner.get(rel) ?? target;
      if (!fileOwner.has(rel)) {
        c.edits.push({ kind: "file", path: rel });
        c.write("base", rel, a.upstream.get(rel)!.data);
      }
      c.write("ours", rel, now.data);
      touched.set(c.name, c);
      notes.push(`file     ${p}` + (c !== target ? ` (in ${c.name})` : ""));
    }
  }

  for (const c of touched.values()) if (c.edits.length || c !== target) saveChange(c);
  if (target.edits.length && !readSeries(book).includes(target.name)) appendSeries(book, target.name);
  process.stdout.write(notes.join("\n") + "\n");
  // The recorded output is now what the patchbook builds, so it no longer counts as a hand edit.
  const lock = readBuildLock(book);
  if (lock !== null) {
    const after = assemble(book).out;
    for (const p of edited) {
      const built = after.get(p);
      if (built !== undefined && sameFile(current.get(p), built)) lock.set(p, blobOid(built.data));
      else if (built === undefined && !current.has(p)) lock.delete(p);
    }
    writeBuildLines(book, lock);
  }
  return 0;
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
