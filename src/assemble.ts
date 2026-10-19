// Assembling the output from the pinned upstreams and the patchbook, and writing it.
import { mkdtempSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InChange, InEdit, InOutput, Problem, StatusJson } from "./api.ts";
import {
  entriesPath, type Entry, formatEntry, leakScan, orphan, patchBlocks, readEntries, Rules, type Unmatched,
} from "./blocks.ts";
import { Book, buildInputs, GIT, PB, type Reserved, under } from "./book.ts";
import { type Change, editText, readChanges } from "./changes.ts";
import { installHookOrWarn, stageModes, upstreamModes, warnUnhooked } from "./githook.ts";
import { Fail } from "./lib/fail.ts";
import {
  exists, type File, fileOid, gitMode, isDir, isEmptyDir, isRealDir, LINK, lexists, mkdirs, type Mode, nonFolders, outputMode, parseGitMode, readText, relative, resolve, rglob,
  rmFolders, sameFile, sameMode, type Seen, writeDisk, writeText,
} from "./lib/fs.ts";
import { forgetBlobOids } from "./lib/hash.ts";
import { dumps, type Json, loads } from "./lib/json.ts";
import { type Env, git, run, spawn } from "./lib/proc.ts";
import { floatRepr, ljust, rstrip, sorted, sortedBy, strip } from "./lib/py.ts";
import { say, verbatim, warn } from "./lib/term.ts";
import { bytesEqual, decode, encode, isText } from "./lib/text.ts";
import { pinned, refuseMergedUpstream } from "./store.ts";

export function describe(p: Problem): string {
  let at = p.file + ("line" in p && p.line ? `:${p.line}` : "") + ("hash" in p && p.hash ? ` [${p.hash}]` : "");
  if ("output" in p && p.output && p.output !== p.file) at += ` (output ${p.output})`;
  switch (p.problem) {
    case "missing":
      return `missing   ${at} needs an entry (${p.terms.join(", ")})`;
    case "leak":
      return `leak      ${at} still says ${p.terms.join(", ")}`;
    case "orphan": {
      const near = p.nearest.map((n) => `line ${n.line} [${n.hash}] ${floatRepr(n.similarity)}`).join(", ") || "none";
      return `orphan    ${p.file} [${p.hash}] intent: ${p.intent}\n          nearest new blocks: ${near}`;
    }
    case "invalid":
    case "gone":
    case "stale":
    case "conflict":
    case "placeholder":
    case "check": {
      const extra = "edit" in p && p.edit ? ` ${p.edit}` : "";
      return `${ljust(p.problem, 9)} ${at}${extra}: ${p.detail}`;
    }
    default: {
      const _exhaustive: never = p;
      return _exhaustive;
    }
  }
}

/** Where an output file comes from: upstream at a staged path, or a change's ours copy. */
export type Source = { kind: "up"; path: string } | { kind: "ours"; change: string; path: string };

export type Assembly = {
  out: Map<string, File>;
  /** Output path to source. */
  sources: Map<string, Source>;
  problems: Problem[];
  applied: number;
  /** Staged path to source, before choosing the output. */
  staged: Map<string, Source>;
  /** Upstream's files at the pins. */
  upstream: Map<string, File>;
};

const CONFLICT = /^(?:<{7}|>{7})(?: |$)/;
/** A line that starts with a conflict marker. Python's `^` in MULTILINE breaks on `\n` only. */
export const hasConflictMarker = (text: string) => text.split("\n").some((line) => CONFLICT.test(line));
const mayHoldMarker = (data: Uint8Array) => {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return bytes.includes("<<<<<<<") || bytes.includes(">>>>>>>");
};

function intoReserved(where: InEdit, path: string, { place, refuse }: Reserved): Problem {
  const detail = `${path} would be written into ${place}`;
  return refuse ? { problem: "invalid", ...where, detail, refuse: true } : { problem: "invalid", ...where, detail };
}

/** Apply add, replace, delete, move and copy to a map of staged path to source. */
export function applyStructure(
  changes: readonly Change[],
  upstream: ReadonlyMap<string, File>,
  problems: Problem[],
  reservedHolding: (staged: string) => Reserved | null,
): Map<string, Source> {
  const tree = new Map<string, Source>(Array.from(upstream.keys(), (p) => [p, { kind: "up", path: p }]));
  for (const c of changes) {
    for (const e of c.edits) {
      if (e.kind === "file") continue;
      const where: InEdit = { file: `changes/${c.name}`, edit: editText(e) };
      const matched = Array.from(tree.keys()).filter((p) => under(p, e.path));
      if (e.kind === "add") {
        const reserved = reservedHolding(e.path);
        if (reserved !== null) {
          problems.push(intoReserved(where, e.path, reserved));
        } else if (matched.length) problems.push({ problem: "invalid", ...where, detail: `${e.path} already exists; use replace` });
        else if (c.read("ours", e.path) === null) problems.push({ problem: "invalid", ...where, detail: "its ours copy is missing" });
        else tree.set(e.path, { kind: "ours", change: c.name, path: e.path });
      } else if (e.kind === "replace") {
        if (!tree.has(e.path)) problems.push({ problem: "gone", ...where, detail: `${e.path} no longer exists` });
        else if (c.read("ours", e.path) === null) problems.push({ problem: "invalid", ...where, detail: "its ours copy is missing" });
        else tree.set(e.path, { kind: "ours", change: c.name, path: e.path });
      } else if (!matched.length) problems.push({ problem: "gone", ...where, detail: `${e.path} no longer exists` });
      else {
        const dest = "dest" in e ? e.dest : "";
        const moved = new Map(dest ? matched.map((p) => [dest + p.slice(e.path.length), tree.get(p)!]) : []);
        const held = Array.from(moved.keys()).flatMap((path) => {
          const reserved = reservedHolding(path);
          return reserved ? [{ path, reserved }] : [];
        });
        const hit = held.find((h) => h.reserved.refuse) ?? held[0];
        if (hit) {
          problems.push(intoReserved(where, hit.path, hit.reserved));
          continue;
        }
        const clash = Array.from(moved.keys()).filter((p) => tree.has(p) && !under(p, e.path));
        if (clash.length) {
          problems.push({ problem: "invalid", ...where, detail: `${clash[0]} already exists` });
          continue;
        }
        if (e.kind === "delete" || e.kind === "move") for (const p of matched) tree.delete(p);
        for (const [p, s] of moved) tree.set(p, s);
      }
    }
  }
  return tree;
}

export function blockFiles(book: Book): string[] {
  return rglob(book.data("blocks"), ".entries").map((p) => p.slice(0, -".entries".length));
}

export function assemble(book: Book): Assembly {
  const upstream = book.stagedUpstream();
  const problems: Problem[] = [];
  let applied = 0;
  const changes = readChanges(book, problems);
  const byName = new Map(changes.map((c) => [c.name, c]));

  // Content edits, keyed by upstream path. One owner per path.
  const content = new Map(upstream);
  const owner = new Map<string, string>();
  for (const c of changes) {
    for (const e of c.edits) {
      if (e.kind !== "file") continue;
      const where: InChange = { file: e.path, change: c.name };
      const owned = owner.get(e.path);
      if (owned !== undefined) {
        problems.push({ problem: "invalid", ...where, detail: `${owned} already owns it` });
        continue;
      }
      owner.set(e.path, `change ${c.name}`);
      const up = upstream.get(e.path);
      if (!up) {
        problems.push({ problem: "gone", ...where, detail: "upstream no longer has it" });
        continue;
      }
      const base = c.file("base", e.path);
      const ours = c.file("ours", e.path);
      if (base === null || ours === null) {
        problems.push({ problem: "invalid", ...where, detail: "its base or ours copy is missing" });
        continue;
      }
      if (!bytesEqual(base.data, up.data)) {
        problems.push({ problem: "stale", ...where, detail: "its base differs from upstream at the pin; run sync" });
      }
      if (isText(ours.data) && hasConflictMarker(decode(ours.data))) problems.push({ problem: "conflict", ...where, detail: "ours has conflict markers" });
      content.set(e.path, { data: ours.data, mode: outputMode(ours, base, up) });
      applied++;
    }
  }
  const blocks = new Map<string, Map<string, Entry>>();
  for (const rel of blockFiles(book)) {
    const owned = owner.get(rel);
    if (owned !== undefined) {
      problems.push({ problem: "invalid", file: rel, detail: `${owned} owns it, so it can't have block entries` });
      continue;
    }
    blocks.set(rel, readEntries(entriesPath(book, rel)));
  }

  const staged = applyStructure(changes, upstream, problems, (p) => book.reservedHolding(p));
  let selected: Map<string, Source>;
  if (book.layout.kind === "folder") {
    const prefix = book.layout.from;
    selected = new Map();
    for (const [p, s] of staged) {
      if (!prefix || p.startsWith(prefix + "/")) selected.set(prefix ? p.slice(prefix.length + 1) : p, s);
    }
  } else selected = new Map(staged);
  const rules = new Rules(book, new Set(selected.keys()));
  problems.push(...book.badChecks);

  const out = new Map<string, File>();
  const used = new Map<string, Set<string>>(Array.from(blocks.keys(), (rel) => [rel, new Set()]));
  const unmatched = new Map<string, Unmatched[]>(Array.from(blocks.keys(), (rel) => [rel, []]));
  for (const [outPath, src] of sortedBy(selected, ([p]) => p)) {
    if (src.kind === "up") {
      const rel = src.path;
      const { data, mode } = content.get(rel)!;
      const where: InOutput = { file: rel, output: outPath };
      if (mode === LINK || !isText(data)) {
        if (blocks.has(rel)) problems.push({ problem: "invalid", ...where, detail: "block entries need a text file; use a replace edit" });
        out.set(outPath, { data, mode });
        continue;
      }
      let text: string;
      if (owner.has(rel)) {
        text = rules.expand(decode(data), (detail) => problems.push({ problem: "placeholder", ...where, detail }));
        leakScan(rules, outPath, text, problems, where);
      } else {
        if (!used.has(rel)) used.set(rel, new Set());
        if (!unmatched.has(rel)) unmatched.set(rel, []);
        const patched = patchBlocks({
          rules, outPath, rel, text: decode(data), entries: blocks.get(rel) ?? new Map(), used: used.get(rel)!,
          unmatched: unmatched.get(rel)!, problems,
        });
        text = patched.text;
        applied += patched.applied;
      }
      out.set(outPath, { data: encode(text), mode });
    } else {
      const c = byName.get(src.change)!;
      const copy = c.file("ours", src.path)!;
      let data = copy.data;
      const mode = outputMode(copy, c.file("base", src.path), upstream.get(src.path));
      const where: InOutput = { file: `changes/${c.name}`, output: outPath };
      if (isText(data)) {
        const text = rules.expand(decode(data), (detail) => problems.push({ problem: "placeholder", ...where, detail }));
        leakScan(rules, outPath, text, problems, where);
        data = encode(text);
      }
      out.set(outPath, { data, mode });
    }
  }
  for (const [rel, entries] of blocks) {
    for (const [h, entry] of entries) {
      if (!used.get(rel)?.has(h)) problems.push(orphan(rel, entry, unmatched.get(rel) ?? []));
    }
  }

  book.hooks.finish?.(out);
  if (book.hooks.check) problems.push(...book.hooks.check(new Map(Array.from(out, ([p, f]) => [p, f.data]))));
  forgetBlobOids();
  for (const [p, { data, mode }] of out) {
    if (mode !== LINK && mayHoldMarker(data) && isText(data) && hasConflictMarker(decode(data))) {
      problems.push({ problem: "conflict", file: p, detail: "conflict marker in the output" });
    }
  }
  return { out, sources: selected, problems, applied, staged, upstream };
}

// Build

export const buildLockPath = (book: Book) => book.data("build.lock");

export type Stamp = { oid: string; mode: Mode | null };

export const stampOf = (f: File): Stamp => ({ oid: fileOid(f), mode: f.mode });

const LOCK_LINE = /^(\d{6}) (\S+) (.*)$/;

export function readBuildLock(book: Book): Map<string, Stamp> | null {
  const path = buildLockPath(book);
  return exists(path) ? parseBuildLock(readText(path)) : null;
}

export function parseBuildLock(text: string): Map<string, Stamp> {
  const entries = new Map<string, Stamp>();
  for (const line of text.split("\n")) {
    if (!strip(line)) continue;
    const [, name, oid, at] = LOCK_LINE.exec(line) ?? [];
    const mode = name === undefined ? undefined : parseGitMode(name);
    if (mode !== undefined) {
      entries.set(at!, { oid: oid!, mode });
      continue;
    }
    const sep = line.indexOf(" ");
    if (sep === -1) entries.set("", { oid: line, mode: null });
    else entries.set(line.slice(sep + 1), { oid: line.slice(0, sep), mode: null });
  }
  return entries;
}

export function writeBuildLines(book: Book, lock: ReadonlyMap<string, Stamp>): void {
  const line = (p: string, { oid, mode }: Stamp) => (mode === null ? `${oid} ${p}\n` : `${gitMode(mode)} ${oid} ${p}\n`);
  writeText(buildLockPath(book), sortedBy(lock, ([p]) => p).map(([p, stamp]) => line(p, stamp)).join(""));
}

export const writeBuildLock = (book: Book, out: ReadonlyMap<string, File>) =>
  writeBuildLines(book, new Map(Array.from(out, ([p, f]) => [p, stampOf(f)])));

export type Changes = { stale: string[]; changed: string[] };

export function changesOf(current: ReadonlyMap<string, File>, out: ReadonlyMap<string, File>, tracksExecBit = true): Changes {
  return {
    stale: Array.from(current.keys()).filter((p) => !out.has(p)),
    changed: Array.from(out.keys()).filter((p) => !sameFile(current.get(p), out.get(p), tracksExecBit)),
  };
}

/** A linked worktree's `.git` is a file, so git is asked. */
function keptPlaces(book: Book): (readonly [string, string])[] {
  const dirs = git(["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"], { cwd: book.root }).split("\n");
  const places = [[PB, join(book.root, PB)], [GIT, join(book.root, GIT)], ...dirs.map((dir) => [GIT, dir] as const)];
  return places.map(([name, path]) => [name, resolve(path!)] as const);
}

function refuseIfUncontained(book: Book, { stale, changed }: Changes): void {
  const root = book.outputRoot();
  const realRoot = resolve(root);
  const kept = keptPlaces(book);
  const unlinked = new Set(stale);
  const resolved = new Map<string, string>();
  const checked = new Set<string>();
  for (const [p, writing] of [...stale.map((p) => [p, false] as const), ...changed.map((p) => [p, true] as const)]) {
    const parts = p.split("/");
    let onDisk = parts.length - 1;
    if (writing) {
      const unlinkedAt = parts.slice(0, -1).findIndex((_, i) => unlinked.has(parts.slice(0, i + 1).join("/")));
      if (unlinkedAt !== -1) onDisk = unlinkedAt;
    }
    for (let i = 1; i <= onDisk; i++) {
      const folder = parts.slice(0, i).join("/");
      if (checked.has(folder)) continue;
      const at = join(root, folder);
      if (lexists(at) && !exists(at)) throw new Fail(`${p} is under ${folder}, which is a link to nothing. Nothing was changed.`);
      if (exists(at) && !isDir(at)) throw new Fail(`${p} is under ${folder}, which is not a folder. Nothing was changed.`);
      checked.add(folder);
    }
    const top = parts.slice(0, onDisk).join("/");
    if (!resolved.has(top)) resolved.set(top, resolve(join(root, top)));
    const parent = join(resolved.get(top)!, ...parts.slice(onDisk, -1));
    const real = join(parent, parts.at(-1)!);
    const hit = kept.find(([, place]) => under(real, place));
    if (hit) throw new Fail(`${p} is really inside ${hit[0]} (it goes to ${real}), so a build must not change it. Nothing was changed.`);
    if (!under(parent, realRoot)) throw new Fail(`${p} really goes to ${real}, outside the output folder. Nothing was changed.`);
  }
}

export type BuildLock = ReadonlyMap<string, Stamp>;

/** A lock line with no mode stands for the mode the current build writes for that path. */
export function builtAs(file: File | undefined, stamp: Stamp | undefined, built: Mode | undefined, tracksExecBit: boolean): boolean {
  if (file === undefined || stamp === undefined) return file === undefined && stamp === undefined;
  return fileOid(file) === stamp.oid && sameMode(stamp.mode ?? built ?? file.mode, file.mode, tracksExecBit);
}

/** The outputs edited by hand since the last build. A file's mode counts only where its exec bit is the user's. */
export function handEdits(
  book: Book, fresh: ReadonlyMap<string, File>, files: ReadonlyMap<string, Seen>, builds: (BuildLock | null)[] = [readBuildLock(book)],
): string[] {
  refuseIfUncontained(book, changesOf(files, fresh));
  const chosen = (p: string) => files.get(p)?.chosen ?? true;
  const last = builds.filter((b) => b !== null);
  if (!last.length) return sorted(Array.from(files.keys()).filter((p) => !sameFile(files.get(p), fresh.get(p), chosen(p)))); // never built here
  const paths = new Set([...files.keys(), ...last.flatMap((b) => [...b.keys()])]);
  return sorted(Array.from(paths).filter((p) => !sameFile(files.get(p), fresh.get(p), chosen(p)) && last.every((b) => !builtAs(files.get(p), b.get(p), fresh.get(p)?.mode, chosen(p)))));
}

export const inRepo = (book: Book, p: string) => relative(book.root, join(book.outputRoot(), p));

export function refuseFolderToFile(book: Book, out: ReadonlyMap<string, File>, now: ReadonlyMap<string, File>, edited: readonly string[], hintSuffix = ""): void {
  const asFile = new Set(edited.filter((p) => now.has(p)));
  if (!asFile.size) return;
  const turned = new Map<string, string[]>();
  for (const p of out.keys()) {
    const parts = p.split("/");
    const file = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/")).find((folder) => asFile.has(folder));
    if (file === undefined) continue;
    if (!turned.has(file)) turned.set(file, []);
    turned.get(file)!.push(inRepo(book, p));
  }
  if (!turned.size) return;
  throw new Fail(Array.from(turned, ([file, gone]) => `${inRepo(book, file)} is a file now, and these paths under it are gone:\n  ${gone.join("\n  ")}`).join("\n")
    + `\nPatchbook can't record a folder turned into a file. Put the folder back${hintSuffix}.`);
}

/** A folder where the build writes a file goes only if it holds nothing but folders and files this build removes. */
function refuseIfFolderHoldsFiles(root: string, { stale, changed }: Changes): void {
  const going = new Set(stale);
  for (const p of changed) {
    const at = join(root, p);
    if (!isRealDir(at)) continue;
    const unreadable: string[] = [];
    const kept = nonFolders(at, unreadable).find((f) => !going.has(`${p}/${f}`));
    if (kept) throw new Fail(`${p} is a folder that holds ${kept}, which isn't build output, so a build won't replace it. Nothing was changed.`);
    if (unreadable.length) throw new Fail(`${unreadable[0] === "." ? p : `${p}/${unreadable[0]}`} is a folder that can't be read, so a build won't replace ${p}. Nothing was changed.`);
  }
}

export function writeOutput(book: Book, out: ReadonlyMap<string, File>, changes: Changes): void {
  const root = book.outputRoot();
  refuseIfUncontained(book, changes);
  refuseIfFolderHoldsFiles(root, changes);
  const { stale, changed } = changes;
  for (const p of stale) {
    if (!lexists(join(root, p))) continue;
    unlinkSync(join(root, p));
    for (let parent = dirname(join(root, p)); parent !== root && exists(parent) && isEmptyDir(parent); parent = dirname(parent)) {
      rmdirSync(parent);
    }
  }
  for (const p of changed) {
    if (isRealDir(join(root, p))) rmFolders(join(root, p));
    writeDisk(join(root, p), out.get(p)!);
  }
  writeBuildLock(book, out);
}

export async function cmdBuild(args: { force: boolean; commit: boolean }) {
  const book = await Book.find();
  refuseMergedUpstream(book, "build");
  installHookOrWarn(book);
  const a = assemble(book);
  if (a.problems.length) {
    for (const p of a.problems) warn(describe(p) + "\n");
    throw new Fail(`${a.problems.length} problems; nothing built. \`patchbook status\` lists them.`);
  }
  const current = book.seen("disk");
  const edited = handEdits(book, a.out, current);
  if (edited.length && !args.force) {
    const shown = edited.slice(0, 20).join("\n  ") + (edited.length > 20 ? "\n  ..." : "");
    throw new Fail(`these output files changed since the last build:\n  ${shown}\n`
      + "Move the edits into the patchbook with `patchbook record`, or pass --force to discard them.");
  }
  writeOutput(book, a.out, changesOf(current, a.out, book.tracksExecBit()));
  say(`built ${a.out.size} files from ${book.pins()} with ${a.applied} edits\n`);
  if (args.commit) commitBuild(book, a);
  return 0;
}

function commitBuild(book: Book, a: Assembly): void {
  const root = book.root;
  const modes = upstreamModes(book, a, Array.from(a.out.keys()));
  const addBuild = (env: Env) => {
    const tracked = (p: string) => git(["--literal-pathspecs", "ls-files", "-z", "--", p], { cwd: root, env }) !== "";
    const matchable = (paths: string[]) => paths.filter((p) => lexists(join(root, p)) || tracked(p));
    const output = matchable([relative(root, book.outputRoot()), ...book.vendors()]).map((p) => `:(literal)${p}`);
    if (output.length) run(["git", "add", "-A", "--", ...output, `:(exclude,literal)${PB}`], { cwd: root, env: { ...env, GIT_LITERAL_PATHSPECS: "0" } });
    stageModes(root, modes, env);
    const inputs = matchable([...buildInputs(book), `${PB}/retired.md`]);
    const ignored = new Set(decode(run(["git", "--literal-pathspecs", "ls-files", "-z", "-o", "-i", "--exclude-standard", "--", ...inputs], { cwd: root, env })).split("\0"));
    const addable = inputs.filter((p) => !ignored.has(p));
    if (addable.length) git(["--literal-pathspecs", "add", "-A", "--", ...addable], { cwd: root, env });
    if (tracked(PB)) git(["--literal-pathspecs", "add", "-u", "--", PB], { cwd: root, env });
  };
  addBuild(process.env);
  const tree = headTreeWith(root, addBuild);
  const parents = ["-p", "HEAD"];
  const own = book.upstreams.find((u) => u.inRepo);
  if (own) {
    const commit = pinned(own, own.pin());
    const ancestor = spawn(["git", "merge-base", "--is-ancestor", commit, "HEAD"], { cwd: root }).code === 0;
    if (!ancestor) parents.push("-p", commit);
  }
  if (git(["rev-parse", "HEAD^{tree}"], { cwd: root }) === tree && parents.length === 2) {
    say("nothing to commit\n");
    return;
  }
  const message = `Build from upstream ${book.pins()}`;
  const commit = git(["commit-tree", tree, ...parents, "-m", message], { cwd: root });
  git(["update-ref", "HEAD", commit], { cwd: root });
  say(`committed ${commit.slice(0, 7)}: ${message}\n`);
}

function headTreeWith(root: string, add: (env: Env) => void): string {
  const tmp = mkdtempSync(join(tmpdir(), "tmp"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
    git(["read-tree", "HEAD"], { cwd: root, env });
    add(env);
    return git(["write-tree"], { cwd: root, env });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function cmdStatus(args: { json: boolean }) {
  const book = await Book.find();
  warnUnhooked(book);
  const a = assemble(book);
  const lastSync = join(book.dir, "last-sync.json");
  const report = exists(lastSync) ? loads(readText(lastSync)) : null;
  if (args.json) {
    const status: Omit<StatusJson, "upstreams" | "last_sync"> & { upstreams: Json; last_sync: Json } = {
      version: 1, upstreams: book.lock(), applied: a.applied, problems: a.problems, last_sync: report,
    };
    verbatim(dumps(status, 2) + "\n");
  } else {
    for (const p of a.problems) say(describe(p) + "\n");
    const counts = new Map<string, number>();
    for (const p of a.problems) counts.set(p.problem, (counts.get(p.problem) ?? 0) + 1);
    const summary = sortedBy(counts, ([k]) => k).map(([k, n]) => `${n} ${k}`).join(", ") || "no problems";
    say(`${a.applied} edits apply at ${book.pins()}; ${summary}\n`);
  }
  return a.problems.length ? 1 : 0;
}

/** Append a skeleton entry for each missing block, to be filled in by hand or by an agent. */
export async function cmdScaffold(args: { file: string[] }) {
  const book = await Book.find();
  const a = assemble(book);
  const byFile = new Map<string, Extract<Problem, { problem: "missing" }>[]>();
  let count = 0;
  for (const p of a.problems) {
    if (p.problem !== "missing" || (args.file.length && !args.file.includes(p.file))) continue;
    count++;
    byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
  }
  for (const [rel, found] of byFile) {
    const path = entriesPath(book, rel);
    mkdirs(dirname(path));
    const existing = exists(path) ? rstrip(readText(path), "\n") + "\n\n" : "";
    const skeletons = found.map((p) => formatEntry({ hash: p.hash, kind: "translation", rules: "", intent: "", upstream: p.upstream, patched: p.upstream }));
    writeText(path, existing + skeletons.join("\n"));
  }
  say(`scaffolded ${count} entries in ${byFile.size} files\n`);
  return 0;
}

