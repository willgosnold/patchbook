// The upstreams: one bare repo per remote in the user's store, fetched shallowly, read at the pin.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Book } from "./book.ts";
import { Fail } from "./lib/fail.ts";
import { exists, type File, mkdirs, normMode, pjoin, readDisk, readText, relative, resolve, writeDisk } from "./lib/fs.ts";
import { sha1 } from "./lib/hash.ts";
import { loads } from "./lib/json.ts";
import { git, run, spawn } from "./lib/proc.ts";
import { type PyValue, slice, sorted, split, strip } from "./lib/py.ts";
import { decode, decodeReplace, encode } from "./lib/text.ts";
import { storeDir, type Table } from "./settings.ts";

export type Pin = { commit?: string; tree?: string };
type Files = Map<string, File>;

export function defaultName(remote: string, path: string): string {
  const tail = (path ? rstrip(path) : rstrip(remote)).split("/").at(-1) ?? "";
  return (tail.endsWith(".git") ? tail.slice(0, -4) : tail) || "upstream";
}

const rstrip = (s: string) => s.replace(/\/+$/, "");

function field(spec: Table, key: string, fallback: string): string {
  const value = Object.hasOwn(spec, key) ? spec[key] : fallback;
  if (typeof value !== "string") throw new Fail(`an [[upstream]]'s ${key} is a string, not ${JSON.stringify(value)}`);
  return value;
}

/** One upstream repo, or a folder of one, mounted at a folder of the staged tree. */
export class Upstream {
  readonly remote: string;
  readonly path: string;
  readonly branch: string;
  readonly name: string;
  readonly mount: string;
  readonly vendor: string | null;
  readonly remoteName: string;

  constructor(readonly book: Book, spec: Table) {
    if (!Object.hasOwn(spec, "remote")) throw new Fail("an [[upstream]] needs a remote");
    this.remote = field(spec, "remote", "");
    this.path = strip(field(spec, "path", ""), "/");
    this.branch = field(spec, "branch", "main");
    this.name = field(spec, "name", "") || defaultName(this.remote, this.path);
    this.mount = strip(field(spec, "mount", this.name), "/");
    const vendor = field(spec, "vendor", "");
    this.vendor = vendor ? pjoin(book.root, vendor) : null;
    this.remoteName = field(spec, "remote_name", "upstream");
  }

  /** A fork's own upstream is the repo itself. The others are fetched into the store. */
  get inRepo(): boolean {
    return this.book.layout.kind === "fork" && this.mount === "";
  }

  key(rel: string): string {
    return this.mount ? `${this.mount}/${rel}` : rel;
  }

  mounted(files: Files): Files {
    return new Map(Array.from(files, ([p, f]) => [this.key(p), f]));
  }

  pin(): Pin {
    const raw = this.book.lock().get(this.name);
    if (!(raw instanceof Map)) return {};
    const pin: Pin = {};
    for (const key of ["commit", "tree"] as const) {
      const value = raw.get(key);
      if (typeof value === "string" && value) pin[key] = value;
    }
    return pin;
  }

  gitDir(): string {
    if (this.inRepo) return this.book.root;
    const bare = this.remote.replace(/^[\p{L}\p{N}_]+:\/\/|\.git$/gu, "");
    const readable = slice(strip(bare.replace(/[^A-Za-z0-9]+/g, "-"), "-"), -60);
    const d = pjoin(storeDir(), `${readable}-${sha1(encode(this.remote)).slice(0, 8)}`);
    if (!exists(d)) {
      mkdirs(dirname(d));
      git(["init", "--quiet", "--bare", d], { cwd: dirname(d) });
    }
    return d;
  }

  source(): string {
    return this.inRepo ? this.remoteName : this.remote;
  }

  fetch(ref: string): string {
    const depth = this.inRepo ? [] : ["--depth=1"];
    git(["fetch", "--quiet", ...depth, this.source(), ref], { cwd: this.gitDir() });
    const commit = git(["rev-parse", "FETCH_HEAD^{commit}"], { cwd: this.gitDir() });
    if (!this.inRepo) git(["update-ref", `refs/pins/${commit}`, commit], { cwd: this.gitDir() });
    return commit;
  }

  have(commit: string): void {
    if (spawn(["git", "cat-file", "-e", `${commit}^{commit}`], { cwd: this.gitDir() }).code !== 0) this.fetch(commit);
  }

  treeOf(commit: string): string {
    return git(["rev-parse", this.path ? `${commit}:${this.path}` : `${commit}^{tree}`], { cwd: this.gitDir() });
  }

  head(): string {
    const out = git(["ls-remote", this.source(), `refs/heads/${this.branch}`], { cwd: this.gitDir() });
    if (!out) throw new Fail(`upstream ${this.name} has no branch ${this.branch}`);
    return split(out)[0]!;
  }

  /** Upstream's files at a commit, relative to the upstream path. */
  files(commit: string): Files {
    this.have(commit);
    const gd = this.gitDir();
    const args = ["ls-tree", "-r", "-z", "--full-tree", commit, ...(this.path ? ["--", this.path] : [])];
    const entries: { rel: string; mode: number; oid: string }[] = [];
    for (const item of decode(run(["git", ...args], { cwd: gd })).split("\0")) {
      if (!item) continue;
      const tab = item.indexOf("\t");
      const [mode = "", kind, oid = ""] = split(item.slice(0, tab));
      const path = item.slice(tab + 1);
      if (kind !== "blob") continue; // submodules are not copied
      entries.push({ rel: this.path ? path.slice(this.path.length + 1) : path, mode: parseInt(mode, 8), oid });
    }
    const blobs = readBlobs(gd, entries.map((e) => e.oid));
    return new Map(entries.map(({ rel, mode, oid }) => [rel, { data: blobs.get(oid)!, mode: normMode(mode) }]));
  }

  /** Hash the vendored copy as git would commit it, and read its files. */
  vendorTree(vendor: string): { files: Files; tree: string } {
    const rel = relative(this.book.root, vendor);
    const { files, tree } = indexFiles(this.book.root, rel);
    return { files: new Map(Array.from(files, ([p, f]) => [p.slice(rel.length + 1), f])), tree };
  }

  /** Upstream's files at the pin, mounted. A vendored copy must match the pin exactly. */
  staged(): Files {
    const pin = this.pin();
    if (!pin.tree) throw new Fail(`upstream ${this.name} has no pin yet. Run: patchbook sync ${this.name}`);
    let files: Files;
    if (this.vendor) {
      const found = this.vendorTree(this.vendor);
      if (found.tree !== pin.tree) {
        throw new Fail(
          `${relative(this.book.root, this.vendor)} (tree ${found.tree.slice(0, 7)}) differs from the pin (tree ${pin.tree.slice(0, 7)}). `
            + "Never edit the vendored copy. Record the change in the patchbook, or run sync.",
        );
      }
      files = found.files;
    } else files = this.files(pinned(this, pin));
    return this.mounted(files);
  }
}

/** The pin's commit, which every pin with a tree has. */
export function pinned(u: Upstream, pin: Pin): string {
  if (!pin.commit) throw new Fail(`upstream ${u.name}'s pin in upstream.lock has no commit`);
  return pin.commit;
}

export function readBlobs(gd: string, oids: string[]): Map<string, Uint8Array> {
  const blobs = new Map<string, Uint8Array>();
  if (oids.length === 0) return blobs;
  const out = run(["git", "cat-file", "--batch"], { cwd: gd, input: encode(oids.join("\n") + "\n") });
  let i = 0;
  for (const oid of oids) {
    const nl = out.indexOf(10, i);
    const header = decode(out.subarray(i, nl));
    const size = Number(split(header)[2]);
    if (nl === -1 || !Number.isInteger(size)) throw new Error(`git cat-file --batch said: ${header}`);
    blobs.set(oid, out.subarray(nl + 1, nl + 1 + size));
    i = nl + 1 + size + 1;
  }
  return blobs;
}

/** What git would commit under rel, and its tree id. */
export function indexFiles(root: string, rel: string): { files: Files; tree: string } {
  const tmp = mkdtempSync(join(tmpdir(), "tmp"));
  let tree: string;
  let staged: string;
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
    git(["read-tree", "--empty"], { cwd: root, env });
    git(["add", "--", rel], { cwd: root, env });
    tree = git(["write-tree", `--prefix=${rel}/`], { cwd: root, env });
    staged = git(["ls-files", "-s", "-z", "--", rel], { cwd: root, env });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const files: Files = new Map();
  for (const item of staged.split("\0")) {
    if (!item) continue;
    const tab = item.indexOf("\t");
    const path = item.slice(tab + 1);
    const mode = parseInt(split(item.slice(0, tab))[0] ?? "", 8);
    files.set(path, { data: readDisk(join(root, path)).data, mode: normMode(mode) });
  }
  return { files, tree };
}

function get(value: PyValue | undefined, key: string): PyValue | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof Map)) throw new Fail(`last-sync.json: expected an object holding ${key}`);
  return value.get(key);
}

/** Read an upstream at its pin, from the store: list its files, print one, export them, or diff the last sync. */
export async function cmdUpstream(args: { name: string; path: string | null; diff: boolean; since: string | null; export: string | null }) {
  const book = await Book.find();
  const u = book.upstream(args.name);
  const pin = u.pin();
  if (!pin.tree) throw new Fail(`upstream ${u.name} has no pin yet. Run: patchbook sync ${u.name}`);
  const commit = pinned(u, pin);
  if (args.diff || args.since) {
    const last = join(book.dir, "last-sync.json");
    const from = exists(last) ? get(get(get(loads(readText(last)), "upstreams") ?? new Map(), u.name) ?? new Map(), "from") : undefined;
    const old = args.since || (typeof from === "string" ? from : "");
    if (!old) throw new Fail(`no earlier pin of ${u.name} to compare with; pass --since <commit>`);
    u.have(old);
    u.have(commit);
    const where = [u.path, args.path].filter((p) => p).join("/");
    const rel = u.path ? [`--relative=${u.path}/`] : [];
    const diff = run(["git", "diff", "--no-color", ...rel, old, commit, "--", ...(where ? [where] : [])], { cwd: u.gitDir() });
    process.stdout.write(decodeReplace(diff));
    return 0;
  }
  const files = u.files(commit);
  if (args.export) {
    const dest = resolve(args.export);
    for (const [path, file] of files) writeDisk(join(dest, path), file);
    process.stdout.write(`wrote ${files.size} files of ${u.name} at ${commit.slice(0, 7)} to ${dest}\n`);
    return 0;
  }
  if (args.path) {
    const file = files.get(args.path);
    if (!file) throw new Fail(`${u.name} has no ${args.path} at ${commit.slice(0, 7)}`);
    process.stdout.write(file.data);
    return 0;
  }
  process.stdout.write(sorted(files.keys()).join("\n") + "\n");
  return 0;
}
