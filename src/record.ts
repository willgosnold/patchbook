// Recording hand edits to the output: as block entries, as edits to a change that owns the file, or as a new change.
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Occurrence, Problem } from "./api.ts";
import { assemble, type Assembly, blockFiles, describe, handEdits, readBuildLock, refuseFolderToFile, type Source, stampOf, writeBuildLines } from "./assemble.ts";
import { type Block, blocksOf, type Entry, entriesPath, entryKey, formatEntry, keyFor, patchBlocks, PLACEHOLDER_HINT, readEntries, Rules } from "./blocks.ts";
import { Book, PB, under } from "./book.ts";
import { appendSeries, CHANGE_NAME, Change, type Edit, editText, type Intent, notAChangeName, readSeries, replaceIntent, Roster, saveChange } from "./changes.ts";
import { installHookOrWarn } from "./githook.ts";
import {
  changeParts, entryPart, type Fresh, intentFromEdits, intentFromParagraph, ModelFailed, nameFromEdits, nameFromIntent, oneLine, PARAGRAPHS, type Part, pendingParts, type Reply, writeIntents,
} from "./intent.ts";
import { Fail } from "./lib/fail.ts";
import { exists, type File, LINK, meantMode, type Mode, recordedModes, relative, sameFile, type Seen, writeText } from "./lib/fs.ts";
import { type Changed, lineChanges } from "./lib/match.ts";
import { say, warn } from "./lib/term.ts";
import { byCodePoint, bytesEqual, decode, encode, isText } from "./lib/text.ts";
import { Undo } from "./undo.ts";

/** An entry a recording makes. A null intent means it still needs one; `was` marks an updated entry, with the intent it had. */
type Draft = Omit<Entry, "intent"> & { intent: Intent | null; was?: Intent };
type Plan = { path: string; entries: Map<string, Draft>; notes: [string, string][] };

type Copy = { change: Change; staged: string };

type Destination = { kind: "owned"; change: Change; up?: File | undefined } | { kind: "recorded"; base: File };

type Follow = Extract<Edit, { kind: "move" | "copy" }>;

type Data = {
  "add": { staged: string; now: Seen };
  "follow": { edit: Follow };
  "delete-upstream": { staged: string; entries: string | null };
  "replace": { staged: string; now: Seen; built: Mode; up: File | undefined; entries: string | null };
  "unadd": Copy;
  "unreplace": Copy;
  "update-ours": Copy & { now: Seen; built: File; up: File | undefined };
  "file-edit": { rel: string; now: Seen; built: Mode; to: Destination };
  "paragraph-edit": { plan: Plan; modeNotRecorded: string | null };
  "skip": { reason: string };
};

type Kind = keyof Data;
export type Edited<K extends Kind = Kind> = { [P in K]: { kind: P; path: string } & Data[P] }[K];

/** The edit a row adds to the change it records into. A delete that stands in for a replace names the change it drops the replace from. */
type Written = Edit & { drops?: Change };

/** A change a row writes a copy into without naming it, with the copy's new bytes. */
type Join = { change: Change; path: string; data: Uint8Array };

/** An add or replace a row takes out of the change that has it. */
type Dropped = { change: Change; kind: "add" | "replace"; path: string };

/** `updates` are the existing entries a row rewrites, by their label. */
type Need = { named: boolean; drafts: readonly Draft[]; updates?: readonly [string, Draft][]; writes?: Written; joins?: Join; dropped?: Dropped };
const NOTHING: Need = { named: false, drafts: [] };
const NAMED: Need = { named: true, drafts: [] };

/** `intent` is for new entries, null when patchbook writes theirs from the paragraph edit; `rewritten` gives an updated entry's new intent by its label, or null to keep it. */
type Recording = { target: Change | null; intent: string | null; rewritten(key: string): string | null };
/** `copies` are the copies whose mode the row picked, absolute, for the commit hook to stage. `drafted` are the entries, by label, whose
 * intent patchbook wrote. */
type Done = { touched: readonly Change[]; notes: readonly string[]; copies?: readonly [string, Mode][]; drafted?: readonly string[]; afterSave?: () => void };

type Row<K extends Kind> = { needs(e: Edited<K>): Need; apply(e: Edited<K>, r: Recording): Done };

const KINDS: { readonly [K in Kind]: Row<K> } = {
  "add": {
    needs: (e) => ({ ...NAMED, writes: { kind: "add", path: e.staged } }),
    apply: (e, r) => {
      const c = r.target!;
      c.edits.push({ kind: "add", path: e.staged });
      const copies = writeCopy(c, e.staged, e.now, undefined, undefined);
      return { touched: [c], notes: [`add      ${e.path}`], copies };
    },
  },
  "follow": {
    needs: (e) => ({ ...NAMED, writes: e.edit }),
    apply: (e, r) => {
      const c = r.target!;
      c.edits.push(e.edit);
      return { touched: [c], notes: [`${e.edit.kind.padEnd(8)} ${editText(e.edit).slice(e.edit.kind.length + 1)}`] };
    },
  },
  "delete-upstream": {
    needs: (e) => ({ ...NAMED, writes: { kind: "delete", path: e.staged } }),
    apply: (e, r) => {
      const c = r.target!;
      c.edits.push({ kind: "delete", path: e.staged });
      const entries = e.entries;
      const afterSave = () => { if (entries !== null && exists(entries)) unlinkSync(entries); };
      return { touched: [c], notes: [`delete   ${e.path}`], afterSave };
    },
  },
  "replace": {
    needs: (e) => ({ ...NAMED, writes: { kind: "replace", path: e.staged } }),
    apply: (e, r) => {
      const c = r.target!;
      c.edits.push({ kind: "replace", path: e.staged });
      const copies = writeCopy(c, e.staged, e.now, e.built, e.up);
      const entries = e.entries;
      const afterSave = () => { if (entries !== null && exists(entries)) unlinkSync(entries); };
      return { touched: [c], notes: [`replace  ${e.path}`], copies, afterSave };
    },
  },
  "unadd": {
    needs: (e) => ({ ...NOTHING, dropped: { change: e.change, kind: "add", path: e.staged } }),
    apply: (e) => {
      e.change.edits = e.change.edits.filter((x) => !(x.kind === "add" && x.path === e.staged));
      const afterSave = () => dropCopies(e.change, e.staged);
      return { touched: [e.change], notes: [`unadd    ${e.path} (from ${e.change.name})`], afterSave };
    },
  },
  "unreplace": {
    needs: (e) => ({ ...NAMED, writes: { kind: "delete", path: e.staged, drops: e.change }, dropped: { change: e.change, kind: "replace", path: e.staged } }),
    apply: (e, r) => {
      const c = r.target!;
      e.change.edits = e.change.edits.filter((x) => !(x.kind === "replace" && x.path === e.staged));
      c.edits.push({ kind: "delete", path: e.staged });
      const afterSave = () => dropCopies(e.change, e.staged);
      return { touched: [e.change, c], notes: [`delete   ${e.path} (replace removed from ${e.change.name})`], afterSave };
    },
  },
  "update-ours": {
    needs: (e) => ({ ...NOTHING, joins: { change: e.change, path: e.staged, data: e.now.data } }),
    apply: (e) => {
      const copies = writeCopy(e.change, e.staged, e.now, e.built.mode, e.up);
      return { touched: [e.change], notes: [`update   ${e.path} (in ${e.change.name})`], copies };
    },
  },
  "file-edit": {
    needs: (e) => (e.to.kind === "recorded" ? { ...NAMED, writes: { kind: "file", path: e.rel } } : { ...NOTHING, joins: { change: e.to.change, path: e.rel, data: e.now.data } }),
    apply: (e, r) => {
      if (e.to.kind === "owned") {
        const c = e.to.change;
        const copies = writeCopy(c, e.rel, e.now, e.built, e.to.up);
        return { touched: [c], notes: [`file     ${e.path}` + (c !== r.target ? ` (in ${c.name})` : "")], copies };
      }
      const c = r.target!;
      c.edits.push({ kind: "file", path: e.rel });
      c.write("base", e.rel, e.to.base.data, e.to.base.mode);
      const copies = writeCopy(c, e.rel, e.now, e.built, e.to.base);
      return { touched: [c], notes: [`file     ${e.path}`], copies: [[c.content("base", e.rel), e.to.base.mode], ...copies] };
    },
  },
  "paragraph-edit": {
    needs: (e) => {
      const drafts = Array.from(e.plan.entries).filter(([, d]) => d.intent === null);
      return {
        named: false,
        drafts: drafts.flatMap(([, d]) => (d.was === undefined ? [d] : [])),
        updates: drafts.flatMap(([h, d]) => (d.was === undefined ? [] : [[entryLabel(e.path, h), d] as [string, Draft]])),
      };
    },
    apply: (e, r) => {
      const { entries, drafted } = withIntent(e.plan, e.path, r.intent, (h) => r.rewritten(entryLabel(e.path, h)));
      saveParagraphs(e.plan.path, entries);
      const notes = e.plan.notes.map(([h, what]) => `entry    ${entryLabel(e.path, h)} ${what}`);
      if (e.modeNotRecorded !== null) notes.push(`skipped  ${e.path}: ${e.modeNotRecorded}`);
      return { touched: [], notes, drafted: drafted.map((h) => entryLabel(e.path, h)) };
    },
  },
  "skip": { needs: () => NOTHING, apply: (e) => ({ touched: [], notes: [`skipped  ${e.path}: ${e.reason}`] }) },
};

/** Write `now` as a change's copy at `path`, at the copy modes recordedModes picks. Returns the copies whose mode it
 * picked, with that mode. A copy left at the mode it had isn't one. */
function writeCopy(c: Change, path: string, now: Seen, built: Mode | undefined, up: File | undefined): [string, Mode][] {
  const had = { ours: c.file("ours", path)?.mode ?? null, base: c.file("base", path)?.mode ?? null };
  const modes = recordedModes(now, built, up?.mode, had);
  const picked: [string, Mode][] = [];
  if (modes.base !== null && modes.base !== had.base) {
    c.write("base", path, c.read("base", path) ?? up!.data, modes.base);
    picked.push([c.content("base", path), modes.base]);
  }
  c.write("ours", path, now.data, modes.ours);
  if (had.ours === null || meantMode(now, built) !== built) picked.push([c.content("ours", path), modes.ours]);
  return picked;
}

function dropCopies(c: Change, path: string): void {
  c.drop("ours", path);
  c.drop("base", path);
}

const row = <K extends Kind>(e: Edited<K>): Row<K> => KINDS[e.kind];

/** A block entry as its `entry` note and the model's reply name it. */
const entryLabel = (path: string, key: string): string => `${path} [${key}]`;

export const needOf = (e: Edited): Need => row(e).needs(e);

export type Snapshot = {
  out: ReadonlyMap<string, File>;
  sources: ReadonlyMap<string, Source>;
  upstream: ReadonlyMap<string, File>;
  current: ReadonlyMap<string, Seen>;
  changes: ReadonlyMap<string, Change>;
  owners: ReadonlyMap<string, Change>;
  blocks: ReadonlySet<string>;
  entriesAt(rel: string): string;
  prefix: string;
  /** Whether a change's copy is text with a placeholder of a configured kind. The build expands only text. */
  uses(copy: Uint8Array | null): boolean;
  plan(rel: string, path: string, built: File, now: File): Plan | string;
  /** Staged path to source, after every change in the series. */
  staged: ReadonlyMap<string, Source>;
  /** What a source builds at an output path, before the finish hook. */
  build(src: Source, at: string): File;
};

/** An edit to an output whose source builds another output still on disk is a replace of that output alone: an edit to the source
 * would change the other output too. A new output that builds as a copy of a staged file is recorded as that copy. A new output that
 * a deleted output's upstream file builds, as is or with a content edit that keeps at least half its lines, is recorded as a move of
 * that file plus the edit. */
export function classify(s: Snapshot, paths: readonly string[]): Edited[] {
  return follow(s, each(s, paths));
}

function each(s: Snapshot, paths: readonly string[]): Edited[] {
  return paths.map((path) => {
    const now = s.current.get(path);
    const built = s.out.get(path);
    const src = now && built ? s.sources.get(path) : undefined;
    const outputs = src ? builtFrom(s, src) : [];
    if (!now || !built || !src || !outputs.some((p) => p !== path && s.current.has(p))) return classifyOne(s, path);
    // Once every output of a file with block entries is replaced, nothing reads its entries.
    const entries = src.kind === "up" && s.blocks.has(src.path) && outputs.every((p) => paths.includes(p)) ? s.entriesAt(src.path) : null;
    const staged = s.prefix + path;
    return { kind: "replace", path, staged, now, built: built.mode, up: s.upstream.get(staged), entries };
  });
}

const builtFrom = (s: Snapshot, src: Source): string[] =>
  Array.from(s.sources).flatMap(([p, o]) => (s.out.has(p) && unitKey(o) === unitKey(src) ? [p] : []));

const stillBuilt = (s: Snapshot, rel: string): boolean =>
  Array.from(s.sources).some(([p, src]) => src.kind === "up" && src.path === rel && s.current.has(p));

/** Whether a move or copy edit reads the ours copy at `path`, even if its output was never built. */
const readByMoveOrCopy = (s: Snapshot, path: string): boolean =>
  Array.from(s.changes.values()).some((c) => c.edits.some((e) => (e.kind === "move" || e.kind === "copy") && under(path, e.path)));

const unitKey = (src: Source) => JSON.stringify(src.kind === "ours" ? ["ours", src.change, src.path] : ["up", src.path]);

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
    if (now === undefined) {
      const staged = s.prefix + path;
      // A moved or copied output, or a copy another output still needs, is deleted. Dropping its add or replace would break the move or copy.
      if (src.path !== staged || readByMoveOrCopy(s, src.path)) return { kind: "delete-upstream", path, staged, entries: null };
      return { kind: change.edits.some((e) => e.kind === "add" && e.path === src.path) ? "unadd" : "unreplace", ...copy };
    }
    if (s.uses(change.read("ours", src.path))) return skipPlaceholders(path, change);
    return { kind: "update-ours", ...copy, now, built, up: s.upstream.get(src.path) };
  }
  if (now === undefined) return { kind: "delete-upstream", path, staged: s.prefix + path, entries: s.blocks.has(src.path) && !stillBuilt(s, src.path) ? s.entriesAt(src.path) : null };
  if (s.blocks.has(src.path)) {
    const plan = s.plan(src.path, path, built, now);
    if (typeof plan === "string") return { kind: "skip", path, reason: plan };
    if (meantMode(now, built.mode) === built.mode || now.mode === LINK || built.mode === LINK) return { kind: "paragraph-edit", path, plan, modeNotRecorded: null };
    const modeNotRecorded = `block entries hold no mode, so the mode change was not recorded; to set it, make your finish hook in ${PB}/hooks.ts run `
      + `out.get(${JSON.stringify(path)})!.mode = 0o${now.mode.toString(8)};`;
    return bytesEqual(built.data, now.data) ? { kind: "skip", path, reason: modeNotRecorded } : { kind: "paragraph-edit", path, plan, modeNotRecorded };
  }
  const owner = s.owners.get(src.path);
  if (owner && s.uses(owner.read("ours", src.path))) return skipPlaceholders(path, owner);
  const to: Destination = owner ? { kind: "owned", change: owner, up: s.upstream.get(src.path) } : { kind: "recorded", base: s.upstream.get(src.path)! };
  return { kind: "file-edit", path, rel: src.path, now, built: built.mode, to };
}

const skipPlaceholders = (path: string, change: Change): Edited =>
  ({ kind: "skip", path, reason: `its copy in ${change.name} uses placeholders; edit that copy directly` });

type Lead = {
  add: Edited<"add">; kind: Follow["kind"]; from: string; rel: string; takes: Edited<"delete-upstream"> | null;
  rest: Edited | null; rank: readonly [sure: number, tail: number];
};

const EXACT_MOVE = 3;
const EXACT_COPY = 2;

const emptyMatch = (l: Lead) => l.add.now.data.length === 0;

function follow(s: Snapshot, edits: readonly Edited[]): Edited[] {
  const all = leads(s, edits);
  const chosen = choose(all.filter((l) => !emptyMatch(l)));
  const going = new Set(chosen.map(wayOf));
  const empties = new Map<Way, Lead>();
  for (const l of all) if (emptyMatch(l) && !empties.has(wayOf(l))) empties.set(wayOf(l), l);
  const widened = new Map(chosen.map((l) => [l.add as Edited, { lead: l, ...widen(s, going, empties, l) }]));
  const dropped = new Set<Edited>(Array.from(widened.values()).flatMap((w) => (w.lead.takes ? [...w.covers, w.lead.takes] : w.covers)));
  const written = new Set<string>();
  return edits.flatMap((e): Edited[] => {
    if (dropped.has(e)) return [];
    const w = widened.get(e);
    if (!w) return [e];
    const text = editText(w.edit);
    const head: Edited[] = written.has(text) ? [] : [{ kind: "follow", path: e.path, edit: w.edit }];
    written.add(text);
    return w.lead.rest ? [...head, w.lead.rest] : head;
  });
}

function leads(s: Snapshot, edits: readonly Edited[]): Lead[] {
  const editedRels = touched(s, edits);
  const buildsAsUpstream = (rel: string) => !s.owners.has(rel) && !s.blocks.has(rel);
  const adds = edits.filter((e): e is Edited<"add"> => e.kind === "add");
  const gone = edits.filter((e): e is Edited<"delete-upstream"> => {
    const src = e.kind === "delete-upstream" ? s.sources.get(e.path) : undefined;
    return src?.kind === "up" && editedRels.get(src.path) === 1;
  });
  const sharers = sharingTwoWordLines(s, gone);
  const moves = adds.flatMap((add) => {
    const near = sharers(add);
    return gone.flatMap((d): Lead[] => {
      const src = s.sources.get(d.path)!;
      const lead = { add, kind: "move", from: d.staged, rel: src.path, takes: d } as const;
      const sized = !buildsAsUpstream(src.path) || s.upstream.get(src.path)!.data.length === add.now.data.length;
      if (sized && sameFile(add.now, s.build(src, add.path), add.now.chosen)) return [{ ...lead, rest: null, rank: [EXACT_MOVE, sharedTail(d.staged, add.staged)] }];
      const share = near.has(d) ? kept(s.out.get(d.path)!.data, add.now.data) : 0;
      if (share < 0.5) return [];
      const r = rest(s, add, src, "move");
      return r === null || r === "unclean" ? [] : [{ ...lead, rest: r, rank: [share, sharedTail(d.staged, add.staged)] }];
    });
  });
  const copies = adds.flatMap((add) => Array.from(s.staged).flatMap(([from, src]): Lead[] => {
    if (src.kind !== "up" || editedRels.has(src.path)) return [];
    if (buildsAsUpstream(src.path) && s.upstream.get(src.path)!.data.length !== add.now.data.length) return [];
    if (rest(s, add, src, "copy") !== null) return [];
    return [{ add, kind: "copy", from, rel: src.path, takes: null, rest: null, rank: [EXACT_COPY, sharedTail(from, add.staged)] }];
  }));
  return [...moves, ...copies];
}

function touched(s: Snapshot, edits: readonly Edited[]): Map<string, number> {
  const rels = new Map<string, number>();
  for (const e of edits) {
    const src = s.sources.get(e.path);
    if (src?.kind === "up") rels.set(src.path, (rels.get(src.path) ?? 0) + 1);
  }
  return rels;
}

/** The content edit a new output needs on top of what `src` builds there: null when it builds as is, "unclean" when the
 * difference can't be recorded as a file or paragraph edit. A copy takes no edit: one to its source would change the output it
 * copies too. */
function rest(s: Snapshot, add: Edited<"add">, src: Source, kind: Follow["kind"]): Edited | null | "unclean" {
  const built = s.build(src, add.path);
  if (sameFile(add.now, built, add.now.chosen)) return null;
  if (kind === "copy") return "unclean";
  const moved: Snapshot = { ...s, out: new Map(s.out).set(add.path, built), sources: new Map(s.sources).set(add.path, src) };
  const e = each(moved, [add.path])[0]!;
  return e.kind === "file-edit" || (e.kind === "paragraph-edit" && e.modeNotRecorded === null) ? e : "unclean";
}

/** The share of non-blank lines two texts keep in order, over the longer text's, or 0 when they keep fewer than two lines with a
 * letter or digit, so short files that share a heading don't pair. */
function kept(old: Uint8Array, fresh: Uint8Array): number {
  if (!isText(old) || !isText(fresh)) return 0;
  const [a, b] = [nonBlank(old), nonBlank(fresh)];
  const changed = new Set(lineChanges(a, b).flatMap(([i1, i2]) => Array.from({ length: i2 - i1 }, (_, k) => i1 + k)));
  const same = a.filter((_, i) => !changed.has(i));
  return same.filter((l) => WORD.test(l)).length < 2 ? 0 : same.length / Math.max(a.length, b.length);
}

const WORD = /[\p{L}\p{N}]/u;
const nonBlank = (data: Uint8Array) => decode(data).split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "");

function wordLines(data: Uint8Array): Map<string, number> {
  const counts = new Map<string, number>();
  if (isText(data)) for (const l of nonBlank(data)) if (WORD.test(l)) counts.set(l, (counts.get(l) ?? 0) + 1);
  return counts;
}

function sharingTwoWordLines(s: Snapshot, gone: readonly Edited<"delete-upstream">[]): (add: Edited<"add">) => Set<Edited> {
  const holding = new Map<string, [Edited, number][]>();
  for (const d of gone) {
    for (const [l, n] of wordLines(s.out.get(d.path)!.data)) {
      if (!holding.has(l)) holding.set(l, []);
      holding.get(l)!.push([d, n]);
    }
  }
  return (add) => {
    const shared = new Map<Edited, number>();
    for (const [l, n] of wordLines(add.now.data)) for (const [d, m] of holding.get(l) ?? []) shared.set(d, (shared.get(d) ?? 0) + Math.min(n, m));
    return new Set(Array.from(shared).flatMap(([d, n]) => (n >= 2 ? [d] : [])));
  };
}

function choose(leads: readonly Lead[]): Lead[] {
  const ranked = leads.toSorted((a, b) => b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1] || byCodePoint(a.from, b.from));
  const ends = (l: Lead): Edited[] => (l.takes ? [l.add, l.takes] : [l.add]);
  const decided = new Set<Edited>();
  const open = (l: Lead) => !ends(l).some((e) => decided.has(e));
  const chosen: Lead[] = [];
  const tiesWithOtherUpstream = (l: Lead) =>
    ranked.some((o) => o.rel !== l.rel && o.rank[0] === l.rank[0] && open(o) && ends(o).some((e) => ends(l).includes(e)));
  for (const l of ranked) {
    if (!open(l)) continue;
    if (!tiesWithOtherUpstream(l)) chosen.push(l);
    for (const e of ends(l)) decided.add(e);
  }
  return chosen;
}

type Way = string & { readonly way: true };
const way = (kind: Follow["kind"], from: string, to: string) => [kind, from, to].join("\0") as Way;
const wayOf = (l: Lead) => way(l.kind, l.from, l.add.staged);

function widen(s: Snapshot, going: ReadonlySet<Way>, empties: ReadonlyMap<Way, Lead>, lead: Lead): { edit: Follow; covers: Edited[] } {
  let [from, dest, covers] = [lead.from, lead.add.staged, [] as Edited[]];
  for (;;) {
    const [i, j] = [from.lastIndexOf("/"), dest.lastIndexOf("/")];
    const sameName = i >= 0 && j >= 0 && from.slice(i) === dest.slice(j);
    if (!sameName) break;
    const [folder, into] = [from.slice(0, i), dest.slice(0, j)];
    const nested = under(folder, into) || under(into, folder);
    const intoStaged = Array.from(s.staged.keys()).some((p) => under(p, into));
    if (nested || intoStaged) break;
    const empty: Edited[] = [];
    const wholeFolderGoes = Array.from(s.staged.keys()).every((p) => {
      if (!under(p, folder)) return true;
      const goes = way(lead.kind, p, into + p.slice(folder.length));
      if (going.has(goes)) return true;
      const keep = empties.get(goes);
      if (keep) empty.push(...(keep.takes ? [keep.add, keep.takes] : [keep.add]));
      return keep !== undefined;
    });
    if (!wholeFolderGoes) break;
    [from, dest, covers] = [folder, into, empty];
  }
  return { edit: { kind: lead.kind, path: from, dest }, covers };
}

function sharedTail(a: string, b: string): number {
  const [x, y] = [a.split("/"), b.split("/")];
  let n = 0;
  while (n < x.length && n < y.length && x[x.length - 1 - n] === y[y.length - 1 - n]) n++;
  return n;
}

function snapshot(book: Book, a: Assembly, current: ReadonlyMap<string, Seen>, changes: ReadonlyMap<string, Change>): Snapshot {
  const owners = new Map<string, Change>();
  for (const c of changes.values()) for (const e of c.edits) if (e.kind === "file") owners.set(e.path, c);
  const rules = new Rules(book, new Set(a.sources.keys()));
  return {
    out: a.out, sources: a.sources, upstream: a.upstream, current, changes, owners,
    blocks: new Set(blockFiles(book)),
    entriesAt: (rel) => entriesPath(book, rel),
    prefix: book.layout.kind === "folder" && book.layout.from ? book.layout.from + "/" : "",
    uses: (copy) => copy !== null && isText(copy) && rules.uses(decode(copy)),
    plan: (rel, path, built, now) => planParagraphs(book, rules, rel, path, decode(a.upstream.get(rel)!.data), built.data, now.data),
    staged: a.staged,
    build: a.build,
  };
}

type Asked = { named: string[]; drafts: [string, Draft][]; updates: [string, Draft][]; writes: Written[]; joins: Join[]; dropped: Dropped[] };

function asked(edits: readonly Edited[]): Asked {
  const ask: Asked = { named: [], drafts: [], updates: [], writes: [], joins: [], dropped: [] };
  for (const e of edits) {
    const need = needOf(e);
    if (need.named) ask.named.push(e.path);
    for (const d of need.drafts) ask.drafts.push([e.path, d]);
    ask.updates.push(...need.updates ?? []);
    if (need.writes) ask.writes.push(need.writes);
    if (need.joins) ask.joins.push(need.joins);
    if (need.dropped) ask.dropped.push(need.dropped);
  }
  return ask;
}

/** The edits that need a change name, as the model reads them: a move or copy as its line with no diff, and every other edit by its output
 * path. A file edited after a move is diffed against the moved file as the build writes it at its new path, so only the edit shows. */
function pendingEdits(a: Assembly, current: ReadonlyMap<string, Seen>, edits: readonly Edited[]): Part[] {
  const moved = new Map(edits.flatMap((e): [string, File][] => (e.kind === "file-edit" && !a.out.has(e.path) ? [[e.path, a.build({ kind: "up", path: e.rel }, e.path)]] : [])));
  const built = { ...a, out: new Map([...a.out, ...moved]) };
  return edits.filter((e) => needOf(e).named).flatMap((e): Part[] => (e.kind === "follow" ? [{ line: editText(e.edit), diff: "" }] : pendingParts(built, current, [e.path])));
}

/** An existing change or block entry this record adds to, by its key in the model's reply, with the intent it has. */
type Joined = { key: string; was: string; parts(): Part[] };

/** Every change an edit joins, the named change too when it exists and takes named edits, and every updated entry. Removals don't join,
 * but a change that is rewritten is shown without the edits this record takes out of it. */
function joined(ask: Asked, known: Change | null, newParts: () => Part[]): Joined[] {
  const changes = new Map<Change, Map<string, Uint8Array>>();
  for (const j of ask.joins) changes.set(j.change, (changes.get(j.change) ?? new Map()).set(j.path, j.data));
  if (known && ask.named.length && !changes.has(known)) changes.set(known, new Map());
  return [
    ...Array.from(changes, ([c, overlay]): Joined => ({
      key: c.name, was: c.intent?.text ?? "", parts: () => [...changeParts(c, overlay, ask.dropped.filter((d) => d.change === c)), ...(c === known && ask.named.length ? newParts() : [])],
    })),
    ...ask.updates.map(([label, d]): Joined => ({ key: label, was: d.was!.text, parts: () => [entryPart(label, d.upstream, d.patched)] })),
  ];
}

type Misfit = { edit: Edit; in: string } | "own";

/** Why the change `name` can't take `w`: an edit on its path, a folder above it or a path under it, in a change later in the series,
 * which has to apply first; or, for an add or a replace, a copy of that path the change already keeps. Any change takes a file edit. */
function misfit(roster: Roster, name: string, w: Written): Misfit | null {
  if (w.kind === "file") return null;
  const ends = "dest" in w ? [w.path, w.dest] : [w.path];
  const overlaps = (p: string) => ends.some((q) => under(p, q) || under(q, p));
  for (const later of roster.after(name).toReversed()) {
    const edit = later.edits.findLast((e) => e.kind !== "file" && !(later === w.drops && e.kind === "replace" && e.path === w.path)
      && (overlaps(e.path) || ("dest" in e && overlaps(e.dest))));
    if (edit) return { edit, in: later.name };
  }
  return (w.kind === "add" || w.kind === "replace") && roster.parsed.get(name)?.read("ours", w.path) != null ? "own" : null;
}

function refusal(name: string, misfits: readonly [Written, Misfit][]): string {
  const lines = misfits.map(([w, why]) => `  ${editText(w)}: `
    + (why === "own" ? `${name} already has its own copy of ${w.path}` : `${editText(why.edit)} in ${why.in}, later in the series, has to come before it`));
  const floor = misfits.flatMap(([, why]) => (why === "own" ? [] : [why.in])).at(-1);
  return `can't record into ${name}:\n${lines.join("\n")}\n`
    + (floor ? `Record into ${floor} or a change after it, or into a new change.` : "Record into a new change.");
}

/** Where this record's intents come from. `fresh` is the model's intent for the record's new change and new entries. */
type Authored =
  | { by: "given"; intent: string }
  | { by: "model"; fresh: string | null; intents: ReadonlyMap<string, string> }
  | { by: "failed"; why: string }
  | { by: "unasked" };
type Naming = { name: string | null; authored: Authored; said: string | null; unused: boolean };

const byAuthor = (text: string): Intent => ({ text, by: "author" });

/** The new intent for a joined change or entry, or null to keep the one it has. */
function rewritten(n: Naming, key: string): string | null {
  if (n.authored.by === "given") return key === n.name ? n.authored.intent : null;
  return n.authored.by === "model" ? n.authored.intents.get(key) ?? null : null;
}

/** The intent for the record's new change and new entries, null when nothing asked for one or patchbook writes it: a new change's once
 * its edits apply, and a new entry's from its paragraph edit. */
function newIntent(n: Naming): string | null {
  const a = n.authored;
  return a.by === "given" ? a.intent : a.by === "model" ? a.fresh : null;
}

function nameAndIntent(
  ask: Asked, name: string | null, given: string | null, roster: Roster, joins: readonly Joined[],
  model: (fresh: Omit<Fresh, "parts"> | null, offered: ReadonlyMap<string, Change>) => Reply,
): Naming {
  const changes = roster.parsed;
  const misfits = (c: string) => ask.writes.flatMap((w): [Written, Misfit][] => {
    const why = misfit(roster, c, w);
    return why ? [[w, why]] : [];
  });

  const stray = name ? roster.stray(name) : null;
  if (stray === "folder") {
    throw new Fail(`change ${name} is not in the series: add it to ${PB}/series to record into it, or move ${PB}/changes/${name} out of the way`);
  }
  if (stray) throw new Fail(`${PB}/changes/${name} is not a change folder: move it out of ${PB}/changes`);
  if (name !== null && roster.known(name)) {
    const refused = misfits(name);
    if (refused.length) throw new Fail(refusal(name, refused));
  }
  const named = ask.named.length > 0;
  const known = name !== null && changes.has(name);
  if (given) {
    const authored: Authored = { by: "given", intent: given };
    const unused = !named && !ask.drafts.length && !known && !ask.updates.some(([, d]) => !d.was!.text);
    if (name) return { name, authored, said: null, unused };
    if (!named) return { name: null, authored, said: null, unused };
    const derived = nameFromIntent(given, roster);
    return { name: derived, authored, said: `${derived}: ${given}`, unused };
  }
  if (!named && !ask.drafts.length && !joins.length) return { name: null, authored: { by: "unasked" }, said: null, unused: false };
  // A named change that exists takes the new edits as a refresh, so only new things are fresh.
  const fresh = named ? (known ? null : { name, named: true }) : ask.drafts.length ? { name: null, named: false } : null;
  let reply: Reply;
  try {
    // The model sees only the changes that can take these edits, and a reply that names another starts a new change.
    reply = model(fresh, new Map(Array.from(changes).filter(([c]) => !misfits(c).length)));
  } catch (e) {
    if (e instanceof ModelFailed) return withoutModel(ask, name, roster, e.why);
    throw e;
  }
  const key = fresh === null ? name : fresh.named ? reply.change ?? name : PARAGRAPHS;
  const intent = key === null ? null : reply.intents.get(key) ?? null;
  const authored: Authored = { by: "model", fresh: intent, intents: reply.intents };
  if (!named) return { name: known ? name : null, authored, said: fresh ? `intent: ${intent}` : null, unused: false };
  if (known) return { name, authored, said: null, unused: false };
  const picked = reply.change ?? name!;
  const chosen = roster.known(picked) && !misfits(picked).length ? picked : roster.free(picked);
  return { name: chosen, authored, said: changes.has(chosen) ? `adding to ${chosen}` : `${chosen}: ${intent}`, unused: false };
}

/** With no model, edits that need a name go to the change named, or to a new one named from the edits, since joining another change is
 * the model's call. Patchbook writes the change's intent once the edits apply, and each new entry's from its paragraph edit. */
function withoutModel(ask: Asked, name: string | null, roster: Roster, why: string): Naming {
  const known = name !== null && roster.parsed.has(name);
  const chosen = known ? name : ask.named.length ? roster.free(name ?? nameFromEdits(ask.writes)) : null;
  return { name: chosen, authored: { by: "failed", why }, said: null, unused: false };
}

/** What a recording says, and the copies whose mode it picked, repo-relative, for the commit hook to stage. */
export type RecordResult = { text: string; copies: ReadonlyMap<string, Mode>; after: Assembly | null };

export async function cmdRecord(args: { change: string | null; intent: string | null; only?: (path: string) => boolean }) {
  const book = await Book.find();
  installHookOrWarn(book);
  say(record(book, args.change, args.intent, { seen: book.seen("disk"), only: args.only }).text);
  return 0;
}

export async function cmdIntent(args: { change: string | null; intent: string | null }) {
  say(fill(await Book.find(), args.change, args.intent));
  return 0;
}

export function fill(book: Book, change: string | null, intent: string | null): string {
  if (change && !CHANGE_NAME.test(change)) throw new Fail(notAChangeName(change));
  const changes = Roster.read(book).parsed;
  const target = change === null ? null : changes.get(change);
  if (change !== null && !target) throw new Fail(`no change called ${change}`);
  if (target?.intent?.by === "author") throw new Fail(`${change} already has an intent; to change it, edit ${PB}/changes/${change}/CHANGE.md`);
  const given = intent === null ? null : oneLine(intent) || null;
  if (given && change === null) throw new Fail("--intent needs a change name: patchbook intent <change> --intent ...");

  const empty = target ? [target] : Array.from(changes.values()).filter((c) => c.intent?.by !== "author");
  const filled = empty.map((c): [Change, string] => [c, given ?? writeIntents(book, changes, null, [{ key: c.name, was: "", parts: changeParts(c) }]).intents.get(c.name)!]);
  const files: { rel: string; entries: Map<string, Entry>; intent: string }[] = [];
  for (const rel of target ? [] : blockFiles(book)) {
    const entries = readEntries(entriesPath(book, rel));
    const open = (e: Entry) => e.intent.by === "patchbook" || !e.intent.text;
    const bare = Array.from(entries.values()).filter(open);
    if (!bare.length) continue;
    const parts = bare.map((e) => entryPart(rel, e.upstream, e.patched));
    const text = given ?? writeIntents(book, changes, { name: null, named: false, parts }, []).intents.get(PARAGRAPHS)!;
    files.push({ rel, entries: new Map(Array.from(entries, ([h, e]) => [h, open(e) ? { ...e, intent: byAuthor(text) } : e])), intent: text });
  }

  if (!filled.length && !files.length) return "no intent is empty or by patchbook; nothing to fill\n";
  for (const [c, text] of filled) {
    c.intent = byAuthor(text);
    saveChange(c);
  }
  for (const f of files) saveParagraphs(entriesPath(book, f.rel), f.entries);
  return filled.map(([c, text]) => `intent   ${c.name}: ${text}\n`).join("") + files.map((f) => `entries  ${f.rel}: ${f.intent}\n`).join("");
}

export function record(
  book: Book, change: string | null, intent: string | null,
  opts: { seen: ReadonlyMap<string, Seen>; edits?: readonly string[]; only?: ((path: string) => boolean) | undefined; undo?: Undo; assembly?: Assembly },
): RecordResult {
  if (change && !CHANGE_NAME.test(change)) throw new Fail(notAChangeName(change));
  const problems: Problem[] = [];
  const roster = Roster.read(book, problems);
  const changes = roster.parsed;
  const badName = problems.find((p) => p.file === "series" && "refuse" in p);
  if (badName) {
    throw new Fail(`refusing to record: ${describe(badName)}\n`
      + (badName.problem === "conflict" ? "Keep both sides' change names in series, then run `patchbook build` first." : "Rename it to lowercase letters, digits and dashes in series and changes/ first."));
  }
  const a = opts.assembly ?? assemble(book);
  const current = opts.seen;
  // Only files edited by hand since the last build. Others differ because the patchbook changed.
  const edited = (opts.edits ?? handEdits(book, a.out, current)).filter(opts.only ?? (() => true));
  if (!edited.length) return { text: "no hand edits to the output since the last build; nothing to record\n", copies: new Map(), after: null };
  refuseLinkTurnedFile(a, current, edited);
  refuseFolderToFile(book, a.out, current, edited);
  const s = snapshot(book, a, current, changes);
  const backslashed = edited.flatMap((p) => [s.prefix + p, a.sources.get(p)?.path ?? p]).find((p) => p.includes("\\"));
  if (backslashed) throw new Fail(`refusing to record: ${backslashed} has a backslash in its name, and an edit path can't have one. Rename it first.`);
  const readAsPatchbook = edited.find((p) => book.reservedOutput(p)?.place === PB);
  if (readAsPatchbook) throw new Fail(`refusing to record: ${readAsPatchbook} is ${PB} on macOS and Windows, and a change can't write into ${PB}. Move it out of there.`);
  const edits = classify(s, edited);

  const given = intent === null ? null : oneLine(intent) || null;
  const ask = asked(edits);
  const newParts = () => [...pendingEdits(a, current, edits), ...ask.drafts.map(([p, d]) => entryPart(p, d.upstream, d.patched))];
  const joins = joined(ask, change === null ? null : changes.get(change) ?? null, newParts);
  const naming = nameAndIntent(ask, change, given, roster, joins, (fresh, offered) =>
    writeIntents(book, offered, fresh && { ...fresh, parts: newParts() }, joins.map((j) => ({ key: j.key, was: j.was, parts: j.parts() }))));
  const fresh = newIntent(naming);
  const target = naming.name ? changes.get(naming.name) ?? new Change(naming.name, join(book.dir, "changes", naming.name), fresh ? byAuthor(fresh) : null) : null;
  for (const c of new Set([...ask.joins.map((j) => j.change), ...(target ? [target] : [])])) {
    const text = rewritten(naming, c.name);
    if (text !== null) c.intent = byAuthor(text);
  }

  const touched = new Map<string, Change>();
  const notes: string[] = [];
  const copies = new Map<string, Mode>();
  const afterSave: (() => void)[] = [];
  const drafted: string[] = [];
  const redrafted: string[] = [];
  const undo = opts.undo ?? new Undo();
  undo.hold(book.dir);
  let after: Assembly | null = null;
  try {
    for (const e of edits) {
      const done = row(e).apply(e, { target, intent: newIntent(naming), rewritten: (key) => rewritten(naming, key) });
      for (const c of done.touched) touched.set(c.name, c);
      notes.push(...done.notes);
      for (const [p, mode] of done.copies ?? []) copies.set(relative(book.root, p), mode);
      if (done.afterSave) afterSave.push(done.afterSave);
      drafted.push(...done.drafted ?? []);
    }
    if (target && (target.edits.length || (given && changes.has(target.name)))) touched.set(target.name, target);
    for (const c of touched.values()) {
      if (c.intent?.by === "author" || !c.edits.length) continue;
      const text = intentFromEdits(c.edits);
      if (changes.has(c.name) && text !== c.intent?.text) redrafted.push(`intent   ${c.name}: ${text}\n`);
      c.intent = { text, by: "patchbook" };
      drafted.push(c.name);
    }
    for (const c of touched.values()) saveChange(c);
    if (target?.edits.length && !readSeries(book).includes(target.name)) appendSeries(book, target.name);
    for (const after of afterSave) after();
    const lock = readBuildLock(book);
    const follows = edits.flatMap((e) => (e.kind === "follow" ? [e.edit] : []));
    if (lock !== null || follows.length) {
      const built = assemble(book);
      after = built;
      refuseBuiltOtherwise(built, current, edited, s.prefix, follows);
      // The recorded output is now what the patchbook builds, so it no longer counts as a hand edit.
      if (lock !== null) {
        for (const p of edited) {
          const out = built.out.get(p);
          const now = current.get(p);
          if (out !== undefined && sameFile(now, out, now?.chosen ?? true)) lock.set(p, stampOf(out));
          else if (out === undefined && !current.has(p)) lock.delete(p);
        }
        writeBuildLines(book, lock);
      }
    }
  } catch (error) {
    // An Undo passed in belongs to the caller, which puts everything back and names what it couldn't, once.
    if (opts.undo) throw error;
    const stuck = undo.restore();
    if (stuck.length) {
      warn("patchbook: couldn't put these back as they were:\n  " + stuck.join("\n  ")
        + "\nCheck that you can write to them, then compare them with `git diff` before you commit again.\n");
    }
    throw error;
  }
  const owners = Array.from(touched.keys()).join(", ");
  const dropped = naming.unused && edits.some((e) => e.kind !== "skip");
  const keys = new Set([...(target && changes.has(target.name) ? [target.name] : []), ...joins.map((j) => j.key)]);
  const intents = naming.authored.by === "model" ? naming.authored.intents : new Map<string, string>();
  const rewrites = Array.from(keys).flatMap((k) => (intents.has(k) ? [`intent   ${k}: ${intents.get(k)}\n`] : []));
  const kept = joins.filter((j) => j.was && rewritten(naming, j.key) === null && !drafted.includes(j.key)).map((j) => j.key);
  const failed = naming.authored.by === "failed" ? naming.authored.why : null;
  const why = failed ?? "the given intent is for the change being recorded";
  const opened = target && !changes.has(target.name) && drafted.includes(target.name) ? `${target.name}: ${target.intent!.text}\n` : "";
  const fix = drafted.length === 1 ? replaceIntent(touched.has(drafted[0]!) ? drafted[0]! : undefined) : "To replace them, run `patchbook intent` or edit their lines to `intent: <yours>`";
  const text = (naming.said !== null ? naming.said + "\n" : "") + opened + notes.map((n) => n + "\n").join("") + rewrites.join("") + redrafted.join("")
    + (dropped ? `intent   not used${owners ? `: the edits went to ${owners}` : ""}\n` : "")
    + (kept.length ? `intent   may be stale: ${kept.join(", ")} (${why}). Edit them by hand to cover these edits\n` : "")
    + (drafted.length ? `intent   by patchbook for ${drafted.join(", ")}${failed ? ` (${failed})` : ""}. ${fix}\n` : "");
  return { text, copies, after };
}

function refuseBuiltOtherwise(a: Assembly, current: ReadonlyMap<string, Seen>, edited: readonly string[], prefix: string, follows: readonly Follow[]): void {
  const wrong = follows.flatMap((f): [Follow, string[]][] => {
    const ends = f.kind === "move" ? [f.path, f.dest] : [f.dest];
    const paths = edited.filter((p) => ends.some((q) => under(prefix + p, q)) && !sameFile(current.get(p), a.out.get(p), current.get(p)?.chosen ?? true));
    return paths.length ? [[f, paths]] : [];
  });
  if (wrong.length) {
    throw new Fail(wrong.map(([f, paths]) => `can't record ${editText(f)}: the build would differ from ${paths.join(", ")} on disk, `
      + "for example because a finish hook rewrites it").join("\n"));
  }
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
  const blocks = blocksOf(upstreamText.split("\n"));
  const owners: (number | null)[] = [];
  const { text } = patchBlocks({ rules, outPath, rel, text: upstreamText, entries, owners });
  if (!bytesEqual(encode(text), built)) return "a hook changes it after its block entries apply; edit the entries directly";
  const old = text.split("\n");
  const fresh = decode(now).split("\n");
  const changed = lineChanges(old, fresh);

  // Each edit belongs to the blocks whose lines it touches, or, between blocks, to the block before it.
  const blame: { inside: Set<number>; i1: number; i2: number; j1: number; j2: number }[] = [];
  for (const [i1, i2, j1, j2] of changed) {
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
  const shown = blocks.map((_, k) => k).filter((k) => owners.includes(k));
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
    const js = Math.min(mapLine(changed, bs), ...mine.map((b) => b.j1));
    const je = Math.max(mapLine(changed, be), ...mine.map((b) => b.j2));
    const chunk = fresh.slice(js, je);
    while (chunk.length && !chunk[0]!.trim()) chunk.shift();
    while (chunk.length && !chunk.at(-1)!.trim()) chunk.pop();
    for (const [i, k] of group.entries()) {
      let piece = i === 0 ? chunk.map((line) => line.replace(/\r$/, "")).join("\n") : "";
      const b = blocks[k]!;
      const upstream = b.text;
      const was = keyFor(entries, b);
      if (was !== undefined) { // keep its placeholders where their values still appear
        for (const [hint] of entries.get(was)!.patched.matchAll(PLACEHOLDER_HINT)) {
          const value = rules.expand(hint, () => {});
          if (value === "") return `its block entry uses ${hint}, which is empty, so the edit can't show where it goes; edit its block entries directly`;
          if (value !== hint) piece = piece.split(value).join(hint);
        }
      }
      const key = recordKey(result, blocks, b);
      const at = key === b.hash ? {} : { at: occurrence(b) };
      const entry = result.get(key) ?? result.get(b.hash);
      if (piece === upstream && (!entry || entry.kind !== "keep")) {
        if (result.delete(key)) notes.push([key, "removed: the paragraph is upstream's again"]);
        // An entry for every paragraph with this text would still patch this one.
        const shared = keyFor(result, b);
        if (shared !== undefined && result.get(shared)!.patched !== upstream) {
          const own = entryKey(b.hash, b);
          result.set(own, { hash: b.hash, at: occurrence(b), kind: "keep", rules: "", intent: null, upstream, patched: upstream });
          notes.push([own, "added"]);
        }
        continue;
      }
      if (entry && entry.kind !== "keep") {
        result.set(key, entry.intent === null ? { ...entry, ...at, patched: piece } : { ...entry, ...at, patched: piece, intent: null, was: entry.intent });
        notes.push([key, "updated"]);
      } else {
        result.set(key, { hash: b.hash, ...at, kind: "policy", rules: "", intent: null, upstream, patched: piece });
        notes.push([key, "added"]);
      }
    }
  }

  const filled = new Map(Array.from(result, ([h, e]) => [h, { ...e, intent: e.intent?.text ? e.intent : byAuthor("-") }]));
  const check = patchBlocks({ rules, outPath, rel, text: upstreamText, entries: filled }).text;
  if (!bytesEqual(encode(check), now)) return "the edit doesn't map onto whole paragraphs; edit its block entries directly";
  return { path: entriesPath(book, rel), entries: result, notes };
}

const occurrence = ({ nth, of, between }: Block): Occurrence => ({ nth, of, between });

/** The key to record a block's entry under: the block's own entry's, else the one for its text, unless another block with that
 * text has no entry of its own and would take the new text too. Then a new entry for this occurrence alone. */
function recordKey(result: ReadonlyMap<string, Draft>, blocks: readonly Block[], b: Block): string {
  const own = entryKey(b.hash, b);
  if (result.has(own)) return own;
  return blocks.some((o) => o !== b && o.hash === b.hash && !result.has(entryKey(o.hash, o))) ? own : b.hash;
}

/** The line of the new text that line i of the old text lines up with. */
function mapLine(changed: readonly Changed[], i: number): number {
  let shift = 0;
  for (const [i1, i2, j1, j2] of changed) {
    if (i < i1) break;
    if (i < i2) return j1;
    shift = j2 - i2;
  }
  return i + shift;
}

/** Each entry with its intent. A new one takes `intent`, or else what patchbook writes from its paragraph edit. An updated one takes its
 * rewrite, else keeps an intent someone wrote, else has one patchbook wrote written again, else takes `intent`, if there is one, in place
 * of its blank. Returns the keys of the entries whose intent patchbook wrote. */
function withIntent(plan: Plan, path: string, intent: string | null, rewrite: (key: string) => string | null): { entries: Map<string, Entry>; drafted: string[] } {
  const drafted: string[] = [];
  const entries = new Map(Array.from(plan.entries, ([h, { was, ...d }]): [string, Entry] => {
    const said = was === undefined ? intent : rewrite(h);
    let own: Intent;
    if (d.intent !== null) own = d.intent;
    else if (said !== null) own = byAuthor(said);
    else if (was === undefined || was.by === "patchbook") {
      own = { text: intentFromParagraph(path, d.upstream, d.patched), by: "patchbook" };
      drafted.push(h);
    } else own = was.text || intent === null ? was : byAuthor(intent);
    return [h, { ...d, intent: own }];
  }));
  return { entries, drafted };
}

function saveParagraphs(path: string, entries: ReadonlyMap<string, Entry>): void {
  if (entries.size) writeText(path, Array.from(entries.values(), formatEntry).join("\n"));
  else if (exists(path)) unlinkSync(path);
}
