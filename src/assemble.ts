// Assembling the output from the pinned upstreams and the patchbook, and writing it.
import { rmdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InChange, InEdit, InOutput, Problem } from "./api.ts";
import {
  entriesPath, type Entry, formatEntry, leakScan, orphan, patchBlocks, readEntries, Rules, type Unmatched,
} from "./blocks.ts";
import { Book, under } from "./book.ts";
import { type Change, editText, readChanges } from "./changes.ts";
import { Fail } from "./lib/fail.ts";
import { exists, type File, isEmptyDir, LINK, mkdirs, readDisk, readText, rglob, sameFile, writeDisk, writeText } from "./lib/fs.ts";
import { blobOid } from "./lib/hash.ts";
import { dumps, loads } from "./lib/json.ts";
import { git, spawn } from "./lib/proc.ts";
import { floatRepr, ljust, rstrip, sorted, sortedBy, strip } from "./lib/py.ts";
import { bytesEqual, decode, encode, isText } from "./lib/text.ts";
import { pinned } from "./store.ts";

export function describe(p: Problem): string {
  let at = p.file + ("line" in p && p.line ? `:${p.line}` : "") + ("hash" in p && p.hash ? ` [${p.hash}]` : "");
  if ("output" in p && p.output && p.output !== p.file) at += ` (output ${p.output})`;
  switch (p.problem) {
    case "missing":
      return `missing   ${at} needs an entry (${p.terms.join(", ")})`;
    case "leak":
      return `leak      ${at} still says ${p.terms.join(", ")}`;
    case "orphan": {
      const near = p.nearest.map((n) => `line ${n.line} [${n.hash}] ${floatRepr(n.similarity.value)}`).join(", ") || "none";
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

/** Apply add, replace, delete, move and copy to a map of staged path to source. */
export function applyStructure(changes: readonly Change[], upstream: ReadonlyMap<string, File>, problems: Problem[]): Map<string, Source> {
  const tree = new Map<string, Source>(Array.from(upstream.keys(), (p) => [p, { kind: "up", path: p }]));
  for (const c of changes) {
    for (const e of c.edits) {
      if (e.kind === "file") continue;
      const where: InEdit = { file: `changes/${c.name}`, edit: editText(e) };
      const matched = Array.from(tree.keys()).filter((p) => under(p, e.path));
      if (e.kind === "add") {
        if (matched.length) problems.push({ problem: "invalid", ...where, detail: `${e.path} already exists; use replace` });
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
  return rglob(join(book.dir, "blocks"), ".entries").map((p) => p.slice(0, -".entries".length));
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
      const base = c.read("base", e.path);
      const ours = c.read("ours", e.path);
      if (base === null || ours === null) {
        problems.push({ problem: "invalid", ...where, detail: "its base or ours copy is missing" });
        continue;
      }
      if (!bytesEqual(base, up.data)) {
        problems.push({ problem: "stale", ...where, detail: "its base differs from upstream at the pin; run sync" });
      }
      if (isText(ours) && hasConflictMarker(decode(ours))) problems.push({ problem: "conflict", ...where, detail: "ours has conflict markers" });
      content.set(e.path, { data: ours, mode: up.mode });
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

  const staged = applyStructure(changes, upstream, problems);
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
      let data = c.read("ours", src.path)!;
      const mode = upstream.get(src.path)?.mode ?? readDisk(c.content("ours", src.path)).mode;
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
  for (const [p, { data, mode }] of out) {
    if (mode !== LINK && isText(data) && hasConflictMarker(decode(data))) {
      problems.push({ problem: "conflict", file: p, detail: "conflict marker in the output" });
    }
  }
  return { out, sources: selected, problems, applied, staged, upstream };
}

// Build

export const buildLockPath = (book: Book) => join(book.dir, "build.lock");

export function readBuildLock(book: Book): Map<string, string> | null {
  const path = buildLockPath(book);
  if (!exists(path)) return null;
  const entries = new Map<string, string>();
  for (const line of readText(path).split("\n")) {
    if (!strip(line)) continue;
    const sep = line.indexOf(" ");
    if (sep === -1) entries.set("", line);
    else entries.set(line.slice(sep + 1), line.slice(0, sep));
  }
  return entries;
}

export const oids = (files: ReadonlyMap<string, File>) => new Map(Array.from(files, ([p, f]) => [p, blobOid(f.data)]));

export function writeBuildLines(book: Book, lock: ReadonlyMap<string, string>): void {
  writeText(buildLockPath(book), sortedBy(lock, ([p]) => p).map(([p, oid]) => `${oid} ${p}\n`).join(""));
}

export const writeBuildLock = (book: Book, out: ReadonlyMap<string, File>) => writeBuildLines(book, oids(out));

/** Output paths changed on disk since the last build, other than to what this build writes. */
export function handEdits(book: Book, fresh: ReadonlyMap<string, File>): string[] {
  const current = oids(book.currentOutput());
  const next = oids(fresh);
  const last = readBuildLock(book);
  if (last === null) return sorted(Array.from(current.keys()).filter((p) => current.get(p) !== next.get(p))); // never built here
  const paths = new Set([...current.keys(), ...last.keys()]);
  return sorted(Array.from(paths).filter((p) => current.get(p) !== last.get(p) && current.get(p) !== next.get(p)));
}

export function writeOutput(book: Book, out: ReadonlyMap<string, File>): void {
  const root = book.outputRoot();
  const current = book.currentOutput();
  for (const p of current.keys()) {
    if (out.has(p)) continue;
    unlinkSync(join(root, p));
    for (let parent = dirname(join(root, p)); parent !== root && exists(parent) && isEmptyDir(parent); parent = dirname(parent)) {
      rmdirSync(parent);
    }
  }
  for (const [p, f] of out) if (!sameFile(current.get(p), f)) writeDisk(join(root, p), f);
  writeBuildLock(book, out);
}

export async function cmdBuild(args: { force: boolean; commit: boolean }) {
  const book = await Book.find();
  const a = assemble(book);
  if (a.problems.length) {
    for (const p of a.problems) process.stderr.write(describe(p) + "\n");
    throw new Fail(`${a.problems.length} problems; nothing built. \`patchbook status\` lists them.`);
  }
  const edited = handEdits(book, a.out);
  if (edited.length && !args.force) {
    const shown = edited.slice(0, 20).join("\n  ") + (edited.length > 20 ? "\n  ..." : "");
    throw new Fail(`these output files changed since the last build:\n  ${shown}\n`
      + "Move the edits into the patchbook with `patchbook record`, or pass --force to discard them.");
  }
  writeOutput(book, a.out);
  process.stdout.write(`built ${a.out.size} files from ${book.pins()} with ${a.applied} edits\n`);
  if (args.commit) commitBuild(book);
  return 0;
}

function commitBuild(book: Book): void {
  const root = book.root;
  git(["add", "-A"], { cwd: root });
  const tree = git(["write-tree"], { cwd: root });
  const parents = ["-p", "HEAD"];
  const own = book.upstreams.find((u) => u.inRepo);
  if (own) {
    const commit = pinned(own, own.pin());
    const ancestor = spawn(["git", "merge-base", "--is-ancestor", commit, "HEAD"], { cwd: root, capture: false }).code === 0;
    if (!ancestor) parents.push("-p", commit);
  }
  if (git(["rev-parse", "HEAD^{tree}"], { cwd: root }) === tree && parents.length === 2) {
    process.stdout.write("nothing to commit\n");
    return;
  }
  const message = `Build from upstream ${book.pins()}`;
  const commit = git(["commit-tree", tree, ...parents, "-m", message], { cwd: root });
  git(["update-ref", "HEAD", commit], { cwd: root });
  process.stdout.write(`committed ${commit.slice(0, 7)}: ${message}\n`);
}

export async function cmdStatus(args: { json: boolean }) {
  const book = await Book.find();
  const a = assemble(book);
  const lastSync = join(book.dir, "last-sync.json");
  const report = exists(lastSync) ? loads(readText(lastSync)) : null;
  if (args.json) {
    const status = { upstreams: book.lock(), applied: a.applied, problems: a.problems, last_sync: report };
    process.stdout.write(dumps(status, 2) + "\n");
  } else {
    for (const p of a.problems) process.stdout.write(describe(p) + "\n");
    const counts = new Map<string, number>();
    for (const p of a.problems) counts.set(p.problem, (counts.get(p.problem) ?? 0) + 1);
    const summary = sortedBy(counts, ([k]) => k).map(([k, n]) => `${n} ${k}`).join(", ") || "no problems";
    process.stdout.write(`${a.applied} edits apply at ${book.pins()}; ${summary}\n`);
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
  process.stdout.write(`scaffolded ${count} entries in ${byFile.size} files\n`);
  return 0;
}

