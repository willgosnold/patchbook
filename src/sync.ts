// Has an upstream moved, and moving the pins: carrying every change forward with git merge-file.
import { appendFileSync, chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { CheckJson, LastSync, SyncReport, UpstreamCheck } from "./api.ts";
import { Book, refuseNestedGit, refuseUpstreamGit, unsafeVendor } from "./book.ts";
import { type Change, readChanges, type Side } from "./changes.ts";
import { installHookOrWarn } from "./githook.ts";
import { SequenceMatcher } from "./lib/difflib.ts";
import { Fail } from "./lib/fail.ts";
import { exists, type File, isSymlink, LINK, lexists, mkdirs, pjoin, readDisk, readText, readTextReplace, sameFile, writeDisk, writeText } from "./lib/fs.ts";
import { dumps, JsonError, loads } from "./lib/json.ts";
import { spawn } from "./lib/proc.ts";
import { sorted } from "./lib/py.ts";
import { bytesEqual, decodeReplace, isText } from "./lib/text.ts";
import { type Pin, pinned, type Upstream } from "./store.ts";

export const EXIT_MOVED = 10;

/** A document as it's written: `upstreams` a Map, so `dumps` keeps them in config order and not integer-like names first. */
type Written<T extends { upstreams: Record<string, unknown> }> =
  Omit<T, "upstreams"> & { upstreams: ReadonlyMap<string, T["upstreams"][string]> };

export async function cmdCheck() {
  const book = await Book.find();
  const upstreams = new Map<string, UpstreamCheck>();
  let moved = false;
  for (const u of book.upstreams) {
    const pin = u.pin();
    const head = u.head();
    const r: UpstreamCheck = { pinned: pin.commit ?? null, head, moved: false, files: [] };
    const held = pin.commit ? u.healIfHeld(pin.commit) : false;
    if (head !== pin.commit) {
      u.fetch(head);
      if (u.treeOf(head) !== pin.tree) {
        const old = pin.tree ? u.mounted(u.files(held ? pinned(u, pin) : u.heal(pinned(u, pin)))) : new Map<string, File>();
        const now = u.mounted(u.files(head));
        const own = (files: ReadonlyMap<string, File>) => new Map([...files].filter(([p]) => !book.isPatchbook(p)));
        r.moved = !pin.tree || upstreamDelta(own(old), own(now)).length > 0;
        if (r.moved) r.files = upstreamDelta(book.buildable(old, false), book.buildable(now));
      }
    }
    upstreams.set(u.name, r);
    moved = moved || r.moved;
  }
  const result: Written<CheckJson> = { version: 1, moved, upstreams };
  process.stdout.write(dumps(result, 2) + "\n");
  return moved ? EXIT_MOVED : 0;
}

export function upstreamDelta(old: ReadonlyMap<string, File>, now: ReadonlyMap<string, File>): string[] {
  const out: string[] = [];
  for (const p of sorted(new Set([...old.keys(), ...now.keys()]))) {
    if (!now.has(p)) out.push(`deleted ${p}`);
    else if (!old.has(p)) out.push(`added ${p}`);
    else if (!sameFile(old.get(p), now.get(p))) out.push(`changed ${p}`);
  }
  return out;
}

/** `git merge-file` on three versions: the merged text and the number of conflicts. */
function mergeFile(ours: Uint8Array, base: Uint8Array, theirs: Uint8Array): { merged: Uint8Array; conflicts: number } {
  const tmp = mkdtempSync(join(tmpdir(), "tmp"));
  try {
    const paths = (["ours", "base", "upstream"] as const).map((name, i) => {
      const p = join(tmp, name);
      writeDisk(p, { data: [ours, base, theirs][i]!, mode: 0o644 });
      return p;
    });
    const result = spawn(["git", "merge-file", "-p", "-L", "ours", "-L", "base", "-L", "upstream", ...paths]);
    if (result.code === null || result.code > 127) throw new Fail(`git merge-file failed: ${decodeReplace(result.stderr)}`);
    return { merged: result.stdout, conflicts: result.code };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function cmdSync(args: { name: string | null; ref: string | null }) {
  const book = await Book.find();
  installHookOrWarn(book);
  if (args.ref && !args.name && book.upstreams.length > 1) throw new Fail("name the upstream to sync to a ref: patchbook sync <name> <ref>");
  const targets = args.name ? [book.upstream(args.name)] : book.upstreams;
  const changes = readChanges(book, []);
  recoverAll(book);
  const path = join(book.dir, REPORT);
  const reports = savedReports(path);
  const save = () => {
    const current = new Map<string, SyncReport>();
    for (const { name } of book.upstreams) {
      const kept = reports.get(name);
      if (kept) current.set(name, kept);
    }
    const written: Written<LastSync> = { version: 1, upstreams: current };
    writeText(path, dumps(written, 2) + "\n");
  };
  const stale = [...reports.keys()].some((name) => !book.upstreams.some((u) => u.name === name));
  let synced = false;
  try {
    for (const u of targets) {
      const report = syncUpstream(book, u, args.ref, changes, (r) => {
        reports.set(u.name, r);
        save();
      });
      if (report) synced = true;
    }
    if (stale && !synced) save();
  } finally {
    if (exists(path)) ignoreReport(book);
  }
  if (synced) process.stdout.write("Next: patchbook status\n");
  return 0;
}

/** The report is this checkout's state, so git is told to leave it alone. Every sync checks the rule, which gives a repo made before it the same one. The rule file ignores itself, so a sync leaves nothing to commit while it is untracked. The file is the user's: lines are only appended, byte for byte, and a failure is a warning that never changes how the sync ends. */
function ignoreReport(book: Book): void {
  const p = join(book.dir, ".gitignore");
  try {
    const kept = exists(p) ? readFileSync(p) : new Uint8Array();
    const lines = decodeReplace(kept).split("\n").map((line) => line.replace(/\r$/, ""));
    const missing = [REPORT, ".gitignore"].filter((rule) => !lines.includes(rule));
    if (missing.length) appendFileSync(p, (kept.length && kept[kept.length - 1] !== 0x0a ? "\n" : "") + missing.join("\n") + "\n");
  } catch (e) {
    if (!(e instanceof Error && "errno" in e)) throw e;
    process.stderr.write(`patchbook: couldn't add ${REPORT} to ${relative(book.root, p)} (${e.message}), so ${REPORT} stays untracked\n`);
  }
}

/** The reports in `last-sync.json`, with or without `version`. Kept as read; nothing here reads their fields. */
function savedReports(path: string): Map<string, SyncReport> {
  if (!exists(path)) return new Map();
  try {
    const root = loads(readTextReplace(path));
    const upstreams = root instanceof Map ? root.get("upstreams") : undefined;
    return upstreams instanceof Map ? new Map(upstreams as unknown as ReadonlyMap<string, SyncReport>) : new Map();
  } catch (e) {
    if (e instanceof JsonError) return new Map();
    throw e;
  }
}

/** Move one upstream's pin and carry every change on its files forward. Returns the report, or null. */
export function syncUpstream(book: Book, u: Upstream, ref: string | null, changes: readonly Change[], beforePin?: (report: SyncReport) => void): SyncReport | null {
  recoverAll(book);
  if (u.vendor) refuseNestedGit(book.root, u.name, u.vendor);
  const pin = u.pin();
  const commit = u.fetch(ref || u.branch);
  const tree = u.treeOf(commit);
  if (tree === pin.tree) {
    const rewrite = u.vendor !== null && (!isFolder(u.vendor) || u.vendorTree(u.vendor).tree !== tree);
    if (rewrite) rewriteVendor(book, u, u.vendor, pin, u.files(commit), tree);
    const rest = rewrite ? "Rewrote the vendored copy, which did not." : "Nothing to do.";
    process.stdout.write(`${u.name}: upstream at ${commit.slice(0, 7)} matches the pin (tree ${tree.slice(0, 7)}). ${rest}\n`);
    warnLeft(book, u);
    return null;
  }
  const raw = u.files(commit);
  if (u.vendor) refuseUpstreamGit(u.name, relative(book.root, u.vendor), raw.keys());
  const old = pin.tree ? book.buildable(u.mounted(u.files(u.heal(pinned(u, pin)))), false) : new Map<string, File>();
  const fresh = book.buildable(u.mounted(raw));
  const report: SyncReport = {
    from: pin.commit ?? null, to: commit, upstream: upstreamDelta(old, fresh), merged: [], conflicts: [], gone: [],
    replaced_upstream_changed: [],
  };

  const writes: { c: Change; side: Side; path: string; data: Uint8Array }[] = [];
  const added = Array.from(fresh.keys()).filter((p) => !old.has(p));
  for (const c of changes) {
    for (const e of c.edits) {
      if (book.upstreamFor(e.path) !== u) continue;
      if (e.kind === "replace" && old.has(e.path) && !sameFile(old.get(e.path), fresh.get(e.path))) {
        report.replaced_upstream_changed.push(`${c.name}: ${e.path}`);
      }
      if (e.kind !== "file") continue;
      const base = c.read("base", e.path);
      const ours = c.read("ours", e.path);
      const theirs = fresh.get(e.path)?.data;
      if (theirs === undefined) {
        const ratio = (p: string) => new SequenceMatcher<string>(p, e.path).ratio();
        const maybe = added.map((p) => [-ratio(p), p] as const).sort((x, y) => x[0] - y[0]).slice(0, 3).map(([, p]) => p);
        report.gone.push({ change: c.name, path: e.path, maybe });
        continue;
      }
      if (base !== null && bytesEqual(theirs, base)) continue;
      if (base === null || ours === null) throw new Error(`${c.name} has no ${base === null ? "base" : "ours"} copy of ${e.path}`);
      if (!(isText(base) && isText(ours) && isText(theirs))) {
        report.conflicts.push({ change: c.name, path: e.path, detail: "binary file changed upstream" });
        continue;
      }
      const { merged, conflicts } = mergeFile(ours, base, theirs);
      writes.push({ c, side: "ours", path: e.path, data: merged }, { c, side: "base", path: e.path, data: theirs });
      if (conflicts) report.conflicts.push({ change: c.name, path: e.path, count: conflicts });
      else report.merged.push({ change: c.name, path: e.path });
    }
  }

  journaled(book, u, pin, { commit, tree }, (j) => {
    u.keep(commit);
    takeVendor(u.vendor, join(j, "old"));
    refuseMovedGit(book, u, join(j, "old"));
    if (u.vendor) writeVendor(u, u.vendor, raw, tree);
    saveBefore(book, j, writes.map((w) => w.c.content(w.side, w.path)));
    for (const w of writes) w.c.write(w.side, w.path, w.data);
    beforePin?.(report);
    const lock = join(book.dir, "upstream.lock");
    writeFileSync(join(j, "lock"), lexists(lock) ? readFileSync(lock) : "");
    book.writeLock(u.name, commit, tree);
  });
  process.stdout.write(`${u.name}: pinned ${commit.slice(0, 7)}. ${report.upstream.length} upstream files changed, `
    + `${report.merged.length} of ours merged cleanly, ${report.conflicts.length} conflicts, ${report.gone.length} gone.\n`);
  warnLeft(book, u);
  return report;
}

function journaled(book: Book, u: Upstream, from: Pin, to: Required<Pin> | null, write: (j: string) => void): void {
  // The check at the top of syncUpstream fails fast. This one, right before the copy is taken, leaves a gap of the journal's setup, not the fetch.
  if (u.vendor) refuseNestedGit(book.root, u.name, u.vendor);
  const j = journal(book, u);
  try {
    begin(book, u, from, to);
    write(j);
  } catch (e) {
    recover(book, u);
    throw e;
  }
  drop(j);
}

/** A missing copy counts as a folder, since it hashes as the empty tree. A link never does, so it is moved aside, not followed. */
function isFolder(vendor: string): boolean {
  return !lexists(vendor) || lstatSync(vendor).isDirectory();
}

function rewriteVendor(book: Book, u: Upstream, vendor: string, pin: Pin, raw: ReadonlyMap<string, File>, tree: string): void {
  refuseUpstreamGit(u.name, relative(book.root, vendor), raw.keys());
  journaled(book, u, pin, null, (j) => {
    takeVendor(vendor, join(j, "old"));
    refuseMovedGit(book, u, join(j, "old"));
    writeVendor(u, vendor, raw, tree);
  });
}

/** Checked only in place: git's ignore rules match by path, so the same files hash differently elsewhere. */
function writeVendor(u: Upstream, vendor: string, raw: ReadonlyMap<string, File>, tree: string): void {
  for (const [p, f] of raw) writeDisk(join(vendor, p), f);
  const actual = u.vendorTree(vendor).tree;
  if (actual !== tree) {
    throw new Fail(`the vendored copy of ${u.name} hashes to ${actual}, not upstream's ${tree}. Does a .gitignore hide upstream files?`);
  }
}

const REPORT = "last-sync.json";

const journal = (book: Book, u: Upstream) => join(book.dir, `sync-${encodeURIComponent(u.name)}`);

const spell = (pin: Pin) => `${pin.commit ?? ""} ${pin.tree ?? ""}`;

type Journal = { from: string; to: string; rewrite: boolean; added: string; vendor: string; copy: boolean; made: string };

const PAYLOADS = ["lock", "pin.tmp", "next", "old", "before"];

function begin(book: Book, u: Upstream, from: Pin, to: Required<Pin> | null): void {
  const j = journal(book, u);
  const stale = PAYLOADS.find((p) => lexists(join(j, p)));
  if (stale) {
    throw new Fail(`couldn't delete ${relative(book.root, join(j, stale))}, left by an earlier sync of ${u.name}, so this sync can't start. `
      + "Make it writable and delete it by hand, then sync again.");
  }
  mkdirs(j);
  ignoreAll(j);
  let made = u.vendor && !lexists(u.vendor) ? u.vendor : "";
  while (made && !lexists(dirname(made))) made = dirname(made);
  const record: Journal = {
    from: spell(from),
    to: to ? spell(to) : "",
    rewrite: !to,
    added: to && !u.kept(to.commit) ? to.commit : "",
    vendor: u.vendor ? relative(book.root, u.vendor) : "",
    copy: u.vendor !== null && lexists(u.vendor),
    made: made && relative(book.root, made),
  };
  writeText(join(j, "pin.tmp"), JSON.stringify(record));
  renameSync(join(j, "pin.tmp"), join(j, "pin"));
}

function saveBefore(book: Book, j: string, files: string[]): void {
  mkdirs(join(j, "next"));
  for (const p of files.filter(lexists)) writeDisk(join(j, "next", relative(book.dir, p)), readDisk(p));
  const report = join(book.dir, REPORT);
  if (exists(report)) writeFileSync(join(j, "next", REPORT), readFileSync(report));
  renameSync(join(j, "next"), join(j, "before"));
}

function locked(u: Upstream): string | null {
  try {
    return spell(u.pin());
  } catch {
    return null;
  }
}

/** A repo made since the last check moves into `old` with the copy, and the journal's drop would delete it there. Put the copy back and refuse, so nothing stays half done. */
function refuseMovedGit(book: Book, u: Upstream, old: string): void {
  if (!u.vendor || !lexists(old)) return;
  try {
    refuseNestedGit(book.root, u.name, u.vendor, undefined, old);
  } catch (e) {
    renameSync(old, u.vendor);
    throw e;
  }
}

function takeVendor(vendor: string | null, to: string | null): void {
  if (!vendor || !lexists(vendor)) return;
  if (to) renameSync(vendor, to);
  else rmSync(vendor, { recursive: true });
}

/** Recover every upstream, torn locks first. Each journal saves last-sync.json, so none may start while another is pending. */
function recoverAll(book: Book): void {
  const tore = (u: Upstream) => lexists(join(journal(book, u), "lock"));
  for (const u of [...book.upstreams.filter(tore), ...book.upstreams.filter((u) => !tore(u))]) recover(book, u);
}

function recover(book: Book, u: Upstream): void {
  const j = journal(book, u);
  const pin = join(j, "pin");
  if (exists(pin)) {
    let record: Journal;
    try {
      record = JSON.parse(readText(pin));
    } catch {
      throw stuck(book, u, "its record can't be read");
    }
    const { from, to, rewrite, added, vendor: path, copy, made } = record;
    const vendor = path ? pjoin(book.root, path) : null;
    const unsafe = vendor && unsafeVendor(book.root, vendor);
    if (unsafe) throw stuck(book, u, `its record names the vendor folder ${JSON.stringify(path)}, which ${unsafe}`);
    const old = join(j, "old");
    const newCopy = lexists(old) || !copy;
    if (vendor && newCopy) refuseNestedGit(book.root, u.name, vendor, relative(book.root, j));
    const now = locked(u);
    const wrote = lexists(join(j, "lock"));
    const torn = now === null && wrote;
    if (!rewrite && now === to) return drop(j);
    if (now !== from && !torn) {
      if (now !== null && !wrote) release(book, u, added);
      throw stuck(book, u, "upstream.lock has changed since");
    }
    const before = join(j, "before");
    const saved = lexists(before) ? readdirSync(before, { recursive: true, encoding: "utf8" }) : [];
    for (const rel of saved.filter((rel) => rel !== REPORT)) {
      if (!lstatSync(join(before, rel)).isDirectory()) putBack(join(book.dir, rel), readDisk(join(before, rel)));
    }
    if (lexists(before)) putReport(join(book.dir, REPORT), join(before, REPORT));
    if (torn) {
      const was = readFileSync(join(j, "lock"));
      if (was.length) writeFileSync(join(book.dir, "upstream.lock"), was);
      else rmSync(join(book.dir, "upstream.lock"), { force: true });
    }
    release(book, u, added);
    if (newCopy) {
      if (vendor) refuseNestedGit(book.root, u.name, vendor, relative(book.root, j));
      takeVendor(vendor, null);
    }
    if (vendor && made) removeMadeFolders(vendor, join(book.root, made));
    if (vendor && lexists(old)) {
      mkdirs(dirname(vendor));
      renameSync(old, vendor);
    }
  }
  drop(j);
}

function removeMadeFolders(vendor: string, made: string): void {
  for (let dir = dirname(vendor); dir === made || dir.startsWith(made + sep); dir = dirname(dir)) {
    if (!lexists(dir)) continue;
    if (readdirSync(dir).length) return;
    rmdirSync(dir);
  }
}

function stuck(book: Book, u: Upstream, why: string): Fail {
  const j = journal(book, u);
  const held = [
    lexists(join(j, "old")) && "old/ holds the vendored copy as it was",
    lexists(join(j, "before")) && "before/ holds the files it wrote over as they were",
  ].filter(Boolean);
  const shown = relative(book.root, j);
  return new Fail(`${shown} holds a sync of ${u.name} that stopped partway, but ${why}. `
    + (held.length ? `In it, ${held.join(", and ")}. Put back what you need, then delete ${shown}.` : `Delete ${shown}.`));
}

function release(book: Book, u: Upstream, added: string): void {
  if (added && !book.upstreams.some((o) => o.inRepo === u.inRepo && o.remote === u.remote && o.pin().commit === added)) u.unkeep(added);
}

function putBack(p: string, was: File): void {
  if (lexists(p) && sameFile(readDisk(p), was)) return;
  if (was.mode === LINK) return writeDisk(p, was);
  mkdirs(dirname(p));
  if (isSymlink(p)) unlinkSync(p);
  writeFileSync(p, was.data);
  if (readDisk(p).mode !== was.mode) chmodSync(p, was.mode);
}

/** The report is written through a link, like the lock, so it comes back by its bytes. */
function putReport(p: string, was: string): void {
  if (!lexists(was)) return rmSync(p, { force: true });
  const data = readFileSync(was);
  if (!exists(p) || !bytesEqual(readFileSync(p), data)) writeFileSync(p, data);
}

function drop(j: string): void {
  if (lexists(j) && !lstatSync(j).isDirectory()) return rmSync(j);
  rmSync(join(j, "pin"), { force: true });
  sweep(j);
}

function sweep(j: string): void {
  try {
    for (const payload of PAYLOADS) {
      try {
        rmSync(join(j, payload), { recursive: true, force: true });
      } catch {
        mkdirs(join(j, "left"));
        renameSync(join(j, payload), join(j, "left", `${payload}-${Date.now()}`));
      }
    }
    rmSync(join(j, "left"), { recursive: true, force: true });
    rmSync(j, { recursive: true, force: true });
  } catch {
    ignoreAll(j);
  }
}

function ignoreAll(j: string): void {
  const p = join(j, ".gitignore");
  if (!exists(p) || readText(p) !== "*\n") writeText(p, "*\n");
}

function warnLeft(book: Book, u: Upstream): void {
  const j = journal(book, u);
  if (!lexists(j)) return;
  process.stderr.write(`patchbook: couldn't delete ${relative(book.root, j)}, which holds files a sync of ${u.name} no longer needs. `
    + "git ignores it, but it still takes disk space. Make it writable and delete it by hand; the next sync tries again.\n");
}
