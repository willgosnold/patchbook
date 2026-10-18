// Has an upstream moved, and moving the pins: carrying every change forward with git merge-file.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Book } from "./book.ts";
import { type Change, readChanges } from "./changes.ts";
import { SequenceMatcher } from "./lib/difflib.ts";
import { Fail } from "./lib/fail.ts";
import { exists, type File, sameFile, writeDisk, writeText } from "./lib/fs.ts";
import { dumps } from "./lib/json.ts";
import { spawn } from "./lib/proc.ts";
import { sorted } from "./lib/py.ts";
import { bytesEqual, decodeReplace, isText } from "./lib/text.ts";
import { pinned, type Upstream } from "./store.ts";

export const EXIT_MOVED = 10;

export async function cmdCheck() {
  const book = await Book.find();
  const result = { moved: false, upstreams: new Map<string, { pinned: string | null; head: string; moved: boolean; files: string[] }>() };
  for (const u of book.upstreams) {
    const pin = u.pin();
    const head = u.head();
    const r = { pinned: pin.commit ?? null, head, moved: false, files: [] as string[] };
    if (head !== pin.commit) {
      u.fetch(head);
      if (pin.tree) u.heal(pinned(u, pin));
      if (u.treeOf(head) !== pin.tree) {
        const old = pin.tree ? u.mounted(u.files(pinned(u, pin))) : new Map<string, File>();
        r.moved = true;
        r.files = upstreamDelta(old, u.mounted(u.files(head)));
      }
    }
    result.upstreams.set(u.name, r);
    result.moved = result.moved || r.moved;
  }
  process.stdout.write(dumps(result, 2) + "\n");
  return result.moved ? EXIT_MOVED : 0;
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

type Report = {
  from: string | null;
  to: string;
  upstream: string[];
  merged: { change: string; path: string }[];
  conflicts: ({ change: string; path: string; count: number } | { change: string; path: string; detail: string })[];
  gone: { change: string; path: string; maybe: string[] }[];
  replaced_upstream_changed: string[];
};

export async function cmdSync(args: { name: string | null; ref: string | null }) {
  const book = await Book.find();
  if (args.ref && !args.name && book.upstreams.length > 1) throw new Fail("name the upstream to sync to a ref: patchbook sync <name> <ref>");
  const targets = args.name ? [book.upstream(args.name)] : book.upstreams;
  const changes = readChanges(book, []);
  const reports = new Map<string, Report>();
  for (const u of targets) {
    const report = syncUpstream(book, u, args.ref, changes);
    if (report) reports.set(u.name, report);
  }
  if (reports.size) {
    writeText(join(book.dir, "last-sync.json"), dumps({ upstreams: reports }, 2) + "\n");
    process.stdout.write("Next: patchbook status\n");
  }
  return 0;
}

/** Move one upstream's pin and carry every change on its files forward. Returns the report, or null. */
export function syncUpstream(book: Book, u: Upstream, ref: string | null, changes: readonly Change[]): Report | null {
  const pin = u.pin();
  const commit = u.fetch(ref || u.branch);
  const tree = u.treeOf(commit);
  if (tree === pin.tree) {
    process.stdout.write(`${u.name}: upstream at ${commit.slice(0, 7)} matches the pin (tree ${tree.slice(0, 7)}). Nothing to do.\n`);
    return null;
  }
  u.keep(commit);
  const raw = u.files(commit);
  const old = pin.tree ? u.mounted(u.files(u.heal(pinned(u, pin)))) : new Map<string, File>();
  const fresh = u.mounted(raw);
  const report: Report = {
    from: pin.commit ?? null, to: commit, upstream: upstreamDelta(old, fresh), merged: [], conflicts: [], gone: [],
    replaced_upstream_changed: [],
  };

  if (u.vendor) {
    if (exists(u.vendor)) rmSync(u.vendor, { recursive: true });
    for (const [p, f] of raw) writeDisk(join(u.vendor, p), f);
    const actual = u.vendorTree(u.vendor).tree;
    if (actual !== tree) {
      throw new Fail(`the vendored copy of ${u.name} hashes to ${actual}, not upstream's ${tree}. Does a .gitignore hide upstream files?`);
    }
  }

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
      c.write("ours", e.path, merged);
      c.write("base", e.path, theirs);
      if (conflicts) report.conflicts.push({ change: c.name, path: e.path, count: conflicts });
      else report.merged.push({ change: c.name, path: e.path });
    }
  }

  book.writeLock(u.name, commit, tree);
  process.stdout.write(`${u.name}: pinned ${commit.slice(0, 7)}. ${report.upstream.length} upstream files changed, `
    + `${report.merged.length} of ours merged cleanly, ${report.conflicts.length} conflicts, ${report.gone.length} gone.\n`);
  return report;
}
