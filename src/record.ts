// Recording hand edits to the output: as block entries, as edits to a change that owns the file, or as a new change.
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Problem } from "./api.ts";
import { assemble, type Assembly, blockFiles, describe, handEdits, readBuildLock, type Source, stampOf, writeBuildLines } from "./assemble.ts";
import { blockHash, blockSpans, type Entry, entriesPath, formatEntry, patchBlocks, PLACEHOLDER_HINT, readEntries, Rules } from "./blocks.ts";
import { Book, PB, under } from "./book.ts";
import { appendSeries, CHANGE_NAME, Change, notAChangeName, readSeries, Roster, saveChange } from "./changes.ts";
import { installHookOrWarn } from "./githook.ts";
import { changeDiff, ModelFailed, nameFromIntent, oneLine, pendingDiff, writeIntent } from "./intent.ts";
import { type Opcode, SequenceMatcher, unifiedDiff } from "./lib/difflib.ts";
import { Fail } from "./lib/fail.ts";
import { exists, type File, LINK, meantMode, type Mode, recordedModes, relative, sameFile, type Seen, writeText } from "./lib/fs.ts";
import { replace, splitlines, strip } from "./lib/py.ts";
import { bytesEqual, decode, encode, isText } from "./lib/text.ts";
import { Undo } from "./undo.ts";

/** An entry a recording makes. A null intent means it still needs one. */
type Draft = Omit<Entry, "intent"> & { intent: string | null };
type Plan = { path: string; entries: Map<string, Draft>; notes: [string, string][] };

type Copy = { change: Change; staged: string };

type Destination = { kind: "owned"; change: Change; up?: File | undefined } | { kind: "recorded"; base: File };

type Data = {
  "add": { staged: string; now: Seen };
  "delete-upstream": { staged: string; entries: string | null };
  "unadd": Copy;
  "unreplace": Copy;
  "update-ours": Copy & { now: Seen; built: File; up: File | undefined };
  "file-edit": { rel: string; now: Seen; built: Mode; to: Destination };
  "paragraph-edit": { plan: Plan; modeNotRecorded: string | null };
  "skip": { reason: string };
};

type Kind = keyof Data;
export type Edited<K extends Kind = Kind> = { [P in K]: { kind: P; path: string } & Data[P] }[K];

type Need = { named: boolean; drafts: readonly Draft[] };
const NOTHING: Need = { named: false, drafts: [] };
const NAMED: Need = { named: true, drafts: [] };

type Recording = { target: Change | null; intent: string | null };
/** `copies` are the copies whose mode the row picked, absolute, for the commit hook to stage. */
type Done = { touched: readonly Change[]; notes: readonly string[]; copies?: readonly [string, Mode][]; afterSave?: () => void };

type Row<K extends Kind> = { needs(e: Edited<K>): Need; apply(e: Edited<K>, r: Recording): Done };

const KINDS: { readonly [K in Kind]: Row<K> } = {
  "add": {
    needs: () => NAMED,
    apply: (e, r) => {
      const c = r.target!;
      c.edits.push({ kind: "add", path: e.staged });
      const copies = writeCopy(c, e.staged, e.now, undefined, undefined);
      return { touched: [c], notes: [`add      ${e.path}`], copies };
    },
  },
  "delete-upstream": {
    needs: () => NAMED,
    apply: (e, r) => {
      const c = r.target!;
      c.edits.push({ kind: "delete", path: e.staged });
      const entries = e.entries;
      const afterSave = () => { if (entries !== null && exists(entries)) unlinkSync(entries); };
      return { touched: [c], notes: [`delete   ${e.path}`], afterSave };
    },
  },
  "unadd": {
    needs: () => NOTHING,
    apply: (e) => {
      e.change.edits = e.change.edits.filter((x) => !(x.kind === "add" && x.path === e.staged));
      const afterSave = () => dropCopies(e.change, e.staged);
      return { touched: [e.change], notes: [`unadd    ${e.path} (from ${e.change.name})`], afterSave };
    },
  },
  "unreplace": {
    needs: () => NAMED,
    apply: (e, r) => {
      const c = r.target!;
      e.change.edits = e.change.edits.filter((x) => !(x.kind === "replace" && x.path === e.staged));
      c.edits.push({ kind: "delete", path: e.staged });
      const afterSave = () => dropCopies(e.change, e.staged);
      return { touched: [e.change, c], notes: [`delete   ${e.path} (replace removed from ${e.change.name})`], afterSave };
    },
  },
  "update-ours": {
    needs: () => NOTHING,
    apply: (e) => {
      const copies = writeCopy(e.change, e.staged, e.now, e.built.mode, e.up);
      return { touched: [e.change], notes: [`update   ${e.path} (in ${e.change.name})`], copies };
    },
  },
  "file-edit": {
    needs: (e) => (e.to.kind === "recorded" ? NAMED : NOTHING),
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
    needs: (e) => ({ named: false, drafts: Array.from(e.plan.entries.values()).filter((d) => d.intent === null) }),
    apply: (e, r) => {
      saveParagraphs(e.plan.path, withIntent(e.plan, r.intent));
      const notes = e.plan.notes.map(([h, what]) => `entry    ${e.path} [${h}] ${what}`);
      if (e.modeNotRecorded !== null) notes.push(`skipped  ${e.path}: ${e.modeNotRecorded}`);
      return { touched: [], notes };
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
};

export function classify(s: Snapshot, paths: readonly string[]): Edited[] {
  const shared = new Map(paths.map((p) => [p, sharedSource(s, p)]));
  const units = Map.groupBy(paths.filter((p) => shared.get(p)), (p) => unitKey(shared.get(p)!));
  return paths.map((path) => {
    const src = shared.get(path);
    const others = src ? units.get(unitKey(src))!.filter((p) => p !== path) : [];
    if (!src || !others.length) return classifyOne(s, path);
    const from = src.kind === "ours" ? `its copy in ${src.change}` : `upstream's ${src.path}`;
    const fix = src.kind === "ours" ? `edit ${src.change} directly` : "edit only one of them";
    return { kind: "skip", path, reason: `${from} also builds ${others.join(", ")}, which this record changes too; ${fix}, or to give them different text, remove the copy edit and record the destination again` };
  });
}

function sharedSource(s: Snapshot, path: string): Source | null {
  const src = s.out.has(path) ? s.sources.get(path) : undefined;
  const deleted = !s.current.has(path);
  return src && (src.kind === "ours" || !deleted) ? src : null;
}

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

type Naming = { name: string; intent: string; said: string | null; unused: boolean } | { name: null; intent: string | null; said: string | null; unused: boolean };

function nameAndIntent(
  ask: Asked, name: string | null, given: string | null, roster: Roster,
  model: (name: string | null, named: boolean) => [string, string],
): Naming {
  const changes = roster.parsed;

  const stray = name ? roster.stray(name) : null;
  if (stray === "folder") {
    throw new Fail(`change ${name} is not in the series: add it to ${PB}/series to record into it, or move ${PB}/changes/${name} out of the way`);
  }
  if (stray) throw new Fail(`${PB}/changes/${name} is not a change folder: move it out of ${PB}/changes`);
  const named = ask.named.length > 0;
  if (given) {
    const setsExisting = name !== null && changes.has(name);
    const unused = !named && !ask.drafts.length && !setsExisting;
    if (name) return { name, intent: given, said: null, unused };
    if (!named) return { name: null, intent: given, said: null, unused };
    const derived = nameFromIntent(given, roster);
    return { name: derived, intent: given, said: `${derived}: ${given}`, unused };
  }
  const known = name === null ? undefined : changes.get(name);
  if (known) return { name, intent: known.intent, said: null, unused: false };
  if (!named && !ask.drafts.length) return { name: null, intent: null, said: null, unused: false };
  let answer: [string, string];
  try {
    answer = model(name, named);
  } catch (e) {
    if (e instanceof ModelFailed) return pending(ask, name, roster, e.why);
    throw e;
  }
  const [picked, intent] = answer;
  if (!named) return { name: null, intent, said: `intent: ${intent}`, unused: false };
  const chosen = roster.known(picked) ? picked : roster.free(picked);
  return { name: chosen, intent, said: changes.has(chosen) ? `adding to ${chosen}` : `${chosen}: ${intent}`, unused: false };
}

function pending(ask: Asked, name: string | null, roster: Roster, why: string): Naming {
  const chosen = ask.named.length ? roster.free(name ?? "pending") : null;
  const entries = ask.drafts.length > 0;
  const what = [chosen, entries ? "the new entries" : null].filter((x) => x !== null).join(" and ");
  const fill = chosen && !entries ? `patchbook intent ${chosen}` : "patchbook intent";
  const said = `pending  no intent yet for ${what} (${why}). To fill it: ${fill}`;
  return chosen ? { name: chosen, intent: "", said, unused: false } : { name: null, intent: "", said, unused: false };
}

function modelDiff(a: Assembly, current: ReadonlyMap<string, File>, ask: Asked): string {
  return pendingDiff(a, current, ask.named) + ask.drafts
    .map(([p, e]) => unifiedDiff(splitlines(e.upstream + "\n", true), splitlines(e.patched + "\n", true), `upstream/${p}`, `disk/${p}`))
    .join("");
}

/** What a recording says, and the copies whose mode it picked, repo-relative, for the commit hook to stage. */
export type RecordResult = { text: string; copies: ReadonlyMap<string, Mode> };

export async function cmdRecord(args: { change: string | null; intent: string | null; only?: (path: string) => boolean }) {
  const book = await Book.find();
  installHookOrWarn(book);
  process.stdout.write(record(book, args.change, args.intent, { seen: book.seen("disk"), only: args.only }).text);
  return 0;
}

export async function cmdIntent(args: { change: string | null; intent: string | null }) {
  process.stdout.write(fill(await Book.find(), args.change, args.intent));
  return 0;
}

export function fill(book: Book, change: string | null, intent: string | null): string {
  if (change && !CHANGE_NAME.test(change)) throw new Fail(notAChangeName(change));
  const changes = Roster.read(book).parsed;
  const target = change === null ? null : changes.get(change);
  if (change !== null && !target) throw new Fail(`no change called ${change}`);
  if (target?.intent) throw new Fail(`${change} already has an intent; to change it, edit ${PB}/changes/${change}/CHANGE.md`);
  const given = intent === null ? null : oneLine(intent) || null;
  if (given && change === null) throw new Fail("--intent needs a change name: patchbook intent <change> --intent ...");

  const empty = target ? [target] : Array.from(changes.values()).filter((c) => !c.intent);
  const filled = empty.map((c): [Change, string] => [c, given ?? writeIntent(book, changes, changeDiff(c), c.name, true, true)[1]]);
  const files: { rel: string; entries: Map<string, Entry>; intent: string }[] = [];
  for (const rel of target ? [] : blockFiles(book)) {
    const entries = readEntries(entriesPath(book, rel));
    const bare = Array.from(entries.values()).filter((e) => !e.intent);
    if (!bare.length) continue;
    const diff = bare.map((e) => unifiedDiff(splitlines(e.upstream + "\n", true), splitlines(e.patched + "\n", true), `upstream/${rel}`, `patched/${rel}`)).join("");
    const text = given ?? writeIntent(book, changes, diff, null, false)[1];
    files.push({ rel, entries: new Map(Array.from(entries, ([h, e]) => [h, e.intent ? e : { ...e, intent: text }])), intent: text });
  }

  if (!filled.length && !files.length) return "no empty intents; nothing to fill\n";
  for (const [c, text] of filled) {
    c.intent = text;
    saveChange(c);
  }
  for (const f of files) saveParagraphs(entriesPath(book, f.rel), f.entries);
  return filled.map(([c, text]) => `intent   ${c.name}: ${text}\n`).join("") + files.map((f) => `entries  ${f.rel}: ${f.intent}\n`).join("");
}

export function record(
  book: Book, change: string | null, intent: string | null,
  opts: { seen: ReadonlyMap<string, Seen>; edits?: readonly string[]; only?: ((path: string) => boolean) | undefined; undo?: Undo },
): RecordResult {
  if (change && !CHANGE_NAME.test(change)) throw new Fail(notAChangeName(change));
  const problems: Problem[] = [];
  const roster = Roster.read(book, problems);
  const changes = roster.parsed;
  const badName = problems.find((p) => p.file === "series" && "refuse" in p);
  if (badName) throw new Fail(`refusing to record: ${describe(badName)}\nRename it to lowercase letters, digits and dashes in series and changes/ first.`);
  const a = assemble(book);
  const current = opts.seen;
  // Only files edited by hand since the last build. Others differ because the patchbook changed.
  const edited = (opts.edits ?? handEdits(book, a.out, current)).filter(opts.only ?? (() => true));
  if (!edited.length) return { text: "no hand edits to the output since the last build; nothing to record\n", copies: new Map() };
  refuseLinkTurnedFile(a, current, edited);
  const s = snapshot(book, a, current, changes);
  const backslashed = edited.flatMap((p) => [s.prefix + p, a.sources.get(p)?.path ?? p]).find((p) => p.includes("\\"));
  if (backslashed) throw new Fail(`refusing to record: ${backslashed} has a backslash in its name, and an edit path can't have one. Rename it first.`);
  const readAsPatchbook = edited.find((p) => book.reservedOutput(p)?.place === PB);
  if (readAsPatchbook) throw new Fail(`refusing to record: ${readAsPatchbook} is ${PB} on macOS and Windows, and a change can't write into ${PB}. Move it out of there.`);
  const edits = classify(s, edited);

  const given = intent === null ? null : oneLine(intent) || null;
  const ask = asked(edits);
  const naming = nameAndIntent(ask, change, given, roster, (n, named) => writeIntent(book, changes, modelDiff(a, current, ask), n, named));
  const target = naming.name ? changes.get(naming.name) ?? new Change(naming.name, join(book.dir, "changes", naming.name), naming.intent) : null;
  if (target && naming.name !== null && !target.intent) target.intent = naming.intent;
  if (target && given) target.intent = given;

  const touched = new Map<string, Change>();
  const notes: string[] = [];
  const copies = new Map<string, Mode>();
  const afterSave: (() => void)[] = [];
  const undo = opts.undo ?? new Undo();
  undo.hold(book.dir);
  try {
    for (const e of edits) {
      const done = row(e).apply(e, { target, intent: naming.intent });
      for (const c of done.touched) touched.set(c.name, c);
      notes.push(...done.notes);
      for (const [p, mode] of done.copies ?? []) copies.set(relative(book.root, p), mode);
      if (done.afterSave) afterSave.push(done.afterSave);
    }
    if (target && (target.edits.length || (given && changes.has(target.name)))) touched.set(target.name, target);
    for (const c of touched.values()) saveChange(c);
    if (target?.edits.length && !readSeries(book).includes(target.name)) appendSeries(book, target.name);
    for (const after of afterSave) after();
    // The recorded output is now what the patchbook builds, so it no longer counts as a hand edit.
    const lock = readBuildLock(book);
    if (lock !== null) {
      const after = assemble(book).out;
      for (const p of edited) {
        const built = after.get(p);
        const now = current.get(p);
        if (built !== undefined && sameFile(now, built, now?.chosen ?? true)) lock.set(p, stampOf(built));
        else if (built === undefined && !current.has(p)) lock.delete(p);
      }
      writeBuildLines(book, lock);
    }
  } catch (error) {
    // An Undo passed in belongs to the caller, which puts everything back and names what it couldn't, once.
    if (opts.undo) throw error;
    const stuck = undo.restore();
    if (stuck.length) {
      process.stderr.write("patchbook: couldn't put these back as they were:\n  " + stuck.join("\n  ")
        + "\nCheck that you can write to them, then compare them with `git diff` before you commit again.\n");
    }
    throw error;
  }
  const owners = Array.from(touched.keys()).join(", ");
  const dropped = naming.unused && edits.some((e) => e.kind !== "skip");
  const text = (naming.said !== null ? naming.said + "\n" : "") + notes.map((n) => n + "\n").join("") + (dropped ? `intent   not used${owners ? `: the edits went to ${owners}` : ""}\n` : "");
  return { text, copies };
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

function withIntent(plan: Plan, intent: string | null): Map<string, Entry> {
  return new Map(Array.from(plan.entries, ([h, d]) => {
    const own = d.intent ?? intent;
    if (own === null) throw new Fail(`${plan.path}: the entry [${h}] has no intent`);
    return [h, { ...d, intent: own }];
  }));
}

function saveParagraphs(path: string, entries: ReadonlyMap<string, Entry>): void {
  if (entries.size) writeText(path, Array.from(entries.values(), formatEntry).join("\n"));
  else if (exists(path)) unlinkSync(path);
}
