import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import type { LastSync, Nearest, SyncReport, UpstreamPin } from "../../src/api.ts";
import { Case, Repo, TIMEOUT, type Run, crashCmd, dedent, permissionTest, sh, words } from "../helpers";
import { read, isSymlink, isExecutable, tree, storeOf, checkedUpstream, lockPin, gc, markerScript, setRemote, snapshot, ForkCase, VendorCase, forkTest, forkTestOnCaseSensitiveFs, vendorTest, installManager, forkWith, withHook, committedFiles, SKILL_FILE, AWKWARD, upstreamsOf } from "../e2e-fixtures.ts";

const syncedAt = (root: string): LastSync => JSON.parse(read(join(root, ".patchbook/last-sync.json")));
const reportOf = (root: string, name = "upstream"): SyncReport => syncedAt(root).upstreams.find((r) => r.name === name)!;

const cloneFollowing = (t: ForkCase, remote: string): string => {
  const origin = join(t.tmp, "origin.git");
  sh(["git", "init", "-q", "--bare", origin], { cwd: t.tmp });
  t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
  t.up.commit("upstream edit");
  t.pb(["sync"], { cwd: t.fork.path });
  setRemote(join(t.fork.path, ".patchbook/config.toml"), remote);
  t.fork.commit("Sync upstream");
  sh(["git", "push", "-q", origin, "HEAD:main"], { cwd: t.fork.path });
  sh(["git", "clone", "-q", "-b", "main", origin, "fresh"], { cwd: t.tmp });
  return join(t.tmp, "fresh");
};

function caseTest(name: string, body: (t: Case) => void): void {
  test(name, () => {
    const t = new Case();
    try {
      body(t);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

describe("ForkTest", () => {
  // Each layout puts a vendored copy where its own upstream's build writes, so a build would land in it.
  for (const [where, mount, vendor] of [
    ["on", "lib", "lib"],
    ["around", "vendor/lib", "vendor"],
    ["inside", "lib", "lib/vendored"],
  ] as const) {
    forkTest(`a vendor folder ${where} its own mount is rejected`, (t) => {
      const lib = new Repo(join(t.tmp, "lib"));
      lib.write("a.txt", "a\n");
      lib.write("vendored/x.txt", "x\n");
      lib.commit("lib");
      const config = join(t.fork.path, ".patchbook/config.toml");
      const before = read(config);
      const tracked = t.pb(["track", "lib", lib.path, "--mount", mount, "--vendor", vendor], { cwd: t.fork.path, code: 1 });
      expect(tracked.stderr).toContain(`the vendored copy of lib (${vendor}) overlaps the folder lib builds into (${mount})`);
      expect(tracked.stderr).toContain("Change vendor or mount for lib");
      expect(read(config)).toBe(before);
      expect(existsSync(join(t.fork.path, vendor))).toBe(false);
      expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    });
  }

  forkTest("a vendor folder on the root upstream is rejected", (t) => {
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replaceAll('mount = ""', 'mount = ""\nvendor = "vendor"'));
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 });
    expect(status.stderr).toContain("the vendored copy of upstream (vendor) overlaps the folder upstream builds into (the repo root)");
    expect(status.stderr).toContain("Change vendor for upstream.");
  });

  forkTest("a vendor folder over another upstream's mount is rejected", (t) => {
    const lib = new Repo(join(t.tmp, "lib"));
    lib.write("a.txt", "a\n");
    lib.commit("lib");
    const other = new Repo(join(t.tmp, "other"));
    other.write("b.txt", "b\n");
    other.commit("other");
    t.pb(["track", "lib", lib.path, "--vendor", "vendor"], { cwd: t.fork.path });
    const config = join(t.fork.path, ".patchbook/config.toml");
    const before = read(config);
    const tracked = t.pb(["track", "other", other.path, "--mount", "vendor/other"], { cwd: t.fork.path, code: 1 });
    expect(tracked.stderr).toContain("the vendored copy of lib (vendor) contains the folder other builds into (vendor/other)");
    expect(tracked.stderr).toContain("Change vendor for lib or mount for other");
    expect(read(config)).toBe(before);
  });

  forkTest("a track whose fetch fails leaves the book as it was", (t) => {
    const lib = new Repo(join(t.tmp, "lib"));
    lib.write("a.txt", "a\n");
    const commit = lib.commit("lib");
    const book = join(t.fork.path, ".patchbook");
    const before = snapshot(book);
    const tracked = t.pb(["track", "lib", join(t.tmp, "no-such-repo")], { cwd: t.fork.path, code: 1 });
    expect(tracked.stderr).toContain("git fetch");
    expect(snapshot(book)).toEqual(before);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["track", "lib", lib.path], { cwd: t.fork.path });
    expect(lockPin(read(join(book, "upstream.lock")), "lib").commit).toBe(commit);
  });

  permissionTest("a track that fails writing config leaves a pin nothing reads", (t) => {
    const lib = new Repo(join(t.tmp, "lib"));
    lib.write("a.txt", "lib\n");
    lib.commit("lib");
    const other = new Repo(join(t.tmp, "other"));
    other.write("a.txt", "other\n");
    const commit = other.commit("other");
    const config = join(t.fork.path, ".patchbook/config.toml");
    sh(["chmod", "a-w", config], { cwd: t.fork.path });
    try {
      t.pb(["track", "lib", lib.path], { cwd: t.fork.path, code: 1 });
    } finally {
      sh(["chmod", "u+w", config], { cwd: t.fork.path });
    }
    expect(JSON.parse(t.pb(["status", "--json"], { cwd: t.fork.path }).stdout).upstreams.map((p: UpstreamPin) => p.name)).toEqual(["upstream"]);
    expect(t.pb(["build"], { cwd: t.fork.path }).stdout).not.toContain("lib");
    t.pb(["track", "lib", other.path], { cwd: t.fork.path });
    expect(lockPin(read(join(t.fork.path, ".patchbook/upstream.lock")), "lib").commit).toBe(commit);
  }, ForkCase);

  permissionTest("a vendored track that fails writing config puts the pin and the copy back, so another URL can be tried", (t) => {
    const lib = new Repo(join(t.tmp, "lib"));
    lib.write("a.txt", "lib\n");
    lib.commit("lib");
    const other = new Repo(join(t.tmp, "other"));
    other.write("b.txt", "other\n");
    const commit = other.commit("other");
    const book = join(t.fork.path, ".patchbook");
    const config = join(book, "config.toml");
    const before = snapshot(book);
    sh(["chmod", "a-w", config], { cwd: t.fork.path });
    try {
      t.pb(["track", "lib", lib.path, "--vendor", "vendor/lib"], { cwd: t.fork.path, code: 1 });
    } finally {
      sh(["chmod", "u+w", config], { cwd: t.fork.path });
    }
    expect(snapshot(book)).toEqual(before);
    expect(existsSync(join(t.fork.path, "vendor"))).toBe(false);
    t.pb(["track", "lib", other.path, "--vendor", "vendor/lib"], { cwd: t.fork.path });
    expect(lockPin(read(join(book, "upstream.lock")), "lib").commit).toBe(commit);
    expect(read(join(t.fork.path, "vendor/lib/b.txt"))).toBe("other\n");
    expect(existsSync(join(t.fork.path, "vendor/lib/a.txt"))).toBe(false);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  }, ForkCase);

  for (const [order, first, second] of [
    ["holding", "vendor/inner", "vendor"],
    ["inside", "vendor", "vendor/inner"],
    ["equal to", "vendor", "vendor"],
  ] as const) {
    forkTest(`a vendor folder ${order} another upstream's vendor folder is rejected`, (t) => {
      const one = new Repo(join(t.tmp, "one"));
      one.write("a.txt", "a\n");
      one.commit("one");
      const two = new Repo(join(t.tmp, "two"));
      two.write("b.txt", "b\n");
      two.commit("two");
      t.pb(["track", "one", one.path, "--mount", "m1", "--vendor", first], { cwd: t.fork.path });
      const config = join(t.fork.path, ".patchbook/config.toml");
      const before = read(config);
      const tracked = t.pb(["track", "two", two.path, "--mount", "m2", "--vendor", second], { cwd: t.fork.path, code: 1 });
      expect(tracked.stderr).toContain(`the vendored copy of two (${second}) overlaps the vendored copy of one (${first})`);
      expect(tracked.stderr).toContain("Change vendor for one or two");
      expect(read(config)).toBe(before);
    });
  }

  forkTest("check and sync count only what the new pin leaves out", (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("x.md", "extra\n");
    extra.commit("extra");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.fork.path });
    t.up.write("vendor/extra/a.md", "a\n");
    t.up.commit("ship a");
    t.pb(["sync", "upstream"], { cwd: t.fork.path });
    t.fork.commit("sync");
    t.up.rm("vendor/extra/a.md");
    t.up.write("vendor/extra/b.md", "b\n");
    t.up.commit("ship b instead");
    const notice = "patchbook: left 1 upstream files out of the build because they would land in a vendored copy: vendor/extra (1).\n";
    expect(t.pb(["check"], { cwd: t.fork.path, code: 10 }).stderr).toBe(notice);
    expect(t.pb(["sync", "upstream"], { cwd: t.fork.path }).stderr).toBe(notice);
  });

  const withOwnPatchbook = (t: ForkCase): void => {
    t.up.write(".patchbook/series", "theirs\n");
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
    t.up.commit("upstream adopts patchbook");
    t.pb(["sync"], { cwd: t.fork.path });
    t.fork.commit("sync");
  };

  forkTest("check ignores a change to upstream's own patchbook", (t) => {
    withOwnPatchbook(t);
    t.up.write(".patchbook/series", "theirs\nmore\n");
    t.up.write(".patchbook/notes.md", "notes\n");
    t.up.commit("only their patchbook");
    const checked = t.pb(["check"], { cwd: t.fork.path });
    expect(JSON.parse(checked.stdout).moved).toBe(false);
    expect(checkedUpstream(checked.stdout, "upstream").moved).toBe(false);
    expect(checkedUpstream(checked.stdout, "upstream").files).toEqual([]);
  });

  forkTest("check reports the real change beside one to upstream's own patchbook", (t) => {
    withOwnPatchbook(t);
    t.up.write(".patchbook/series", "theirs\nmore\n");
    t.up.write("docs/guide.md", "a new guide\n");
    t.up.commit("both");
    const out = t.pb(["check"], { cwd: t.fork.path, code: 10 }).stdout;
    expect(checkedUpstream(out, "upstream").moved).toBe(true);
    expect(checkedUpstream(out, "upstream").files).toEqual(["changed docs/guide.md"]);
  });

  forkTest("sync still pins a commit that changes only upstream's own patchbook", (t) => {
    withOwnPatchbook(t);
    t.up.write(".patchbook/series", "theirs\nmore\n");
    const head = t.up.commit("only their patchbook");
    t.pb(["check"], { cwd: t.fork.path });
    const synced = t.pb(["sync"], { cwd: t.fork.path });
    expect(synced.stdout).toContain(`upstream: pinned ${head.slice(0, 7)}. 0 upstream files changed`);
    expect(lockPin(t.fork.read(".patchbook/upstream.lock"), "upstream").commit).toBe(head);
    expect(t.pb(["check"], { cwd: t.fork.path }).code).toBe(0);
  });

  forkTest("check reports a vendored upstream's patchbook as a change", (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "extra\n");
    extra.write(".patchbook/series", "theirs\n");
    extra.commit("extra");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.fork.path });
    t.fork.commit("track");
    extra.write(".patchbook/series", "theirs\nmore\n");
    extra.commit("only its patchbook");
    const out = t.pb(["check"], { cwd: t.fork.path, code: 10 }).stdout;
    expect(checkedUpstream(out, "extra").moved).toBe(true);
    expect(checkedUpstream(out, "extra").files).toEqual(["changed extra/.patchbook/series"]);
    expect(checkedUpstream(out, "upstream").moved).toBe(false);
    t.pb(["sync", "extra"], { cwd: t.fork.path });
    expect(t.fork.read("vendor/extra/.patchbook/series")).toBe("theirs\nmore\n");
    expect(t.pb(["check"], { cwd: t.fork.path }).code).toBe(0);
  });

  for (const folder of [".patchbook/pbx", ".git/x", ".patchbook", ".git"]) {
    forkTest(`a mount at ${folder} is rejected`, (t) => {
      const lib = new Repo(join(t.tmp, "lib"));
      lib.write("d/p.md", "p\n");
      lib.commit("lib");
      const config = join(t.fork.path, ".patchbook/config.toml");
      const before = read(config);
      const tracked = t.pb(["track", "lib", lib.path, "--mount", folder], { cwd: t.fork.path, code: 1 });
      expect(tracked.stderr).toContain(`lib mounts at ${folder}`);
      expect(tracked.stderr).toContain("patchbook never builds into");
      expect(read(config)).toBe(before);
    });
  }

  for (const mount of ["./.patchbook/pbx"]) {
    forkTest(`a mount spelled ${mount} is rejected`, (t) => {
      const lib = new Repo(join(t.tmp, "lib"));
      lib.write("d/p.md", "p\n");
      lib.commit("lib");
      const config = join(t.fork.path, ".patchbook/config.toml");
      const before = read(config);
      const tracked = t.pb(["track", "lib", lib.path, "--mount", mount], { cwd: t.fork.path, code: 1 });
      expect(tracked.stderr).toContain("patchbook never builds into");
      expect(read(config)).toBe(before);
    });
  }

  for (const mount of ["x/../../outside", "/abs/outside", ".."]) {
    forkTest(`a mount ${mount} outside the repo is rejected`, (t) => {
      const lib = new Repo(join(t.tmp, "lib"));
      lib.write("d/p.md", "p\n");
      lib.commit("lib");
      const config = join(t.fork.path, ".patchbook/config.toml");
      const before = read(config);
      const tracked = t.pb(["track", "lib", lib.path, "--mount", mount], { cwd: t.fork.path, code: 1 });
      expect(tracked.stderr).toContain("must be a folder inside the staged tree");
      expect(read(config)).toBe(before);
    });
  }

  forkTest("a vendor folder inside a mount spelled with a leading ./ is rejected", (t) => {
    const lib = new Repo(join(t.tmp, "lib"));
    lib.write("a.txt", "a\n");
    lib.write("vendored/z.txt", "z\n");
    lib.commit("lib");
    const bup = new Repo(join(t.tmp, "bup"));
    bup.write("b.txt", "b\n");
    bup.commit("bup");
    t.pb(["track", "bup", bup.path, "--vendor", "lib/vendored"], { cwd: t.fork.path });
    const config = join(t.fork.path, ".patchbook/config.toml");
    const before = read(config);
    const tracked = t.pb(["track", "lib", lib.path, "--mount", "./lib", "--vendor", "./lib/own"], { cwd: t.fork.path, code: 1 });
    expect(tracked.stderr).toContain("the vendored copy of lib (lib/own) overlaps the folder lib builds into (lib)");
    expect(read(config)).toBe(before);
  });

  forkTest("a mount spelled with a leading ./ and no overlap builds where the plain one does", (t) => {
    const lib = new Repo(join(t.tmp, "lib"));
    lib.write("a.txt", "a\n");
    lib.write("vendored/z.txt", "z\n");
    lib.commit("lib");
    const bup = new Repo(join(t.tmp, "bup"));
    bup.write("b.txt", "b\n");
    bup.commit("bup");
    t.pb(["track", "bup", bup.path, "--vendor", "lib/vendored"], { cwd: t.fork.path });
    t.pb(["track", "lib", lib.path, "--mount", "./lib"], { cwd: t.fork.path });
    const built = t.pb(["build"], { cwd: t.fork.path });
    expect(built.stderr).toContain("left 1 upstream files out of the build because they would land in a vendored copy: lib/vendored (1).");
    expect(t.fork.read("lib/a.txt")).toBe("a\n");
    expect(t.fork.read("lib/vendored/b.txt")).toBe("b\n");
    expect(existsSync(join(t.fork.path, "lib/vendored/z.txt"))).toBe(false);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("two upstreams mounted at lib and ./lib/x are rejected", (t) => {
    const a = new Repo(join(t.tmp, "a"));
    a.write("a.txt", "a\n");
    a.commit("a");
    const b = new Repo(join(t.tmp, "b"));
    b.write("b.txt", "b\n");
    b.commit("b");
    t.pb(["track", "a", a.path, "--mount", "lib"], { cwd: t.fork.path });
    const tracked = t.pb(["track", "b", b.path, "--mount", "./lib/x"], { cwd: t.fork.path, code: 1 });
    expect(tracked.stderr).toContain("mount at overlapping folders");
  });

  forkTest("a vendor folder inside another upstream's mount leaves that upstream's files out", (t) => {
    const lib = new Repo(join(t.tmp, "lib"));
    lib.write("a.txt", "a\n");
    lib.write("vendored/z.txt", "z\n");
    lib.commit("lib");
    const bup = new Repo(join(t.tmp, "bup"));
    bup.write("b.txt", "b\n");
    bup.commit("bup");
    t.pb(["track", "lib", lib.path], { cwd: t.fork.path });
    t.pb(["track", "bup", bup.path, "--vendor", "lib/vendored"], { cwd: t.fork.path });
    const built = t.pb(["build"], { cwd: t.fork.path });
    expect(built.stderr).toContain("patchbook: left 1 upstream files out of the build because they would land in a vendored copy: lib/vendored (1).");
    expect(built.stderr.split("left ").length - 1).toBe(1);
    expect(t.fork.read("lib/a.txt")).toBe("a\n");
    expect(t.fork.read("lib/vendored/b.txt")).toBe("b\n");
    expect(existsSync(join(t.fork.path, "lib/vendored/z.txt"))).toBe(false);
    expect(t.fork.read("bup/b.txt")).toBe("b\n");
    t.fork.commit("build");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
  });

  forkTest("a failed command still says which files it left out", (t) => {
    const lib = new Repo(join(t.tmp, "lib"));
    lib.write("a.txt", "a\n");
    lib.write("vendored/z.txt", "z\n");
    lib.commit("lib");
    const bup = new Repo(join(t.tmp, "bup"));
    bup.write("b.txt", "b\n");
    bup.commit("bup");
    t.pb(["track", "lib", lib.path], { cwd: t.fork.path });
    t.pb(["track", "bup", bup.path, "--vendor", "lib/vendored"], { cwd: t.fork.path });
    const change = join(t.fork.path, ".patchbook/changes/into-vendor");
    mkdirSync(join(change, "ours/lib/vendored"), { recursive: true });
    writeFileSync(join(change, "ours/lib/vendored/n.md.pb"), "ours\n");
    writeFileSync(join(change, "CHANGE.md"), "# into-vendor\n\nintent: Write into the vendored copy.\n\nedits:\n- add lib/vendored/n.md\n");
    writeFileSync(join(t.fork.path, ".patchbook/series"), "into-vendor\n");
    const refused = t.pb(["build"], { cwd: t.fork.path, code: 1 });
    expect(refused.stderr).toContain("add lib/vendored/n.md");
    expect(refused.stderr).toContain("patchbook: left 1 upstream files out of the build because they would land in a vendored copy: lib/vendored (1).");
  });

  const intoVendor = [
    ["add", "add vendor/extra/new.md"],
    ["copy", "copy app.txt -> vendor/extra/app.txt"],
  ] as const;
  for (const [kind, edit] of intoVendor) {
    forkTest(`${kind} edit into a vendored copy is refused`, (t) => {
      const extra = new Repo(join(t.tmp, "extra"));
      extra.write("a.md", "extra\n");
      extra.commit("extra");
      t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.fork.path });
      t.pb(["build"], { cwd: t.fork.path });
      t.fork.commit("track");
      const change = join(t.fork.path, ".patchbook/changes/into-vendor");
      mkdirSync(join(change, "ours/vendor/extra"), { recursive: true });
      writeFileSync(join(change, "ours/vendor/extra/new.md.pb"), "ours\n");
      writeFileSync(join(change, "CHANGE.md"), `# into-vendor\n\nintent: Write into the vendored copy.\n\nedits:\n- ${edit}\n`);
      writeFileSync(join(t.fork.path, ".patchbook/series"), "into-vendor\n");
      const lock = t.fork.read(".patchbook/build.lock");
      const refused = t.pb(["build"], { cwd: t.fork.path, code: 1 });
      expect(refused.stderr).toContain(`changes/into-vendor ${edit}`);
      expect(refused.stderr).toContain("the vendored copy vendor/extra");
      expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain(`changes/into-vendor ${edit}`);
      expect(t.fork.read(".patchbook/build.lock")).toBe(lock);
      expect(sh(["git", "status", "--porcelain", "--", "vendor", "app.txt", "docs"], { cwd: t.fork.path }).stdout).toBe("");
    });
  }

  const intoKept = [
    ["copy into .patchbook/config.toml", "copy app.txt -> .patchbook/config.toml", ".patchbook/config.toml", ".patchbook"],
    ["add into .patchbook", "add .patchbook/new.md", ".patchbook/new.md", ".patchbook"],
    ["copy into .PATCHBOOK/config.toml", "copy app.txt -> .PATCHBOOK/config.toml", ".PATCHBOOK/config.toml", ".patchbook"],
    ["copy into .patchbook./config.toml", "copy app.txt -> .patchbook./config.toml", ".patchbook./config.toml", ".patchbook"],
    ["copy into .patchbook with a Kelvin sign", "copy app.txt -> .patchboo\u212A/config.toml", ".patchboo\u212A/config.toml", ".patchbook"],
    ["copy into .patchbook and a space", "copy app.txt -> .patchbook /config.toml", ".patchbook /config.toml", ".patchbook"],
    ["add into .PatchBook. and a space", "add .PatchBook. ./new.md", ".PatchBook. ./new.md", ".patchbook"],
    ["move into .patchbook..", "move docs/guide.md -> .patchbook../guide.md", ".patchbook../guide.md", ".patchbook"],
    ["copy into .GIT", "copy app.txt -> .GIT/x", ".GIT/x", ".git"],
  ] as const;
  for (const [name, edit, dest, place] of intoKept) {
    forkTest(`${name} is invalid and nothing is written`, (t) => {
      const change = join(t.fork.path, ".patchbook/changes/into-kept");
      mkdirSync(change, { recursive: true });
      if (edit.startsWith("add ")) {
        mkdirSync(join(change, "ours", dirname(dest)), { recursive: true });
        writeFileSync(join(change, "ours", `${dest}.pb`), "ours\n");
      }
      writeFileSync(join(change, "CHANGE.md"), `# into-kept\n\nintent: Write into a place a build keeps.\n\nedits:\n- ${edit}\n`);
      writeFileSync(join(t.fork.path, ".patchbook/series"), "into-kept\n");
      const target = join(t.fork.path, dest);
      const was = existsSync(target) ? read(target) : null;
      const before = tree(t.fork.path);
      const detail = `${dest} would be written into ${place}`;
      const status = t.pb(["status"], { cwd: t.fork.path, code: 1 });
      expect(status.stdout).toContain(`changes/into-kept ${edit}`);
      expect(status.stdout).toContain(detail);
      const problems = JSON.parse(t.pb(["status", "--json"], { cwd: t.fork.path, code: 1 }).stdout).problems;
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({ problem: "invalid", file: "changes/into-kept", edit, refuse: true });
      expect(problems[0].detail).toBe(detail);
      const refused = t.pb(["build"], { cwd: t.fork.path, code: 1 });
      expect(refused.stderr).toContain(detail);
      expect(refused.stderr).toContain("nothing built");
      expect(tree(t.fork.path)).toEqual(before);
      expect(existsSync(target) ? read(target) : null).toBe(was);
    });
  }

  const intoKeptCommit = (t: ForkCase, ...args: string[]) =>
    sh(["git", "commit", "-qm", "into kept", ...args], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Shout two." }, check: false });
  const gitState = (t: ForkCase): string =>
    ["rev-parse HEAD", "ls-files -s", "diff --cached", "diff"].map((a) => sh(["git", ...a.split(" ")], { cwd: t.fork.path }).stdout).join("\n--\n");
  const fixHint = "Edit or remove that line in the change's CHANGE.md, or skip the hook once with PATCHBOOK_HOOK=0.";

  const hookRefuses = [
    ["copy into .patchbook/config.toml", "copy app.txt -> .patchbook/config.toml", ".patchbook/config.toml", ".patchbook"],
    ["copy into .patchbook.", "copy app.txt -> .patchbook./config.toml", ".patchbook./config.toml", ".patchbook"],
    ["add into .patchbook and a space", "add .patchbook /new.md", ".patchbook /new.md", ".patchbook"],
  ] as const;
  for (const [name, edit, dest, place] of hookRefuses) {
    for (const pending of [false, true]) {
      forkTest(`hook refuses a ${name}${pending ? " with a hand edit pending" : ""} and leaves everything as it was`, (t) => {
        const change = join(t.fork.path, ".patchbook/changes/into-kept");
        mkdirSync(change, { recursive: true });
        if (edit.startsWith("add ")) {
          mkdirSync(join(change, "ours", dirname(dest)), { recursive: true });
          writeFileSync(join(change, "ours", `${dest}.pb`), "ours\n");
        }
        writeFileSync(join(change, "CHANGE.md"), `# into-kept\n\nintent: Write into a place a build keeps.\n\nedits:\n- ${edit}\n`);
        writeFileSync(join(t.fork.path, ".patchbook/series"), "into-kept\n");
        if (pending) t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
        sh(["git", "add", "-A"], { cwd: t.fork.path });
        const files = tree(t.fork.path);
        const state = gitState(t);
        const refused = intoKeptCommit(t);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("patchbook: refusing this commit");
        expect(refused.stderr).toContain(`  invalid   changes/into-kept ${edit}: ${dest} would be written into ${place}\n`);
        expect(refused.stderr).toContain(fixHint);
        expect(refused.stderr).not.toContain("wasn't rebuilt");
        expect(tree(t.fork.path)).toEqual(files);
        expect(gitState(t)).toBe(state);
        expect(readdirSync(join(t.fork.path, ".patchbook/changes"))).toEqual(["into-kept"]);
        if (pending) expect(t.fork.read("app.txt")).toContain("TWO");
      });
    }
  }

  forkTest("hook refuses a staged file under .patchbook. before recording it", (t) => {
    const path = ".patchbook./x.md";
    t.fork.write(path, "ours\n");
    sh(["git", "add", "--", path], { cwd: t.fork.path });
    const files = tree(t.fork.path);
    const state = gitState(t);
    const refused = intoKeptCommit(t, "--allow-empty");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`patchbook: refusing this commit: ${path} is new, but a change can't write into .patchbook.`);
    expect(refused.stderr).toContain(`Move ${path} out of there, or skip the hook once with PATCHBOOK_HOOK=0.`);
    expect(tree(t.fork.path)).toEqual(files);
    expect(gitState(t)).toBe(state);
    expect(existsSync(join(t.fork.path, ".patchbook/changes"))).toBe(false);
  });

  forkTestOnCaseSensitiveFs("hook leaves an untracked file under .GIT out of the commit", (t) => {
    t.fork.write("a/.GIT/y", "ours\n");
    expect(sh(["git", "add", "--", "a/.GIT/y"], { cwd: t.fork.path, check: false }).code).not.toBe(0);
    const committed = intoKeptCommit(t, "--allow-empty");
    expect(committed.code).toBe(0);
    expect(committed.stderr).not.toContain("refusing this commit");
    expect(t.fork.read("a/.GIT/y")).toBe("ours\n");
    expect(existsSync(join(t.fork.path, ".patchbook/changes"))).toBe(false);
  });

  const hookRefusesUnsafe = [
    ["add climbing out", "add ../outside.txt"],
    ["add climbing out with a backslash", "add ..\\outside.txt"],
    ["copy dest .patchbook backslash config.toml", "copy app.txt -> .patchbook\\config.toml"],
  ] as const;
  for (const [name, edit] of hookRefusesUnsafe) {
    for (const pending of [false, true]) {
      forkTest(`hook refuses an unsafe ${name} edit${pending ? " with a hand edit pending" : ""} and leaves everything as it was`, (t) => {
        const change = join(t.fork.path, ".patchbook/changes/unsafe");
        mkdirSync(change, { recursive: true });
        writeFileSync(join(change, "CHANGE.md"), `# unsafe\n\nintent: Name a path outside the tree.\n\nedits:\n- ${edit}\n`);
        writeFileSync(join(t.fork.path, ".patchbook/series"), "unsafe\n");
        if (pending) t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
        sh(["git", "add", "-A"], { cwd: t.fork.path });
        const files = tree(t.fork.path);
        const state = gitState(t);
        const beside = readdirSync(t.tmp).sort();
        const refused = intoKeptCommit(t);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("patchbook: refusing this commit");
        expect(refused.stderr).toContain(`  invalid   changes/unsafe ${edit}: `);
        expect(refused.stderr).toContain("must be a path inside the tree: not absolute, with no empty, . or .. segment");
        expect(refused.stderr).toContain(fixHint);
        expect(refused.stderr).not.toContain("wasn't rebuilt");
        expect(tree(t.fork.path)).toEqual(files);
        expect(gitState(t)).toBe(state);
        expect(readdirSync(t.tmp).sort()).toEqual(beside);
        expect(readdirSync(join(t.fork.path, ".patchbook/changes"))).toEqual(["unsafe"]);
        if (pending) expect(t.fork.read("app.txt")).toContain("TWO");
      });
    }
  }

  for (const pending of [false, true]) {
    forkTest(`hook refuses a new file with a backslash in its name${pending ? " with a hand edit pending" : ""} and leaves everything as it was`, (t) => {
      if (pending) t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
      t.fork.write("odd\\name.txt", "ours\n");
      sh(["git", "add", "-A"], { cwd: t.fork.path });
      const files = tree(t.fork.path);
      const state = gitState(t);
      const refused = intoKeptCommit(t);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("refusing to record: odd\\name.txt has a backslash in its name");
      expect(tree(t.fork.path)).toEqual(files);
      expect(gitState(t)).toBe(state);
      expect(existsSync(join(t.fork.path, ".patchbook/changes"))).toBe(false);
      expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain("unrecorded odd\\name.txt");
    });
  }

  forkTest("hook commits an ordinary edit beside an intent-to-add file under .PATCHBOOK", (t) => {
    t.fork.write(".PATCHBOOK/x.md", "ours\n");
    sh(["git", "add", "-N", "--", ".PATCHBOOK/x.md"], { cwd: t.fork.path });
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    const committed = intoKeptCommit(t);
    expect(committed.code).toBe(0);
    expect(committed.stderr).not.toContain("refusing this commit");
    expect(sh(["git", "show", "--stat", "--format=", "HEAD"], { cwd: t.fork.path }).stdout).not.toContain(".PATCHBOOK");
  });

  test("record refuses a hand edit under an --output-from folder with a backslash in its name", () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("odd\\dir/x.txt", "one\n");
      up.commit("start");
      const repo = new Repo(join(t.tmp, "adapted"));
      repo.write("README.md", "mine\n");
      repo.commit("start");
      t.pb(["init", "--upstream", up.path, "--output-from", "odd\\dir", "--output-to", "out"], { cwd: repo.path });
      t.pb(["build"], { cwd: repo.path });
      repo.write("out/x.txt", "edited\n");
      const files = tree(repo.path);
      const refused = t.pb(["record", "--intent", "Edit."], { cwd: repo.path, code: 1 });
      expect(refused.stderr).toContain("refusing to record: odd\\dir/x.txt has a backslash in its name");
      expect(tree(repo.path)).toEqual(files);
      expect(existsSync(join(repo.path, ".patchbook/changes"))).toBe(false);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  forkTest("record refuses a hand edit to a file with a backslash in its name", (t) => {
    t.fork.write("odd\\name.txt", "ours\n");
    const files = tree(t.fork.path);
    const refused = t.pb(["record", "--intent", "Odd."], { cwd: t.fork.path, code: 1 });
    expect(refused.stderr).toContain("refusing to record: odd\\name.txt has a backslash in its name");
    expect(tree(t.fork.path)).toEqual(files);
    expect(existsSync(join(t.fork.path, ".patchbook/changes"))).toBe(false);
  });

  forkTest("hook still warns and commits for another problem", (t) => {
    const change = join(t.fork.path, ".patchbook/changes/gone");
    mkdirSync(change, { recursive: true });
    writeFileSync(join(change, "CHANGE.md"), "# gone\n\nintent: Delete a file upstream lacks.\n\nedits:\n- delete missing.txt\n");
    writeFileSync(join(t.fork.path, ".patchbook/series"), "gone\n");
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    const before = sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout;
    const committed = intoKeptCommit(t);
    expect(committed.code).toBe(0);
    expect(committed.stderr).toContain("1 problems, so the output wasn't rebuilt.");
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).not.toBe(before);
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain("gone      changes/gone delete missing.txt");
  });

  const escaping = [
    ["add climbing out", "add ../outside.txt"],
    ["copy dest climbing out", "copy app.txt -> ../copied.txt"],
  ] as const;
  for (const [name, edit] of escaping) {
    forkTest(`${name} is invalid and nothing is read or written outside`, (t) => {
      const change = join(t.fork.path, ".patchbook/changes/esc");
      mkdirSync(join(change, "ours"), { recursive: true });
      const path = /^add (\S+)$/.exec(edit)?.[1];
      if (path) {
        mkdirSync(dirname(join(change, "ours", path)), { recursive: true });
        writeFileSync(join(change, "ours", `${path.replace(/^\//, "")}.pb`), "ours\n");
      }
      writeFileSync(join(change, "CHANGE.md"), `# esc\n\nintent: Reach outside.\n\nedits:\n- ${edit}\n`);
      writeFileSync(join(t.fork.path, ".patchbook/series"), "esc\n");
      const before = tree(t.fork.path);
      const beside = readdirSync(t.tmp).sort();
      const detail = "must be a path inside the tree: not absolute, with no empty, . or .. segment";
      const status = t.pb(["status"], { cwd: t.fork.path, code: 1 });
      expect(status.stdout).toContain(`changes/esc ${edit}`);
      expect(status.stdout).toContain(detail);
      const problems = JSON.parse(t.pb(["status", "--json"], { cwd: t.fork.path, code: 1 }).stdout).problems;
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({ problem: "invalid", file: "changes/esc", edit, refuse: true });
      expect(problems[0].detail).toContain(detail);
      const refused = t.pb(["build", "--force"], { cwd: t.fork.path, code: 1 });
      expect(refused.stderr).toContain("nothing built");
      expect(tree(t.fork.path)).toEqual(before);
      expect(readdirSync(t.tmp).sort()).toEqual(beside);
    });
  }

  for (const [label, name] of [
    ["nested", "a/b"], ["absolute", "/abs"], ["capitalised", "Shout"],
    ["leading dot", ".x"], ["with a space", "a b"], ["with an underscore", "a_b"],
  ] as const) {
    forkTest(`record refuses a ${label} change name and writes nothing`, (t) => {
      t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
      const before = tree(t.fork.path);
      const beside = readdirSync(t.tmp).sort();
      const refused = t.pb(["record", name, "--intent", "Shout the second line."], { cwd: t.fork.path, code: 1 });
      expect(refused.stderr).toContain(`"${name}" isn't a valid change name`);
      expect(tree(t.fork.path)).toEqual(before);
      expect(readdirSync(t.tmp).sort()).toEqual(beside);
    });
  }

  forkTest("record refuses a bad change name with no hand edits", (t) => {
    const before = snapshot(join(t.fork.path, ".patchbook"));
    const refused = t.pb(["record", "Bad Name", "--intent", "x"], { cwd: t.fork.path, code: 1 });
    expect(refused.stderr).toContain(`"Bad Name" isn't a valid change name`);
    expect(refused.stdout).not.toContain("nothing to record");
    expect(snapshot(join(t.fork.path, ".patchbook"))).toEqual(before);
  });

  forkTest("a series line that is not a change name is invalid and its folder is not read", (t) => {
    mkdirSync(join(t.fork.path, ".patchbook/elsewhere"), { recursive: true });
    writeFileSync(join(t.fork.path, ".patchbook/elsewhere/CHANGE.md"), "# elsewhere\n\nintent: Not a change.\n\nedits:\n- delete app.txt\n");
    writeFileSync(join(t.fork.path, ".patchbook/series"), "../elsewhere\n..\n.\na/b\n/abs\n");
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 });
    for (const name of ["../elsewhere", "..", ".", "a/b", "/abs"]) {
      expect(status.stdout).toContain(`"${name}" isn't a valid change name`);
    }
    expect(status.stdout).toContain("0 edits apply");
    expect(status.stdout).toContain("5 invalid");
    const shown = t.pb(["show", "../elsewhere"], { cwd: t.fork.path, code: 1 });
    expect(shown.stderr).toContain("no change called ../elsewhere");
    expect(shown.stdout).not.toContain("Not a change");
    const before = tree(t.fork.path);
    t.pb(["build", "--force"], { cwd: t.fork.path, code: 1 });
    expect(tree(t.fork.path)).toEqual(before);
  });

  forkTest("a change folder that is not a change name is invalid and a strict one is just unlisted", (t) => {
    for (const name of ["we\\ird", "Loose_Name", "loose-name"]) {
      mkdirSync(join(t.fork.path, ".patchbook/changes", name), { recursive: true });
      writeFileSync(join(t.fork.path, ".patchbook/changes", name, "CHANGE.md"), `# ${name}\n\nintent: Loose.\n\nedits:\n- delete app.txt\n`);
    }
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 });
    expect(status.stdout).toContain(`"we\\\\ird" isn't a valid change name`);
    expect(status.stdout).toContain(`"Loose_Name" isn't a valid change name`);
    expect(status.stdout).toContain("change loose-name is not in the series");
    expect(status.stdout).toContain("3 invalid");
  });

  const badNames = [
    ["a series line", "My_Fix", true],
    ["a folder that is not in the series", "My_Fix", false],
    ["a folder with a backslash that is not in the series", "we\\ird", false],
  ] as const;
  const badName = (t: ForkCase, name: string, listed: boolean): void => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "tmp-fix", "--intent", "Shout the second line."], { cwd: t.fork.path });
    const changes = join(t.fork.path, ".patchbook/changes");
    renameSync(join(changes, "tmp-fix"), join(changes, name));
    writeFileSync(join(changes, name, "CHANGE.md"), read(join(changes, name, "CHANGE.md")).replace("# tmp-fix", `# ${name}`));
    writeFileSync(join(t.fork.path, ".patchbook/series"), listed ? `${name}\n` : "");
    t.fork.commit("bad name");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("three", "THREE"));
  };

  for (const [what, name, listed] of badNames) {
    forkTest(`status reports ${what} that is not a change name as invalid and show has no such change`, (t) => {
      badName(t, name, listed);
      const detail = `${JSON.stringify(name)} isn't a valid change name; use lowercase letters, digits and hyphens, starting with a letter or digit`;
      const status = t.pb(["status"], { cwd: t.fork.path, code: 1 });
      expect(status.stdout).toContain(`invalid   series: ${detail}`);
      const problems = JSON.parse(t.pb(["status", "--json"], { cwd: t.fork.path, code: 1 }).stdout).problems;
      expect(problems).toContainEqual({ problem: "invalid", file: "series", detail, refuse: true });
      const shown = t.pb(["show", name], { cwd: t.fork.path, code: 1 });
      expect(shown.stderr).toContain(`no change called ${name}`);
      expect(shown.stdout).toBe("");
    });
  }

  for (const [what, name, listed] of badNames.slice(0, 2)) {
    forkTest(`hook refuses ${what} that is not a change name and loses no edit`, (t) => {
      badName(t, name, listed);
      sh(["git", "add", "-A"], { cwd: t.fork.path });
      const files = tree(t.fork.path);
      const state = gitState(t);
      const refused = intoKeptCommit(t);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("patchbook: refusing this commit");
      expect(refused.stderr).toContain(`${JSON.stringify(name)} isn't a valid change name`);
      expect(refused.stderr).toContain("Rename it to lowercase letters, digits and dashes in series and changes/, or skip the hook once with PATCHBOOK_HOOK=0.");
      expect(refused.stderr).not.toContain("wasn't rebuilt");
      expect(tree(t.fork.path)).toEqual(files);
      expect(gitState(t)).toBe(state);
      expect(t.fork.read("app.txt")).toContain("THREE");
      expect(readdirSync(join(t.fork.path, ".patchbook/changes"))).toEqual([name]);
    });

    forkTest(`record refuses ${what} that is not a change name and writes nothing`, (t) => {
      badName(t, name, listed);
      const files = tree(t.fork.path);
      for (const args of [["--intent", "Shout more."], ["my-fix", "--intent", "Shout more."]]) {
        const refused = t.pb(["record", ...args], { cwd: t.fork.path, code: 1 });
        expect(refused.stderr).toContain(`${JSON.stringify(name)} isn't a valid change name`);
        expect(tree(t.fork.path)).toEqual(files);
      }
    });
  }

  forkTest("record still takes a strict name and makes one from the intent", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "my-fix", "--intent", "Shout the second line."], { cwd: t.fork.path });
    t.fork.write("extra.txt", "ours\n");
    t.pb(["record", "--intent", "Add an extra file."], { cwd: t.fork.path });
    expect(readdirSync(join(t.fork.path, ".patchbook/changes")).sort()).toEqual(["add-an-extra-file", "my-fix"]);
    expect(read(join(t.fork.path, ".patchbook/series"))).toBe("my-fix\nadd-an-extra-file\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    expect(t.pb(["show", "my-fix"], { cwd: t.fork.path }).stdout).toContain("+TWO");
  });

  forkTest("record with an empty name names the change from the intent", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "", "--intent", "Make the second line loud."], { cwd: t.fork.path });
    expect(readdirSync(join(t.fork.path, ".patchbook/changes"))).toEqual(["make-the-second-line"]);
  });

  const keepsRejected = (name: string, setup: (t: ForkCase) => void, edit: (t: ForkCase) => void, record: (t: ForkCase) => void): void => {
    forkTest(name, (t) => {
      setup(t);
      const file = join(t.fork.path, ".patchbook/changes/fix/CHANGE.md");
      writeFileSync(file, read(file) + "- add ../outside.txt\n- copy app.txt -> /abs.txt\n");
      edit(t);
      record(t);
      const after = read(file);
      expect(after).toContain("- add ../outside.txt\n");
      expect(after).toContain("- copy app.txt -> /abs.txt\n");
      expect(after).toMatch(/^# fix\n\nintent: .+\n\nedits:\n/);
      const status = t.pb(["status"], { cwd: t.fork.path, code: 1 });
      expect(status.stdout).toContain("changes/fix add ../outside.txt");
      expect(status.stdout).toContain("changes/fix copy app.txt -> /abs.txt");
      expect(existsSync(join(t.tmp, "outside.txt"))).toBe(false);
    });
  };
  const fix = (t: ForkCase): void => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "fix", "--intent", "Shout the second line."], { cwd: t.fork.path });
    t.pb(["build", "--force"], { cwd: t.fork.path });
    t.fork.commit("fix");
  };

  keepsRejected(
    "record keeps an edit line it rejected when it updates the change that owns the file",
    fix,
    (t) => t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("three", "THREE")),
    (t) => void t.pb(["record", "--intent", "Shout more."], { cwd: t.fork.path }),
  );
  keepsRejected(
    "record keeps an edit line it rejected when it adds an edit to that change",
    fix,
    (t) => t.fork.write("extra.txt", "ours\n"),
    (t) => void t.pb(["record", "fix", "--intent", "Shout, and add extra."], { cwd: t.fork.path }),
  );
  keepsRejected(
    "record keeps an edit line it rejected when it unadds a file of that change",
    (t) => {
      t.fork.write("extra.txt", "ours\n");
      t.pb(["record", "fix", "--intent", "Shout the second line."], { cwd: t.fork.path });
      t.pb(["build", "--force"], { cwd: t.fork.path });
      t.fork.commit("fix");
    },
    (t) => t.fork.rm("extra.txt"),
    (t) => void t.pb(["record", "--intent", "Drop extra."], { cwd: t.fork.path }),
  );

  forkTest("check and sync leave out what the build ignores", (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "extra\n");
    extra.commit("extra");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.fork.path });
    t.fork.commit("track");
    t.up.write(".patchbook/notes.md", "upstream's notes\n");
    t.up.write("vendor/extra/new.md", "new\n");
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
    t.up.commit("upstream edit");
    const notice = "patchbook: left 1 upstream files out of the build because they would land in a vendored copy: vendor/extra (1).\n";
    const checked = t.pb(["check"], { cwd: t.fork.path, code: 10 });
    expect(checkedUpstream(checked.stdout, "upstream").files).toEqual(["changed app.txt"]);
    expect(checked.stderr).toBe(notice);
    const synced = t.pb(["sync", "upstream"], { cwd: t.fork.path });
    expect(synced.stderr).toBe(notice);
    const report = reportOf(t.fork.path);
    expect(report.upstream).toEqual(["changed app.txt"]);
  });

  for (const kind of ["annotated"]) {
    forkTest(`sync does not import the ${kind} tags of an in-repo upstream`, (t) => {
      t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
      t.up.commit("upstream edit");
      sh(["git", "tag", ...(kind === "annotated" ? ["-a", "-m", "release"] : []), "v6"], { cwd: t.up.path });
      t.pb(["sync", "upstream"], { cwd: t.fork.path });
      expect(sh(["git", "for-each-ref", "refs/tags"], { cwd: t.fork.path }).stdout).toBe("");
    });
  }

  forkTest("clone keeps the history of the repo and pins the upstream", (t) => {
    const log = sh(["git", "log", "--oneline"], { cwd: t.fork.path }).stdout;
    expect(log).toContain("start");
    expect(sh(["git", "remote"], { cwd: t.fork.path }).stdout).toContain("upstream");
    expect(t.pb(["check"], { cwd: t.fork.path }).code).toBe(0);
  });

  forkTest("record writes the change and a build after it changes nothing", (t) => {
    t.recordFeature();
    const change = read(join(t.fork.path, ".patchbook/changes/feature/CHANGE.md"));
    expect(change).toContain("- file app.txt");
    expect(change).toContain("- add extra.txt");
    expect(change).toContain("- delete docs/guide.md");
    t.pb(["build"], { cwd: t.fork.path });
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout).toBe("");
    expect(t.pb(["show", "feature"], { cwd: t.fork.path }).stdout).toContain("TWO");
  });

  forkTest("sync merges a clean upstream change and build --commit keeps upstream reachable", (t) => {
    t.recordFeature();
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
    const head = t.up.commit("upstream edit");
    const check = t.pb(["check"], { cwd: t.fork.path, code: 10 });
    expect(check.stdout).toContain("changed app.txt");
    t.pb(["sync"], { cwd: t.fork.path });
    const report = reportOf(t.fork.path);
    expect(report.merged.map((m) => m.path)).toEqual(["app.txt"]);
    t.pb(["build", "--commit"], { cwd: t.fork.path });
    const text = t.fork.read("app.txt");
    expect(text).toContain("TWO");
    expect(text).toContain("SIX");
    const parents = words(sh(["git", "rev-list", "--parents", "-n1", "HEAD"], { cwd: t.fork.path }).stdout);
    expect(parents[2]).toBe(head); // the build merges upstream, so its history stays reachable
  });

  forkTest("a fresh clone of the fork reads the pin after a sync", (t) => {
    const origin = join(t.tmp, "origin.git");
    const hooked = { ...t.env, PATCHBOOK_HOOK: "1" };
    sh(["git", "init", "-q", "--bare", origin], { cwd: t.tmp });
    sh(["git", "remote", "add", "origin", origin], { cwd: t.fork.path });
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
    const head = t.up.commit("upstream edit");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "commit", "-qam", "Sync upstream"], { cwd: t.fork.path, env: hooked });
    sh(["git", "push", "-q", "origin", "HEAD:main"], { cwd: t.fork.path });
    sh(["git", "clone", "-q", "-b", "main", origin, "fresh"], { cwd: t.tmp });
    const fresh = new Repo(join(t.tmp, "fresh"));
    expect(t.pb(["status"], { cwd: fresh.path }).stdout).toBe(`0 edits apply at upstream ${head.slice(0, 7)}; no problems\n`);
    expect(t.pb(["build"], { cwd: fresh.path }).stdout).toContain(`from upstream ${head.slice(0, 7)}`);
    fresh.write("app.txt", fresh.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "commit", "-qam", "shout"], { cwd: fresh.path, env: hooked });
    expect(words(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: fresh.path }).stdout)).toContain(".patchbook/changes/shout/CHANGE.md");
    t.pb(["build", "--commit"], { cwd: fresh.path });
    expect(words(sh(["git", "rev-list", "--parents", "-n1", "HEAD"], { cwd: fresh.path }).stdout)[2]).toBe(head);
  });

  forkTest("a fork and its clone keep the pin through gc when upstream is gone", (t) => {
    const origin = join(t.tmp, "origin.git");
    sh(["git", "init", "-q", "--bare", origin], { cwd: t.tmp });
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
    const head = t.up.commit("upstream edit");
    t.pb(["sync"], { cwd: t.fork.path });
    t.fork.commit("Sync upstream");
    sh(["git", "push", "-q", origin, "HEAD:main"], { cwd: t.fork.path });
    sh(["git", "clone", "-q", "-b", "main", origin, "fresh"], { cwd: t.tmp });
    const fresh = new Repo(join(t.tmp, "fresh"));
    t.pb(["hook", "install"], { cwd: fresh.path });
    fresh.write("app.txt", fresh.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "commit", "-qam", "shout"], { cwd: fresh.path, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(words(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: fresh.path }).stdout)).toContain(".patchbook/changes/shout/CHANGE.md");
    rmSync(t.up.path, { recursive: true });
    for (const repo of [t.fork.path, fresh.path]) {
      gc(repo);
      expect(t.pb(["status"], { cwd: repo }).stdout).toContain(`apply at upstream ${head.slice(0, 7)}; no problems`);
    }
  });

  forkTest("clone init and track write a relative upstream path as an absolute one", (t) => {
    const up = realpathSync(t.up.path);
    const remotes = (repo: string): string[] => Array.from(read(join(repo, ".patchbook/config.toml")).matchAll(/^remote = "(.*)"$/gm), (m) => m[1]!);
    const sub = join(t.tmp, "sub");
    mkdirSync(sub);
    t.pb(["clone", "../upstream", "cloned"], { cwd: sub });
    expect(remotes(join(sub, "cloned"))).toEqual([up]);
    const mine = join(sub, "mine");
    sh(["git", "clone", "-q", t.up.path, mine], { cwd: t.tmp });
    mkdirSync(join(mine, "deep"));
    t.pb(["init", "--upstream", "../../../upstream"], { cwd: join(mine, "deep") });
    expect(remotes(mine)).toEqual([up]);
    t.pb(["track", "again", "../../upstream", "--mount", "again"], { cwd: join(t.fork.path, "docs") });
    expect(remotes(t.fork.path)).toEqual([t.up.path, up]);
  });

  forkTest("a relative remote in config fails sync status and check and pins nothing", (t) => {
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replace(`remote = "${t.up.path}"`, 'remote = "../fork"'));
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
    t.up.commit("upstream edit");
    const lock = t.fork.read(".patchbook/upstream.lock");
    for (const command of ["sync", "status", "check"]) {
      const out = t.pb([command], { cwd: t.fork.path, code: 1 });
      expect(out.stderr).toContain('upstream upstream\'s remote "../fork" is a relative path');
      expect(out.stderr).toContain("Set remote in .patchbook/config.toml to an absolute path or a URL.");
    }
    expect(t.fork.read(".patchbook/upstream.lock")).toBe(lock);
  });

  forkTest("status reads a URL remote and refuses a relative path or an empty remote", (t) => {
    const config = join(t.fork.path, ".patchbook/config.toml");
    const original = read(config);
    const status = (remote: string, code: number) => {
      writeFileSync(config, original.replace(`remote = "${t.up.path}"`, `remote = "${remote}"`));
      return t.pb(["status"], { cwd: t.fork.path, code });
    };
    for (const remote of ["https://example.invalid/up.git", "ssh://example.invalid/up.git", "git@example.invalid:up.git", `file://${t.up.path}`]) {
      expect(status(remote, 0).stdout).toContain("no problems");
    }
    for (const remote of ["up", "./up", "../up", "sub/dir:up"]) {
      expect(status(remote, 1).stderr).toContain(`remote "${remote}" is a relative path`);
    }
    expect(status("", 1).stderr).toContain("an [[upstream]] needs a remote");
  });

  forkTest("an empty upstream argument is refused and pins nothing", (t) => {
    const mine = join(t.tmp, "mine");
    sh(["git", "clone", "-q", t.up.path, mine], { cwd: t.tmp });
    expect(t.pb(["init", "--upstream", ""], { cwd: mine, code: 1 }).stderr).toContain("an [[upstream]] needs a remote");
    expect(existsSync(join(mine, ".patchbook"))).toBe(false);
    expect(t.pb(["track", "again", ""], { cwd: t.fork.path, code: 1 }).stderr).toContain("an [[upstream]] needs a remote");
    expect(read(join(t.fork.path, ".patchbook/config.toml"))).not.toContain("again");
    const before = readdirSync(t.tmp);
    t.pb(["clone", ""], { cwd: t.tmp, code: 1 });
    expect(readdirSync(t.tmp)).toEqual(before);
  });

  forkTest("a remote that starts with a dash fails sync status and check and pins nothing", (t) => {
    const config = join(t.fork.path, ".patchbook/config.toml");
    const original = read(config);
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
    t.up.commit("upstream edit");
    const lock = t.fork.read(".patchbook/upstream.lock");
    for (const remote of ["--bogus", "-x", "--bogus=a:b"]) {
      writeFileSync(config, original.replace(`remote = "${t.up.path}"`, `remote = "${remote}"`));
      for (const command of ["sync", "status", "check"]) {
        const out = t.pb([command], { cwd: t.fork.path, code: 1 });
        expect(out.stderr).toContain(`upstream upstream's remote "${remote}" starts with "-", so git would read it as an option.`);
      }
    }
    expect(t.fork.read(".patchbook/upstream.lock")).toBe(lock);
  });

  forkTest("init and track refuse a remote that starts with a dash and change nothing", (t) => {
    const mine = join(t.tmp, "mine");
    sh(["git", "clone", "-q", t.up.path, mine], { cwd: t.tmp });
    const config = read(join(t.fork.path, ".patchbook/config.toml"));
    const lock = t.fork.read(".patchbook/upstream.lock");
    for (const remote of ["--bogus", "--bogus=a:b"]) {
      const message = `remote "${remote}" starts with "-", so git would read it as an option.`;
      expect(t.pb(["init", `--upstream=${remote}`], { cwd: mine, code: 1 }).stderr).toContain(message);
      expect(existsSync(join(mine, ".patchbook"))).toBe(false);
      expect(t.pb(["track", "again", "--", remote], { cwd: t.fork.path, code: 1 }).stderr).toContain(message);
      expect(read(join(t.fork.path, ".patchbook/config.toml"))).toBe(config);
      expect(t.fork.read(".patchbook/upstream.lock")).toBe(lock);
    }
  });

  forkTest("a remote helper in a cloned fork's config runs only if the user's git config allows it and ext never runs", (t) => {
    const helperRan = markerScript(t, "git-remote-pbtest");
    const extRan = markerScript(t, "pbtest-ext");
    const fresh = cloneFollowing(t, "pbtest::x");
    for (const command of ["check", "status"]) {
      expect(t.pb([command], { cwd: fresh, code: 1 }).stderr).toContain("transport 'pbtest' not allowed");
    }
    expect(existsSync(helperRan)).toBe(false);
    const gitconfig = join(t.tmp, "gitconfig");
    writeFileSync(gitconfig, '[protocol "pbtest"]\n\tallow = always\n[protocol "ext"]\n\tallow = always\n');
    t.env["GIT_CONFIG_GLOBAL"] = gitconfig;
    t.pb(["check"], { cwd: fresh, code: 1 });
    expect(existsSync(helperRan)).toBe(true);
    setRemote(join(fresh, ".patchbook/config.toml"), `ext::${join(t.tmp, "bin/pbtest-ext")}`);
    expect(t.pb(["check"], { cwd: fresh, code: 1 }).stderr).toContain("transport 'ext' not allowed");
    expect(existsSync(extRan)).toBe(false);
  });

  for (const name of ["file", "ssh", "git"]) {
    forkTest(`a cloned fork's config naming the ${name} helper runs no git remote ${name}`, (t) => {
      const helperRan = markerScript(t, `git-remote-${name}`);
      const fresh = cloneFollowing(t, `${name}::x`);
      for (const command of ["check", "status"]) t.pb([command], { cwd: fresh, code: 1 });
      expect(existsSync(helperRan)).toBe(false);
    });
  }

  forkTest("a user's git config that refuses the file transport refuses a local path remote", (t) => {
    const gitconfig = join(t.tmp, "gitconfig");
    writeFileSync(gitconfig, '[protocol]\n\tallow = never\n[protocol "https"]\n\tallow = always\n');
    t.env["GIT_CONFIG_GLOBAL"] = gitconfig;
    expect(t.pb(["check"], { cwd: t.fork.path, code: 1 }).stderr).toContain("transport 'file' not allowed");
  });

  forkTest("a refused remote helper names the git command without patchbook's own flags", (t) => {
    const fresh = cloneFollowing(t, "pbtest::x");
    const check = t.pb(["check"], { cwd: fresh, code: 1 }).stderr;
    expect(check).toContain("git ls-remote \"pbtest::x\" refs/heads/main failed:\nfatal: transport 'pbtest' not allowed");
    for (const stderr of [check, t.pb(["status"], { cwd: fresh, code: 1 }).stderr]) {
      expect(stderr).not.toContain("protocol.");
      expect(stderr).not.toContain("--end-of-options");
    }
  });

  const CONTROL = /[\p{Cc}--[\n\t]]/v;
  const asciiJson = (value: unknown): string =>
    JSON.stringify(value, null, 2).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n";
  const renameUpstream = (t: ForkCase, name: string): void => {
    for (const file of ["config.toml", "upstream.lock"]) {
      const path = join(t.fork.path, ".patchbook", file);
      writeFileSync(path, read(path).replace(/^name = .*$/m, `name = "${name}"`).replace(/^( *)"name": "upstream",$/m, `$1"name": "${name}",`));
    }
  };

  forkTest("a committed remote with control characters reaches the terminal escaped", (t) => {
    const fresh = cloneFollowing(t, "https://example.invalid/\\u001b[31mRED\\u001b]0;TITLE\\u0007x\\u007f[31mDEL\\u009b31mC1\\u0085NEL");
    for (const command of ["check", "status"]) {
      const { stdout, stderr } = t.pb([command], { cwd: fresh, code: 1 });
      expect(stdout + stderr).not.toMatch(CONTROL);
      const [ours = "", git = ""] = stderr.split(" failed:\n");
      for (const shown of ["example.invalid/\\u001b[31mRED\\u001b]0;TITLE\\u0007x", "DEL", "\\u009b31mC1", "NEL"]) expect(ours).toContain(shown);
      for (const shown of ["\\u009b31mC1", "\\u0085NEL"]) expect(git).toContain(shown);
    }
  });

  forkTest("an upstream name and branch with control characters reach the terminal escaped", (t) => {
    renameUpstream(t, "up\\u001b]0;NAME\\u0007\\u009b");
    const pin = sh(["git", "rev-parse", "--short=7", "HEAD"], { cwd: t.up.path }).stdout.trim();
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toBe(`0 edits apply at up\\u001b]0;NAME\\u0007\\u009b ${pin}; no problems\n`);
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replace(/^branch = .*$/m, 'branch = "ma\\u001b[31min"'));
    expect(t.pb(["check"], { cwd: t.fork.path, code: 1 }).stderr).toBe("patchbook: upstream up\\u001b]0;NAME\\u0007\\u009b has no branch ma\\u001b[31min\n");
  });

  forkTest("a git error relayed to the user shows its control characters escaped", (t) => {
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replace(/^branch = .*$/m, 'branch = "ma\\u009b31min"'));
    const fetch = t.pb(["sync"], { cwd: t.fork.path, code: 1 }).stderr;
    expect(fetch).toContain("fatal: couldn't find remote ref ma\\u009b31min\n");
    const clone = t.pb(["clone", "--branch", "ma\u009b31min", t.up.path, "again"], { cwd: t.tmp, code: 1 }).stderr;
    expect(clone).toContain("fatal: Remote branch ma\\u009b31min not found");
    expect(fetch + clone).not.toMatch(CONTROL);
  });

  forkTest("an upstream path with control characters is listed escaped", (t) => {
    t.up.write("evil\u001b]0;TITLE\u0007.txt", "x\n");
    t.up.commit("a file with control characters in its name");
    t.pb(["sync"], { cwd: t.fork.path });
    const listed = t.pb(["upstream", "upstream"], { cwd: t.fork.path }).stdout;
    expect(listed).toContain("evil\\u001b]0;TITLE\\u0007.txt\n");
    expect(listed).not.toMatch(CONTROL);
  });

  forkTest("show prints a changed path with control characters escaped", (t) => {
    t.up.write("evil\u001b]0;TITLE\u0007.txt", "one\n");
    t.up.commit("a file with control characters in its name");
    t.pb(["sync"], { cwd: t.fork.path });
    t.fork.write("evil\u001b]0;TITLE\u0007.txt", "ONE\n");
    t.pb(["record", "shout", "--intent", "Shout."], { cwd: t.fork.path });
    const shown = t.pb(["show", "shout"], { cwd: t.fork.path }).stdout;
    expect(shown).toContain("--- upstream/evil\\u001b]0;TITLE\\u0007.txt\n+++ ours/evil\\u001b]0;TITLE\\u0007.txt\n");
    expect(shown).not.toMatch(CONTROL);
  });

  forkTest("check and status JSON keep control characters as JSON escapes", (t) => {
    renameUpstream(t, "up\\u001b]0;NAME\\u0007\\u007f\\u009b");
    for (const args of [["check"], ["status", "--json"]]) {
      const { stdout, stderr } = t.pb(args, { cwd: t.fork.path });
      const parsed = JSON.parse(stdout);
      expect(parsed.upstreams.map((u: { name: string }) => u.name)).toEqual(["up\u001b]0;NAME\u0007\u007f\u009b"]);
      expect(stdout).toBe(asciiJson(parsed));
      expect(stderr).not.toMatch(CONTROL);
    }
  });

  forkTest("init and clone give git an option like branch or URL as a value and pin nothing", (t) => {
    for (const [i, value] of ["--bogus", "--bogus=a:b"].entries()) {
      const mine = join(t.tmp, `mine${i}`);
      sh(["git", "clone", "-q", t.up.path, mine], { cwd: t.tmp });
      const init = t.pb(["init", `--upstream=${t.up.path}`, `--branch=${value}`], { cwd: mine, code: 1 }).stderr;
      expect(init).not.toContain("unknown option");
      expect(init).toContain("couldn't find remote ref --bogus");
      expect(existsSync(join(mine, ".patchbook/upstream.lock"))).toBe(false);
      const dest = join(t.tmp, `clone${i}`);
      expect(t.pb(["clone", "--", value, dest], { cwd: t.tmp, code: 1 }).stderr).not.toContain("unknown option");
      expect(existsSync(dest)).toBe(false);
    }
  });

  forkTest("init refuses an upstream remote that points elsewhere and pins nothing", (t) => {
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("one", "ONE"));
    t.up.commit("b1");
    const mine = join(t.tmp, "mine");
    sh(["git", "clone", "-q", t.up.path, mine], { cwd: t.tmp });
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("two", "TWO"));
    t.up.commit("b2");
    const other = join(t.tmp, "other");
    sh(["git", "clone", "-q", t.up.path, other], { cwd: t.tmp });
    sh(["git", "reset", "-q", "--hard", "HEAD~2"], { cwd: other });
    const elsewhere = new Repo(other);
    elsewhere.write("other.txt", "a1\n");
    elsewhere.commit("a1");
    sh(["git", "remote", "add", "upstream", other], { cwd: mine });
    expect(t.pb(["init", "--upstream", t.up.path], { cwd: mine, code: 1 }).stderr).toContain("the upstream remote and --upstream serve different commits for main");
    expect(existsSync(join(mine, ".patchbook"))).toBe(false);
  });

  forkTest("a shallow clone of the fork fetches only the pin", (t) => {
    const origin = join(t.tmp, "origin.git");
    sh(["git", "init", "-q", "--bare", origin], { cwd: t.tmp });
    let head = "";
    for (const word of ["four", "five", "six"]) {
      t.up.write("app.txt", t.up.read("app.txt").replaceAll(word, word.toUpperCase()));
      head = t.up.commit(`shout ${word}`);
    }
    t.pb(["sync"], { cwd: t.fork.path });
    t.fork.commit("Sync upstream");
    sh(["git", "push", "-q", origin, "HEAD:main"], { cwd: t.fork.path });
    sh(["git", "clone", "-q", "--depth", "1", "-b", "main", `file://${origin}`, "shallow"], { cwd: t.tmp });
    const shallow = join(t.tmp, "shallow");
    const commits = (): string => sh(["git", "rev-list", "--count", "--all"], { cwd: shallow }).stdout.trim();
    expect(commits()).toBe("1");
    // The sync commit skipped the hook, so the output is behind the pin, as the note says.
    expect(t.pb(["status"], { cwd: shallow }).stdout).toBe(
      "note      the output is behind the patchbook: app.txt differs from a build. Run `patchbook build`.\n"
      + `0 edits apply at upstream ${head.slice(0, 7)}; no problems\n`,
    );
    expect(t.pb(["build"], { cwd: shallow }).stdout).toContain(`from upstream ${head.slice(0, 7)}`);
    expect(commits()).toBe("2");
  });

  forkTest("a full fork stays full after a sync fetches a new pin", (t) => {
    const shallow = (): string => sh(["git", "rev-parse", "--is-shallow-repository"], { cwd: t.fork.path }).stdout.trim();
    expect(shallow()).toBe("false");
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
    const head = t.up.commit("upstream edit");
    t.pb(["sync"], { cwd: t.fork.path });
    expect(lockPin(t.fork.read(".patchbook/upstream.lock"), "upstream").commit).toBe(head);
    expect(sh(["git", "cat-file", "-e", `${head}^{commit}`], { cwd: t.fork.path, check: false }).code).toBe(0);
    expect(shallow()).toBe("false");
  });

  forkTest("sync leaves a conflict that status reports and build refuses", (t) => {
    t.recordFeature();
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("two", "deux"));
    t.up.commit("conflicting edit");
    t.pb(["sync"], { cwd: t.fork.path });
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout;
    expect(status).toContain("conflict");
    t.pb(["build"], { cwd: t.fork.path, code: 1 });
  });

  forkTest("the hook refuses a synced conflict in an older change until it is resolved", (t) => {
    t.recordFeature();
    t.fork.write("later.txt", "a later change\n");
    t.pb(["record", "later", "--intent", "Add a later file."], { cwd: t.fork.path });
    t.fork.commit("later");
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("two", "deux"));
    t.up.commit("conflicting edit");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    const head = sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout;
    const index = sh(["git", "write-tree"], { cwd: t.fork.path }).stdout;
    const before = tree(t.fork.path);
    const commit = sh(["git", "commit", "-qam", "Sync upstream"], { cwd: t.fork.path, env: withHook(t), check: false });
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("refusing this commit");
    expect(commit.stderr).toContain(".patchbook/changes/feature/ours/app.txt.pb");
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).toBe(head);
    expect(sh(["git", "write-tree"], { cwd: t.fork.path }).stdout).toBe(index);
    expect(tree(t.fork.path)).toEqual(before);
    const resolved = t.up.read("app.txt").replaceAll("deux", "DEUX");
    t.fork.write(".patchbook/changes/feature/ours/app.txt.pb", resolved);
    sh(["git", "commit", "-qam", "Resolve upstream conflict"], { cwd: t.fork.path, env: withHook(t) });
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("app.txt")).toBe(resolved);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  for (const kind of ["file", "add", "replace"] as const) {
    forkTest(`the hook refuses markers in a ${kind} copy hidden by a later delete`, (t) => {
      t.recordFeature();
      const path = kind === "add" ? "extra.txt" : "app.txt";
      if (kind === "replace") {
        t.fork.write(".patchbook/changes/feature/CHANGE.md", t.fork.read(".patchbook/changes/feature/CHANGE.md").replace("- file app.txt", "- replace app.txt"));
        t.pb(["build"], { cwd: t.fork.path });
        t.fork.commit("replace app.txt");
      }
      t.fork.write(".patchbook/changes/later/CHANGE.md", `# later\n\nintent: Remove the output file.\n\nedits:\n- delete ${path}\n`);
      appendFileSync(join(t.fork.path, ".patchbook/series"), "later\n");
      t.pb(["build"], { cwd: t.fork.path });
      t.fork.commit("later");
      const copy = `.patchbook/changes/feature/ours/${path}.pb`;
      t.fork.write(copy, "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> upstream\n");
      t.fork.write("unrecorded.txt", "do not record this\n");
      sh(["git", "add", "-A"], { cwd: t.fork.path });
      const head = sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout;
      const index = sh(["git", "write-tree"], { cwd: t.fork.path }).stdout;
      const before = tree(t.fork.path);
      const commit = sh(["git", "commit", "-qm", "conflicted"], { cwd: t.fork.path, env: withHook(t), check: false });
      expect(commit.code).not.toBe(0);
      expect(commit.stderr).toContain(copy);
      expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).toBe(head);
      expect(sh(["git", "write-tree"], { cwd: t.fork.path }).stdout).toBe(index);
      expect(tree(t.fork.path)).toEqual(before);
    });
  }

  for (const orphan of [false, true]) {
    forkTest(`the hook refuses markers in ${orphan ? "an orphaned" : "an applied"} paragraph entry`, (t) => {
      const hash = orphan ? "000000000000" : createHash("sha256").update("a guide").digest("hex").slice(0, 12);
      const path = ".patchbook/blocks/docs/guide.md.entries";
      t.fork.write(path, `=== entry ${hash}\nkind: policy\nrules: \nintent: Adapt the guide.\n--- upstream\na guide\n--- patched\n<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> upstream\n`);
      sh(["git", "add", "-A"], { cwd: t.fork.path });
      const head = sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout;
      const before = tree(t.fork.path);
      const commit = sh(["git", "commit", "-qm", "conflicted entry"], { cwd: t.fork.path, env: withHook(t), check: false });
      expect(commit.code).not.toBe(0);
      expect(commit.stderr).toContain(path);
      expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).toBe(head);
      expect(tree(t.fork.path)).toEqual(before);
    });
  }

  forkTest("the hook restores a new recording that introduces conflict markers", (t) => {
    t.fork.write("app.txt", "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> upstream\n");
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    const head = sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout;
    const index = sh(["git", "write-tree"], { cwd: t.fork.path }).stdout;
    const before = tree(t.fork.path);
    const commit = sh(["git", "commit", "-qm", "conflicted output"], { cwd: t.fork.path, env: { ...withHook(t), PATCHBOOK_INTENT: "Adapt app.txt." }, check: false });
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("refusing this commit");
    expect(commit.stderr).toContain("  app.txt\n");
    expect(commit.stderr).not.toContain("adapt-app-txt");
    expect(commit.stdout).toBe("");
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).toBe(head);
    expect(sh(["git", "write-tree"], { cwd: t.fork.path }).stdout).toBe(index);
    expect(tree(t.fork.path)).toEqual(before);
  });

  forkTest("the hook names the staged file when markers typed into an owned file are recorded", (t) => {
    t.recordFeature();
    t.fork.write("app.txt", "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> upstream\n");
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    const before = tree(t.fork.path);
    const commit = sh(["git", "commit", "-qm", "conflicted output"], { cwd: t.fork.path, env: withHook(t), check: false });
    expect(commit.code).toBe(1);
    expect(commit.stderr).toContain("  app.txt\n");
    expect(commit.stderr).not.toContain("ours/app.txt.pb");
    expect(tree(t.fork.path)).toEqual(before);
  });

  const BLOCK = "<<<<<<< ours\nx\n=======\ny\n>>>>>>> upstream\n";

  caseTest("the hook records an edit to a file whose markers upstream already holds", (t) => {
    const fork = forkWith(t, { "doc.md": `intro\n${BLOCK}end\n` });
    fork.write("doc.md", `Intro\n${BLOCK}end\n`);
    sh(["git", "commit", "-qam", "capitalize"], { cwd: fork.path, env: { ...withHook(t), PATCHBOOK_INTENT: "Capitalize the intro." } });
    expect(committedFiles(fork)).toContain(".patchbook/changes/capitalize-the-intro/ours/doc.md.pb");
  });

  caseTest("the hook refuses an edit to a file with markers upstream holds when the edit adds a block", (t) => {
    const fork = forkWith(t, { "doc.md": `intro\n${BLOCK}end\n` });
    fork.write("doc.md", `intro\n${BLOCK}end\n${BLOCK}`);
    const commit = sh(["git", "commit", "-qam", "quote"], { cwd: fork.path, env: { ...withHook(t), PATCHBOOK_INTENT: "Quote a block." }, check: false });
    expect(commit.code).toBe(1);
    expect(commit.stderr).toContain("  doc.md\n");
  });

  const entry = (patched: string) => {
    const upstream = `Use:\n${BLOCK.trimEnd()}`;
    const hash = createHash("sha256").update(upstream).digest("hex").slice(0, 12);
    return `=== entry ${hash}\nkind: policy\nrules: \nintent: Adapt the guide.\n--- upstream\n${upstream}\n--- patched\n${patched}\n`;
  };

  caseTest("the hook commits a paragraph entry whose text holds the markers upstream holds", (t) => {
    const fork = forkWith(t, { "guide.md": `Use:\n${BLOCK}` });
    fork.write(".patchbook/blocks/guide.md.entries", entry(`Use this:\n${BLOCK.trimEnd()}`));
    sh(["git", "add", "-A"], { cwd: fork.path });
    sh(["git", "commit", "-qm", "scaffold"], { cwd: fork.path, env: withHook(t) });
    fork.write("app.txt", "one\nTWO\n");
    sh(["git", "commit", "-qam", "unrelated"], { cwd: fork.path, env: { ...withHook(t), PATCHBOOK_INTENT: "Shout two." } });
  });

  caseTest("the hook refuses a paragraph entry that adds a marker block to the paragraph", (t) => {
    const fork = forkWith(t, { "guide.md": `Use:\n${BLOCK}` });
    fork.write(".patchbook/blocks/guide.md.entries", entry(`Use:\n${BLOCK}${BLOCK.trimEnd()}`));
    sh(["git", "add", "-A"], { cwd: fork.path });
    const commit = sh(["git", "commit", "-qm", "quote"], { cwd: fork.path, env: withHook(t), check: false });
    expect(commit.code).toBe(1);
    expect(commit.stderr).toContain(".patchbook/blocks/guide.md.entries");
  });

  caseTest("the hook records an edit inside the marker block upstream holds", (t) => {
    const fork = forkWith(t, { "doc.md": `intro\n${BLOCK}end\n` });
    fork.write("doc.md", `intro\n${BLOCK.replace("x", "X")}end\n`);
    sh(["git", "commit", "-qam", "edit inside"], { cwd: fork.path, env: { ...withHook(t), PATCHBOOK_INTENT: "Capitalize the example." } });
    expect(committedFiles(fork)).toContain(".patchbook/changes/capitalize-the-example/ours/doc.md.pb");
  });

  const syncedConflict = (t: Case) => {
    const fork = forkWith(t, { "doc.md": `intro\n${BLOCK}middle\nend\n` });
    fork.write("doc.md", "Intro\nmiddle\nEND-ours\n");
    sh(["git", "commit", "-qam", "drop the example"], { cwd: fork.path, env: { ...withHook(t), PATCHBOOK_INTENT: "Drop the example." } });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("doc.md", `intro\n${BLOCK}middle\nEND-theirs\n`);
    up.commit("reword the end");
    t.pb(["sync"], { cwd: fork.path });
    sh(["git", "add", "-A"], { cwd: fork.path });
    return fork;
  };

  caseTest("the hook refuses a synced conflict in a copy whose base holds upstream's marker block", (t) => {
    const fork = syncedConflict(t);
    const copy = ".patchbook/changes/drop-the-example/ours/doc.md.pb";
    const head = sh(["git", "rev-parse", "HEAD"], { cwd: fork.path }).stdout;
    const before = tree(fork.path);
    const commit = sh(["git", "commit", "-qm", "Sync upstream"], { cwd: fork.path, env: withHook(t), check: false });
    expect(commit.code).toBe(1);
    expect(commit.stderr).toContain(`  ${copy}\n`);
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: fork.path }).stdout).toBe(head);
    expect(tree(fork.path)).toEqual(before);
    fork.write(copy, "Intro\nmiddle\nEND-both\n");
    sh(["git", "commit", "-qam", "Resolve upstream conflict"], { cwd: fork.path, env: withHook(t) });
    expect(committedFiles(fork)).toContain(copy);
    expect(fork.read("doc.md")).toBe("Intro\nmiddle\nEND-both\n");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
  });

  caseTest("the hook refuses a synced conflict when HEAD's upstream.lock is a link", (t) => {
    const fork = forkWith(t, { "doc.md": `intro\n${BLOCK}middle\nend\n` });
    fork.write("doc.md", "Intro\nmiddle\nEND-ours\n");
    sh(["git", "commit", "-qam", "drop the example"], { cwd: fork.path, env: { ...withHook(t), PATCHBOOK_INTENT: "Drop the example." } });
    const lock = join(fork.path, ".patchbook/upstream.lock");
    renameSync(lock, join(fork.path, ".patchbook/pin.lock"));
    symlinkSync("pin.lock", lock);
    sh(["git", "add", "-A"], { cwd: fork.path });
    sh(["git", "commit", "-qm", "link the lock"], { cwd: fork.path, env: t.env });
    expect(sh(["git", "ls-tree", "HEAD", "--", ".patchbook/upstream.lock"], { cwd: fork.path }).stdout).toMatch(/^120000 /);
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("doc.md", `intro\n${BLOCK}middle\nEND-theirs\n`);
    up.commit("reword the end");
    rmSync(lock);
    copyFileSync(join(fork.path, ".patchbook/pin.lock"), lock);
    t.pb(["sync"], { cwd: fork.path });
    sh(["git", "add", "-u"], { cwd: fork.path });
    const before = tree(fork.path);
    const commit = sh(["git", "commit", "-qm", "Sync upstream"], { cwd: fork.path, env: withHook(t), check: false });
    expect(commit.code).toBe(1);
    expect(commit.stderr).toContain("  .patchbook/changes/drop-the-example/ours/doc.md.pb\n");
    expect(tree(fork.path)).toEqual(before);
  });

  caseTest("status lists a synced conflict when HEAD's upstream.lock is not valid UTF-8", (t) => {
    const fork = forkWith(t, { "doc.md": `intro\n${BLOCK}middle\nend\n` });
    fork.write("doc.md", "Intro\nmiddle\nEND-ours\n");
    sh(["git", "commit", "-qam", "drop the example"], { cwd: fork.path, env: { ...withHook(t), PATCHBOOK_INTENT: "Drop the example." } });
    const lock = join(fork.path, ".patchbook/upstream.lock");
    const valid = readFileSync(lock);
    writeFileSync(lock, Buffer.from([0xff, 0xfe, 0x20, 0x6a, 0x75, 0x6e, 0x6b, 0x0a]));
    sh(["git", "add", "-A"], { cwd: fork.path });
    sh(["git", "commit", "-qm", "corrupt the lock"], { cwd: fork.path, env: t.env });
    writeFileSync(lock, valid);
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("doc.md", `intro\n${BLOCK}middle\nEND-theirs\n`);
    up.commit("reword the end");
    t.pb(["sync"], { cwd: fork.path });
    const status = t.pb(["status"], { cwd: fork.path, code: 1 });
    expect(status.stderr + status.stdout).toContain("conflict");
    expect(status.stderr + status.stdout).not.toContain("TypeError");
    expect(status.stderr + status.stdout).not.toMatch(/\n\s+at /);
  });

  caseTest("the hook records an edit inside upstream's marker block in a copy whose sync conflict was committed", (t) => {
    const fork = forkWith(t, { "doc.md": `intro\n${BLOCK}middle\nend\n` });
    fork.write("doc.md", `Intro\n${BLOCK}middle\nEND-ours\n`);
    sh(["git", "commit", "-qam", "reword the end"], { cwd: fork.path, env: { ...withHook(t), PATCHBOOK_INTENT: "Reword the end." } });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("doc.md", `intro\n${BLOCK}middle\nEND-theirs\n`);
    up.commit("reword the end");
    t.pb(["sync"], { cwd: fork.path });
    sh(["git", "add", "-A"], { cwd: fork.path });
    const sync = sh(["git", "commit", "-qm", "Sync upstream"], { cwd: fork.path, env: withHook(t), check: false });
    expect(sync.code).toBe(1);
    expect(sync.stderr).toContain("  .patchbook/changes/reword-the-end/ours/doc.md.pb\n");
    fork.write(".patchbook/changes/reword-the-end/ours/doc.md.pb", `Intro\n${BLOCK}middle\nEND-both\n`);
    sh(["git", "commit", "-qam", "Resolve upstream conflict"], { cwd: fork.path, env: withHook(t) });
    fork.write("doc.md", `Intro\n${BLOCK.replace("x", "X")}middle\nEND-both\n`);
    sh(["git", "commit", "-qam", "edit inside"], { cwd: fork.path, env: withHook(t) });
    expect(committedFiles(fork)).toContain(".patchbook/changes/reword-the-end/ours/doc.md.pb");
    expect(fork.read(".patchbook/changes/reword-the-end/ours/doc.md.pb")).toBe(`Intro\n${BLOCK.replace("x", "X")}middle\nEND-both\n`);
  });

  for (const report of ["deleted", "unreadable"] as const) {
    caseTest(`the hook counts marker lines in a synced copy when last-sync.json is ${report}`, (t) => {
      const fork = syncedConflict(t);
      if (report === "deleted") rmSync(join(fork.path, ".patchbook/last-sync.json"));
      else fork.write(".patchbook/last-sync.json", "not json\n");
      sh(["git", "commit", "-qm", "Sync upstream"], { cwd: fork.path, env: withHook(t) });
      expect(committedFiles(fork)).toContain(".patchbook/changes/drop-the-example/ours/doc.md.pb");
    });
  }

  caseTest("the hook names the staged file when a recorded paragraph gains the markers another paragraph lost", (t) => {
    const fork = forkWith(t, { "guide.md": `Alpha.\n${BLOCK}\nMiddle.\n\nBeta.\n` });
    fork.write(".patchbook/blocks/guide.md.entries", "");
    sh(["git", "add", "-A"], { cwd: fork.path });
    sh(["git", "commit", "-qm", "start block entries"], { cwd: fork.path, env: t.env });
    fork.write("guide.md", "Alpha.\n\nMiddle.\n\nBeta.\n<<<<<<< mine\nq\n=======\nr\n>>>>>>> theirs\n");
    const before = tree(fork.path);
    const commit = sh(["git", "commit", "-qam", "move the example"], { cwd: fork.path, env: { ...withHook(t), PATCHBOOK_INTENT: "Move the example." }, check: false });
    expect(commit.code).toBe(1);
    expect(commit.stderr).toContain("  guide.md\n");
    expect(commit.stderr).not.toContain("guide.md.entries");
    expect(tree(fork.path)).toEqual(before);
  });

  forkTest("a conflicted change copy named series is not the series list", (t) => {
    t.fork.write("series", "ours\n");
    t.pb(["record", "feature", "--intent", "Add a series file."], { cwd: t.fork.path });
    t.fork.commit("record");
    const path = ".patchbook/changes/feature/ours/series.pb";
    t.fork.write(path, "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> upstream\n");
    sh(["git", "add", path], { cwd: t.fork.path });
    const commit = sh(["git", "commit", "-qm", "conflicted series file"], { cwd: t.fork.path, env: withHook(t), check: false });
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain(path);
    expect(commit.stderr).not.toContain("keep both sides' change names");
  });

  for (const conflict of [false, true]) {
    forkTest(`the hook ${conflict ? "refuses" : "allows"} an off-series change ${conflict ? "with" : "without"} markers`, (t) => {
      t.recordFeature();
      t.fork.write(".patchbook/series", "");
      if (conflict) t.fork.write(".patchbook/changes/feature/ours/app.txt.pb", "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> upstream\n");
      sh(["git", "add", "-A"], { cwd: t.fork.path });
      const head = sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout;
      const index = sh(["git", "write-tree"], { cwd: t.fork.path }).stdout;
      const before = tree(t.fork.path);
      const commit = sh(["git", "commit", "-qm", "off-series change"], { cwd: t.fork.path, env: withHook(t), check: false });
      expect(commit.code).toBe(conflict ? 1 : 0);
      if (conflict) {
        expect(commit.stderr).toContain(".patchbook/changes/feature/ours/app.txt.pb");
        expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).toBe(head);
        expect(sh(["git", "write-tree"], { cwd: t.fork.path }).stdout).toBe(index);
        expect(tree(t.fork.path)).toEqual(before);
      }
    });
  }

  forkTest("sync names a file edit whose base copy is missing, changes nothing, and works again once they are back", (t) => {
    t.recordFeature();
    const book = join(t.fork.path, ".patchbook");
    const copy = join(book, "changes/feature/base/app.txt.pb");
    const saved = read(copy);
    rmSync(copy);
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
    t.up.commit("upstream edit");
    const before = snapshot(book);
    const failed = t.pb(["sync"], { cwd: t.fork.path, code: 1 });
    expect(failed.stderr).toContain("patchbook: can't sync upstream: change feature has no base copy of app.txt (.patchbook/changes/feature/base/app.txt.pb). ");
    expect(failed.stderr).toContain("Nothing was changed.");
    expect(failed.stderr).not.toContain("    at ");
    expect(snapshot(book)).toEqual(before);
    writeFileSync(copy, saved);
    t.pb(["sync"], { cwd: t.fork.path });
    expect(reportOf(t.fork.path).merged.map((m) => m.path)).toEqual(["app.txt"]);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("sync names both copies of a file edit when its base and ours copies are missing", (t) => {
    t.recordFeature();
    const book = join(t.fork.path, ".patchbook");
    const [base, ours] = ["base", "ours"].map((side) => join(book, `changes/feature/${side}/app.txt.pb`));
    const saved = [read(base!), read(ours!)];
    rmSync(base!);
    rmSync(ours!);
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
    t.up.commit("upstream edit");
    const before = snapshot(book);
    const failed = t.pb(["sync"], { cwd: t.fork.path, code: 1 });
    expect(failed.stderr).toContain("change feature has no base copy of app.txt (.patchbook/changes/feature/base/app.txt.pb) and no ours copy of app.txt (.patchbook/changes/feature/ours/app.txt.pb). ");
    expect(snapshot(book)).toEqual(before);
    writeFileSync(base!, saved[0]!);
    writeFileSync(ours!, saved[1]!);
    t.pb(["sync"], { cwd: t.fork.path });
    expect(reportOf(t.fork.path).merged.map((m) => m.path)).toEqual(["app.txt"]);
  });

  forkTest("sync reports an edited file upstream deleted as gone, with the file it moved to", (t) => {
    t.recordFeature();
    t.up.rm("app.txt");
    t.up.write("src/app.txt", "moved\n");
    t.up.commit("move");
    t.pb(["sync"], { cwd: t.fork.path });
    const report = reportOf(t.fork.path);
    expect(report.gone[0]!.maybe[0]).toBe("src/app.txt");
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain("gone");
  });

  forkTest("a gone file suggests the three added paths with the most similar names in found order on a tie", (t) => {
    t.recordFeature();
    t.up.rm("app.txt");
    for (const p of ["app.md", "app.txt.bak", "readme", "src/app.txt", "zzz.bin"]) t.up.write(p, "new\n");
    t.up.commit("move");
    t.pb(["sync"], { cwd: t.fork.path });
    // Against app.txt, app.txt.bak and src/app.txt score 2 * 7 / 18 = 0.78, app.md 2 * 4 / 13 = 0.62, readme 2 / 13 and zzz.bin 2 / 14.
    expect(reportOf(t.fork.path).gone).toEqual([{ change: "feature", path: "app.txt", maybe: ["app.txt.bak", "src/app.txt", "app.md"] }]);
  });

  forkTest("a lock from before it had a version is refused by every command that reads it", (t) => {
    const path = join(t.fork.path, ".patchbook/upstream.lock");
    const old = `{\n  "upstream": {\n    "commit": "${"a".repeat(40)}",\n    "tree": "${"b".repeat(40)}"\n  }\n}\n`;
    writeFileSync(path, old);
    for (const args of [["status"], ["status", "--json"], ["check"], ["sync"], ["build"]]) {
      const { stderr } = t.pb(args, { cwd: t.fork.path, code: 1 });
      expect(stderr).toContain("patchbook: .patchbook/upstream.lock has no version, so an older patchbook wrote it. ");
    }
    expect(read(path)).toBe(old);
  });

  forkTest("check prints a versioned document", (t) => {
    const pinned = lockPin(t.fork.read(".patchbook/upstream.lock"), "upstream").commit;
    const document = (moved: boolean, head: string, files: string): string => [
      "{",
      '  "version": 2,',
      `  "moved": ${moved},`,
      '  "upstreams": [',
      "    {",
      '      "name": "upstream",',
      `      "pinned": "${pinned}",`,
      `      "head": "${head}",`,
      `      "moved": ${moved},`,
      `      "files": ${files}`,
      "    }",
      "  ]",
      "}",
      "",
    ].join("\n");
    expect(t.pb(["check"], { cwd: t.fork.path }).stdout).toBe(document(false, pinned, "[]"));
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
    const head = t.up.commit("upstream edit");
    expect(t.pb(["check"], { cwd: t.fork.path, code: 10 }).stdout).toBe(document(true, head, '[\n        "changed app.txt"\n      ]'));
  });

  forkTest("sync writes a versioned report", (t) => {
    t.recordFeature();
    const from = lockPin(t.fork.read(".patchbook/upstream.lock"), "upstream").commit;
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
    const to = t.up.commit("upstream edit");
    t.pb(["sync"], { cwd: t.fork.path });
    expect(t.fork.read(".patchbook/last-sync.json")).toBe([
      "{",
      '  "version": 2,',
      '  "upstreams": [',
      "    {",
      '      "name": "upstream",',
      `      "from": "${from}",`,
      `      "to": "${to}",`,
      '      "upstream": [',
      '        "changed app.txt"',
      "      ],",
      '      "merged": [',
      "        {",
      '          "change": "feature",',
      '          "path": "app.txt"',
      "        }",
      "      ],",
      '      "conflicts": [],',
      '      "gone": [],',
      '      "replacedUpstreamChanged": []',
      "    }",
      "  ]",
      "}",
      "",
    ].join("\n"));
  });

  forkTest("status --json prints a versioned document", (t) => {
    const pin = lockPin(t.fork.read(".patchbook/upstream.lock"), "upstream");
    expect(t.pb(["status", "--json"], { cwd: t.fork.path }).stdout).toBe([
      "{",
      '  "version": 2,',
      '  "upstreams": [',
      "    {",
      '      "name": "upstream",',
      `      "commit": "${pin.commit}",`,
      `      "tree": "${pin.tree}"`,
      "    }",
      "  ],",
      '  "applied": 0,',
      '  "problems": [],',
      '  "lastSync": null',
      "}",
      "",
    ].join("\n"));
    t.recordFeature();
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("two", "deux"));
    t.up.commit("conflicting edit");
    t.pb(["sync"], { cwd: t.fork.path });
    const status = JSON.parse(t.pb(["status", "--json"], { cwd: t.fork.path, code: 1 }).stdout);
    expect(Object.keys(status)).toEqual(["version", "upstreams", "applied", "problems", "lastSync"]);
    expect(Object.keys(status.upstreams[0])).toEqual(["name", "commit", "tree"]);
    expect(status.problems.map((p: { problem: string }) => p.problem)).toEqual(["conflict", "conflict"]);
    expect(status.lastSync).toEqual(syncedAt(t.fork.path));
    expect(status.lastSync.upstreams[0].conflicts).toEqual([{ change: "feature", path: "app.txt", count: 1 }]);
  });

  forkTest("check and last sync list upstreams in config order", (t) => {
    const names = ["up", "2"];
    const pinned = lockPin(t.fork.read(".patchbook/upstream.lock"), "upstream").commit;
    const heads: string[] = [];
    const starts: string[] = [];
    for (const name of names) {
      const repo = new Repo(join(t.tmp, `up-${name}`));
      repo.write("a.txt", "a\n");
      starts.push(repo.commit("start"));
      t.pb(["track", name, repo.path, "--mount", `m-${name}`], { cwd: t.fork.path });
      repo.write("a.txt", "b\n");
      heads.push(repo.commit("move"));
    }
    const entry = (name: string, from: string, head: string, files: string): string => [
      "    {",
      `      "name": "${name}",`,
      `      "pinned": "${from}",`,
      `      "head": "${head}",`,
      `      "moved": ${files !== "[]"},`,
      `      "files": ${files}`,
      "    }",
    ].join("\n");
    const changed = (name: string): string => `[\n        "changed m-${name}/a.txt"\n      ]`;
    expect(t.pb(["check"], { cwd: t.fork.path, code: 10 }).stdout).toBe([
      "{",
      '  "version": 2,',
      '  "moved": true,',
      '  "upstreams": [',
      [entry("upstream", pinned, pinned, "[]"), entry("up", starts[0]!, heads[0]!, changed("up")), entry("2", starts[1]!, heads[1]!, changed("2"))].join(",\n"),
      "  ]",
      "}",
      "",
    ].join("\n"));
    t.pb(["sync"], { cwd: t.fork.path });
    expect(syncedAt(t.fork.path).upstreams.map((r) => r.name)).toEqual(names);
  });

  for (const [what, version, says] of [
    ["before versions", undefined, "has no version, so an older patchbook wrote it."],
    ["the first version", 1, "is version 1, and this patchbook reads version 2."],
  ] as const) {
    forkTest(`a last-sync.json from ${what} is refused by every command that reads it`, (t) => {
      t.recordFeature();
      t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
      t.up.commit("upstream edit");
      t.pb(["sync"], { cwd: t.fork.path });
      const path = join(t.fork.path, ".patchbook/last-sync.json");
      const { upstreams } = syncedAt(t.fork.path);
      writeFileSync(path, JSON.stringify({ version, upstreams: Object.fromEntries(upstreams.map(({ name, ...r }) => [name, r])) }, null, 2) + "\n");
      t.up.write("app.txt", t.up.read("app.txt").replaceAll("five", "FIVE"));
      t.up.commit("second edit");
      const before = tree(t.fork.path);
      for (const args of [["status", "--json"], ["sync"], ["upstream", "upstream", "--diff"]]) {
        const { stderr } = t.pb(args, { cwd: t.fork.path, code: 1 });
        expect(stderr).toContain(`patchbook: .patchbook/last-sync.json ${says} It only reports past syncs: delete it, and the next patchbook sync writes a new one.\n`);
      }
      expect(tree(t.fork.path)).toEqual(before);
    });
  }

  forkTest("status and upstream since do not read last-sync.json", (t) => {
    writeFileSync(join(t.fork.path, ".patchbook/last-sync.json"), "{ not json");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    const pinned = t.pb(["upstream", "upstream"], { cwd: t.fork.path }).stdout;
    expect(pinned).toContain("app.txt");
    t.pb(["upstream", "upstream", "--since", sh(["git", "rev-parse", "HEAD"], { cwd: t.up.path }).stdout.trim()], { cwd: t.fork.path });
  });

  forkTest("upstream refuses options it cannot apply together and writes nothing", (t) => {
    const out = join(t.tmp, "out");
    const head = sh(["git", "rev-parse", "HEAD"], { cwd: t.up.path }).stdout.trim();
    for (const [args, problem] of [
      [["--diff", "--export", out], "--export can't go with --diff"],
      [["app.txt", "--export", out], "--export can't go with <path>"],
      [["--since", head, "--diff"], "--diff can't go with --since"],
    ] as const) {
      const r = t.pb(["upstream", "upstream", ...args], { cwd: t.fork.path, code: 2 });
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(`patchbook upstream: ${problem}\nRun \`patchbook upstream --help\` for its arguments and options.\n`);
    }
    expect(existsSync(out)).toBe(false);
  });

  describe("a json placeholder file", () => {
    const useJson = (t: VendorCase, json: string): string => {
      const entries = t.missingScaffoldPatchBuild();
      const config = join(t.repo.path, ".patchbook/config.toml");
      writeFileSync(config, read(config) + '\n[placeholders.str]\nfile = ".patchbook/strings.json"\nformat = "json"\n');
      t.repo.write(".patchbook/strings.json", json);
      writeFileSync(entries, read(entries).replaceAll("{{snippet:greet}}", "{{str:greet}} {{str:tools}}"));
      return entries;
    };

    vendorTest("a JSON placeholder file fills a string and a list of strings", (t) => {
      useJson(t, '{"_note": 5, "greet": "Say hello in T3.", "tools": ["a", "b"]}');
      t.pb(["build"], { cwd: t.repo.path });
      expect(t.repo.read("skills/hello/SKILL.md")).toContain("Say hello in T3. a, b\n");
      expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
    });

    vendorTest("a JSON placeholder file that holds a boolean is refused naming the key", (t) => {
      useJson(t, '{"greet": "Say hello in T3.", "tools": true}');
      const before = tree(t.repo.path);
      const { stderr } = t.pb(["build"], { cwd: t.repo.path, code: 1 });
      expect(stderr).toBe('patchbook: .patchbook/strings.json: "tools" must be a string or a list of strings, not true.\n');
      expect(tree(t.repo.path)).toEqual(before);
    });
  });

  vendorTest("status --json prints the nearest similarity as a number", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.commit("built");
    const skill = "plugin/skills/hello/SKILL.md";
    t.up.write(skill, t.up.read(skill).replaceAll("say hello", "say hi"));
    t.up.commit("reword");
    t.pb(["sync"], { cwd: t.repo.path });
    const out = t.pb(["status", "--json"], { cwd: t.repo.path, code: 1 }).stdout;
    const orphan = JSON.parse(out).problems.find((p: { problem: string }) => p.problem === "orphan");
    const first: Nearest = { line: 7, hash: orphan.nearest[0].hash, similarity: 0.9 };
    expect(orphan.nearest[0]).toEqual(first);
    expect(out).toContain('"similarity": 0.9\n');
    expect(t.pb(["status"], { cwd: t.repo.path, code: 1 }).stdout).toContain(`nearest new blocks: line 7 [${orphan.nearest[0].hash}] 90%\n`);
  });

  vendorTest("a check hook may return an orphan problem", (t) => {
    writeFileSync(join(t.repo.path, ".patchbook/hooks.ts"), dedent(`
      export function check() {
        return [{
          problem: "orphan", file: "skills/hello/SKILL.md", hash: "abc", kind: "keep", rules: "", intent: "Keep it.",
          upstream: "u", patched: "u", nearest: [{ line: 1, hash: "h", similarity: 0.5 }],
        }];
      }
    `));
    expect(t.pb(["status"], { cwd: t.repo.path, code: 1 }).stdout).toContain("nearest new blocks: line 1 [h] 50%\n");
    const out = t.pb(["status", "--json"], { cwd: t.repo.path, code: 1 }).stdout;
    const orphan = JSON.parse(out).problems.find((p: { hash: string }) => p.hash === "abc");
    expect(orphan.nearest).toEqual([{ line: 1, hash: "h", similarity: 0.5 }]);
  });

  forkTest("record writes the name and intent", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    const out = t.pb(["record"], { cwd: t.fork.path });
    expect(out.stdout).toContain("shout: Shout the second line.");
    const change = read(join(t.fork.path, ".patchbook/changes/shout/CHANGE.md"));
    expect(change).toContain("intent: Shout the second line.");
    expect(change).toContain("- file app.txt");
    expect(read(join(t.tmp, "prompt.txt"))).toContain("+TWO");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("three", "THREE"));
    t.pb(["record"], { cwd: t.fork.path });
    expect(read(join(t.fork.path, ".patchbook/changes/shout/CHANGE.md")).split("intent:").length - 1).toBe(1);
    expect(t.pb(["show", "shout"], { cwd: t.fork.path }).stdout).toContain("THREE");
    unlinkSync(join(t.tmp, "prompt.txt"));
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("one", "ONE"));
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe("file     app.txt (in shout)\nintent   shout: Shout the second line.\n");
    expect(read(join(t.tmp, "prompt.txt"))).toContain("+ONE\n+TWO\n+THREE\n");
  });

  forkTest("show and the model prompt split lines where git diff does", (t) => {
    const before = "form\ffeed\nlone\rreturn\nline\u2028separator\ncrlf\r\nlast\n";
    const after = before.replace("return", "RETURN");
    writeFileSync(join(t.up.path, "lines.txt"), before);
    t.up.commit("add lines.txt");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    writeFileSync(join(t.fork.path, "lines.txt"), after);
    t.pb(["record"], { cwd: t.fork.path });
    writeFileSync(join(t.tmp, "before.txt"), before);
    writeFileSync(join(t.tmp, "after.txt"), after);
    const files = [join(t.tmp, "before.txt"), join(t.tmp, "after.txt")];
    const git = sh(["git", "diff", "--no-index", "--no-color", ...files], { cwd: t.fork.path, check: false }).stdout;
    const hunk = git.slice(git.indexOf("@@"));
    expect(hunk).toBe("@@ -1,5 +1,5 @@\n form\ffeed\n-lone\rreturn\n+lone\rRETURN\n line\u2028separator\n crlf\r\n last\n");
    const shown = t.pb(["show", "shout"], { cwd: t.fork.path }).stdout;
    expect(shown.slice(shown.indexOf("@@"))).toBe(hunk);
    expect(read(join(t.tmp, "prompt.txt"))).toContain(`+++ disk/lines.txt\n${hunk}`);
  });

  forkTest("show and the model prompt mark a last line with no newline as git diff does", (t) => {
    const gitHunks = (before: string | null, after: string): string => {
      writeFileSync(join(t.tmp, "after.txt"), after);
      if (before !== null) writeFileSync(join(t.tmp, "before.txt"), before);
      const from = before === null ? "/dev/null" : join(t.tmp, "before.txt");
      const out = sh(["git", "diff", "--no-index", "--no-color", "-U3", from, join(t.tmp, "after.txt")], { cwd: t.fork.path, check: false }).stdout;
      return out.slice(out.indexOf("@@"));
    };
    const tail = "one\ntwo\nthree\nfour\nlast line, no newline";
    const middle = "one\ntwo\nthree\nfour\nfive\nlast";
    writeFileSync(join(t.up.path, "tail.txt"), tail);
    writeFileSync(join(t.up.path, "middle.txt"), middle);
    t.up.commit("add files with no final newline");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    const edits = { tail: tail.replace("no newline", "edited, no newline"), middle: middle.replace("four", "FOUR"), added: "new\nfile" };
    writeFileSync(join(t.fork.path, "tail.txt"), edits.tail);
    writeFileSync(join(t.fork.path, "middle.txt"), edits.middle);
    writeFileSync(join(t.fork.path, "added.txt"), edits.added);
    t.pb(["record"], { cwd: t.fork.path });

    const hunks = { tail: gitHunks(tail, edits.tail), middle: gitHunks(middle, edits.middle), added: gitHunks(null, edits.added) };
    expect(hunks.tail).toBe("@@ -2,4 +2,4 @@ one\n two\n three\n four\n-last line, no newline\n\\ No newline at end of file\n+last line, edited, no newline\n\\ No newline at end of file\n");
    expect(hunks.middle).toBe("@@ -1,6 +1,6 @@\n one\n two\n three\n-four\n+FOUR\n five\n last\n\\ No newline at end of file\n");
    expect(hunks.added).toBe("@@ -0,0 +1,2 @@\n+new\n+file\n\\ No newline at end of file\n");
    const shown = t.pb(["show", "shout"], { cwd: t.fork.path }).stdout;
    expect(shown).toContain(`--- upstream/tail.txt\n+++ ours/tail.txt\n${hunks.tail}`);
    expect(shown).toContain(`--- upstream/middle.txt\n+++ ours/middle.txt\n${hunks.middle}`);
    const prompt = read(join(t.tmp, "prompt.txt"));
    expect(prompt).toContain(`--- built/tail.txt\n+++ disk/tail.txt\n${hunks.tail}`);
    expect(prompt).toContain(`--- built/middle.txt\n+++ disk/middle.txt\n${hunks.middle}`);
    expect(prompt).toContain(`--- /dev/null\n+++ disk/added.txt\n${hunks.added}`);
  });

  forkTest("show says when a change has no intent yet", (t) => {
    mkdirSync(join(t.fork.path, ".patchbook/changes/noted"), { recursive: true });
    writeFileSync(join(t.fork.path, ".patchbook/changes/noted/CHANGE.md"), "# noted\n\nintent:\n\nedits:\n");
    appendFileSync(join(t.fork.path, ".patchbook/series"), "noted\n");
    const shown = t.pb(["show", "noted"], { cwd: t.fork.path }).stdout;
    expect(shown).toStartWith("noted: (no intent yet)\n");
    expect(shown).not.toContain("None");
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain("it has no intent");
  });

  forkTest("record keeps a given intent when no name is given", (t) => {
    const prompt = join(t.tmp, "prompt.txt");
    const intent = "Make the second line loud so it stands out.";
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    const out = t.pb(["record", "--intent", intent], { cwd: t.fork.path });
    expect(existsSync(prompt)).toBe(false);
    expect(out.stdout).toContain(`make-the-second-line: ${intent}`);
    const change = join(t.fork.path, ".patchbook/changes/make-the-second-line/CHANGE.md");
    expect(read(change)).toContain(`intent: ${intent}`);
    t.fork.write("extra.txt", "ours\n");
    t.pb(["record", "--intent", "Make the second line of the new file ours."], { cwd: t.fork.path });
    expect(existsSync(prompt)).toBe(false);
    expect(read(join(t.fork.path, ".patchbook/changes/make-the-second-line-2/CHANGE.md"))).toContain("- add extra.txt");
    expect(read(change)).toContain(`intent: ${intent}`);
  });

  forkTest("commit with an intent does not need the model", (t) => {
    writeFileSync(join(t.tmp, "bin/claude"), "#!/bin/sh\nexit 1\n");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    const intent = "Make the second line loud.";
    sh(["git", "commit", "-qam", "shout"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: intent } });
    expect(read(join(t.fork.path, ".patchbook/changes/make-the-second-line/CHANGE.md"))).toContain(`intent: ${intent}`);
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout).toBe("");
  });

  const changeNames = (t: ForkCase): string[] => readdirSync(join(t.fork.path, ".patchbook/changes"));

  const unusableReplies: [string, string, string][] = [
    ["has no JSON object", "I could not decide.", "claude's reply isn't JSON: "],
    ["is not JSON", '{"change": null, "intents": }', "claude's reply isn't JSON: "],
    ["has a second object", '{"change": null, "intents": {"edit-app-txt": "x"}} {"y"}', "claude's reply isn't JSON: "],
    ["has no intents", '{"change": null}', "claude's reply: intents.edit-app-txt is missing.\n"],
    ["has a change that is not a string", '{"change": 1, "intents": {"edit-app-txt": "Shout."}}', "claude's reply: change must be a string, not 1.\n"],
    ["has an intent that is null", '{"change": null, "intents": {"edit-app-txt": null}}', "claude's reply: intents.edit-app-txt must be a string, not null.\n"],
    ["has no intent for the change", '{"change": null, "intents": {"other": "Shout."}}', "claude's reply: intents.edit-app-txt is missing.\n"],
    ["has a blank intent", '{"change": null, "intents": {"edit-app-txt": "  "}}', "claude's reply: intents.edit-app-txt is blank.\n"],
  ];
  for (const [what, reply, says] of unusableReplies) {
    forkTest(`intent refuses a model reply that ${what} says why and writes nothing`, (t) => {
      writeFileSync(join(t.tmp, "bin/claude"), `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${reply}'\n`, { mode: 0o755 });
      t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
      const name = /intent {3}by patchbook for (\S+) \(/.exec(t.pb(["record"], { cwd: t.fork.path }).stdout)![1]!;
      const before = tree(t.fork.path);
      const { stderr } = t.pb(["intent", name], { cwd: t.fork.path, code: 1 });
      expect(stderr.startsWith(`patchbook: claude didn't return a usable name and intent. ${says}`)).toBe(true);
      expect(stderr.endsWith(`${reply}\nPass a name and --intent instead.\n`)).toBe(true);
      expect(tree(t.fork.path)).toEqual(before);
    });
  }

  forkTest("record names a change from an intent with one very long word", (t) => {
    const intent = "a".repeat(300);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "--intent", intent], { cwd: t.fork.path });
    const names = changeNames(t);
    expect(names).toHaveLength(1);
    expect(Buffer.byteLength(names[0]!)).toBeLessThan(256);
    expect(read(join(t.fork.path, ".patchbook/changes", names[0]!, "CHANGE.md"))).toContain(`intent: ${intent}`);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("record names a change from an intent with several long words", (t) => {
    const intent = ["a", "b", "c", "d"].map((c) => c.repeat(64)).join(" ");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "--intent", intent], { cwd: t.fork.path });
    const names = changeNames(t);
    expect(names).toHaveLength(1);
    expect(Buffer.byteLength(names[0]!)).toBeLessThan(256);
    expect(read(join(t.fork.path, ".patchbook/changes", names[0]!, "CHANGE.md"))).toContain(`intent: ${intent}`);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("record names a change from the first four words of an intent", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "--intent", "One two three four five six."], { cwd: t.fork.path });
    expect(changeNames(t)).toEqual(["one-two-three-four"]);
  });

  const unlisted = (t: ForkCase, name: string): string => {
    const path = join(t.fork.path, ".patchbook/changes", name, "CHANGE.md");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `# ${name}\n\nintent: Old intent.\n\nedits:\n- add old.txt\n`);
    sh(["git", "add", path], { cwd: t.fork.path });
    return path;
  };

  forkTest("status reports every unlisted change entry without writing", (t) => {
    const dir = join(t.fork.path, ".patchbook/changes");
    mkdirSync(join(dir, "ours-only/ours"), { recursive: true });
    writeFileSync(join(dir, "ours-only/ours/app.txt.pb"), "saved copy\n");
    mkdirSync(join(dir, "empty-only"));
    writeFileSync(join(dir, "plain-file"), "saved file\n");
    mkdirSync(join(dir, "bad name"));
    const before = tree(t.fork.path);
    const folders = ["empty-only", "ours-only"];
    const others = ["plain-file"];
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout;
    for (const name of folders) expect(status).toContain(`change ${name} is not in the series`);
    for (const name of others) expect(status).toContain(`changes/${name}: not a change folder`);
    expect(status).toContain('"bad name" isn\'t a valid change name');
    const problems = JSON.parse(t.pb(["status", "--json"], { cwd: t.fork.path, code: 1 }).stdout).problems;
    expect(problems).toHaveLength(4);
    expect(tree(t.fork.path)).toEqual(before);
    expect(readdirSync(join(dir, "empty-only"))).toEqual([]);
    rmSync(join(dir, "bad name"), { recursive: true });
    t.fork.write("app.txt", "changed\n");
    const recording = tree(t.fork.path);
    for (const name of folders) {
      expect(t.pb(["record", name], { cwd: t.fork.path, code: 1 }).stderr).toContain(`change ${name} is not in the series`);
    }
    for (const name of others) {
      expect(t.pb(["record", name], { cwd: t.fork.path, code: 1 }).stderr).toContain(`changes/${name} is not a change folder`);
    }
    expect(tree(t.fork.path)).toEqual(recording);
  });

  const hookedCommit = (t: ForkCase, ...args: string[]) =>
    sh(["git", "commit", "-qm", "work", ...args], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Shout two." }, check: false });

  forkTest("an ignored dotfile and an empty bad-named folder leave record and a commit working while status reports them", (t) => {
    const dir = join(t.fork.path, ".patchbook/changes");
    mkdirSync(join(dir, "bad name"), { recursive: true });
    writeFileSync(join(dir, ".DS_Store"), "finder\n");
    appendFileSync(join(t.fork.path, ".git/info/exclude"), ".DS_Store\n");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "--intent", "Shout the second line."], { cwd: t.fork.path });
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    const commit = hookedCommit(t);
    expect(commit.stderr).not.toContain("wasn't rebuilt");
    expect(commit.stderr).not.toContain("refusing");
    expect(commit.code).toBe(0);
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout;
    expect(status).toContain('".DS_Store" isn\'t a valid change name');
    expect(status).toContain('"bad name" isn\'t a valid change name');
  });

  const strayShapes: [string, (dir: string) => void, string][] = [
    ["an ours-only folder", (dir) => {
      mkdirSync(join(dir, "ours-only/ours"), { recursive: true });
      writeFileSync(join(dir, "ours-only/ours/app.txt.pb"), "saved copy\n");
    }, "change ours-only is not in the series"],
    ["an empty folder", (dir) => mkdirSync(join(dir, "empty-only")), "change empty-only is not in the series"],
    ["a plain file", (dir) => writeFileSync(join(dir, "plain-file"), "saved file\n"), "changes/plain-file: not a change folder"],
  ];
  for (const [shape, make, message] of strayShapes) {
    forkTest(`build, skill install and a commit ignore ${shape} in changes while status reports it`, (t) => {
      const dir = join(t.fork.path, ".patchbook/changes");
      mkdirSync(dir, { recursive: true });
      make(dir);
      sh(["git", "add", "-A"], { cwd: t.fork.path });
      const built = t.pb(["build"], { cwd: t.fork.path });
      expect(built.stderr).not.toContain("nothing built");
      Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
      const installed = t.pb(["skill", "install"], { cwd: t.fork.path });
      expect(installed.stdout).toContain(`wrote ${SKILL_FILE}`);
      expect(installed.stderr).not.toContain("problems");
      delete t.env["PATCHBOOK_SKILL"];
      sh(["git", "add", "-A"], { cwd: t.fork.path });
      const first = hookedCommit(t);
      expect(first.code).toBe(0);
      t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("three", "THREE"));
      const commit = hookedCommit(t, "-a");
      expect(commit.code).toBe(0);
      expect(commit.stderr).not.toContain("wasn't rebuilt");
      expect(commit.stderr).not.toContain("refusing");
      const status = t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout;
      expect(status).toContain(message);
      expect(status).toContain("1 invalid");
    });
  }

  forkTest("status reports an unlisted change entry together with an unrecorded output edit", (t) => {
    const dir = join(t.fork.path, ".patchbook/changes");
    mkdirSync(join(dir, "ours-only/ours"), { recursive: true });
    writeFileSync(join(dir, "ours-only/ours/app.txt.pb"), "saved copy\n");
    writeFileSync(join(dir, "plain-file"), "saved file\n");
    t.fork.write("app.txt", "hand edited\n");
    const before = tree(t.fork.path);
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout;
    expect(status).toContain("change ours-only is not in the series");
    expect(status).toContain("changes/plain-file: not a change folder");
    expect(status).toContain("unrecorded app.txt:");
    expect(status).toContain("2 invalid, 1 unrecorded");
    const problems = JSON.parse(t.pb(["status", "--json"], { cwd: t.fork.path, code: 1 }).stdout).problems;
    expect(problems.map((p: { problem: string }) => p.problem)).toEqual(["invalid", "invalid", "unrecorded"]);
    expect(tree(t.fork.path)).toEqual(before);
  });

  forkTest("status and record refuse linked change entries without writing", (t) => {
    const dir = join(t.fork.path, ".patchbook/changes");
    mkdirSync(join(t.tmp, "outside"));
    writeFileSync(join(t.tmp, "outside-file"), "saved\n");
    t.fork.write("app.txt", "hand edited\n");
    for (const target of ["outside", "outside-file", "missing"]) {
      mkdirSync(dir, { recursive: true });
      symlinkSync(join(t.tmp, target), join(dir, "linked"));
      const before = tree(t.fork.path);
      for (const args of [["status"], ["status", "--json"], ["record", "linked"]]) {
        expect(t.pb(args, { cwd: t.fork.path, code: 1 }).stderr).toContain(".patchbook/changes/linked is a link");
      }
      expect(tree(t.fork.path)).toEqual(before);
      unlinkSync(join(dir, "linked"));
    }
    expect(read(join(t.tmp, "outside-file"))).toBe("saved\n");
    expect(readdirSync(join(t.tmp, "outside"))).toEqual([]);
  });

  forkTest("status reports unrecorded output edits and deletions until record", (t) => {
    t.fork.write("app.txt", "hand edited\n");
    t.fork.rm("docs/guide.md");
    const before = tree(t.fork.path);
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout;
    expect(status).toContain("unrecorded app.txt:");
    expect(status).toContain("unrecorded docs/guide.md:");
    expect(status).toContain("patchbook record");
    expect(status).not.toContain("behind the patchbook");
    expect(status).toContain("2 unrecorded");
    const json = JSON.parse(t.pb(["status", "--json"], { cwd: t.fork.path, code: 1 }).stdout);
    expect(json.version).toBe(2);
    expect(json.problems.map((p: { problem: string; file: string }) => [p.problem, p.file])).toEqual([
      ["unrecorded", "app.txt"], ["unrecorded", "docs/guide.md"],
    ]);
    expect(tree(t.fork.path)).toEqual(before);
    expect(t.pb(["build"], { cwd: t.fork.path, code: 1 }).stderr).toContain("changed since the last build");
    t.pb(["record", "edit-and-delete", "--intent", "Keep the edit and deletion."], { cwd: t.fork.path });
    expect(JSON.parse(t.pb(["status", "--json"], { cwd: t.fork.path }).stdout).problems).toEqual([]);
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("app.txt")).toBe("hand edited\n");
    expect(existsSync(join(t.fork.path, "docs/guide.md"))).toBe(false);
  });

  forkTest("record refuses a name whose folder is not in the series", (t) => {
    const path = unlisted(t, "ghost");
    const before = readFileSync(path);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    const out = t.pb(["record", "ghost", "--intent", "New intent."], { cwd: t.fork.path, code: 1 });
    expect(out.stderr).toContain("change ghost is not in the series");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(existsSync(join(t.fork.path, ".patchbook/series")) ? read(join(t.fork.path, ".patchbook/series")) : "").not.toContain("ghost");
    expect(t.pb(["record", "--intent", "New intent."], { cwd: t.fork.path }).stdout).toContain("new-intent: New intent.");
  });

  forkTest("record refuses the skill change name by hand when its folder is not in the series", (t) => {
    const path = unlisted(t, "patchbook-update-skill");
    const before = readFileSync(path);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    const out = t.pb(["record", "patchbook-update-skill", "--intent", "New intent."], { cwd: t.fork.path, code: 1 });
    expect(out.stderr).toContain("change patchbook-update-skill is not in the series");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(existsSync(join(t.fork.path, ".patchbook/series")) ? read(join(t.fork.path, ".patchbook/series")) : "").not.toContain("patchbook-update-skill");
  });

  forkTest("record refuses a name whose folder has no change file", (t) => {
    mkdirSync(join(t.fork.path, ".patchbook/changes/ghost"), { recursive: true });
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    const out = t.pb(["record", "ghost", "--intent", "New intent."], { cwd: t.fork.path, code: 1 });
    expect(out.stderr).toContain("change ghost is not in the series");
    expect(readdirSync(join(t.fork.path, ".patchbook/changes/ghost"))).toEqual([]);
  });

  forkTest("record refuses a name that is a plain file and says it is not a change folder", (t) => {
    const path = join(t.fork.path, ".patchbook/changes/ghost");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "KEEP ME\n");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    const out = t.pb(["record", "ghost", "--intent", "New intent."], { cwd: t.fork.path, code: 1 });
    expect(out.stderr).toContain(".patchbook/changes/ghost is not a change folder: move it out of .patchbook/changes");
    expect(out.stderr).not.toContain("add it to");
    expect(read(path)).toBe("KEEP ME\n");
  });

  forkTest("record tells how to keep a stray folder", (t) => {
    unlisted(t, "ghost");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    const out = t.pb(["record", "ghost", "--intent", "New intent."], { cwd: t.fork.path, code: 1 });
    expect(out.stderr).toContain(
      "change ghost is not in the series: add it to .patchbook/series to record into it, or move .patchbook/changes/ghost out of the way",
    );
  });

  for (const [what, folder] of [["no folder", null], ["only ours", "ours"]] as const) {
    forkTest(`record into a name the series lists with ${what} keeps the name`, (t) => {
      if (folder) mkdirSync(join(t.fork.path, ".patchbook/changes/ghost", folder), { recursive: true });
      writeFileSync(join(t.fork.path, ".patchbook/series"), "ghost\n");
      t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
      expect(t.pb(["record", "ghost"], { cwd: t.fork.path }).stdout).toContain("ghost: Shout the second line.");
      expect(read(join(t.fork.path, ".patchbook/series"))).toBe("ghost\n");
      expect(existsSync(join(t.fork.path, ".patchbook/changes/ghost-2"))).toBe(false);
      expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    });
  }

  forkTest("record writes patchbook's intent for a model reply whose intent is not a string", (t) => {
    const intents = ["null", "7", "true", '{"a": 1}', "[]"];
    for (const [i, intent] of intents.entries()) {
      t.fork.write(`extra${i}.txt`, "ours\n");
      writeFileSync(join(t.tmp, "bin/claude"), `#!/bin/sh\ncat > /dev/null\necho '{"change": "model-name", "intent": ${intent}}'\n`);
      const run = t.pb(["record"], { cwd: t.fork.path });
      expect(run.stdout).toContain(`intent   by patchbook for add-extra${i}-txt (claude didn't return a usable name and intent: claude's reply`);
    }
    expect(readdirSync(join(t.fork.path, ".patchbook/changes")).sort()).toEqual(intents.map((_, i) => `add-extra${i}-txt`));
    expect(read(join(t.fork.path, ".patchbook/series"))).not.toContain("model-name");
  });

  forkTest("record lets the model pick a name the series lists without a folder", (t) => {
    writeFileSync(join(t.tmp, "bin/claude"), `#!/bin/sh\ncat > /dev/null\necho '{"change": "ghost", "intent": "Ghost intent."}'\n`);
    writeFileSync(join(t.fork.path, ".patchbook/series"), "ghost\n");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toContain("ghost: Ghost intent.");
    expect(read(join(t.fork.path, ".patchbook/series"))).toBe("ghost\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("commit with an intent records into a name the series lists without a folder", (t) => {
    writeFileSync(join(t.fork.path, ".patchbook/series"), "make-the-second-line\n");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "commit", "-qam", "shout"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Make the second line loud." } });
    expect(read(join(t.fork.path, ".patchbook/changes/make-the-second-line/CHANGE.md"))).toContain("intent: Make the second line loud.");
    expect(changeNames(t)).toEqual(["make-the-second-line"]);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("record into a name the series lists does not call it missing from the series", (t) => {
    mkdirSync(join(t.fork.path, ".patchbook/changes/ghost"), { recursive: true });
    writeFileSync(join(t.fork.path, ".patchbook/series"), "ghost\n");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "ghost", "--intent", "New intent."], { cwd: t.fork.path });
    expect(read(join(t.fork.path, ".patchbook/changes/ghost/CHANGE.md"))).toContain("intent: New intent.");
    expect(read(join(t.fork.path, ".patchbook/series"))).toBe("ghost\n");
  });

  forkTest("record names a change from an intent around a folder that is not in the series", (t) => {
    const path = unlisted(t, "make-the-second-line");
    const before = readFileSync(path);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    const out = t.pb(["record", "--intent", "Make the second line loud."], { cwd: t.fork.path });
    expect(out.stdout).toContain("make-the-second-line-2: Make the second line loud.");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(read(join(t.fork.path, ".patchbook/changes/make-the-second-line-2/CHANGE.md"))).toContain("intent: Make the second line loud.");
    expect(read(join(t.fork.path, ".patchbook/series"))).toBe("make-the-second-line-2\n");
  });

  forkTest("commit with an intent names the change around a folder that is not in the series", (t) => {
    const path = unlisted(t, "make-the-second-line");
    const before = readFileSync(path);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "commit", "-qam", "shout"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Make the second line loud." } });
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(read(join(t.fork.path, ".patchbook/changes/make-the-second-line-2/CHANGE.md"))).toContain("intent: Make the second line loud.");
  });

  forkTest("record gives a model-chosen name a suffix when its folder is not in the series", (t) => {
    const path = unlisted(t, "shout");
    const before = readFileSync(path);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    const out = t.pb(["record"], { cwd: t.fork.path });
    expect(out.stdout).toContain("shout-2: Shout the second line.");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(read(join(t.fork.path, ".patchbook/changes/shout-2/CHANGE.md"))).toContain("intent: Shout the second line.");
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain("change shout is not in the series");
  });

  forkTest("commit with a blank intent asks the model", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "commit", "-qam", "shout"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "  \n\t " } });
    expect(read(join(t.fork.path, ".patchbook/changes/shout/CHANGE.md"))).toContain("intent: Shout the second line.");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("three", "THREE"));
    const commit = sh(["git", "commit", "-qam", "again"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(commit.stderr).not.toContain("wasn't rebuilt");
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout).toBe("");
  });

  forkTest("record keeps a multi-line intent as one line", (t) => {
    const intent = "Shout the second line.\nedits:\n- add ghost.txt";
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "--intent", intent], { cwd: t.fork.path });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.fork.write("extra.txt", "ours\n");
    t.pb(["record", "extra", "--intent", intent], { cwd: t.fork.path });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    expect(read(join(t.fork.path, ".patchbook/changes/extra/CHANGE.md")).match(/^edits:$/gm)).toHaveLength(1);
  });

  forkTest("record with an intent and no name keeps the intent of a change named unnamed", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("one", "ONE"));
    t.pb(["record", "unnamed", "--intent", "Shout the first line."], { cwd: t.fork.path });
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "--intent", "Shout the second line too."], { cwd: t.fork.path });
    expect(read(join(t.fork.path, ".patchbook/changes/unnamed/CHANGE.md"))).toContain("intent: Shout the first line.");
    expect(read(join(t.fork.path, ".patchbook/changes/unnamed/CHANGE.md"))).not.toContain("second line too");
  });

  const shoutOwnsAppWithEditPending = (t: ForkCase): void => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "shout", "--intent", "Shout the second line."], { cwd: t.fork.path });
    sh(["git", "add", "-A"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } });
    sh(["git", "commit", "-qm", "shout"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } });
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("one", "ONE"));
  };
  const SHOUT_KEPT = "# shout\n\nintent: Shout the second line.\n\nedits:\n- file app.txt\n";
  const NOT_USED = "intent   not used: the edits went to shout\n";
  const stale = (keys: string) => `intent   may be stale: ${keys} (the given intent is for the change being recorded). Edit them by hand to cover these edits\n`;

  forkTest("record with an intent and no name says the intent was not used when the edits go to an owner", (t) => {
    shoutOwnsAppWithEditPending(t);
    const out = t.pb(["record", "--intent", "Make it louder still."], { cwd: t.fork.path });
    expect(out.stdout).toBe(`file     app.txt (in shout)\n${NOT_USED}${stale("shout")}`);
    expect(changeText(t, "shout")).toBe(SHOUT_KEPT);
    expect(changeNames(t)).toEqual(["shout"]);
    expect(read(join(t.fork.path, ".patchbook/series"))).toBe("shout\n");
    expect(existsSync(join(t.tmp, "prompt.txt"))).toBe(false);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("record with an intent and a name that is not a change says the intent was not used when the edits go to an owner", (t) => {
    shoutOwnsAppWithEditPending(t);
    const out = t.pb(["record", "new", "--intent", "Make it louder still."], { cwd: t.fork.path });
    expect(out.stdout).toBe(`file     app.txt (in shout)\n${NOT_USED}${stale("shout")}`);
    expect(changeText(t, "shout")).toBe(SHOUT_KEPT);
    expect(changeNames(t)).toEqual(["shout"]);
    expect(read(join(t.fork.path, ".patchbook/series"))).toBe("shout\n");
  });

  forkTest("commit with an intent says the intent was not used when the edits go to an owner", (t) => {
    shoutOwnsAppWithEditPending(t);
    const commit = sh(["git", "commit", "-qam", "louder"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Make it louder still." } });
    expect(commit.stdout + commit.stderr).toContain(`file     app.txt (in shout)\n${NOT_USED}${stale("shout")}`);
    expect(changeText(t, "shout")).toBe(SHOUT_KEPT);
    expect(changeNames(t)).toEqual(["shout"]);
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout).toBe("");
  });

  forkTest("record with an intent names every owner the edits went to", (t) => {
    shoutOwnsAppWithEditPending(t);
    t.fork.write("docs/guide.md", "a louder guide\n");
    t.pb(["record", "guide", "--intent", "Reword the guide."], { cwd: t.fork.path });
    sh(["git", "add", "-A"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } });
    sh(["git", "commit", "-qm", "guide"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } });
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("three", "THREE"));
    t.fork.write("docs/guide.md", "a louder guide still\n");
    const out = t.pb(["record", "--intent", "Make it louder still."], { cwd: t.fork.path });
    expect(out.stdout).toBe(`file     app.txt (in shout)\nfile     docs/guide.md (in guide)\nintent   not used: the edits went to shout, guide\n${stale("shout, guide")}`);
  });

  forkTest("record with an intent uses it for a new file beside an owned edit", (t) => {
    shoutOwnsAppWithEditPending(t);
    t.fork.write("extra.txt", "ours\n");
    const out = t.pb(["record", "--intent", "Make it louder still."], { cwd: t.fork.path });
    expect(out.stdout).toBe(`make-it-louder-still: Make it louder still.\nfile     app.txt (in shout)\nadd      extra.txt\n${stale("shout")}`);
    expect(changeText(t, "shout")).toBe(SHOUT_KEPT);
    expect(changeText(t, "make-it-louder-still")).toContain("intent: Make it louder still.");
  });

  forkTest("record with an intent and the name of an existing change sets its intent and says only that the owner's may be stale", (t) => {
    t.fork.write("extra.txt", "ours\n");
    t.pb(["record", "ch", "--intent", "Add extra."], { cwd: t.fork.path });
    shoutOwnsAppWithEditPending(t);
    const out = t.pb(["record", "ch", "--intent", "Make it louder still."], { cwd: t.fork.path });
    expect(out.stdout).toBe(`file     app.txt (in shout)\n${stale("shout")}`);
    expect(changeText(t, "ch")).toBe("# ch\n\nintent: Make it louder still.\n\nedits:\n- add extra.txt\n");
    expect(changeText(t, "shout")).toBe(SHOUT_KEPT);
  });

  forkTest("record with an intent and the name of an emptied change sets its intent", (t) => {
    t.fork.write("extra.txt", "ours\n");
    t.pb(["record", "ch", "--intent", "Add extra."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.rm("extra.txt");
    t.pb(["record", "ch"], { cwd: t.fork.path });
    expect(changeText(t, "ch")).toBe("# ch\n\nintent: Add extra.\n\nedits:\n");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "shout", "--intent", "Shout the second line."], { cwd: t.fork.path });
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("one", "ONE"));
    const out = t.pb(["record", "ch", "--intent", "Make it louder still."], { cwd: t.fork.path });
    expect(out.stdout).toBe(`file     app.txt (in shout)\n${stale("shout")}`);
    expect(changeText(t, "ch")).toBe("# ch\n\nintent: Make it louder still.\n\nedits:\n");
    expect(changeText(t, "shout")).toBe(SHOUT_KEPT);
  });

  forkTest("record with no name does not default to a change named unnamed", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.fork.write("extra.txt", "ours\n");
    t.pb(["record", "unnamed", "--intent", "Shout and add extra.txt."], { cwd: t.fork.path });
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("three", "THREE"));
    t.fork.rm("extra.txt");
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe("file     app.txt (in unnamed)\nunadd    extra.txt (from unnamed)\nintent   unnamed: Shout the second line.\n");
    const prompt = read(join(t.tmp, "prompt.txt"));
    expect(prompt).toContain("app.txt: changed");
    expect(prompt).not.toContain("extra.txt: added");
    const change = read(join(t.fork.path, ".patchbook/changes/unnamed/CHANGE.md"));
    expect(change).toContain("- file app.txt");
    expect(change).not.toContain("- add extra.txt");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("record skips a file that a hook leaves out and was put back", (t) => {
    writeFileSync(join(t.fork.path, ".patchbook/hooks.ts"), dedent(`
      export const finish = (out: Map<string, { data: Uint8Array; mode: number }>) => {
        out.delete("docs/guide.md");
      };
    `));
    t.pb(["build"], { cwd: t.fork.path });
    expect(existsSync(join(t.fork.path, "docs/guide.md"))).toBe(false);
    t.fork.write("docs/guide.md", "a guide\n");
    expect(t.pb(["record", "--intent", "Keep the guide."], { cwd: t.fork.path }).stdout)
      .toBe("skipped  docs/guide.md: a hook leaves it out of the build; change the hook to keep it\n");
    expect(existsSync(join(t.fork.path, ".patchbook/changes/keep-the-guide"))).toBe(false);
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain("unrecorded docs/guide.md");
  });

  forkTest("record edits each of two outputs of one upstream file at its own path when both are edited", (t) => {
    mkdirSync(join(t.fork.path, ".patchbook/changes/twin"), { recursive: true });
    writeFileSync(join(t.fork.path, ".patchbook/changes/twin/CHANGE.md"), "# twin\n\nintent: Two guides.\n\nedits:\n- copy docs/guide.md -> docs/guide2.md\n");
    const series = join(t.fork.path, ".patchbook/series");
    writeFileSync(series, (existsSync(series) ? read(series) : "") + "twin\n");
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.write("docs/guide.md", "a guide!\n");
    t.fork.write("docs/guide2.md", "a second guide\n");
    expect(t.pb(["record", "--intent", "Shout."], { cwd: t.fork.path }).stdout).toBe("shout: Shout.\nfile     docs/guide.md\nfile     docs/guide2.md\n");
    expect(read(join(t.fork.path, ".patchbook/changes/shout/CHANGE.md"))).toContain("edits:\n- file docs/guide.md\n- file docs/guide2.md\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect([t.fork.read("docs/guide.md"), t.fork.read("docs/guide2.md")]).toEqual(["a guide!\n", "a second guide\n"]);
  });

  forkTest("record that cannot write a later edit puts back the edits it wrote before", (t) => {
    if (process.getuid?.() === 0) return;
    t.fork.write("aa.txt", "A\n");
    t.pb(["record", "aa", "--intent", "Aa."], { cwd: t.fork.path });
    t.fork.write("bb.txt", "B\n");
    t.pb(["record", "bb", "--intent", "Bb."], { cwd: t.fork.path });
    t.fork.write("aa.txt", "A2\n");
    t.fork.write("bb.txt", "B2\n");
    const bb = join(t.fork.path, ".patchbook/changes/bb/ours/bb.txt.pb");
    chmodSync(bb, 0o444);
    try {
      const r = t.pb(["record"], { cwd: t.fork.path, code: 1 });
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("permission denied");
      expect(read(join(t.fork.path, ".patchbook/changes/aa/ours/aa.txt.pb"))).toBe("A\n");
    } finally {
      chmodSync(bb, 0o644);
    }
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe("update   aa.txt (in aa)\nupdate   bb.txt (in bb)\nintent   aa: Shout the second line.\nintent   bb: Shout the second line.\n");
    expect(read(join(t.fork.path, ".patchbook/changes/aa/ours/aa.txt.pb"))).toBe("A2\n");
  });

  permissionTest("record that cannot write a later edit does not say it added a file no change records", (t) => {
    t.fork.write("bb.txt", "B\n");
    t.pb(["record", "bb", "--intent", "Bb."], { cwd: t.fork.path });
    t.fork.write("aa.txt", "new\n");
    t.fork.write("bb.txt", "B2\n");
    const bb = join(t.fork.path, ".patchbook/changes/bb/ours/bb.txt.pb");
    chmodSync(bb, 0o444);
    try {
      const r = t.pb(["record", "zz", "--intent", "Zz."], { cwd: t.fork.path, code: 1 });
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("permission denied");
    } finally {
      chmodSync(bb, 0o644);
    }
    expect(existsSync(join(t.fork.path, ".patchbook/changes/zz/CHANGE.md"))).toBe(false);
  }, ForkCase);

  forkTest("commit records the staged edit and builds", (t) => {
    expect(read(join(t.fork.path, ".git/hooks/pre-commit"))).toContain("Installed by patchbook");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "commit", "-qam", "shout"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout).toBe("");
    const files = words(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: t.fork.path }).stdout);
    expect(files).toContain("app.txt");
    expect(files).toContain(".patchbook/changes/shout/CHANGE.md");
    expect(files).toContain(".patchbook/build.lock");
    // A patchbook edit is built on commit too.
    const ours = join(t.fork.path, ".patchbook/changes/shout/ours/app.txt.pb");
    writeFileSync(ours, read(ours).replaceAll("TWO", "Two"));
    sh(["git", "commit", "-qam", "soften"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(t.fork.read("app.txt")).toContain("Two");
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout).toBe("");
  });

  const hookCommit = (t: ForkCase, args: string[], check = true) =>
    sh(["git", "commit", "-q", ...args], { cwd: t.fork.path, check, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
  const committed = (t: ForkCase): string[] => words(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: t.fork.path }).stdout);
  const porcelain = (t: ForkCase): string => sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout;

  forkTest("build and commit keep an upstream file with paragraphs and no entries byte for byte", (t) => {
    const text = "---\ntitle: notes\n---\n# Notes\n\nfirst paragraph\nstill first  \n\n\n\n```sh\necho one\n\necho two\n```\n \t\ncrlf line\r\n\r\n\nlast line, no newline";
    writeFileSync(join(t.up.path, "docs/notes.md"), text);
    t.up.commit("notes");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    expect(read(join(t.fork.path, "docs/notes.md"))).toBe(text);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "notes and shout"]);
    expect(sh(["git", "show", "HEAD:docs/notes.md"], { cwd: t.fork.path }).stdout).toBe(text);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    expect(porcelain(t)).toBe("");
  });

  forkTest("status flags a conflict marker in any output file", (t) => {
    t.up.write("docs/merge.md", "é\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n");
    t.up.write("docs/inline.md", "a <<<<<<< b and c >>>>>>> d\n");
    t.up.commit("markers");
    t.pb(["sync"], { cwd: t.fork.path });
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout;
    expect(status).toContain("conflict  docs/merge.md: conflict marker in the output\n");
    expect(status).not.toContain("docs/inline.md");
    expect(status).toContain("; 1 conflict\n");
  });

  forkTest("status flags the files a check or the block terms hook matches", (t) => {
    t.up.write("docs/cursor.md", "Open Cursor.\n\nThen wave.\n");
    t.up.write("docs/other.md", "Open Cursor too.\n");
    t.up.write("notes.txt", "Ask Claude.\n");
    t.up.commit("mentions");
    syncAndBuild(t);
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config) + dedent(`
      [[check]]
      name = "cursor"
      files = ["docs/*.md"]
      exclude = ["docs/other.md"]
      pattern = '\\bCursor\\b'
    `));
    writeFileSync(join(t.fork.path, ".patchbook/hooks.ts"), dedent(`
      export const blockTerms = (file: string, block: string) => (file === "notes.txt" && block.includes("Claude") ? ["Claude"] : []);
    `));
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout;
    expect(status.split("\n").filter((l) => l.startsWith("missing")).map((l) => l.replace(/ \[[0-9a-f]{12}\]/, ""))).toEqual([
      "missing   docs/cursor.md:1 needs an entry (Cursor)",
      "missing   notes.txt:1 needs an entry (Claude)",
    ]);
    expect(status).toContain("; 2 missing\n");
  });

  forkTest("commit records a paragraph edit and rebuilds from the entry it wrote", (t) => {
    t.up.write("greet.md", "Open Cursor.\n\nThen wave.\n");
    t.up.commit("greet");
    syncAndBuild(t);
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config) + dedent(`
      [[check]]
      name = "cursor"
      files = ["greet.md"]
      pattern = '\\bCursor\\b'
    `));
    t.pb(["scaffold"], { cwd: t.fork.path });
    const entries = join(t.fork.path, ".patchbook/blocks/greet.md.entries");
    const text = read(entries).replaceAll("rules: \nintent: \n", "rules: t3\nintent: Speak T3.\n");
    writeFileSync(entries, text.split("--- patched\n")[0]! + "--- patched\nOpen T3.\n");
    t.pb(["build"], { cwd: t.fork.path });
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "speak t3"]);
    t.fork.write("greet.md", "Open T3.\n\nThen wave twice.\n");
    sh(["git", "add", "greet.md"], { cwd: t.fork.path });
    expect(hookCommit(t, ["-m", "wave twice"]).stderr).toContain("entry    greet.md [");
    expect(sh(["git", "show", "HEAD:greet.md"], { cwd: t.fork.path }).stdout).toBe("Open T3.\n\nThen wave twice.\n");
    expect(sh(["git", "show", "HEAD:.patchbook/blocks/greet.md.entries"], { cwd: t.fork.path }).stdout).toContain("--- patched\nThen wave twice.\n");
    expect(t.fork.read("greet.md")).toBe("Open T3.\n\nThen wave twice.\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit records hand edits staged after a rebuild of a changed patchbook", (t) => {
    t.recordFeature();
    const ours = join(t.fork.path, ".patchbook/changes/feature/ours/app.txt.pb");
    writeFileSync(ours, read(ours).replaceAll("TWO", "Two"));
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("app.txt")).toContain("Two");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("three", "THREE"));
    t.fork.write("bin/run.sh", "#!/bin/sh\necho run fast\n", 0o755);
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    const commit = hookCommit(t, ["-m", "soften and speed up"]);
    expect(commit.stderr).toContain("file     app.txt (in feature)");
    expect(commit.stderr).toContain("file     bin/run.sh");
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toBe(t.fork.read("app.txt"));
    expect(t.fork.read("app.txt")).toContain("Two\nTHREE\n");
    expect(read(ours)).toContain("Two\nTHREE\n");
    expect(sh(["git", "show", "HEAD:bin/run.sh"], { cwd: t.fork.path }).stdout).toBe("#!/bin/sh\necho run fast\n");
    expect(t.pb(["build"], { cwd: t.fork.path }).stdout).toContain("built ");
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit reads each output file from the index where the working copy differs", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    const staged = t.fork.read("app.txt");
    t.fork.write("app.txt", staged.replaceAll("three", "THREE"));
    t.fork.write("docs/guide.md", "an unstaged guide\n");
    hookCommit(t, ["-m", "shout two"]);
    expect(committed(t).filter((p) => !p.startsWith(".patchbook/"))).toEqual(["app.txt"]);
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toBe(staged);
    expect(read(join(t.fork.path, ".patchbook/changes/shout/ours/app.txt.pb"))).toBe(staged);
    expect(sh(["git", "show", "HEAD:docs/guide.md"], { cwd: t.fork.path }).stdout).toBe("a guide\n");
    expect(t.fork.read("app.txt")).toBe(staged.replaceAll("three", "THREE"));
    expect(t.fork.read("docs/guide.md")).toBe("an unstaged guide\n");
    expect(porcelain(t)).toBe(" M app.txt\n M docs/guide.md\n");
  });

  forkTest("commit stages output a finish hook rewrites in a buffer it reuses", (t) => {
    writeFileSync(join(t.fork.path, ".patchbook/hooks.ts"), dedent(`
      let mirror = new Uint8Array(0);
      export const finish = (out: Map<string, { data: Uint8Array; mode: number }>) => {
        const app = out.get("app.txt")!.data;
        if (mirror.length !== app.length) mirror = new Uint8Array(app.length);
        mirror.set(app);
        out.set("mirror.txt", { data: mirror, mode: 0o644 });
      };
    `));
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("mirror");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout two"]);
    expect(sh(["git", "show", "HEAD:mirror.txt"], { cwd: t.fork.path }).stdout).toBe(t.fork.read("app.txt"));
    expect(t.fork.read("mirror.txt")).toContain("TWO");
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit in a SHA-256 fork records only the staged edit", (t) => {
    sh(["git", "init", "-q", "-b", "main", "--object-format=sha256", "up256"], { cwd: t.tmp });
    const up = new Repo(join(t.tmp, "up256"));
    up.write("app.txt", "one\ntwo\nthree\n");
    up.write("docs/guide.md", "a guide\n");
    up.commit("start");
    t.pb(["clone", up.path, "fork256"], { cwd: t.tmp });
    const fork = join(t.tmp, "fork256");
    expect(sh(["git", "rev-parse", "--show-object-format"], { cwd: fork }).stdout).toBe("sha256\n");
    writeFileSync(join(fork, "app.txt"), "one\nTWO\nthree\n");
    sh(["git", "add", "app.txt"], { cwd: fork });
    sh(["git", "commit", "-q", "-m", "shout two"], { cwd: fork, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    const names = words(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: fork }).stdout);
    expect(names.filter((p) => !p.startsWith(".patchbook/"))).toEqual(["app.txt"]);
    expect(read(join(fork, ".patchbook/changes/shout/ours/app.txt.pb"))).toBe("one\nTWO\nthree\n");
    expect(sh(["git", "status", "--porcelain"], { cwd: fork }).stdout).toBe("");
  });

  for (const [where, path] of [["inside the book tree", (t: ForkCase) => join(t.fork.path, ".scratch-wt")], ["outside the book tree", (t: ForkCase) => join(t.tmp, "scratch-wt")]] as const) {
    forkTest(`commit from a linked worktree ${where} with no patchbook goes through`, (t) => {
      const wt = path(t);
      sh(["git", "worktree", "add", "-q", "--detach", wt, "HEAD~1"], { cwd: t.fork.path });
      expect(existsSync(join(wt, ".patchbook"))).toBe(false);
      writeFileSync(join(wt, "scratch.txt"), "scratch\n");
      sh(["git", "add", "scratch.txt"], { cwd: wt });
      const commit = sh(["git", "commit", "-q", "-m", "scratch"], { cwd: wt, check: false, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
      expect(commit.stderr).not.toContain("refusing");
      expect(commit.code).toBe(0);
      expect(words(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: wt }).stdout)).toEqual(["scratch.txt"]);
      expect(existsSync(join(t.tmp, "prompt.txt"))).toBe(false);
      expect(existsSync(join(t.fork.path, ".patchbook/changes/model-name"))).toBe(false);
    });
  }

  forkTest("commit in the main checkout still records with a linked worktree around", (t) => {
    sh(["git", "worktree", "add", "-q", "--detach", join(t.tmp, "scratch-wt"), "HEAD~1"], { cwd: t.fork.path });
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    hookCommit(t, ["-qam", "shout"]);
    expect(committed(t)).toContain(".patchbook/build.lock");
    expect(committed(t)).toContain("app.txt");
  });

  const mergeUpstream = (t: ForkCase, ...flags: string[]) => {
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("seven", "SEVEN"));
    t.up.commit("upstream shouts seven");
    sh(["git", "fetch", "-q", "upstream"], { cwd: t.fork.path });
    sh(["git", "merge", "-q", "--no-edit", ...flags, "upstream/main"], { cwd: t.fork.path });
  };

  forkTest("commit stops when upstream was merged in directly", (t) => {
    mergeUpstream(t);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    const staged = tree(t.fork.path);
    const commit = hookCommit(t, ["-m", "shout"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("upstream shouts seven");
    expect(commit.stderr).toContain("patchbook sync");
    expect(commit.stderr).toContain("PATCHBOOK_HOOK=0");
    expect(tree(t.fork.path)).toEqual(staged);
    expect(existsSync(join(t.tmp, "prompt.txt"))).toBe(false);
  });

  forkTest("commit stops on a merge of upstream that is not committed yet", (t) => {
    mergeUpstream(t, "--no-commit", "--no-ff");
    const commit = hookCommit(t, ["-m", "merge upstream"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("upstream shouts seven");
    expect(commit.stderr).toContain("patchbook sync");
    expect(existsSync(join(t.tmp, "prompt.txt"))).toBe(false);
  });

  forkTest("build refuses when upstream was merged in directly", (t) => {
    mergeUpstream(t);
    const before = tree(t.fork.path);
    const build = t.pb(["build"], { cwd: t.fork.path, code: 1 });
    expect(build.stderr).toContain("upstream shouts seven");
    expect(build.stderr).toContain("patchbook sync");
    expect(tree(t.fork.path)).toEqual(before);
    const forced = t.pb(["build", "--force"], { cwd: t.fork.path, code: 1 });
    expect(forced.stderr).toContain("patchbook sync");
    expect(tree(t.fork.path)).toEqual(before);
  });

  forkTest("commit works again once sync has moved the pin past a merged upstream", (t) => {
    mergeUpstream(t);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    expect(hookCommit(t, ["-m", "shout"], false).code).not.toBe(0);
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook/upstream.lock"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout"]);
    expect(committed(t)).toContain(".patchbook/changes/shout/CHANGE.md");
    expect(t.fork.read("app.txt")).toContain("TWO");
    expect(t.fork.read("app.txt")).toContain("SEVEN");
  });

  forkTest("build refuses without installing the hook", (t) => {
    mergeUpstream(t);
    rmSync(join(t.fork.path, ".git/hooks/pre-commit"));
    t.pb(["build"], { cwd: t.fork.path, code: 1 });
    expect(existsSync(join(t.fork.path, ".git/hooks/pre-commit"))).toBe(false);
  });

  forkTest("commit and build still work after sync pins an older upstream commit", (t) => {
    const start = sh(["git", "rev-parse", "HEAD"], { cwd: t.up.path }).stdout.trim();
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("seven", "SEVEN"));
    t.up.commit("upstream shouts seven");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build", "--force", "--commit"], { cwd: t.fork.path });
    t.pb(["sync", "upstream", start], { cwd: t.fork.path });
    t.pb(["build", "--force"], { cwd: t.fork.path });
    expect(t.fork.read("app.txt")).toContain("seven");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout"]);
    expect(committed(t)).toContain(".patchbook/changes/shout/CHANGE.md");
  });

  forkTest("commit works after a merged upstream commit that changes nothing", (t) => {
    sh(["git", "commit", "-q", "--allow-empty", "-m", "an empty commit upstream"], { cwd: t.up.path });
    sh(["git", "fetch", "-q", "upstream"], { cwd: t.fork.path });
    sh(["git", "merge", "-q", "--no-edit", "upstream/main"], { cwd: t.fork.path });
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout"]);
    expect(committed(t)).toContain(".patchbook/changes/shout/CHANGE.md");
  });

  forkTest("commit leaves out an untracked file", (t) => {
    t.fork.write("notes.txt", "scratch\n");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "only app.txt"]);
    const files = committed(t);
    expect(files).toContain("app.txt");
    expect(files).toContain(".patchbook/changes/shout/CHANGE.md");
    expect(files.filter((f) => f.includes("notes.txt"))).toEqual([]);
    expect(read(join(t.fork.path, ".patchbook/changes/shout/CHANGE.md"))).not.toContain("notes.txt");
    expect(porcelain(t)).toBe("?? notes.txt\n");
  });

  forkTest("commit records only the staged part of a file", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    const staged = t.fork.read("app.txt");
    t.fork.write("app.txt", staged.replaceAll("three", "THREE"));
    const unstaged = t.fork.read("app.txt");
    hookCommit(t, ["-m", "shout two"]);
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toBe(staged);
    const shown = t.pb(["show", "shout"], { cwd: t.fork.path }).stdout;
    expect(shown).toContain("+TWO");
    expect(shown).not.toContain("THREE");
    expect(t.fork.read("app.txt")).toBe(unstaged);
    expect(porcelain(t)).toBe(" M app.txt\n");
  });

  forkTest("partial commit records only the paths it names", (t) => {
    t.fork.write("staged.txt", "staged\n");
    sh(["git", "add", "staged.txt"], { cwd: t.fork.path });
    t.fork.write("notes.txt", "scratch\n");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    hookCommit(t, ["-m", "only app.txt", "app.txt"]);
    const files = committed(t);
    expect(files).toContain("app.txt");
    expect(files).toContain(".patchbook/changes/shout/CHANGE.md");
    expect(files.filter((f) => f.includes("staged.txt") || f.includes("notes.txt"))).toEqual([]);
    expect(porcelain(t)).toBe("A  staged.txt\n?? notes.txt\n");
  });

  forkTest("commit refuses to build over unstaged edits", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    hookCommit(t, ["-am", "shout"]);
    const ours = join(t.fork.path, ".patchbook/changes/shout/ours/app.txt.pb");
    writeFileSync(ours, read(ours).replaceAll("TWO", "Two"));
    sh(["git", "add", ours], { cwd: t.fork.path });
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("three", "THREE"));
    const edited = t.fork.read("app.txt");
    t.fork.write("docs/guide.md", "a better guide\n");
    sh(["git", "add", "docs/guide.md"], { cwd: t.fork.path });
    const before = porcelain(t);
    const head = sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout;
    const commit = hookCommit(t, ["-m", "soften"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("changes you haven't staged:\n  app.txt");
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).toBe(head);
    expect(t.fork.read("app.txt")).toBe(edited);
    expect(read(ours)).toContain("Two");
    expect(porcelain(t)).toBe(before);
  });

  forkTest("commit after record takes what was recorded", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.fork.write("new.txt", "hello\n");
    t.pb(["record", "loud", "--intent", "Shout the second line and add new.txt."], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "loud"]);
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("TWO");
    expect(sh(["git", "show", "HEAD:new.txt"], { cwd: t.fork.path }).stdout).toBe("hello\n");
    expect(read(join(t.fork.path, ".patchbook/changes/loud/CHANGE.md"))).toContain("- add new.txt");
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit after build takes the built output", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    hookCommit(t, ["-am", "shout"]);
    const ours = join(t.fork.path, ".patchbook/changes/shout/ours/app.txt.pb");
    writeFileSync(ours, read(ours).replaceAll("TWO", "Two"));
    t.pb(["build"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "soften"]);
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("Two");
    expect(read(ours)).toContain("Two");
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit refuses patchbook edits it does not take", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    hookCommit(t, ["-am", "shout"]);
    const ours = join(t.fork.path, ".patchbook/changes/shout/ours/app.txt.pb");
    writeFileSync(ours, read(ours).replaceAll("TWO", "Two"));
    t.fork.write("docs/guide.md", "a better guide\n");
    sh(["git", "add", "docs/guide.md"], { cwd: t.fork.path });
    const head = sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout;
    const commit = hookCommit(t, ["-m", "guide"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("the patchbook has changes that aren't in this commit:\n  .patchbook/changes/shout/ours/app.txt.pb");
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).toBe(head);
    expect(t.fork.read("app.txt")).toContain("TWO");
    expect(porcelain(t)).toBe(" M .patchbook/changes/shout/ours/app.txt.pb\nM  docs/guide.md\n");
  });

  forkTest("commit builds over a file git converts on checkout", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    hookCommit(t, ["-am", "shout"]);
    writeFileSync(join(t.fork.path, ".git/info/attributes"), "*.txt text eol=crlf\n");
    t.fork.rm("app.txt");
    sh(["git", "checkout", "--", "app.txt"], { cwd: t.fork.path });
    expect(t.fork.read("app.txt")).toContain("TWO\r\n");
    const ours = join(t.fork.path, ".patchbook/changes/shout/ours/app.txt.pb");
    writeFileSync(ours, read(ours).replaceAll("TWO", "Two"));
    sh(["git", "add", ours], { cwd: t.fork.path });
    hookCommit(t, ["-m", "soften"]);
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("Two");
  });

  const renameToIgnoredLocalCfg = (t: ForkCase) => {
    t.fork.write("extra.txt", "ours\n");
    sh(["git", "add", "extra.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "extra"]);
    const change = join(t.fork.path, ".patchbook/changes/shout");
    writeFileSync(join(change, "CHANGE.md"), read(join(change, "CHANGE.md")).replaceAll("- add extra.txt", "- add local.cfg"));
    sh(["git", "mv", join(change, "ours/extra.txt.pb"), join(change, "ours/local.cfg.pb")], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    writeFileSync(join(t.fork.path, ".git/info/exclude"), "local.cfg\n");
  };

  forkTest("commit keeps an ignored file the build would overwrite", (t) => {
    renameToIgnoredLocalCfg(t);
    t.fork.write("local.cfg", "mine\n");
    expect(hookCommit(t, ["-m", "rename"], false).code).toBe(0);
    expect(committed(t)).toContain("extra.txt");
    expect(t.fork.read("local.cfg")).toBe("mine\n");
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit writes ignored output to disk and leaves it out", (t) => {
    renameToIgnoredLocalCfg(t);
    expect(hookCommit(t, ["-m", "rename"]).stderr).not.toContain("local.cfg");
    expect(t.fork.read("local.cfg")).toBe("ours\n");
    expect(sh(["git", "ls-files", "local.cfg"], { cwd: t.fork.path }).stdout).toBe("");
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit leaves out an intent-to-add file", (t) => {
    t.fork.write("notes.txt", "scratch\n");
    sh(["git", "add", "-N", "notes.txt"], { cwd: t.fork.path });
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "only app.txt"]);
    expect(committed(t).filter((f) => f.includes("notes.txt"))).toEqual([]);
    expect(read(join(t.fork.path, ".patchbook/changes/shout/CHANGE.md"))).not.toContain("notes.txt");
    expect(porcelain(t)).toBe(" A notes.txt\n");
  });

  forkTest("commit stages a built path literally", (t) => {
    t.fork.write("a[1].txt", "one\n");
    sh(["git", "--literal-pathspecs", "add", "a[1].txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "add a[1].txt"]);
    const ours = join(t.fork.path, ".patchbook/changes/shout/ours/a[1].txt.pb");
    writeFileSync(ours, "ONE\n");
    sh(["git", "--literal-pathspecs", "add", ours], { cwd: t.fork.path });
    t.fork.write("a1.txt", "scratch\n");
    hookCommit(t, ["-m", "shout a[1].txt"]);
    expect(sh(["git", "show", "HEAD:a[1].txt"], { cwd: t.fork.path }).stdout).toBe("ONE\n");
    expect(committed(t)).not.toContain("a1.txt");
    expect(porcelain(t)).toBe("?? a1.txt\n");
  });

  forkTest("partial commit on its own index says how to keep the record", (t) => {
    const index = join(t.tmp, "index");
    writeFileSync(index, readFileSync(join(t.fork.path, ".git/index")));
    const env = { ...t.env, GIT_INDEX_FILE: index };
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    const commit = sh(["git", "commit", "-qm", "only app.txt", "app.txt"], { cwd: t.fork.path, env: { ...env, PATCHBOOK_HOOK: "1" } });
    expect(commit.stderr).toContain("run `git --literal-pathspecs reset -q -- .patchbook/");
    const paths = commit.stderr.split("reset -q -- ")[1]!.split("`")[0]!.split(" ");
    sh(["git", "--literal-pathspecs", "reset", "-q", "--", ...paths], { cwd: t.fork.path, env });
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path, env }).stdout).toBe("");
  });

  const syncAndBuild = (t: ForkCase) => {
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
  };

  const stageAnOlderBuild = (t: ForkCase) => {
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("two", "two v1"));
    t.up.commit("v1");
    syncAndBuild(t);
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("two v1", "two v2"));
    t.up.commit("v2");
    syncAndBuild(t);
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
  };

  const stopsOnAnOlderBuild = (t: ForkCase, path: string) => {
    const head = sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout;
    const before = [porcelain(t), tree(t.fork.path)];
    const commit = hookCommit(t, ["-m", "take upstream"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain(`\n  ${path}\n`);
    expect(commit.stderr).toContain(`git --literal-pathspecs add -- ${path}`);
    expect(commit.stderr).toContain(`git --literal-pathspecs checkout -- ${path}`);
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).toBe(head);
    expect([porcelain(t), tree(t.fork.path)]).toEqual(before);
  };

  forkTest("commit stops on an older build left in the index and takes the newer once added", (t) => {
    stageAnOlderBuild(t);
    stopsOnAnOlderBuild(t, "app.txt");
    sh("git --literal-pathspecs add -- app.txt".split(" "), { cwd: t.fork.path });
    expect(hookCommit(t, ["-m", "take upstream"]).stderr).not.toContain("app.txt");
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("two v2");
    expect(t.fork.read("app.txt")).toContain("two v2");
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit stops on an older build left in the index and records it once checked out", (t) => {
    stageAnOlderBuild(t);
    stopsOnAnOlderBuild(t, "app.txt");
    sh("git --literal-pathspecs checkout -- app.txt".split(" "), { cwd: t.fork.path });
    expect(hookCommit(t, ["-m", "take upstream"]).stderr).toContain("file     app.txt");
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("two v1");
    expect(t.fork.read("app.txt")).toContain("two v1");
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit records a staged edit after build --force", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    t.pb(["build", "--force"], { cwd: t.fork.path });
    expect(hookCommit(t, ["-m", "shout"]).stderr).toContain("file     app.txt");
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("TWO");
    expect(porcelain(t)).toBe("");
  });

  const stageAnOlderBuildsFile = (t: ForkCase) => {
    t.up.write("extra.txt", "extra\n");
    t.up.commit("add extra.txt");
    syncAndBuild(t);
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    t.up.rm("extra.txt");
    t.up.commit("remove extra.txt");
    syncAndBuild(t);
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
  };

  forkTest("commit stops on a file an older build left in the index and drops it once added", (t) => {
    stageAnOlderBuildsFile(t);
    stopsOnAnOlderBuild(t, "extra.txt");
    sh("git --literal-pathspecs add -- extra.txt".split(" "), { cwd: t.fork.path });
    expect(hookCommit(t, ["-m", "take upstream"]).stderr).not.toContain("extra.txt");
    expect(sh(["git", "ls-files", "extra.txt"], { cwd: t.fork.path }).stdout).toBe("");
    expect(existsSync(join(t.fork.path, "extra.txt"))).toBe(false);
    expect(porcelain(t)).toBe("");
    t.pb(["build"], { cwd: t.fork.path });
  });

  forkTest("commit stops on a file an older build left in the index and records it once checked out", (t) => {
    stageAnOlderBuildsFile(t);
    stopsOnAnOlderBuild(t, "extra.txt");
    sh("git --literal-pathspecs checkout -- extra.txt".split(" "), { cwd: t.fork.path });
    expect(hookCommit(t, ["-m", "keep extra"]).stderr).toContain("add      extra.txt");
    expect(sh(["git", "show", "HEAD:extra.txt"], { cwd: t.fork.path }).stdout).toBe("extra\n");
    expect(t.fork.read("extra.txt")).toBe("extra\n");
    expect(porcelain(t)).toBe("");
    t.pb(["build"], { cwd: t.fork.path });
    expect(porcelain(t)).toBe("");
  });

  const placeholderInOutput = (t: ForkCase) => {
    t.up.write("greet.txt", "Say hello in Cursor.\n");
    t.up.write("strings.md", "## greet\n\nhello\n");
    t.up.commit("add greet.txt and strings.md");
    syncAndBuild(t);
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config) + dedent(`
      [placeholders.snippet]
      file = "strings.md"
      format = "sections"

      [[check]]
      name = "cursor"
      files = ["greet.txt"]
      pattern = '\\bCursor\\b'
    `));
    t.pb(["scaffold"], { cwd: t.fork.path });
    const entries = join(t.fork.path, ".patchbook/blocks/greet.txt.entries");
    const text = read(entries).replaceAll("rules: \nintent: \n", "rules: t3\nintent: Speak T3.\n");
    writeFileSync(entries, text.split("--- patched\n")[0]! + "--- patched\n{{snippet:greet}}\n");
    t.pb(["build"], { cwd: t.fork.path });
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "greet from strings.md"]);
    expect(t.fork.read("greet.txt")).toBe("hello\n");
    expect(porcelain(t)).toBe("");
  };

  forkTest("commit stops on an unstaged edit to a placeholder file in the output", (t) => {
    placeholderInOutput(t);
    t.fork.write("strings.md", "## greet\n\nhi there\n");
    t.fork.write("notes.txt", "notes\n");
    sh(["git", "add", "notes.txt"], { cwd: t.fork.path });
    const head = sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout;
    const before = [porcelain(t), tree(t.fork.path)];
    const commit = hookCommit(t, ["-m", "notes"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("the patchbook has changes that aren't in this commit:\n  strings.md\n");
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).toBe(head);
    expect([porcelain(t), tree(t.fork.path)]).toEqual(before);
    sh(["git", "add", "strings.md"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "notes"]);
    expect(sh(["git", "show", "HEAD:strings.md"], { cwd: t.fork.path }).stdout).toContain("hi there");
    expect(sh(["git", "show", "HEAD:greet.txt"], { cwd: t.fork.path }).stdout).toBe("hi there\n");
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit stops on a staged placeholder file in the output the working copy put back", (t) => {
    placeholderInOutput(t);
    const built = t.fork.read("strings.md");
    t.fork.write("strings.md", "## greet\n\nhi there\n");
    sh(["git", "add", "strings.md"], { cwd: t.fork.path });
    t.fork.write("strings.md", built);
    stopsOnAnOlderBuild(t, "strings.md");
    sh("git --literal-pathspecs checkout -- strings.md".split(" "), { cwd: t.fork.path });
    hookCommit(t, ["-m", "say hi"]);
    expect(sh(["git", "show", "HEAD:strings.md"], { cwd: t.fork.path }).stdout).toContain("hi there");
    expect(sh(["git", "show", "HEAD:greet.txt"], { cwd: t.fork.path }).stdout).toBe("hi there\n");
    expect(porcelain(t)).toBe("");
    t.pb(["build"], { cwd: t.fork.path });
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit takes a placeholder file in the output that the build changed", (t) => {
    placeholderInOutput(t);
    t.up.write("strings.md", "## greet\n\nhowdy\n");
    t.up.commit("howdy");
    syncAndBuild(t);
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "take upstream"]);
    expect(sh(["git", "show", "HEAD:strings.md"], { cwd: t.fork.path }).stdout).toContain("howdy");
    expect(sh(["git", "show", "HEAD:greet.txt"], { cwd: t.fork.path }).stdout).toBe("howdy\n");
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit without file modes builds a program from upstream once", (t) => {
    sh(["git", "config", "core.fileMode", "false"], { cwd: t.fork.path });
    t.up.write("new.sh", "echo up\n", 0o755);
    t.up.commit("add new.sh");
    syncAndBuild(t);
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "take upstream"]);
    expect(committed(t)).toContain("new.sh");
    expect(sh(["git", "ls-tree", "HEAD", "new.sh"], { cwd: t.fork.path }).stdout).toStartWith("100755 ");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    const later = hookCommit(t, ["-m", "shout"]);
    expect(later.stderr).not.toContain("built from");
    expect(committed(t)).not.toContain("new.sh");
  });

  forkTest("commit without file modes records an edit to a program from upstream", (t) => {
    sh(["git", "config", "core.fileMode", "false"], { cwd: t.fork.path });
    t.up.write("new.sh", "echo up\n", 0o755);
    t.up.commit("add new.sh");
    syncAndBuild(t);
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "take upstream"]);
    t.fork.write("new.sh", "echo mine\n", 0o755);
    sh(["git", "add", "new.sh"], { cwd: t.fork.path });
    expect(hookCommit(t, ["-m", "mine"]).stderr).toContain("file     new.sh");
    t.pb(["build"], { cwd: t.fork.path });
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit after sync leaves the sync report untracked", (t) => {
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("one", "ONE"));
    t.up.commit("move");
    t.pb(["sync"], { cwd: t.fork.path });
    hookCommit(t, ["-am", "Sync upstream"]);
    expect(committed(t)).toContain(".patchbook/upstream.lock");
    expect(committed(t)).not.toContain(".patchbook/last-sync.json");
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("ONE");
    expect(porcelain(t)).toBe("");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout"]);
    expect(committed(t)).toContain(".patchbook/changes/shout/CHANGE.md");
    expect(committed(t)).not.toContain(".patchbook/last-sync.json");
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit leaves out an untracked file in the patchbook folder", (t) => {
    writeFileSync(join(t.fork.path, ".patchbook/scratch.txt"), "my note\n");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout"]);
    expect(committed(t)).toContain(".patchbook/changes/shout/CHANGE.md");
    expect(committed(t)).not.toContain(".patchbook/scratch.txt");
    expect(porcelain(t)).toBe("?? .patchbook/scratch.txt\n");
  });

  forkTest("build --commit leaves out an untracked file in the patchbook folder", (t) => {
    writeFileSync(join(t.fork.path, ".patchbook/notes.md"), "v1\n");
    t.fork.commit("notes");
    writeFileSync(join(t.fork.path, ".patchbook/notes.md"), "v2\n");
    writeFileSync(join(t.fork.path, ".patchbook/scratch.txt"), "my note\n");
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("two", "deux"));
    t.up.commit("move");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build", "--commit"], { cwd: t.fork.path });
    for (const p of [".patchbook/build.lock", ".patchbook/notes.md", ".patchbook/upstream.lock"]) expect(committed(t)).toContain(p);
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("deux");
    expect(committed(t)).not.toContain(".patchbook/scratch.txt");
    expect(committed(t)).not.toContain(".patchbook/last-sync.json");
    expect(porcelain(t)).toBe("?? .patchbook/scratch.txt\n");
  });

  forkTest("partial commit says the patchbook changes are not in it", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "loud", "--intent", "Shout the second line."], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    const commit = hookCommit(t, ["-m", "only app.txt", "app.txt"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("the patchbook has changes that aren't in this commit:\n  .patchbook/build.lock");
    expect(commit.stderr).not.toContain("haven't staged");
  });

  forkTest("commit keeps a staged new file deleted from the working tree", (t) => {
    t.fork.write("new.txt", "new\n");
    sh(["git", "add", "new.txt"], { cwd: t.fork.path });
    t.fork.rm("new.txt");
    hookCommit(t, ["-m", "add new.txt"]);
    expect(committed(t)).toContain("new.txt");
    expect(sh(["git", "show", "HEAD:new.txt"], { cwd: t.fork.path }).stdout).toBe("new\n");
  });

  forkTest("commit over an unstaged edit advises a stash that keeps the build", (t) => {
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("one", "ONE"));
    t.up.commit("move");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    t.fork.write("app.txt", t.fork.read("app.txt") + "local\n");
    const commit = hookCommit(t, ["-m", "Sync upstream"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).not.toContain("Stage them");
    const stash = "git --literal-pathspecs stash push -a -- app.txt";
    expect(commit.stderr).toContain(stash);
    sh(stash.split(" "), { cwd: t.fork.path });
    hookCommit(t, ["-m", "Sync upstream"]);
    sh(["git", "stash", "pop", "-q"], { cwd: t.fork.path });
    expect(t.fork.read("app.txt")).toStartWith("ONE\n");
    expect(t.fork.read("app.txt")).toEndWith("local\n");
  });

  forkTest("commit over an unstaged edit beside an intent-to-add entry advises untracking it first", (t) => {
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("one", "ONE"));
    t.up.commit("move");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    t.fork.write("app.txt", t.fork.read("app.txt") + "local\n");
    t.fork.write("notes.txt", "scratch\n");
    sh(["git", "add", "-N", "notes.txt"], { cwd: t.fork.path });
    const commit = hookCommit(t, ["-m", "Sync upstream"], false);
    expect(commit.code).not.toBe(0);
    const untrack = "git --literal-pathspecs rm -q --cached -- notes.txt";
    expect(commit.stderr).toContain(untrack);
    expect(commit.stderr.indexOf(untrack)).toBeLessThan(commit.stderr.indexOf("stash push"));
    sh(untrack.split(" "), { cwd: t.fork.path });
    sh("git --literal-pathspecs stash push -a -- app.txt".split(" "), { cwd: t.fork.path });
    hookCommit(t, ["-m", "Sync upstream"]);
    sh(["git", "stash", "pop", "-q"], { cwd: t.fork.path });
    expect(t.fork.read("app.txt")).toStartWith("ONE\n");
    expect(t.fork.read("app.txt")).toEndWith("local\n");
    expect(t.fork.read("notes.txt")).toBe("scratch\n");
  });

  forkTest("commit refuses to build over an unstaged edit to a name with a leading space", (t) => {
    t.up.write(" spaced.txt", "v1\n");
    t.up.commit("v1");
    syncAndBuild(t);
    t.fork.commit("v1");
    t.up.write(" spaced.txt", "v2\n");
    t.up.commit("v2");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    t.fork.write(" spaced.txt", "mine\n");
    const commit = hookCommit(t, ["-m", "v2"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).not.toContain("delete");
    expect(existsSync(join(t.fork.path, ".patchbook/changes"))).toBe(false);
    expect(commit.stderr).toContain("changes you haven't staged:\n   spaced.txt");
    expect(t.fork.read(" spaced.txt")).toBe("mine\n");
  });

  forkTest("commit stages records the repo ignores", (t) => {
    writeFileSync(join(t.fork.path, ".git/info/exclude"), "*.pb\n");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout"]);
    expect(committed(t)).toContain(".patchbook/changes/shout/ours/app.txt.pb");
    expect(committed(t)).toContain(".patchbook/changes/shout/base/app.txt.pb");
  });

  forkTest("commit builds over an unstaged mode change", (t) => {
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("two", "two v1"));
    t.up.commit("v1");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    chmodSync(join(t.fork.path, "app.txt"), 0o755);
    hookCommit(t, ["-m", "v1"]);
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("two v1");
    expect(headMode(t, "app.txt")).toBe("100644");
  });

  forkTest("commit stops on a file removed from the index but kept on disk", (t) => {
    sh(["git", "rm", "-q", "--cached", "app.txt"], { cwd: t.fork.path });
    const head = sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout;
    const commit = hookCommit(t, ["-m", "stop tracking app.txt"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("`git rm --cached` keeps");
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).toBe(head);
    expect(existsSync(join(t.fork.path, ".patchbook/changes"))).toBe(false);
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("app.txt")).toContain("two");
    t.fork.rm("app.txt");
    expect(hookCommit(t, ["-m", "delete app.txt"]).stderr).toContain("delete   app.txt");
    t.pb(["build"], { cwd: t.fork.path });
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit deletes an output file before any build lock", (t) => {
    sh(["git", "rm", "-q", ".patchbook/build.lock"], { cwd: t.fork.path });
    t.fork.commit("no build lock");
    sh(["git", "rm", "-q", "app.txt"], { cwd: t.fork.path });
    const commit = hookCommit(t, ["-m", "delete app.txt"]);
    expect(commit.stderr).toContain("delete   app.txt");
    expect(sh(["git", "ls-files", "app.txt"], { cwd: t.fork.path }).stdout).toBe("");
    expect(porcelain(t)).toBe("");
  });

  const lastCommit = (t: ForkCase): string => sh(["git", "log", "-1", "--format=%s"], { cwd: t.fork.path }).stdout;
  const inHead = (t: ForkCase, ...paths: string[]): string => sh(["git", "ls-tree", "-r", "--name-only", "HEAD", "--", ...paths], { cwd: t.fork.path }).stdout;

  forkTest("commit unadds a file a change added after git rm", (t) => {
    t.fork.write("extra.txt", "extra\n");
    sh(["git", "add", "extra.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "add extra.txt"]);
    sh(["git", "rm", "-q", "extra.txt"], { cwd: t.fork.path });
    expect(hookCommit(t, ["-m", "drop extra.txt"]).stderr).toContain("unadd    extra.txt");
    expect(lastCommit(t)).toBe("drop extra.txt\n");
    expect(inHead(t, "extra.txt")).toBe("");
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit -a unadds a recorded symlink deleted from disk", (t) => {
    symlinkSync("app.txt", join(t.fork.path, "link.txt"));
    sh(["git", "add", "link.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "link app.txt"]);
    unlinkSync(join(t.fork.path, "link.txt"));
    expect(hookCommit(t, ["-am", "drop the link"]).stderr).toContain("unadd    link.txt");
    expect(lastCommit(t)).toBe("drop the link\n");
    expect(inHead(t, "link.txt")).toBe("");
    expect(porcelain(t)).toBe("");
  });

  const recordedCopy = (t: ForkCase, path: string): string => join(t.fork.path, ".patchbook/changes/shout/ours", `${path}.pb`);
  const modeInHead = (t: ForkCase, path: string): string => sh(["git", "ls-tree", "HEAD", "--", path], { cwd: t.fork.path }).stdout.split(" ")[0]!;

  forkTest("commit records a regular file over a recorded symlink", (t) => {
    symlinkSync("app.txt", join(t.fork.path, "link"));
    sh(["git", "add", "link"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "link app.txt"]);
    expect(isSymlink(recordedCopy(t, "link"))).toBe(true);
    unlinkSync(join(t.fork.path, "link"));
    t.fork.write("link", "plain\n");
    sh(["git", "add", "link"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "link is a file"]);
    expect(modeInHead(t, "link")).toBe("100644");
    expect(isSymlink(join(t.fork.path, "link"))).toBe(false);
    expect(t.fork.read("link")).toBe("plain\n");
    expect(isSymlink(recordedCopy(t, "link"))).toBe(false);
    expect(read(recordedCopy(t, "link"))).toBe("plain\n");
    expect(porcelain(t)).toBe("");
    t.pb(["build"], { cwd: t.fork.path });
    expect(isSymlink(join(t.fork.path, "link"))).toBe(false);
    expect(t.fork.read("link")).toBe("plain\n");
  });

  forkTest("commit records a retargeted symlink as a symlink", (t) => {
    symlinkSync("app.txt", join(t.fork.path, "link"));
    sh(["git", "add", "link"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "link app.txt"]);
    unlinkSync(join(t.fork.path, "link"));
    symlinkSync("docs", join(t.fork.path, "link"));
    sh(["git", "add", "link"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "link docs"]);
    expect(modeInHead(t, "link")).toBe("120000");
    expect(readlinkSync(join(t.fork.path, "link"))).toBe("docs");
    expect(readlinkSync(recordedCopy(t, "link"))).toBe("docs");
    expect(porcelain(t)).toBe("");
  });

  const upstreamLink = (t: ForkCase): void => {
    symlinkSync("app.txt", join(t.up.path, "link"));
    t.up.commit("add a link");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "take upstream"]);
    expect(readlinkSync(join(t.fork.path, "link"))).toBe("app.txt");
  };

  forkTest("commit refuses an upstream link replaced by a regular file", (t) => {
    upstreamLink(t);
    unlinkSync(join(t.fork.path, "link"));
    t.fork.write("link", "plain\n");
    sh(["git", "add", "link"], { cwd: t.fork.path });
    const before = { files: tree(t.fork.path), staged: porcelain(t) };
    const commit = hookCommit(t, ["-m", "link is a file"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("link");
    expect(commit.stderr).toContain("can't record a link turned into a file yet");
    expect(commit.stderr).toContain("#133");
    expect(tree(t.fork.path)).toEqual(before.files);
    expect(porcelain(t)).toBe(before.staged);
    expect(lastCommit(t)).toBe("take upstream\n");
  });

  forkTest("record refuses an upstream link replaced by a regular file", (t) => {
    upstreamLink(t);
    unlinkSync(join(t.fork.path, "link"));
    t.fork.write("link", "plain\n");
    const before = tree(t.fork.path);
    const out = t.pb(["record", "--intent", "Make the link a file."], { cwd: t.fork.path, code: 1 });
    expect(out.stderr).toContain("link");
    expect(out.stderr).toContain("can't record a link turned into a file yet");
    expect(out.stderr).toContain("#133");
    expect(tree(t.fork.path)).toEqual(before);
  });

  forkTest("commit records a retargeted upstream link as a link", (t) => {
    upstreamLink(t);
    unlinkSync(join(t.fork.path, "link"));
    symlinkSync("docs", join(t.fork.path, "link"));
    sh(["git", "add", "link"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "link docs"]);
    expect(modeInHead(t, "link")).toBe("120000");
    expect(readlinkSync(join(t.fork.path, "link"))).toBe("docs");
    expect(porcelain(t)).toBe("");
    t.pb(["build"], { cwd: t.fork.path });
    expect(readlinkSync(join(t.fork.path, "link"))).toBe("docs");
  });

  for (const fileMode of ["false", "true"]) {
    forkTest(`record with core.fileMode ${fileMode} records an executable file over a recorded symlink as a regular file`, (t) => {
      sh(["git", "config", "core.fileMode", fileMode], { cwd: t.fork.path });
      symlinkSync("app.txt", join(t.fork.path, "link"));
      sh(["git", "add", "link"], { cwd: t.fork.path });
      hookCommit(t, ["-m", "link app.txt"]);
      expect(isSymlink(recordedCopy(t, "link"))).toBe(true);
      unlinkSync(join(t.fork.path, "link"));
      t.fork.write("link", "plain\n", 0o755);
      t.pb(["record", "--intent", "Make the link a file."], { cwd: t.fork.path });
      expect(isSymlink(recordedCopy(t, "link"))).toBe(false);
      expect(read(recordedCopy(t, "link"))).toBe("plain\n");
      t.pb(["build"], { cwd: t.fork.path });
      expect(isSymlink(join(t.fork.path, "link"))).toBe(false);
      expect(t.fork.read("link")).toBe("plain\n");
    });
  }

  forkTest("hook install without file modes keeps the exec bit of a script we added", (t) => {
    sh(["git", "config", "core.fileMode", "false"], { cwd: t.fork.path });
    t.fork.write(".husky/pre-commit", "npm test\n", 0o755);
    sh(["git", "add", ".husky/pre-commit"], { cwd: t.fork.path });
    sh(["git", "update-index", "--chmod=+x", ".husky/pre-commit"], { cwd: t.fork.path });
    sh(["git", "commit", "-q", "-m", "add husky script"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Add the pre-commit script." } });
    expect(modeInHead(t, ".husky/pre-commit")).toBe("100755");
    const pb = join(t.fork.path, ".patchbook/changes/add-the-pre-commit/ours/.husky/pre-commit.pb");
    expect(isExecutable(pb)).toBe(true);
    expect(sh(["git", "ls-tree", "HEAD", relative(t.fork.path, pb)], { cwd: t.fork.path }).stdout).toStartWith("100755 ");
    chmodSync(join(t.fork.path, ".husky/pre-commit"), 0o644);
    writeFileSync(join(t.fork.path, ".husky/pre-commit"), "npm test --run\n");
    installManager(t.fork, ".husky");
    t.pb(["hook", "install"], { cwd: t.fork.path });
    expect(read(pb)).toContain("npm test --run");
    expect(isExecutable(pb)).toBe(true);
    expect(sh(["git", "ls-files", "-s", ".husky/pre-commit"], { cwd: t.fork.path }).stdout.split(" ")[0]).toBe("100755");
  });

  forkTest("commit deletes an upstream file and folder after git rm", (t) => {
    expect(existsSync(join(t.fork.path, ".patchbook/build.lock"))).toBe(true);
    sh(["git", "rm", "-q", "-r", "app.txt", "docs"], { cwd: t.fork.path });
    const commit = hookCommit(t, ["-m", "drop app.txt and docs"]);
    expect(commit.stderr).toContain("delete   app.txt");
    expect(commit.stderr).toContain("delete   docs/guide.md");
    expect(lastCommit(t)).toBe("drop app.txt and docs\n");
    expect(inHead(t, "app.txt", "docs")).toBe("");
    t.pb(["build"], { cwd: t.fork.path });
    expect(porcelain(t)).toBe("");
  });

  const shoutThenSync = (t: ForkCase, upstream: () => void) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout"]);
    upstream();
    t.up.commit("move app.txt");
    t.pb(["sync"], { cwd: t.fork.path });
  };

  forkTest("commit drops the file of a change retired after upstream deleted it", (t) => {
    shoutThenSync(t, () => t.up.rm("app.txt"));
    const pb = join(t.fork.path, ".patchbook");
    writeFileSync(join(pb, "series"), read(join(pb, "series")).replaceAll("shout\n", ""));
    rmSync(join(pb, "changes/shout"), { recursive: true });
    writeFileSync(join(pb, "retired.md"), read(join(pb, "retired.md")) + "\n- shout: upstream deleted app.txt\n");
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "retire shout"]);
    expect(inHead(t, "app.txt")).toBe("");
    expect(porcelain(t)).toBe("");
    t.pb(["build"], { cwd: t.fork.path });
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit drops the old name of a file a change follows across an upstream rename", (t) => {
    shoutThenSync(t, () => sh(["git", "mv", "app.txt", "renamed.txt"], { cwd: t.up.path }));
    const change = join(t.fork.path, ".patchbook/changes/shout");
    for (const copy of ["base", "ours"]) renameSync(join(change, copy, "app.txt.pb"), join(change, copy, "renamed.txt.pb"));
    writeFileSync(join(change, "CHANGE.md"), read(join(change, "CHANGE.md")).replaceAll("app.txt", "renamed.txt"));
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "repair shout"]);
    expect(inHead(t, "app.txt")).toBe("");
    expect(sh(["git", "show", "HEAD:renamed.txt"], { cwd: t.fork.path }).stdout).toContain("TWO");
    expect(porcelain(t)).toBe("");
    t.pb(["build"], { cwd: t.fork.path });
    expect(porcelain(t)).toBe("");
  });

  const headMode = (t: ForkCase, path: string): string => sh(["git", "ls-tree", "HEAD", path], { cwd: t.fork.path }).stdout.split(" ")[0]!;

  forkTest("commit takes a staged mode change and later commits leave it", (t) => {
    chmodSync(join(t.fork.path, "app.txt"), 0o755);
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "make app.txt executable"]);
    expect(headMode(t, "app.txt")).toBe("100755");
    t.fork.write("notes.txt", "notes\n");
    sh(["git", "add", "notes.txt"], { cwd: t.fork.path });
    const later = hookCommit(t, ["-m", "notes"]);
    expect(later.stderr).not.toContain("built from");
    expect(sh(["git", "show", "--summary", "--format=", "HEAD"], { cwd: t.fork.path }).stdout).not.toContain("app.txt");
    expect(headMode(t, "app.txt")).toBe("100755");
  });

  forkTest("commit records an edit staged with a mode change", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    chmodSync(join(t.fork.path, "app.txt"), 0o755);
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    const commit = hookCommit(t, ["-m", "shout and run"]);
    expect(commit.stderr).toContain("file     app.txt");
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("TWO");
    expect(headMode(t, "app.txt")).toBe("100755");
  });

  forkTest("commit records an edit staged with a mode change under an unstaged edit", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"), 0o755);
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    const staged = t.fork.read("app.txt");
    t.fork.write("app.txt", staged + "extra\n", 0o755);
    const commit = hookCommit(t, ["-m", "shout and run"], false);
    expect(commit.code).toBe(0);
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toBe(staged);
    expect(headMode(t, "app.txt")).toBe("100755");
    expect(t.fork.read("app.txt")).toBe(staged + "extra\n");
    expect(porcelain(t)).toBe(" M app.txt\n");
  });

  forkTest("commit takes a mode change to a file the fork added and records the mode the index already has", (t) => {
    t.fork.write("mine.sh", "echo mine\n", 0o755);
    sh(["git", "add", "mine.sh"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "add mine.sh"]);
    chmodSync(join(t.fork.path, "mine.sh"), 0o644);
    sh(["git", "add", "mine.sh"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "mine.sh is not a program"]);
    expect(headMode(t, "mine.sh")).toBe("100644");
    expect(isExecutable(join(t.fork.path, ".patchbook/changes/shout/ours/mine.sh.pb"))).toBe(false);
    expect(isExecutable(join(t.fork.path, "mine.sh"))).toBe(false);
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit records a staged file where upstream adds a program", (t) => {
    t.fork.write("new.sh", "mine\n");
    sh(["git", "add", "new.sh"], { cwd: t.fork.path });
    t.up.write("new.sh", "echo up\n", 0o755);
    t.up.commit("add new.sh");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    const commit = hookCommit(t, ["-m", "take upstream"]);
    expect(commit.stderr).toContain("file     new.sh");
    expect(sh(["git", "show", "HEAD:new.sh"], { cwd: t.fork.path }).stdout).toBe("mine\n");
  });

  forkTest("commit refuses to build over an intent-to-add file", (t) => {
    t.fork.write("new.sh", "mine\n");
    sh(["git", "add", "-N", "new.sh"], { cwd: t.fork.path });
    t.up.write("new.sh", "echo up\n", 0o755);
    t.up.commit("add new.sh");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    const commit = hookCommit(t, ["-m", "take upstream"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("the build changes these files, which have changes you haven't staged:\n  new.sh");
    expect(t.fork.read("new.sh")).toBe("mine\n");
  });

  forkTest("commit leaves out ignored output that build --commit left out", (t) => {
    writeFileSync(join(t.fork.path, ".git/info/exclude"), "*.log\n");
    t.up.write("keep.log", "kept\n");
    t.up.commit("a log");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build", "--commit"], { cwd: t.fork.path });
    for (const [line, shout] of [["two", "TWO"], ["three", "THREE"]] as const) {
      t.fork.write("app.txt", t.fork.read("app.txt").replaceAll(line, shout));
      sh(["git", "add", "app.txt"], { cwd: t.fork.path });
      expect(hookCommit(t, ["-m", `shout ${line}`]).stderr).not.toContain("keep.log");
      expect(committed(t)).not.toContain("keep.log");
      expect(t.fork.read("keep.log")).toBe("kept\n");
    }
    expect(sh(["git", "ls-files", "keep.log"], { cwd: t.fork.path }).stdout).toBe("");
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit takes a mode change from upstream", (t) => {
    t.up.write("app.txt", t.up.read("app.txt"), 0o755);
    t.up.commit("make app.txt executable");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "take upstream"]);
    expect(sh(["git", "ls-files", "-s", "app.txt"], { cwd: t.fork.path }).stdout).toStartWith("100755 ");
    expect(porcelain(t)).toBe("");
  });

  const lockOf = (t: ForkCase) => join(t.fork.path, ".patchbook/build.lock");

  permissionTest("failed commit leaves the patchbook as it found it", (t) => {
    const series = read(join(t.fork.path, ".patchbook/series"));
    const lock = read(lockOf(t));
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    chmodSync(lockOf(t), 0o444);
    const head = sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout;
    const commit = hookCommit(t, ["-m", "shout"], false);
    expect(commit.code).not.toBe(0);
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).toBe(head);
    expect(existsSync(join(t.fork.path, ".patchbook/changes/shout"))).toBe(false);
    expect(read(join(t.fork.path, ".patchbook/series"))).toBe(series);
    expect(read(lockOf(t))).toBe(lock);
    expect(porcelain(t)).toBe("M  app.txt\n");
  }, ForkCase);

  permissionTest("commit retried after a failed record holds the output and its record", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    chmodSync(lockOf(t), 0o444);
    expect(hookCommit(t, ["-m", "shout"], false).code).not.toBe(0);
    chmodSync(lockOf(t), 0o644);
    hookCommit(t, ["-m", "shout, retried"]);
    const files = committed(t);
    expect(files).toContain("app.txt");
    expect(files).toContain(".patchbook/series");
    expect(files).toContain(".patchbook/changes/shout/CHANGE.md");
    expect(files).toContain(".patchbook/build.lock");
    expect(porcelain(t)).toBe("");
  }, ForkCase);

  permissionTest("failed commit leaves the output as it found it", (t) => {
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("five", "FIVE"));
    t.up.commit("shout five");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    const app = t.fork.read("app.txt");
    const before = porcelain(t);
    chmodSync(lockOf(t), 0o444);
    expect(hookCommit(t, ["-m", "take upstream"], false).code).not.toBe(0);
    expect(t.fork.read("app.txt")).toBe(app);
    expect(porcelain(t)).toBe(before);
    chmodSync(lockOf(t), 0o644);
    hookCommit(t, ["-m", "take upstream"]);
    expect(committed(t)).toContain("app.txt");
    expect(t.fork.read("app.txt")).toContain("FIVE");
    expect(porcelain(t)).toBe("");
  }, ForkCase);

  /** Replaces `.patchbook/<name>` with a committed link to a copy outside the repo, and returns what the copy holds. */
  const linkPatchbook = (t: ForkCase, name: string) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("one", "ONE"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout one"]);
    const [inside, outside] = [join(t.fork.path, ".patchbook", name), join(t.tmp, `outside-${name.replaceAll("/", "-")}`)];
    if (!existsSync(inside)) t.fork.write(`.patchbook/${name}/keep`, "kept\n");
    renameSync(inside, outside);
    symlinkSync(outside, inside);
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    sh(["git", "commit", "-q", "-m", `${name} is a link`], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } });
    const held = () => sh(["find", outside, "-type", "f", "-exec", "cat", "{}", "+"], { cwd: t.tmp }).stdout;
    return { held, before: held() };
  };

  const shoutTwo = (t: ForkCase) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    return hookCommit(t, ["-m", "shout"], false);
  };

  for (const name of ["blocks", "changes", "series", "build.lock"]) {
    forkTest(`commit refuses a patchbook ${name} that is a link`, (t) => {
      const { held, before } = linkPatchbook(t, name);
      const commit = shoutTwo(t);
      expect(commit.code).not.toBe(0);
      expect(commit.stderr).toContain(`.patchbook/${name} is a link`);
      expect(commit.stderr).toContain("PATCHBOOK_HOOK=0");
      expect(held()).toBe(before);
      expect(porcelain(t)).toBe("M  app.txt\n");
    });
  }

  for (const [what, path] of [["change folder", "changes/shout"], ["CHANGE.md", "changes/shout/CHANGE.md"], ["side folder", "changes/shout/ours"]] as const) {
    forkTest(`commit refuses a ${what} that is a link`, (t) => {
      const { held, before } = linkPatchbook(t, path);
      const commit = shoutTwo(t);
      expect(commit.code).not.toBe(0);
      expect(commit.stderr).toContain(`.patchbook/${path} is a link`);
      expect(commit.stderr).toContain("a copy of what it points to");
      expect(held()).toBe(before);
      expect(porcelain(t)).toBe("M  app.txt\n");
    });
  }

  for (const name of ["config.toml", "upstream.lock"]) {
    forkTest(`commit goes through a patchbook ${name} that is a link`, (t) => {
      const { held, before } = linkPatchbook(t, name);
      expect(shoutTwo(t).code).toBe(0);
      expect(committed(t)).toContain("app.txt");
      expect(held()).toBe(before);
      expect(porcelain(t)).toBe("");
    });
  }

  /** Commits the `shout` change, then plants `link` in its `ours` copy, pointing at `outside` (made here, holding `keep.txt`). */
  const plantInShout = (t: ForkCase, link: string, file: boolean) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("one", "ONE"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout one"]);
    const outside = join(t.tmp, "outside");
    if (file) writeFileSync(outside, "keep\n");
    else t.fork.write("../outside/keep.txt", "keep\n");
    symlinkSync(outside, join(t.fork.path, ".patchbook/changes/shout/ours", link));
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    sh(["git", "commit", "-q", "-m", "plant a link"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } });
    return outside;
  };

  forkTest("commit refuses a recorded folder link named like a copy", (t) => {
    const outside = plantInShout(t, "d.pb", false);
    t.fork.write("d.pb/x", "payload\n");
    sh(["git", "add", "d.pb/x"], { cwd: t.fork.path });
    const commit = hookCommit(t, ["-m", "add d.pb/x"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain(".patchbook/changes/shout/ours/d.pb is a link");
    expect(readdirSync(outside)).toEqual(["keep.txt"]);
    expect(porcelain(t)).toBe("A  d.pb/x\n");
  });

  for (const [what, target] of [["a folder in the repo", "../../../../kept"], ["the changes folder", "../.."], ["its own side", "."]] as const) {
    forkTest(`commit refuses a recorded folder link to ${what}`, (t) => {
      plantInShout(t, "d.pb", false);
      const link = join(t.fork.path, ".patchbook/changes/shout/ours/d.pb");
      unlinkSync(link);
      t.fork.write("kept/keep.txt", "keep\n");
      symlinkSync(target, link);
      sh(["git", "add", "-A"], { cwd: t.fork.path });
      sh(["git", "commit", "-q", "-m", "point the link into the repo"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } });
      const before = readdirSync(link);
      t.fork.write("d.pb/x", "payload\n");
      sh(["git", "add", "d.pb/x"], { cwd: t.fork.path });
      const commit = hookCommit(t, ["-m", "add d.pb/x"], false);
      expect(commit.code).not.toBe(0);
      expect(commit.stderr).toContain(".patchbook/changes/shout/ours/d.pb is a link");
      expect(readdirSync(link)).toEqual(before);
      expect(porcelain(t)).toBe("A  d.pb/x\n");
    });
  }

  forkTest("commit refuses to build a copy read through a link copy", (t) => {
    const outside = plantInShout(t, "s.pb", false);
    writeFileSync(join(outside, "key.pb"), "secret\n");
    t.fork.write(".patchbook/changes/shout/CHANGE.md", t.fork.read(".patchbook/changes/shout/CHANGE.md") + "- add s.pb/key\n");
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    sh(["git", "commit", "-q", "-m", "add a copy under the link"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } });
    const commit = shoutTwo(t);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain(".patchbook/changes/shout/ours/s.pb is a link, and the copy of s.pb/key sits under it");
    expect(existsSync(join(t.fork.path, "s.pb"))).toBe(false);
    expect(porcelain(t)).toBe("M  app.txt\n");
  });

  forkTest("commit refuses to record under a link copy it just retargeted", (t) => {
    t.fork.write("kept/keep.txt", "keep\n");
    symlinkSync("kept", join(t.fork.path, "d"));
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "link d"]);
    const outside = join(t.tmp, "outside");
    mkdirSync(outside);
    unlinkSync(join(t.fork.path, "d"));
    symlinkSync(outside, join(t.fork.path, "d"));
    t.fork.write("d.pb/x", "payload\n");
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    const commit = hookCommit(t, ["-m", "retarget d"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain(".patchbook/changes/shout/ours/d.pb is a link");
    expect(readdirSync(outside)).toEqual([]);
    expect(readlinkSync(join(t.fork.path, ".patchbook/changes/shout/ours/d.pb"))).toBe("kept");
  });

  forkTest("commit refuses a folder link above a copy", (t) => {
    const outside = plantInShout(t, "sub", false);
    t.fork.write("sub/x", "payload\n");
    sh(["git", "add", "sub/x"], { cwd: t.fork.path });
    const commit = hookCommit(t, ["-m", "add sub/x"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain(".patchbook/changes/shout/ours/sub is a link");
    expect(readdirSync(outside)).toEqual(["keep.txt"]);
  });

  forkTest("commit replaces a recorded symlink without changing its target", (t) => {
    const outside = plantInShout(t, "note.txt.pb", true);
    t.fork.write("note.txt", "payload\n");
    sh(["git", "add", "note.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "add note.txt"]);
    expect(read(outside)).toBe("keep\n");
    expect(committed(t)).toContain("note.txt");
    expect(porcelain(t)).toBe("");
  });

  forkTest("commit refuses a link inside blocks", (t) => {
    const outside = join(t.tmp, "outside.md");
    writeFileSync(outside, "keep\n");
    mkdirSync(join(t.fork.path, ".patchbook/blocks"));
    symlinkSync(outside, join(t.fork.path, ".patchbook/blocks/app.txt.md"));
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    sh(["git", "commit", "-q", "-m", "link a block"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } });
    const commit = shoutTwo(t);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain(".patchbook/blocks/app.txt.md is a link");
    expect(read(outside)).toBe("keep\n");
    expect(porcelain(t)).toBe("M  app.txt\n");
  });

  const commitWithoutHook = (t: ForkCase, message: string) => {
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    sh(["git", "commit", "-q", "-m", message], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } });
  };

  const refusesLink = (out: Run, link: string) => {
    expect(out.stderr).toContain(`${link} is a link`);
    expect(out.stderr).toContain("replace the link with a copy of what it points to");
  };

  /** Links `.patchbook/blocks/app.txt.entries` to a file outside the repo, which holds an entry that patches app.txt to OUTSIDE when `patched` is set. */
  const linkEntries = (t: ForkCase, patched: boolean) => {
    const block = t.fork.read("app.txt").replace(/\n$/, "");
    const hash = createHash("sha256").update(block).digest("hex").slice(0, 12);
    const outside = join(t.tmp, "outside.entries");
    writeFileSync(outside, patched ? `=== entry ${hash}\nkind: policy\nrules: \nintent: Planted.\n--- upstream\n${block}\n--- patched\nOUTSIDE\n` : "");
    mkdirSync(join(t.fork.path, ".patchbook/blocks"));
    symlinkSync(outside, join(t.fork.path, ".patchbook/blocks/app.txt.entries"));
    commitWithoutHook(t, "link the entries");
    return outside;
  };

  forkTest("status refuses a linked entries file", (t) => {
    const outside = linkEntries(t, true);
    const before = read(outside);
    refusesLink(t.pb(["status"], { cwd: t.fork.path, code: 1 }), ".patchbook/blocks/app.txt.entries");
    expect(read(outside)).toBe(before);
  });

  forkTest("build refuses a linked entries file", (t) => {
    linkEntries(t, true);
    refusesLink(t.pb(["build"], { cwd: t.fork.path, code: 1 }), ".patchbook/blocks/app.txt.entries");
    expect(t.fork.read("app.txt")).not.toContain("OUTSIDE");
  });

  forkTest("record refuses a linked entries file", (t) => {
    const outside = linkEntries(t, true);
    const before = read(outside);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    refusesLink(t.pb(["record", "--intent", "Shout two."], { cwd: t.fork.path, code: 1 }), ".patchbook/blocks/app.txt.entries");
    expect(read(outside)).toBe(before);
  });

  forkTest("scaffold refuses a linked entries file", (t) => {
    const outside = linkEntries(t, false);
    appendFileSync(join(t.fork.path, ".patchbook/config.toml"), '\n[[check]]\npattern = "two"\n');
    commitWithoutHook(t, "check two");
    refusesLink(t.pb(["scaffold"], { cwd: t.fork.path, code: 1 }), ".patchbook/blocks/app.txt.entries");
    expect(read(outside)).toBe("");
  });

  for (const [what, path] of [["change folder", "changes/shout"], ["side folder", "changes/shout/ours"]] as const) {
    forkTest(`build refuses a ${what} that is a link`, (t) => {
      linkPatchbook(t, path);
      writeFileSync(join(readlinkSync(join(t.fork.path, ".patchbook", path)), path.endsWith("ours") ? "" : "ours", "app.txt.pb"), "OUTSIDE\n");
      refusesLink(t.pb(["build"], { cwd: t.fork.path, code: 1 }), `.patchbook/${path}`);
      expect(t.fork.read("app.txt")).not.toContain("OUTSIDE");
    });

    forkTest(`record refuses a ${what} that is a link`, (t) => {
      const { held, before } = linkPatchbook(t, path);
      t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
      refusesLink(t.pb(["record", "--intent", "Shout two."], { cwd: t.fork.path, code: 1 }), `.patchbook/${path}`);
      expect(held()).toBe(before);
    });
  }

  forkTest("record refuses a recorded folder named like a copy that is now a link", (t) => {
    t.fork.write("d.pb/X.md", "alpha\n");
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "add d.pb/X.md"]);
    const outside = join(t.tmp, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "X.md.pb"), "OUTSIDE\n");
    rmSync(join(t.fork.path, ".patchbook/changes/shout/ours/d.pb"), { recursive: true });
    symlinkSync(outside, join(t.fork.path, ".patchbook/changes/shout/ours/d.pb"));
    commitWithoutHook(t, "ours folder is a link");
    t.fork.write("d.pb/X.md", "alpha, edited\n");
    refusesLink(t.pb(["record", "--intent", "Edit d."], { cwd: t.fork.path, code: 1 }), ".patchbook/changes/shout/ours/d.pb");
    expect(read(join(outside, "X.md.pb"))).toBe("OUTSIDE\n");
  });

  forkTest("record refuses a link where it would start a change", (t) => {
    const outside = join(t.tmp, "outside");
    mkdirSync(outside);
    mkdirSync(join(t.fork.path, ".patchbook/changes"), { recursive: true });
    symlinkSync(outside, join(t.fork.path, ".patchbook/changes/add-new"));
    commitWithoutHook(t, "plant a change folder");
    t.fork.write("new.txt", "new\n");
    refusesLink(t.pb(["record", "add-new", "--intent", "Add new.txt."], { cwd: t.fork.path, code: 1 }), ".patchbook/changes/add-new");
    expect(readdirSync(outside)).toEqual([]);
    expect(read(join(t.fork.path, ".patchbook/series"))).not.toContain("add-new");
  });

  forkTest("record refuses a series that is a link", (t) => {
    const { held, before } = linkPatchbook(t, "series");
    t.fork.write("new.txt", "new\n");
    refusesLink(t.pb(["record", "add-new", "--intent", "Add new.txt."], { cwd: t.fork.path, code: 1 }), ".patchbook/series");
    expect(held()).toBe(before);
    expect(existsSync(join(t.fork.path, ".patchbook/changes/add-new"))).toBe(false);
  });

  forkTest("build refuses a build.lock that is a link", (t) => {
    const outside = join(t.tmp, "outside.lock");
    writeFileSync(outside, "kept\n");
    rmSync(join(t.fork.path, ".patchbook/build.lock"));
    symlinkSync(outside, join(t.fork.path, ".patchbook/build.lock"));
    commitWithoutHook(t, "build.lock is a link");
    refusesLink(t.pb(["build", "--force"], { cwd: t.fork.path, code: 1 }), ".patchbook/build.lock");
    expect(read(outside)).toBe("kept\n");
  });

  forkTest("record refuses a patchbook that is a link", (t) => {
    const outside = join(t.tmp, "outside-patchbook");
    renameSync(join(t.fork.path, ".patchbook"), outside);
    symlinkSync(outside, join(t.fork.path, ".patchbook"));
    commitWithoutHook(t, ".patchbook is a link");
    const before = tree(outside);
    t.fork.write("new.txt", "new\n");
    refusesLink(t.pb(["record", "add-new", "--intent", "Add new.txt."], { cwd: t.fork.path, code: 1 }), ".patchbook");
    expect(tree(outside)).toEqual(before);
  });

  for (const [what, file] of [["a path", "../outside.json"], ["a link", ".patchbook/terms.json"]] as const) {
    forkTest(`build refuses a placeholder file outside the repo through ${what}`, (t) => {
      writeFileSync(join(t.tmp, "outside.json"), '{"secret": "OUTSIDE"}\n');
      if (what === "a link") symlinkSync(join(t.tmp, "outside.json"), join(t.fork.path, file));
      t.fork.write("note.md", "{{term:secret}}\n");
      t.pb(["record", "--intent", "Add a note."], { cwd: t.fork.path });
      appendFileSync(join(t.fork.path, ".patchbook/config.toml"), `\n[placeholders.term]\nfile = "${file}"\n`);
      commitWithoutHook(t, "a placeholder file outside the repo");
      const out = t.pb(["build", "--force"], { cwd: t.fork.path, code: 1 });
      expect(out.stderr).toContain(`[placeholders.term] file "${file}" is outside the repo`);
      expect(t.fork.read("note.md")).not.toContain("OUTSIDE");
    });
  }

  permissionTest("failed commit puts a private copy back with its own mode when its bytes did not change", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("one", "ONE"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout one"]);
    const copy = join(t.fork.path, ".patchbook/changes/shout/ours/new.md.pb");
    writeFileSync(copy, "secret\n", { mode: 0o600 });
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    sh(["git", "commit", "-q", "-m", "keep a private copy"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } });
    t.fork.write("new.md", "secret\n");
    sh(["git", "add", "new.md"], { cwd: t.fork.path });
    chmodSync(lockOf(t), 0o444);
    expect(hookCommit(t, ["-m", "add new.md"], false).code).not.toBe(0);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
  }, ForkCase);

  for (const [where, target] of [["into the patchbook", ".patchbook"], ["to a folder beside it", "docs.bak"]] as const) {
    forkTest(`commit refuses an output folder replaced by a link ${where}`, (t) => {
      renameSync(join(t.fork.path, "docs"), join(t.fork.path, "docs.bak"));
      symlinkSync(target, join(t.fork.path, "docs"));
      sh(["git", "add", "-A"], { cwd: t.fork.path });
      const before = { files: tree(t.fork.path), staged: porcelain(t) };
      const commit = hookCommit(t, ["--allow-empty", "-m", "link docs"], false);
      expect(commit.code).not.toBe(0);
      expect(commit.stderr).toContain("docs is a link");
      expect(commit.stderr).toContain("docs/guide.md");
      expect(commit.stderr).not.toContain("fatal");
      expect(tree(t.fork.path)).toEqual(before.files);
      expect(porcelain(t)).toBe(before.staged);
    });
  }

  forkTest("commit -a refuses an output folder replaced by a link", (t) => {
    renameSync(join(t.fork.path, "docs"), join(t.fork.path, "docs.bak"));
    symlinkSync("docs.bak", join(t.fork.path, "docs"));
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("one", "ONE"));
    const before = tree(t.fork.path);
    const commit = hookCommit(t, ["-am", "link docs"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("docs is a link");
    expect(commit.stderr).not.toContain("fatal");
    expect(tree(t.fork.path)).toEqual(before);
  });

  forkTest("commit ignores an output folder replaced by a link that is not staged", (t) => {
    renameSync(join(t.fork.path, "docs"), join(t.fork.path, "docs.bak"));
    symlinkSync("docs.bak", join(t.fork.path, "docs"));
    hookCommit(t, ["--allow-empty", "-m", "nothing staged"]);
    expect(inHead(t, "docs")).toBe("docs/guide.md\n");
  });

  const FOLDER_TO_FILE = "can't record a folder turned into a file";

  forkTest("record refuses an output folder replaced by a file", (t) => {
    rmSync(join(t.fork.path, "docs"), { recursive: true });
    t.fork.write("docs", "x\n");
    const before = tree(t.fork.path);
    const out = t.pb(["record", "--intent", "Make docs a file."], { cwd: t.fork.path, code: 1 });
    expect(out.stderr).toContain("docs is a file now");
    expect(out.stderr).toContain("docs/guide.md");
    expect(out.stderr).toContain(FOLDER_TO_FILE);
    expect(out.stderr).not.toContain("PATCHBOOK_HOOK");
    expect(tree(t.fork.path)).toEqual(before);
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain("unrecorded docs:");
  });

  forkTest("record refuses a nested output folder replaced by a file", (t) => {
    t.up.write("deep/er/one.txt", "one\n");
    t.up.commit("add a nested folder");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "take upstream"]);
    rmSync(join(t.fork.path, "deep/er"), { recursive: true });
    t.fork.write("deep/er", "x\n");
    const before = tree(t.fork.path);
    const out = t.pb(["record", "--intent", "Make er a file."], { cwd: t.fork.path, code: 1 });
    expect(out.stderr).toContain("deep/er is a file now");
    expect(out.stderr).toContain("deep/er/one.txt");
    expect(out.stderr).toContain(FOLDER_TO_FILE);
    expect(tree(t.fork.path)).toEqual(before);
  });

  forkTest("record takes a folder that upstream turned into a file", (t) => {
    t.up.write("deep/er/one.txt", "one\n");
    t.up.commit("add a nested folder");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    rmSync(join(t.up.path, "deep/er"), { recursive: true });
    t.up.write("deep/er", "now a file\n");
    t.up.commit("deep/er is a file");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    const out = t.pb(["record", "--intent", "Shout two."], { cwd: t.fork.path });
    expect(out.stderr).not.toContain(FOLDER_TO_FILE);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("skill install leaves an output folder replaced by a file alone", (t) => {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    rmSync(join(t.fork.path, "docs"), { recursive: true });
    t.fork.write("docs", "x\n");
    const out = t.pb(["skill", "install"], { cwd: t.fork.path });
    expect(out.stdout).toContain(`wrote ${SKILL_FILE}`);
    expect(t.fork.read("docs")).toBe("x\n");
    expect(t.pb(["record", "--intent", "Make docs a file."], { cwd: t.fork.path, code: 1 }).stderr).toContain(FOLDER_TO_FILE);
  });

  forkTest("commit refuses an output folder replaced by a file", (t) => {
    rmSync(join(t.fork.path, "docs"), { recursive: true });
    t.fork.write("docs", "x\n");
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    const before = { files: tree(t.fork.path), staged: porcelain(t), head: sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout };
    const commit = hookCommit(t, ["-m", "docs is a file"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("docs");
    expect(commit.stderr).toContain(FOLDER_TO_FILE);
    expect(commit.stderr).toContain("PATCHBOOK_HOOK=0");
    expect(commit.stderr).not.toContain("fatal");
    expect(tree(t.fork.path)).toEqual(before.files);
    expect(porcelain(t)).toBe(before.staged);
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).toBe(before.head);
  });

  forkTest("commit refuses a nested output folder replaced by a file", (t) => {
    t.up.write("deep/er/one.txt", "one\n");
    t.up.commit("add a nested folder");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "take upstream"]);
    rmSync(join(t.fork.path, "deep/er"), { recursive: true });
    t.fork.write("deep/er", "x\n");
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    const before = { files: tree(t.fork.path), staged: porcelain(t) };
    const commit = hookCommit(t, ["-m", "deep/er is a file"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("deep/er");
    expect(commit.stderr).toContain(FOLDER_TO_FILE);
    expect(tree(t.fork.path)).toEqual(before.files);
    expect(porcelain(t)).toBe(before.staged);
  });

  forkTest("commit ignores an output folder replaced by a file that is not staged", (t) => {
    rmSync(join(t.fork.path, "docs"), { recursive: true });
    t.fork.write("docs", "x\n");
    hookCommit(t, ["--allow-empty", "-m", "nothing staged"]);
    expect(inHead(t, "docs")).toBe("docs/guide.md\n");
  });

  forkTest("commit records an output folder that is only deleted", (t) => {
    sh(["git", "rm", "-rq", "docs"], { cwd: t.fork.path });
    const commit = hookCommit(t, ["-m", "drop the docs"], false);
    expect(commit.code).toBe(0);
    expect(commit.stderr).not.toContain(FOLDER_TO_FILE);
    expect(inHead(t, "docs")).toBe("");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("commit records an output folder deleted while a file of its name is only marked with add -N", (t) => {
    rmSync(join(t.fork.path, "docs"), { recursive: true });
    t.fork.write("docs", "x\n");
    sh(["git", "add", "-u"], { cwd: t.fork.path });
    sh(["git", "add", "-N", "docs"], { cwd: t.fork.path });
    rmSync(join(t.fork.path, "docs"));
    mkdirSync(join(t.fork.path, "docs"));
    const commit = hookCommit(t, ["-m", "drop the guide"], false);
    expect(commit.stderr).not.toContain(FOLDER_TO_FILE);
    expect(commit.code).toBe(0);
    expect(inHead(t, "docs")).toBe("");
  });

  forkTest("commit takes a folder that upstream turned into a file", (t) => {
    t.up.write("deep/er/one.txt", "one\n");
    t.up.commit("add a nested folder");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "take upstream"]);
    rmSync(join(t.up.path, "deep/er"), { recursive: true });
    t.up.write("deep/er", "now a file\n");
    t.up.commit("deep/er is a file");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    const commit = hookCommit(t, ["-m", "take upstream again"], false);
    expect(commit.stderr).not.toContain(FOLDER_TO_FILE);
    expect(commit.code).toBe(0);
    expect(inHead(t, "deep")).toBe("deep/er\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("commit records an edit to a file that was always a file", (t) => {
    const commit = shoutTwo(t);
    expect(commit.code).toBe(0);
    expect(commit.stderr).not.toContain(FOLDER_TO_FILE);
    expect(committed(t)).toContain("app.txt");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  permissionTest("failed commit reports nothing stuck after putting back nested new folders", (t) => {
    t.up.write("deep/er/one.txt", "one\n");
    t.up.write("deep/other/two.txt", "two\n");
    t.up.commit("add nested folders");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    chmodSync(lockOf(t), 0o444);
    const commit = hookCommit(t, ["-m", "take upstream"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).not.toContain("couldn't put these back");
    expect(existsSync(join(t.fork.path, "deep"))).toBe(false);
  }, ForkCase);

  permissionTest("commit goes through when a folder in the patchbook can't be read", (t) => {
    writeFileSync(join(t.fork.path, ".git/info/exclude"), "*.junk\n");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout"]);
    const secret = join(t.fork.path, ".patchbook/changes/shout/secret");
    mkdirSync(secret);
    writeFileSync(join(secret, "s.junk"), "x\n");
    chmodSync(secret, 0o000);
    try {
      t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("three", "THREE"));
      sh(["git", "add", "app.txt"], { cwd: t.fork.path });
      hookCommit(t, ["-m", "shout again"]);
      expect(committed(t)).toContain("app.txt");
    } finally {
      chmodSync(secret, 0o755);
    }
  }, ForkCase);

  permissionTest("failed commit puts a private file back with its own mode", (t) => {
    const series = join(t.fork.path, ".patchbook/series");
    chmodSync(series, 0o600);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    chmodSync(lockOf(t), 0o444);
    expect(hookCommit(t, ["-m", "shout"], false).code).not.toBe(0);
    expect(statSync(series).mode & 0o777).toBe(0o600);
  }, ForkCase);

  permissionTest("failed commit lists what it could not put back", (t) => {
    const patchbook = join(t.fork.path, ".patchbook");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    mkdirSync(join(patchbook, "changes"));
    chmodSync(lockOf(t), 0o444);
    chmodSync(patchbook, 0o555);
    try {
      const commit = hookCommit(t, ["-m", "shout"], false);
      expect(commit.code).not.toBe(0);
      expect(commit.stderr).toMatch(/couldn't put these back as they were:\n  \S+\/\.patchbook\/series\n/);
      expect(commit.stderr).toContain("Check that you can write to them");
    } finally {
      chmodSync(patchbook, 0o755);
    }
  }, ForkCase);

  permissionTest("failed commit puts a private folder back with its own mode", (t) => {
    t.fork.write("private/New.md", "new\n");
    sh(["git", "add", "private/New.md"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "add private"]);
    const folder = join(t.fork.path, "private");
    chmodSync(folder, 0o700);
    const changes = join(t.fork.path, ".patchbook/changes");
    const change = readdirSync(changes).find((n) => read(join(changes, n, "CHANGE.md")).includes("private/New.md"))!;
    sh(["git", "rm", "-q", "-r", `.patchbook/changes/${change}`], { cwd: t.fork.path });
    const series = join(t.fork.path, ".patchbook/series");
    writeFileSync(series, read(series).split("\n").filter((l) => l.trim() !== change).join("\n"));
    sh(["git", "add", ".patchbook/series"], { cwd: t.fork.path });
    chmodSync(lockOf(t), 0o444);
    expect(hookCommit(t, ["-m", "drop private"], false).code).not.toBe(0);
    expect(t.fork.read("private/New.md")).toBe("new\n");
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  }, ForkCase);

  permissionTest("failed commit puts back the lock it rebuilt when nothing was recorded", (t) => {
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("five", "FIVE"));
    t.up.commit("shout five");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    const lock = read(lockOf(t));
    sh(["git", "write-tree"], { cwd: t.fork.path });
    const objects = join(t.fork.path, ".git/objects");
    const dirs = () => sh(["find", objects, "-type", "d"], { cwd: t.tmp }).stdout.split("\n").filter(Boolean);
    for (const d of dirs()) chmodSync(d, 0o555);
    try {
      expect(hookCommit(t, ["-m", "take upstream"], false).code).not.toBe(0);
    } finally {
      for (const d of dirs()) chmodSync(d, 0o755);
    }
    expect(read(lockOf(t))).toBe(lock);
    expect(t.fork.read("app.txt")).not.toContain("FIVE");
  }, ForkCase);

  // A hook with the paths of an older patchbook written into it. Nothing in the file marks it as one patchbook installs now.
  const bakedPathsHook = (extra = "") => `#!/bin/sh
# Installed by patchbook. On each commit, it records hand edits to the build output in the
# patchbook, rebuilds, and stages both. Skip it once with: PATCHBOOK_HOOK=0 git commit
[ "$PATCHBOOK_HOOK" = 0 ] && exit 0
${extra}if [ -f '/opt/my tools/patchbook-old' ]; then exec /usr/bin/interpreter '/opt/my tools/patchbook-old' hook run; fi
if command -v patchbook >/dev/null; then exec patchbook hook run; fi
echo "patchbook isn't installed, so this commit doesn't record hand edits." >&2
`;

  forkTest("hook with the paths of an older patchbook is another tool's hook", (t) => {
    const hook = join(t.fork.path, ".git/hooks/pre-commit");
    writeFileSync(hook, bakedPathsHook(), { mode: 0o755 });
    expect(t.pb(["build"], { cwd: t.fork.path }).stderr).not.toContain("patchbook:");
    expect(read(hook)).toBe(bakedPathsHook());
    expect(t.pb(["hook", "install"], { cwd: t.fork.path }).stderr).toContain("is another tool's hook; add `patchbook hook run`");
    expect(read(hook)).toBe(bakedPathsHook());
  });

  const unguardedHook = `#!/bin/sh
# Installed by patchbook v2. On each commit, it records hand edits to the build output in the
# patchbook, rebuilds, and stages both. Skip it once with: PATCHBOOK_HOOK=0 git commit
[ "$PATCHBOOK_HOOK" = 0 ] && exit 0
if command -v patchbook >/dev/null; then exec patchbook hook run; fi
echo "patchbook isn't installed, so this commit doesn't record hand edits." >&2
`;

  forkTest("hook without the patchbook check is rewritten", (t) => {
    const hook = join(t.fork.path, ".git/hooks/pre-commit");
    writeFileSync(hook, unguardedHook, { mode: 0o755 });
    expect(t.pb(["status", "--json"], { cwd: t.fork.path }).stderr).not.toContain("is another tool's hook");
    expect(read(hook)).toBe(unguardedHook);
    expect(t.pb(["hook", "install"], { cwd: t.fork.path }).stderr).toContain("updated");
    expect(read(hook)).toContain(".patchbook/config.toml");
    expect(read(hook)).not.toBe(unguardedHook);
    expect(t.pb(["hook", "install"], { cwd: t.fork.path }).stderr).toBe("");
  });

  forkTest("hook someone added lines to is left alone", (t) => {
    const hook = join(t.fork.path, ".git/hooks/pre-commit");
    const edited = unguardedHook + "other-tool --check || exit $?\n";
    writeFileSync(hook, edited, { mode: 0o755 });
    expect(t.pb(["build"], { cwd: t.fork.path }).stderr).not.toContain("patchbook:");
    expect(t.pb(["status", "--json"], { cwd: t.fork.path }).stderr).not.toContain("patchbook:");
    expect(read(hook)).toBe(edited);
    expect(t.pb(["hook", "install"], { cwd: t.fork.path }).stderr).toContain("is another tool's hook; add `patchbook hook run`");
    expect(read(hook)).toBe(edited);
  });

  forkTest("a core.hooksPath elsewhere gets the lines to add", (t) => {
    sh(["git", "config", "core.hooksPath", ".githooks"], { cwd: t.fork.path });
    const install = t.pb(["hook", "install"], { cwd: t.fork.path }).stderr;
    expect(install).toContain(".githooks/pre-commit");
    expect(install).toContain("patchbook hook run");
    expect(existsSync(join(t.fork.path, ".githooks"))).toBe(false);
    Object.assign(t.env, { PATCHBOOK_HOOK: "1" });
    expect(t.pb(["status"], { cwd: t.fork.path }).stderr).toContain(".githooks/pre-commit");
    t.fork.write(".githooks/pre-commit", "patchbook hook run || exit 1\n", 0o755);
    const added = t.pb(["status"], { cwd: t.fork.path, code: 1 });
    expect(added.stdout).toContain("unrecorded .githooks/pre-commit");
    expect(added.stderr).not.toContain(".githooks/pre-commit");
  });

  forkTest("a setting comes from the default, the user config, the project config, then the environment, in that order", (t) => {
    const project = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(project, "# my settings\n" + read(project));
    expect(t.config(["intent.provider"])).toMatch(/"claude" .*default/);
    t.config(["intent.provider", "codex"]);
    t.config(["intent.model", "gpt-6-sol"]);
    expect(t.config(["intent.model"])).toMatch(/"gpt-6-sol" .*user/);
    // The project picks another provider, so the user's codex model doesn't apply.
    t.config(["--project", "intent.provider", "claude"]);
    expect(t.config(["intent.provider"])).toMatch(/"claude" .*project/);
    expect(t.config(["intent.model"])).toMatch(/"claude-haiku-5-5" .*default/);
    expect(read(project)).toContain("# my settings");
    // An env var beats both.
    expect(t.config(["intent.provider"], { PATCHBOOK_PROVIDER: "codex" })).toMatch(/"codex" .*env/);
    t.config(["--project", "--unset", "intent.provider"]);
    expect(t.config(["intent.model"])).toContain('"gpt-6-sol"');
    expect(t.pb(["config", "--project", "store.path", "/x"], { cwd: t.fork.path, code: 1 }).stderr)
      .toContain("can only be set in the user config");
  });

  forkTest("settings with awkward text read back as given", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    const model = `sm😀ke "q" \\b \x01 \x7f é`;
    t.config(["intent.model", model]);
    expect((Bun.TOML.parse(read(user)) as { intent: { model: string } }).intent.model).toBe(model);
    expect(t.config(["intent.model"])).toContain("user");
    const agents = ['a😀', 'b"c', "d\\e"];
    t.config(["start.agents", agents.join(",")]);
    expect((Bun.TOML.parse(read(user)) as { start: { agents: string[] } }).start.agents).toEqual(agents);
    expect(t.config(["start.agents"])).toContain("user");
  });

  forkTest("config changes a dotted key or inline table in place", (t) => {
    const project = join(t.fork.path, ".patchbook/config.toml");
    const original = read(project);
    for (const on of ["hook.enabled = true", "hook = { enabled = true }"]) {
      const before = original.replaceAll('layout = "fork"\n', `layout = "fork"\n${on}\n`);
      writeFileSync(project, before);
      t.config(["--project", "hook.enabled", "false"]);
      expect(t.config(["hook.enabled"], { PATCHBOOK_HOOK: "" })).toMatch(/false .*project/);
      expect(read(project)).toBe(before.replaceAll(on, on.replaceAll("true", "false")));
    }
  });

  forkTest("config refuses to edit a setting whose section is not a table", (t) => {
    const project = join(t.fork.path, ".patchbook/config.toml");
    const before = read(project).replaceAll('layout = "fork"\n', 'layout = "fork"\nhook = true\n');
    writeFileSync(project, before);
    expect(t.pb(["config", "--project", "hook.enabled", "false"], { cwd: t.fork.path, code: 1 }).stderr)
      .toContain("hook in the config must be a table, as in [hook]");
    expect(read(project)).toBe(before);
  });

  forkTest("config set and unset keep the rest of a commented file", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    const before = dedent(`
      # my patchbook settings
      [start]
      # agents I install for, by machine
      by_host = [
        ["laptop", "claude-code"],
        ["server", "codex"],
      ]
      agents = ["claude-code"] # for now

      [intent]
      model = "claude-haiku-5-5"
    `);
    writeFileSync(user, before);
    t.config(["start.agents", "codex"]);
    expect(t.config(["start.agents"])).toMatch(/\["codex"\] .*user/);
    expect(read(user)).toBe(before.replaceAll('agents = ["claude-code"] # for now', 'agents = ["codex"] # for now'));
    t.config(["--unset", "start.agents"]);
    expect(t.config(["start.agents"])).toMatch(/\["claude-code", "codex"\] .*default/);
    expect(read(user)).toBe(before.replaceAll('agents = ["claude-code"] # for now\n', ""));
  });

  forkTest("config replaces a value that spans lines", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    writeFileSync(user, '[start]\nagents = [\n  "claude-code",\n  "codex",\n]\n');
    t.config(["start.agents", "codex"]);
    expect(t.config(["start.agents"])).toMatch(/\["codex"\] .*user/);
    expect(Bun.TOML.parse(read(user))).toEqual({ start: { agents: ["codex"] } });
  });

  forkTest("config refuses an edit it cannot make safely", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    for (const [before, model, cause] of [
      ["[intent]\nmodel = 'old'\n", "first\r\nsecond", 'turn intent.model into "first\\nsecond", not "first\\r\\nsecond"'],
      ['[__proto__]\nkeep = "this"\n\n[intent]\nmodel = "old"\n', "new", "drop __proto__"],
      ['[other]\nwhen = 2016-12-31T23:59:60Z\n\n[intent]\nmodel = "old"\n', "new", "the TOML library failed on it (RangeError: "],
    ]) {
      writeFileSync(user, before!);
      const out = t.pb(["config", "intent.model", model!], { cwd: t.fork.path, code: 1 });
      expect(out.stderr).toContain(`can't change intent.model in ${user} safely: `);
      expect(out.stderr).toContain(cause!);
      expect(out.stderr).toContain("The file is left as it was.");
      expect(out.stderr).not.toContain("    at ");
      expect(read(user)).toBe(before!);
    }
  });

  forkTest("config unset keeps the comments above the key", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    const unset = (before: string, name: string, after: string) => {
      writeFileSync(user, before);
      t.config(["--unset", name]);
      expect(read(user)).toBe(after);
    };
    unset(
      '[start]\n# agents I install for\nagents = ["claude-code"] # for now\nby_host = []\n',
      "start.agents",
      "[start]\n# agents I install for\nby_host = []\n",
    );
    unset(
      '# agents I install for\nstart.agents = [\n  "claude-code",\n]\n[intent]\nmodel = "x"\n',
      "start.agents",
      '# agents I install for\n[intent]\nmodel = "x"\n',
    );
    unset(
      '# the hook\nhook = { enabled = true }\n',
      "hook.enabled",
      '# the hook\nhook = {}\n',
    );
  });

  forkTest("config unset leaves no fragment of a multi-line value", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    const unset = (before: string, after: string) => {
      writeFileSync(user, before);
      t.config(["--unset", "start.agents"]);
      expect(read(user)).toBe(after);
    };
    unset(
      '[start]\n# agents I install for\nagents = [ # open\n  "claude-code", # first\n  # between\n  "codex"\n] # close\nby_host = []\n',
      "[start]\n# agents I install for\nby_host = []\n",
    );
    unset(
      '# top\n[start]\n\n# agents\n# more\nagents = [\n  "claude-code", # first\n  "codex",\n]\n# about by_host\nby_host = []\n',
      "# top\n[start]\n\n# agents\n# more\n# about by_host\nby_host = []\n",
    );
    unset(
      '[intent]\nmodel = "x"\n[start]\nagents = [ # open\n  "codex",\n]\n',
      '[intent]\nmodel = "x"\n[start]\n',
    );
  });

  forkTest("config unset keeps the comment above a key whatever the library would have changed", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    const unset = (before: string, after: string) => {
      writeFileSync(user, before);
      t.config(["--unset", "intent.model"]);
      expect(read(user)).toBe(after);
    };
    unset("[intent]\n# above\nmodel = 7243981605\n# below\n", "[intent]\n# above\n# below\n");
    unset('[ table ]\nx = 1\n[intent]\n# above\nmodel = "old"\n', "[ table ]\nx = 1\n[intent]\n# above\n");
    unset('[intent]\n# above\nmodel = "old" # after\n', "[intent]\n# above\n");
  });

  forkTest("config unset refuses rather than drop a comment", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    const before = "[hook]\n# about enabled\nenabled.x = 1\n";
    writeFileSync(user, before);
    const out = t.pb(["config", "--unset", "hook.enabled"], { cwd: t.fork.path, code: 1 });
    expect(out.stderr).toContain(`can't change hook.enabled in ${user} safely: the TOML library would drop the comment "# about enabled"`);
    expect(read(user)).toBe(before);
  });

  forkTest("config sets and unsets a setting in a CRLF user config, keeping its endings, and says what it set", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    const before = '# my settings\r\n[start]\r\n# agents\r\nagents = ["claude-code"]\r\nby_host = []\r\n';
    writeFileSync(user, before);
    const set = t.pb(["config", "start.agents", "codex"], { cwd: t.fork.path });
    expect([set.stdout, set.stderr]).toEqual([`start.agents = ["codex"] in ${user}\n`, ""]);
    expect(read(user)).toBe(before.replaceAll('["claude-code"]', '["codex"]'));
    const unset = t.pb(["config", "--unset", "start.agents"], { cwd: t.fork.path });
    expect([unset.stdout, unset.stderr]).toEqual(["", ""]);
    expect(read(user)).toBe("# my settings\r\n[start]\r\n# agents\r\nby_host = []\r\n");
  });

  forkTest("a config with an integer too big for Bun says so in either scope", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    const project = join(t.fork.path, ".patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    const big = "[other]\nbig = 9007199254740993\n";
    writeFileSync(user, big);
    for (const args of [["config", "intent.model", "x"], ["config", "--unset", "start.agents"], ["config", "intent.model"]]) {
      const out = t.pb(args, { cwd: t.fork.path, code: 1 });
      expect(out.stderr).toContain(`${user} holds an integer`);
      expect(out.stderr).toContain("Bun can't represent");
      expect(out.stderr).not.toContain("isn't valid TOML");
    }
    expect(read(user)).toBe(big);
    unlinkSync(user);
    const before = read(project);
    writeFileSync(project, before + big);
    for (const args of [["config", "--project", "hook.enabled", "false"], ["config", "--project", "--unset", "hook.enabled"], ["status"], ["build"]]) {
      const out = t.pb(args, { cwd: t.fork.path, code: 1 });
      expect(out.stderr).toContain(`${project} holds an integer`);
      expect(out.stderr).toContain("Bun can't represent");
      expect(out.stderr).not.toContain("isn't valid TOML");
    }
    expect(read(project)).toBe(before + big);
  });

  forkTest("config starts a user config that does not exist", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    t.config(["--unset", "start.agents"]);
    expect(existsSync(user)).toBe(false);
    t.config(["start.agents", "codex"]);
    expect(read(user)).toBe('[start]\nagents = ["codex"]\n');
    expect(t.config(["start.agents"])).toMatch(/\["codex"\] .*user/);
  });

  forkTest("track writes awkward values so they read back as given", (t) => {
    const lib = new Repo(join(t.tmp, AWKWARD("lib")));
    lib.write(`${AWKWARD("plug")}/a.txt`, "a\n");
    lib.commit("lib");
    const name = AWKWARD("name");
    const mount = AWKWARD("mount");
    t.pb(["track", name, lib.path, "--path", AWKWARD("plug"), "--mount", mount, "--vendor", AWKWARD("vend")], { cwd: t.fork.path });
    const tracked = upstreamsOf(read(join(t.fork.path, ".patchbook/config.toml"))).at(-1);
    expect(tracked).toMatchObject({ name, remote: lib.path, path: AWKWARD("plug"), mount, vendor: AWKWARD("vend") });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain(name);
  });

  forkTest("a project config that is not TOML is named in the error", (t) => {
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, 'layout = "fork"\n[[upstream]\nname = "x"\n');
    for (const args of [["status"], ["build"], ["config"]]) {
      const out = t.pb(args, { cwd: t.fork.path, code: 1 });
      expect(out.stderr).toContain(`${config} isn't valid TOML`);
      expect(out.stderr).not.toContain("SyntaxError");
      expect(out.stderr).not.toContain("    at ");
    }
  });

  forkTest("config writes the user config inside a book that fails to load", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replaceAll('layout = "fork"', 'layout = "bogus"'));
    const broken = t.pb(["status"], { cwd: t.fork.path, code: 1 }).stderr;
    expect(broken).toContain("bogus");
    expect(t.pb(["config", "intent.model", "fake-x"], { cwd: t.fork.path }).stdout).toContain("intent.model");
    expect((Bun.TOML.parse(read(user)) as { intent: { model: string } }).intent.model).toBe("fake-x");
    t.pb(["config", "--unset", "intent.model"], { cwd: t.fork.path });
    expect(read(user)).not.toContain("fake-x");
    for (const args of [["config"], ["config", "intent.model"], ["config", "--project", "intent.model", "p-x"]]) {
      const out = t.pb(args, { cwd: t.fork.path, code: 1 });
      expect(out.stderr).toBe(broken);
    }
    expect(read(config)).not.toContain("p-x");
  });

  forkTest("config writes the user config inside a book whose hooks throw", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    writeFileSync(join(t.fork.path, ".patchbook/hooks.ts"), 'throw new Error("hooks blew up");\n');
    t.pb(["config", "intent.model", "fake-x"], { cwd: t.fork.path });
    expect((Bun.TOML.parse(read(user)) as { intent: { model: string } }).intent.model).toBe("fake-x");
    t.pb(["config", "--unset", "intent.model"], { cwd: t.fork.path });
    expect(read(user)).not.toContain("fake-x");
  });

  forkTest("config writes the user config and leaves a missing hook alone in a clone", (t) => {
    sh(["git", "clone", "-q", t.fork.path, "teammate"], { cwd: t.tmp });
    const teammate = new Repo(join(t.tmp, "teammate"));
    const hook = join(teammate.path, ".git/hooks/pre-commit");
    expect(existsSync(hook)).toBe(false);
    const out = t.pb(["config", "intent.model", "fake-x"], { cwd: teammate.path });
    expect(out.stdout).toContain("intent.model");
    expect(out.stderr).not.toContain("pre-commit hook");
    expect(existsSync(hook)).toBe(false);
  });

  forkTest("a user config that is not TOML is named in the error", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    writeFileSync(user, "start.agents = [\n");
    for (const args of [["config"], ["config", "intent.model"], ["config", "intent.model", "x"]]) {
      const out = t.pb(args, { cwd: t.fork.path, code: 1 });
      expect(out.stderr).toContain(`${user} isn't valid TOML`);
      expect(out.stderr).not.toContain("SyntaxError");
      expect(out.stderr).not.toContain("    at ");
    }
    expect(read(user)).toBe("start.agents = [\n");
  });

  forkTest("a commit records nothing while hook.enabled is false in the project config", (t) => {
    t.config(["--project", "hook.enabled", "false"]);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "commit", "-qam", "shout"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "" } });
    expect(existsSync(join(t.fork.path, ".patchbook/changes/shout"))).toBe(false);
  });

  forkTest("build refuses to overwrite hand edits", (t) => {
    t.recordFeature();
    t.fork.write("app.txt", "hand edit\n");
    t.pb(["build"], { cwd: t.fork.path, code: 1 });
    t.pb(["build", "--force"], { cwd: t.fork.path });
    expect(t.fork.read("app.txt")).toContain("TWO");
  });

  /** Writes a change by hand and lists it in the series, with the ours copies of the files it adds or replaces. */
  const handChange = (t: ForkCase, name: string, intent: string, edits: string[], ours: Record<string, string> = {}): void => {
    const dir = join(t.fork.path, ".patchbook/changes", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CHANGE.md"), `# ${name}\n\nintent: ${intent}\n\nedits:\n${edits.map((e) => `- ${e}\n`).join("")}`);
    for (const [path, text] of Object.entries(ours)) {
      mkdirSync(dirname(join(dir, "ours", `${path}.pb`)), { recursive: true });
      writeFileSync(join(dir, "ours", `${path}.pb`), text);
    }
    const series = join(t.fork.path, ".patchbook/series");
    writeFileSync(series, (existsSync(series) ? read(series) : "") + name + "\n");
  };
  const changeText = (t: ForkCase, name: string): string => read(join(t.fork.path, ".patchbook/changes", name, "CHANGE.md"));
  const outputs = (t: ForkCase): Record<string, string> =>
    Object.fromEntries(Object.entries(tree(t.fork.path)).filter(([p]) => !p.startsWith(".patchbook/")));
  const without = (files: Record<string, string>, path: string): Record<string, string> =>
    Object.fromEntries(Object.entries(files).filter(([p]) => p !== path));

  forkTest("record deleting the output of a replace moves the deletion into the new change", (t) => {
    handChange(t, "rep", "Replace the guide.", ["replace docs/guide.md"], { "docs/guide.md": "replaced\n" });
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("docs/guide.md")).toBe("replaced\n");
    const before = outputs(t);
    t.fork.rm("docs/guide.md");
    const out = t.pb(["record", "dropguide", "--intent", "Drop the guide."], { cwd: t.fork.path });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(outputs(t)).toEqual(without(before, "docs/guide.md"));
    expect(changeText(t, "rep")).not.toContain("replace");
    expect(changeText(t, "rep")).toContain("intent: Replace the guide.");
    expect(existsSync(join(t.fork.path, ".patchbook/changes/rep/ours/docs/guide.md.pb"))).toBe(false);
    expect(changeText(t, "dropguide")).toContain("intent: Drop the guide.");
    expect(changeText(t, "dropguide")).toContain("- delete docs/guide.md");
    expect(read(join(t.fork.path, ".patchbook/series"))).toBe("rep\ndropguide\n");
    expect(out.stdout).toBe("delete   docs/guide.md (replace removed from rep)\n");
  });

  forkTest("record deleting the output of a replace asks the model for the name and intent", (t) => {
    handChange(t, "rep", "Replace the guide.", ["replace docs/guide.md"], { "docs/guide.md": "replaced\n" });
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.rm("docs/guide.md");
    const out = t.pb(["record"], { cwd: t.fork.path });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    expect(changeText(t, "shout")).toContain("- delete docs/guide.md");
    expect(changeText(t, "rep")).not.toContain("replace");
    expect(out.stdout).toBe("shout: Shout the second line.\ndelete   docs/guide.md (replace removed from rep)\n");
  });

  forkTest("record deleting the output of a replace in the named change that owns it", (t) => {
    handChange(t, "rep", "Replace the guide.", ["replace docs/guide.md"], { "docs/guide.md": "replaced\n" });
    t.pb(["build"], { cwd: t.fork.path });
    const before = outputs(t);
    t.fork.rm("docs/guide.md");
    const out = t.pb(["record", "rep"], { cwd: t.fork.path });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(outputs(t)).toEqual(without(before, "docs/guide.md"));
    expect(changeText(t, "rep")).toBe("# rep\n\nintent: Shout the second line.\n\nedits:\n- delete docs/guide.md\n");
    expect(existsSync(join(t.fork.path, ".patchbook/changes/rep/ours/docs/guide.md.pb"))).toBe(false);
    expect(read(join(t.fork.path, ".patchbook/series"))).toBe("rep\n");
    expect(out.stdout).toBe("delete   docs/guide.md (replace removed from rep)\nintent   rep: Shout the second line.\n");
    const prompt = read(join(t.tmp, "prompt.txt"));
    expect(prompt).toContain('For "rep": write its intent again, to cover all of its edits below. Its intent now: Replace the guide.\n');
    expect(prompt).toContain("docs/guide.md: deleted");
    expect(prompt).not.toContain("docs/guide.md: replaced");
  });

  forkTest("record deleting the output of a replace prints no note when the second change cannot be saved", (t) => {
    if (process.getuid?.() === 0) return;
    handChange(t, "rep", "Replace the guide.", ["replace docs/guide.md"], { "docs/guide.md": "replaced\n" });
    handChange(t, "late", "Late.", ["add notes/late.txt"], { "notes/late.txt": "late\n" });
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.rm("docs/guide.md");
    const dir = join(t.fork.path, ".patchbook/changes/late");
    chmodSync(join(dir, "CHANGE.md"), 0o444);
    chmodSync(dir, 0o555);
    try {
      const out = t.pb(["record", "late"], { cwd: t.fork.path, code: 1 });
      expect(out.stdout).toBe("");
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  forkTest("record deleting the output of a replace keeps the ours copy when the owner cannot be saved", (t) => {
    if (process.getuid?.() === 0) return;
    handChange(t, "rep", "Replace the guide.", ["replace docs/guide.md"], { "docs/guide.md": "replaced\n" });
    t.pb(["build"], { cwd: t.fork.path });
    const before = outputs(t);
    t.fork.rm("docs/guide.md");
    const owner = join(t.fork.path, ".patchbook/changes/rep/CHANGE.md");
    const ours = join(t.fork.path, ".patchbook/changes/rep/ours/docs/guide.md.pb");
    chmodSync(owner, 0o444);
    try {
      t.pb(["record", "dropguide", "--intent", "Drop the guide."], { cwd: t.fork.path, code: 1 });
      expect(existsSync(ours)).toBe(true);
    } finally {
      chmodSync(owner, 0o644);
    }
    t.pb(["record", "dropguide", "--intent", "Drop the guide."], { cwd: t.fork.path });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(outputs(t)).toEqual(without(before, "docs/guide.md"));
    expect(existsSync(ours)).toBe(false);
  });

  forkTest("record unadd keeps the ours copy when the named change cannot be saved", (t) => {
    if (process.getuid?.() === 0) return;
    t.fork.write("extra.txt", "ours\n");
    t.pb(["record", "ch", "--intent", "Add extra."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    const before = outputs(t);
    t.fork.rm("extra.txt");
    const owner = join(t.fork.path, ".patchbook/changes/ch/CHANGE.md");
    const ours = join(t.fork.path, ".patchbook/changes/ch/ours/extra.txt.pb");
    chmodSync(owner, 0o444);
    try {
      t.pb(["record", "ch"], { cwd: t.fork.path, code: 1 });
      expect(existsSync(ours)).toBe(true);
    } finally {
      chmodSync(owner, 0o644);
    }
    t.pb(["record", "ch"], { cwd: t.fork.path });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(outputs(t)).toEqual(without(before, "extra.txt"));
    expect(existsSync(ours)).toBe(false);
  });

  forkTest("record deleting the source of a copy that was never built keeps the copy", (t) => {
    handChange(t, "addn", "Add n.", ["add notes/n.txt"], { "notes/n.txt": "new\n" });
    t.pb(["build"], { cwd: t.fork.path });
    handChange(t, "cp", "Copy n.", ["copy notes/n.txt -> manual/n.txt"]);
    t.fork.rm("notes/n.txt");
    const out = t.pb(["record", "dropit", "--intent", "Drop it."], { cwd: t.fork.path });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(outputs(t)["manual/n.txt"]).toBe("new\n");
    expect(existsSync(join(t.fork.path, "notes/n.txt"))).toBe(false);
    expect(out.stdout).toBe("delete   notes/n.txt\n");
  });

  forkTest("status and build count add, replace, copy, move and delete edits, a folder copy as one", (t) => {
    handChange(t, "all", "Every kind.", [
      "add notes/n.txt",
      "replace docs/guide.md",
      "copy docs -> manual/docs",
      "move bin -> tools",
      "delete app.txt",
    ], { "notes/n.txt": "new\n", "docs/guide.md": "mine\n" });
    const status = t.pb(["status", "--json"], { cwd: t.fork.path });
    expect(JSON.parse(status.stdout)).toMatchObject({ applied: 5, problems: [] });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("5 edits apply");
    expect(t.pb(["build"], { cwd: t.fork.path }).stdout).toContain("with 5 edits");
  });

  forkTest("status does not count a structure edit that does not apply", (t) => {
    handChange(t, "gone", "Gone.", ["delete missing.txt", "copy missing -> there"]);
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 });
    expect(status.stdout).toContain("0 edits apply");
  });

  forkTest("record unadd that empties the named change saves it and keeps it", (t) => {
    t.fork.write("extra.txt", "ours\n");
    t.pb(["record", "ch", "--intent", "Add extra."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    const before = outputs(t);
    t.fork.rm("extra.txt");
    const out = t.pb(["record", "ch"], { cwd: t.fork.path });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(outputs(t)).toEqual(without(before, "extra.txt"));
    expect(changeText(t, "ch")).toBe("# ch\n\nintent: Add extra.\n\nedits:\n");
    expect(existsSync(join(t.fork.path, ".patchbook/changes/ch/ours/extra.txt.pb"))).toBe(false);
    expect(read(join(t.fork.path, ".patchbook/series"))).toBe("ch\n");
    expect(out.stdout).toBe("unadd    extra.txt (from ch)\n");
  });

  forkTest("record unadd that empties a change does not create the new change it was named for", (t) => {
    t.fork.write("extra.txt", "ours\n");
    t.pb(["record", "ch", "--intent", "Add extra."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.rm("extra.txt");
    expect(t.pb(["record", "other", "--intent", "Nothing to record."], { cwd: t.fork.path }).stdout).toBe("unadd    extra.txt (from ch)\nintent   not used: the edits went to ch\n");
    expect(existsSync(join(t.fork.path, ".patchbook/changes/other"))).toBe(false);
    expect(read(join(t.fork.path, ".patchbook/series"))).toBe("ch\n");
    expect(changeText(t, "ch")).toBe("# ch\n\nintent: Add extra.\n\nedits:\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  // What deleting the output of a move or a copy does, for upstream's file and for a file a change added.
  const MOVES: { name: string; edit: string; added: boolean; gone: string }[] = [
    { name: "record deleting the destination of a move of an upstream file", edit: "move docs/guide.md -> manual/guide.md", added: false, gone: "manual/guide.md" },
    { name: "record deleting the destination of a copy of an upstream file", edit: "copy docs/guide.md -> manual/guide.md", added: false, gone: "manual/guide.md" },
    { name: "record deleting the source of a copy of an upstream file", edit: "copy docs/guide.md -> manual/guide.md", added: false, gone: "docs/guide.md" },
    { name: "record deleting the destination of a move of an added file", edit: "move notes/n.txt -> manual/n.txt", added: true, gone: "manual/n.txt" },
    { name: "record deleting the destination of a copy of an added file", edit: "copy notes/n.txt -> manual/n.txt", added: true, gone: "manual/n.txt" },
    { name: "record deleting the source of a copy of an added file", edit: "copy notes/n.txt -> manual/n.txt", added: true, gone: "notes/n.txt" },
  ];
  for (const { name, edit, added, gone } of MOVES) {
    forkTest(name, (t) => {
      if (added) handChange(t, "addn", "Add n.", ["add notes/n.txt"], { "notes/n.txt": "new\n" });
      handChange(t, "mv", "Move or copy it.", [edit]);
      t.pb(["build"], { cwd: t.fork.path });
      const before = outputs(t);
      expect(before[gone]).toBeDefined();
      t.fork.rm(gone);
      const out = t.pb(["record", "dropit", "--intent", "Drop it."], { cwd: t.fork.path });
      expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
      t.pb(["build"], { cwd: t.fork.path });
      expect(outputs(t)).toEqual(without(before, gone));
      expect(changeText(t, "dropit")).toContain(`- delete ${gone}`);
      expect(changeText(t, "mv")).toContain(`- ${edit}`);
      if (added) expect(changeText(t, "addn")).toContain("- add notes/n.txt");
      expect(out.stdout).toBe(`delete   ${gone}\n`);
    });
  }

  forkTest("record deleting the source of a copy of a replaced file keeps the copy", (t) => {
    handChange(t, "rep", "Replace the guide.", ["replace docs/guide.md"], { "docs/guide.md": "replaced\n" });
    handChange(t, "cp", "Copy the guide.", ["copy docs/guide.md -> manual/guide.md"]);
    t.pb(["build"], { cwd: t.fork.path });
    const before = outputs(t);
    expect(before["manual/guide.md"]).toBe("replaced\n");
    t.fork.rm("docs/guide.md");
    const out = t.pb(["record", "dropguide", "--intent", "Drop the guide."], { cwd: t.fork.path });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(outputs(t)).toEqual(without(before, "docs/guide.md"));
    expect(changeText(t, "rep")).toContain("- replace docs/guide.md");
    expect(out.stdout).toBe("delete   docs/guide.md\n");
  });

  // #28: identical paragraphs, CRLF files, and edits to the outputs of a copy.
  const DUP = "# Title\n\nExample:\n\nfirst body\n\nExample:\n\nsecond body\n";
  const upstreamFile = (t: ForkCase, path: string, text: string): void => {
    writeFileSync(join(t.up.path, path), text);
    t.up.commit(`add ${path}`);
    syncAndBuild(t);
  };
  const keepEntry = (t: ForkCase, rel: string, hash: string, text: string): void => {
    mkdirSync(join(t.fork.path, ".patchbook/blocks"), { recursive: true });
    writeFileSync(join(t.fork.path, `.patchbook/blocks/${rel}.entries`),
      `=== entry ${hash}\nkind: keep\nrules: \nintent: Keep it.\n--- upstream\n${text}\n--- patched\n${text}\n`);
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("entries");
  };

  forkTest("commit records an edit to one of two identical paragraphs", (t) => {
    upstreamFile(t, "dup.md", DUP);
    keepEntry(t, "dup.md", "79aeaf7ba450", "# Title");
    const edited = DUP.replaceAll("Example:\n\nsecond", "Example 2:\n\nsecond");
    writeFileSync(join(t.fork.path, "dup.md"), edited);
    sh(["git", "add", "dup.md"], { cwd: t.fork.path });
    const commit = sh(["git", "commit", "-qm", "number it"], { cwd: t.fork.path, env: { ...withHook(t), PATCHBOOK_INTENT: "Number the second example." } });
    expect(commit.stdout + commit.stderr).toContain("entry    dup.md [872887e563e7 2 of 2 between 9eae27830b75] added\n");
    expect(committedFiles(t.fork)).toContain(".patchbook/blocks/dup.md.entries");
    expect(read(join(t.fork.path, ".patchbook/blocks/dup.md.entries"))).toContain(
      "=== entry 872887e563e7 2 of 2 between 9eae27830b75\nkind: policy\nrules: \nintent: Number the second example.\n--- upstream\nExample:\n--- patched\nExample 2:\n");
    expect(t.pb(["blocks", "dup.md"], { cwd: t.fork.path }).stdout).toContain("=== line 3 [872887e563e7 1 of 2 between 4734623e8873]\nExample:\n\n=== line 5");
    expect(t.pb(["blocks", "dup.md"], { cwd: t.fork.path }).stdout).toContain("=== line 7 [872887e563e7 2 of 2 between 9eae27830b75]\nExample:\n\n=== line 9");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("dup.md")).toBe(edited);
  });

  const SAS = "# Title\n\nOne.\n\nTwo.\n\nS\n\nA\n\nS\n\nB\n\nS\n";
  const editMiddleS = (t: ForkCase): void => {
    upstreamFile(t, "r.md", SAS);
    keepEntry(t, "r.md", "79aeaf7ba450", "# Title");
    writeFileSync(join(t.fork.path, "r.md"), SAS.replaceAll("A\n\nS\n\nB", "A\n\nX\n\nB"));
    expect(t.pb(["record", "x", "--intent", "Say X between A and B."], { cwd: t.fork.path }).stdout).toStartWith("entry    r.md [8de0b3c47f11 2 of 3");
    t.fork.commit("x");
  };

  forkTest("an occurrence entry orphans when upstream moves what lies around it", (t) => {
    editMiddleS(t);
    t.up.write("r.md", "# Title\n\nOne.\n\nTwo.\n\nS\n\nA\n\nB\n\nS\n\nS\n");
    t.up.commit("move an S after B");
    t.pb(["sync"], { cwd: t.fork.path });
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain("orphan    r.md [8de0b3c47f11 2 of 3");
    t.pb(["build"], { cwd: t.fork.path, code: 1 });
    expect(t.fork.read("r.md")).toBe(SAS.replaceAll("A\n\nS\n\nB", "A\n\nX\n\nB"));
  });

  forkTest("an occurrence entry still applies when upstream reorders paragraphs away from it", (t) => {
    editMiddleS(t);
    t.up.write("r.md", SAS.replaceAll("One.\n\nTwo.", "Two.\n\nOne."));
    t.up.commit("swap one and two");
    t.pb(["sync"], { cwd: t.fork.path });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("r.md")).toBe("# Title\n\nTwo.\n\nOne.\n\nS\n\nA\n\nX\n\nB\n\nS\n");
  });

  // #283: a file edit to one of several identical paragraphs.
  const fileEditMiddleS = (t: ForkCase): void => {
    upstreamFile(t, "r.md", SAS);
    writeFileSync(join(t.fork.path, "r.md"), SAS.replaceAll("A\n\nS\n\nB", "A\n\nX\n\nB"));
    expect(t.pb(["record", "x", "--intent", "Say X between A and B."], { cwd: t.fork.path }).stdout).toBe("file     r.md\n");
    t.fork.commit("x");
  };

  forkTest("sync refuses a file edit to a repeated paragraph once upstream moves what lies around it", (t) => {
    fileEditMiddleS(t);
    t.up.write("r.md", SAS.replaceAll("A\n\nS\n\nB", "B\n\nS\n\nA"));
    t.up.commit("swap A and B");
    const sync = t.pb(["sync"], { cwd: t.fork.path });
    expect(sync.stdout).toContain("0 of ours merged cleanly, 1 conflicts");
    expect(sync.stderr).toContain("patchbook: r.md (change x): the edit is to a paragraph the file repeats, and upstream moved what lies "
      + "around it, so sync can't tell which copy the edit is for and didn't merge it. .patchbook/changes/x/ours/r.md.pb holds our text "
      + "and upstream's between conflict markers. Resolve them with the edit on the copy you mean, then run patchbook build.\n");
    expect(read(join(t.fork.path, ".patchbook/changes/x/ours/r.md.pb")))
      .toBe("# Title\n\nOne.\n\nTwo.\n\nS\n\n<<<<<<< ours\nA\n\nX\n\nB\n=======\nB\n\nS\n\nA\n>>>>>>> upstream\n\nS\n");
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain("conflict  r.md: ours has conflict markers\n");
    t.pb(["build"], { cwd: t.fork.path, code: 1 });
    expect(t.fork.read("r.md")).toBe(SAS.replaceAll("A\n\nS\n\nB", "A\n\nX\n\nB"));
  });

  forkTest("sync merges a file edit to a repeated paragraph when upstream reorders paragraphs away from it", (t) => {
    fileEditMiddleS(t);
    t.up.write("r.md", SAS.replaceAll("One.\n\nTwo.", "Two.\n\nOne."));
    t.up.commit("swap one and two");
    expect(t.pb(["sync"], { cwd: t.fork.path }).stdout).toContain("1 of ours merged cleanly, 0 conflicts");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("r.md")).toBe("# Title\n\nTwo.\n\nOne.\n\nS\n\nA\n\nX\n\nB\n\nS\n");
  });

  const syncRefuses = (t: ForkCase, text: string, ours: string, upstream: string): void => {
    upstreamFile(t, "r.md", text);
    writeFileSync(join(t.fork.path, "r.md"), ours);
    t.pb(["record", "x", "--intent", "Edit next to an S."], { cwd: t.fork.path });
    t.fork.commit("x");
    t.up.write("r.md", upstream);
    t.up.commit("move an S");
    expect(t.pb(["sync"], { cwd: t.fork.path }).stdout).toContain("0 of ours merged cleanly, 1 conflicts");
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain("conflict  r.md: ours has conflict markers\n");
    t.pb(["build"], { cwd: t.fork.path, code: 1 });
    expect(t.fork.read("r.md")).toBe(ours);
  };

  forkTest("sync refuses a file edit that deletes a repeated paragraph once upstream moves it", (t) => {
    syncRefuses(t, "# T\n\nS\n\nA\n\nS\n\nB\n\nC\n\nD\n", "# T\n\nS\n\nA\n\nB\n\nC\n\nD\n", "# T\n\nS\n\nA\n\nB\n\nS\n\nC\n\nD\n");
  });

  forkTest("sync refuses a file edit that inserts next to a repeated paragraph once upstream moves it", (t) => {
    syncRefuses(t, "S\n\nS\n\nU2\n\nS\n\nU4\n\nR\n\nU6\n\nR\n", "S\n\nS\n\nN\n\nX\n\nS\n\nU4\n\nR\n\nU6\n\nR\n",
      "U4\n\nU6x\n\nU2\n\nS\n\nR\n\nS\n\nR\n\nS\n");
  });

  forkTest("sync refuses a file edit that deletes a paragraph upstream moves", (t) => {
    syncRefuses(t, "T\n\nU\n\nV\n", "U\n\nV\n", "U\n\nT\n\nV\n");
  });

  forkTest("sync refuses a file edit that inserts a copy of a repeated paragraph where upstream moves a copy", (t) => {
    syncRefuses(t, "# T\n\nS\n\nA\n\nS\n\nB\n\nC\n\nD\n", "# T\n\nS\n\nA\n\nS\n\nB\n\nS\n\nC\n\nD\n", "# T\n\nS\n\nA\n\nB\n\nS\n\nC\n\nD\n");
  });

  forkTest("sync of a file edit without repeated paragraphs is unchanged", (t) => {
    upstreamFile(t, "u.md", "# Title\n\nOne.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.\n");
    writeFileSync(join(t.fork.path, "u.md"), "# Title\n\nOne.\n\nTwo.\n\nThree.\n\nFour.\n\n5.\n");
    t.pb(["record", "five", "--intent", "Number five."], { cwd: t.fork.path });
    t.fork.commit("five");
    t.up.write("u.md", "# Title\n\nTwo.\n\nOne.\n\nThree.\n\nFour.\n\nFive.\n");
    t.up.commit("swap one and two");
    const sync = t.pb(["sync"], { cwd: t.fork.path });
    expect([sync.stdout, sync.stderr]).toEqual([expect.stringContaining("1 of ours merged cleanly, 0 conflicts"), ""]);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("u.md")).toBe("# Title\n\nTwo.\n\nOne.\n\nThree.\n\nFour.\n\n5.\n");
  });

  forkTest("scaffold writes one entry for identical paragraphs", (t) => {
    upstreamFile(t, "dup.md", DUP);
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config) + "\n[[check]]\nname = \"example\"\nfiles = [\"dup.md\"]\npattern = 'Example'\n");
    expect(t.pb(["scaffold"], { cwd: t.fork.path }).stdout).toBe("scaffolded 1 entries in 1 files\n");
    expect(read(join(t.fork.path, ".patchbook/blocks/dup.md.entries")))
      .toBe("=== entry 872887e563e7\nkind: translation\nrules: \nintent: \n--- upstream\nExample:\n--- patched\nExample:\n");
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout;
    expect(status).toContain("invalid   dup.md:3 [872887e563e7]: it has no intent; fill it with `patchbook intent`\n");
    expect(status).toContain("invalid   dup.md:7 [872887e563e7]: it has no intent; fill it with `patchbook intent`\n");
  });

  forkTest("record --intent fills a scaffolded block entry with an empty intent", (t) => {
    upstreamFile(t, "dup.md", DUP);
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config) + "\n[[check]]\nname = \"example\"\nfiles = [\"dup.md\"]\npattern = 'Example'\n");
    t.pb(["scaffold"], { cwd: t.fork.path });
    const file = join(t.fork.path, ".patchbook/blocks/dup.md.entries");
    writeFileSync(file, read(file).replace("kind: translation", "kind: policy"));
    t.fork.write("dup.md", t.fork.read("dup.md").replaceAll("Example:", "Sample:"));
    const recorded = t.pb(["record", "--intent", "Rename the flagged step."], { cwd: t.fork.path }).stdout;
    expect(recorded).not.toContain("not used");
    expect(read(file)).toContain("intent: Rename the flagged step.\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).not.toContain("no intent");
    t.pb(["build"], { cwd: t.fork.path });
  });

  const twoEntries = (t: ForkCase, intents: readonly [string, string]): { file: string; labels: string[] } => {
    upstreamFile(t, "dup.md", "# Title\n\nExample one:\n\nbody\n\nExample two:\n");
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config) + "\n[[check]]\nname = \"example\"\nfiles = [\"dup.md\"]\npattern = 'Example'\n");
    t.pb(["scaffold"], { cwd: t.fork.path });
    const file = join(t.fork.path, ".patchbook/blocks/dup.md.entries");
    const hashes = Array.from(read(file).matchAll(/^=== entry (\w+)/gm), (m) => m[1]!);
    let at = 0;
    writeFileSync(file, read(file).replaceAll("kind: translation", "kind: policy").replaceAll("intent: \n", () => `intent: ${intents[at++]}\n`));
    t.fork.write("dup.md", t.fork.read("dup.md").replaceAll("Example", "Sample"));
    return { file, labels: hashes.map((h) => `dup.md [${h}]`) };
  };
  const modelReplying = (t: ForkCase, reply: object): void => {
    writeFileSync(join(t.tmp, "bin/claude"), `#!/bin/sh\ncat > /dev/null\ncat <<'REPLY'\n${JSON.stringify(reply)}\nREPLY\n`, { mode: 0o755 });
  };

  forkTest("record gives each empty block entry its own model intent", (t) => {
    const { file, labels } = twoEntries(t, ["", ""]);
    modelReplying(t, { change: "x", intent: "Shared.", intents: { [labels[0]!]: "First paragraph.", [labels[1]!]: "Second paragraph." } });
    t.pb(["record"], { cwd: t.fork.path });
    const entries = read(file);
    expect(entries).toContain("intent: First paragraph.\n");
    expect(entries).toContain("intent: Second paragraph.\n");
    expect(entries).not.toContain("Shared.");
  });

  forkTest("record keeps the model's entry intents apart from the intent of the change it names", (t) => {
    const { file, labels } = twoEntries(t, ["", ""]);
    t.fork.write("newfile.txt", "new\n");
    modelReplying(t, { change: "mychange", intent: "Change.", intents: { mychange: "Change.", [labels[0]!]: "First paragraph.", [labels[1]!]: "Second paragraph." } });
    t.pb(["record"], { cwd: t.fork.path });
    const entries = read(file);
    expect(entries).toContain("intent: First paragraph.\n");
    expect(entries).toContain("intent: Second paragraph.\n");
    expect(read(join(t.fork.path, ".patchbook/changes/mychange/CHANGE.md"))).toContain("intent: Change.\n");
  });

  forkTest("record --intent fills each empty block entry beside a new file and keeps the others", (t) => {
    const { file } = twoEntries(t, ["", "Keep this one."]);
    t.fork.write("newfile.txt", "new\n");
    const recorded = t.pb(["record", "mychange", "--intent", "Rename and add."], { cwd: t.fork.path }).stdout;
    expect(recorded).not.toContain("not used");
    const entries = read(file);
    expect(entries.match(/intent: Rename and add\.\n/g)).toHaveLength(1);
    expect(entries).toContain("intent: Keep this one.\n");
  });

  forkTest("record --intent says it was not used when every block entry already has an intent", (t) => {
    const { file } = twoEntries(t, ["Keep one.", "Keep two."]);
    const recorded = t.pb(["record", "--intent", "Rename them."], { cwd: t.fork.path }).stdout;
    expect(recorded).toContain("intent   not used");
    expect(read(file)).toContain("intent: Keep one.\n");
    expect(read(file)).toContain("intent: Keep two.\n");
  });

  forkTest("status does not count a block entry that is invalid", (t) => {
    upstreamFile(t, "dup.md", DUP);
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config) + "\n[[check]]\nname = \"example\"\nfiles = [\"dup.md\"]\npattern = 'Example'\n");
    t.pb(["scaffold"], { cwd: t.fork.path });
    const status = t.pb(["status", "--json"], { cwd: t.fork.path, code: 1 });
    expect(JSON.parse(status.stdout)).toMatchObject({ applied: 0 });
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain("0 edits apply");
  });

  const patchedEntry = (t: ForkCase, rel: string, text: string, kind: "policy" | "keep", hash = "0850995b29fd"): void => {
    mkdirSync(dirname(join(t.fork.path, `.patchbook/blocks/${rel}`)), { recursive: true });
    writeFileSync(join(t.fork.path, `.patchbook/blocks/${rel}.entries`),
      `=== entry ${hash}\nkind: ${kind}\nrules: \nintent: Reword it.\n--- upstream\n${text}\n--- patched\n${kind === "keep" ? text : "the guide"}\n`);
  };
  const applies = (t: ForkCase, n: number): void => {
    expect(JSON.parse(t.pb(["status", "--json"], { cwd: t.fork.path }).stdout)).toMatchObject({ applied: n, problems: [] });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain(`${n} edits apply`);
    expect(t.pb(["build"], { cwd: t.fork.path }).stdout).toContain(`with ${n} edits`);
  };

  forkTest("status counts a block entry once when a copy gives its file a second output", (t) => {
    patchedEntry(t, "docs/guide.md", "a guide", "policy");
    handChange(t, "copy-guide", "Copy the guide.", ["copy docs/guide.md -> manual/guide.md"]);
    applies(t, 2);
    expect([t.fork.read("docs/guide.md"), t.fork.read("manual/guide.md")]).toEqual(["the guide\n", "the guide\n"]);
  });

  forkTest("status counts a keep entry once when a copy gives its file a second output", (t) => {
    patchedEntry(t, "docs/guide.md", "a guide", "keep");
    handChange(t, "copy-guide", "Copy the guide.", ["copy docs/guide.md -> manual/guide.md"]);
    applies(t, 2);
  });

  forkTest("status counts a block entry once across a copy of a copy and a move", (t) => {
    patchedEntry(t, "docs/guide.md", "a guide", "policy");
    handChange(t, "spread", "Spread the guide.", [
      "copy docs/guide.md -> a/guide.md",
      "copy a/guide.md -> b/guide.md",
      "move docs/guide.md -> c/guide.md",
    ]);
    applies(t, 4);
    expect(["a", "b", "c"].map((d) => t.fork.read(`${d}/guide.md`))).toEqual(["the guide\n", "the guide\n", "the guide\n"]);
  });

  forkTest("status counts a block entry once when it matches two identical paragraphs", (t) => {
    upstreamFile(t, "dup.md", DUP);
    patchedEntry(t, "dup.md", "Example:", "policy", "872887e563e7");
    applies(t, 1);
  });

  forkTest("status counts a file edit once when a copy gives its file a second output", (t) => {
    t.fork.write("docs/guide.md", "my guide\n");
    t.pb(["record", "own", "--intent", "Own the guide."], { cwd: t.fork.path });
    handChange(t, "copy-guide", "Copy the guide.", ["copy docs/guide.md -> manual/guide.md"]);
    applies(t, 2);
    expect([t.fork.read("docs/guide.md"), t.fork.read("manual/guide.md")]).toEqual(["my guide\n", "my guide\n"]);
  });

  forkTest("status counts a file edit whose file a later change deletes", (t) => {
    t.fork.write("docs/guide.md", "my guide\n");
    t.pb(["record", "shout", "--intent", "Own the guide."], { cwd: t.fork.path });
    handChange(t, "drop", "Drop the guide.", ["delete docs/guide.md"]);
    applies(t, 2);
  });

  forkTest("status does not count a block entry whose file a delete removes", (t) => {
    patchedEntry(t, "docs/guide.md", "a guide", "policy");
    handChange(t, "drop-guide", "Drop the guide.", ["delete docs/guide.md"]);
    expect(JSON.parse(t.pb(["status", "--json"], { cwd: t.fork.path, code: 1 }).stdout)).toMatchObject({ applied: 1 });
  });

  forkTest("record records an edit to a CRLF file with block entries", (t) => {
    const crlf = "---\r\nname: crlf\r\n---\r\n# Title\r\n\r\nBody one.\r\n\r\nBody two.\r\n";
    upstreamFile(t, "crlf.md", crlf);
    expect(t.pb(["blocks", "crlf.md"], { cwd: t.fork.path }).stdout).toBe("=== line 1 [39eb3e2cacd1]\n---\nname: crlf\n---\n\n"
      + "=== line 4 [79aeaf7ba450]\n# Title\n\n=== line 6 [c9317c857871]\nBody one.\n\n=== line 8 [adeb0bde4698]\nBody two.\n\n");
    keepEntry(t, "crlf.md", "c9317c857871", "Body one.");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    const edited = crlf.replaceAll("Body two.", "Body dos.");
    writeFileSync(join(t.fork.path, "crlf.md"), edited);
    expect(t.pb(["record", "spanish", "--intent", "Say the second body in Spanish."], { cwd: t.fork.path }).stdout)
      .toBe("entry    crlf.md [adeb0bde4698] added\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("crlf.md")).toBe(edited);
  });

  forkTest("record refuses a delete into a change before the copy that makes the file", (t) => {
    handChange(t, "first", "Add a first file.", ["add first.txt"], { "first.txt": "first\n" });
    handChange(t, "second", "Copy the guide.", ["copy docs/guide.md -> docs/guide2.md"]);
    t.pb(["build"], { cwd: t.fork.path });
    const first = changeText(t, "first");
    t.fork.rm("docs/guide2.md");
    expect(t.pb(["record", "first"], { cwd: t.fork.path, code: 1 }).stderr).toContain("patchbook: can't record into first:\n"
      + "  delete docs/guide2.md: copy docs/guide.md -> docs/guide2.md in second, later in the series, has to come before it\n"
      + "Record into second or a change after it, or into a new change.\n");
    expect(changeText(t, "first")).toBe(first);
    writeFileSync(join(t.tmp, "bin/claude"), `#!/bin/sh\ncat > ${t.tmp}/prompt.txt\necho '{"change": "first", "intent": "Add a first file."}'\n`);
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe("first-2: Add a first file.\ndelete   docs/guide2.md\n");
    expect(read(join(t.tmp, "prompt.txt"))).toContain("second: Copy the guide.");
    expect(read(join(t.tmp, "prompt.txt"))).not.toContain("first: Add a first file.");
    expect(changeText(t, "first")).toBe(first);
    expect(changeText(t, "first-2")).toContain("- delete docs/guide2.md\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(existsSync(join(t.fork.path, "docs/guide2.md"))).toBe(false);
  });

  for (const [what, copy] of [["file", "copy docs/guide.md -> manual/guide.md"], ["folder", "copy docs -> manual"]] as const) {
    forkTest(`record refuses deleting the source of a ${what} copy into a change before it`, (t) => {
      handChange(t, "early", "Add an early file.", ["add early.txt"], { "early.txt": "early\n" });
      handChange(t, "cp", "Copy the guide.", [copy]);
      t.pb(["build"], { cwd: t.fork.path });
      const early = changeText(t, "early");
      t.fork.rm("docs/guide.md");
      expect(t.pb(["record", "early"], { cwd: t.fork.path, code: 1 }).stderr).toContain(`patchbook: can't record into early:\n`
        + `  delete docs/guide.md: ${copy} in cp, later in the series, has to come before it\nRecord into cp or a change after it, or into a new change.\n`);
      expect(changeText(t, "early")).toBe(early);
      expect(t.pb(["record", "cp"], { cwd: t.fork.path }).stdout).toBe("delete   docs/guide.md\nintent   cp: Shout the second line.\n");
      expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
      t.pb(["build"], { cwd: t.fork.path });
      expect(t.fork.read("manual/guide.md")).toBe("a guide\n");
      expect(existsSync(join(t.fork.path, "docs/guide.md"))).toBe(false);
    });
  }

  forkTest("record refuses a copy into a change before one that edits the copied folder", (t) => {
    t.up.write("docs/notes.md", "notes\n");
    t.up.commit("notes");
    t.pb(["sync"], { cwd: t.fork.path });
    handChange(t, "early", "Add an early file.", ["add early.txt"], { "early.txt": "early\n" });
    handChange(t, "late", "Drop the notes.", ["delete docs/notes.md"]);
    t.pb(["build"], { cwd: t.fork.path });
    const early = changeText(t, "early");
    t.fork.write("manual/guide.md", "a guide\n");
    expect(t.pb(["record", "early"], { cwd: t.fork.path, code: 1 }).stderr).toContain("patchbook: can't record into early:\n"
      + "  copy docs -> manual: delete docs/notes.md in late, later in the series, has to come before it\n"
      + "Record into late or a change after it, or into a new change.\n");
    expect(changeText(t, "early")).toBe(early);
    expect(t.pb(["record", "late"], { cwd: t.fork.path }).stdout).toBe("copy     docs -> manual\nintent   late: Shout the second line.\n");
    expect(changeText(t, "late")).toContain("- delete docs/notes.md\n- copy docs -> manual\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("manual/guide.md")).toBe("a guide\n");
  });

  forkTest("record of a copy that a finish hook rewrites fails and saves nothing", (t) => {
    writeFileSync(join(t.fork.path, ".patchbook/hooks.ts"), dedent(`
      export const finish = (out: Map<string, { data: Uint8Array; mode: number }>) => {
        const guide = out.get("manual/guide.md");
        if (guide) out.set("manual/guide.md", { ...guide, data: new TextEncoder().encode("rewritten\\n") });
      };
    `));
    t.pb(["build"], { cwd: t.fork.path });
    const before = snapshot(join(t.fork.path, ".patchbook"));
    t.fork.write("manual/guide.md", "a guide\n");
    expect(t.pb(["record", "--intent", "Copy the guide."], { cwd: t.fork.path, code: 1 }).stderr)
      .toBe("patchbook: can't record copy docs -> manual: the build would differ from manual/guide.md on disk, for example because a finish hook rewrites it\n");
    expect(snapshot(join(t.fork.path, ".patchbook"))).toEqual(before);
  });

  forkTest("record of a move whose old path a finish hook writes back fails and saves nothing", (t) => {
    writeFileSync(join(t.fork.path, ".patchbook/hooks.ts"), dedent(`
      export const finish = (out: Map<string, { data: Uint8Array; mode: number }>) => {
        if (!out.has("docs/guide.md")) out.set("docs/guide.md", { data: new TextEncoder().encode("a guide\\n"), mode: 0o644 });
      };
    `));
    t.pb(["build"], { cwd: t.fork.path });
    const before = snapshot(join(t.fork.path, ".patchbook"));
    t.fork.rm("docs/guide.md");
    t.fork.write("manual/guide.md", "a guide\n");
    expect(t.pb(["record", "--intent", "Move the guide."], { cwd: t.fork.path, code: 1 }).stderr)
      .toBe("patchbook: can't record move docs -> manual: the build would differ from docs/guide.md on disk, for example because a finish hook rewrites it\n");
    expect(snapshot(join(t.fork.path, ".patchbook"))).toEqual(before);
  });

  forkTest("recording an edit to the source of an upstream copy replaces only that output", (t) => {
    handChange(t, "second", "Copy the guide.", ["copy docs/guide.md -> docs/guide2.md"]);
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.write("docs/guide.md", "a copied guide\n");
    const disk = outputs(t);
    expect(t.pb(["record", "copyedit", "--intent", "Change one guide."], { cwd: t.fork.path }).stdout).toBe("replace  docs/guide.md\n");
    expect(changeText(t, "copyedit")).toBe("# copyedit\n\nintent: Change one guide.\n\nedits:\n- replace docs/guide.md\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(outputs(t)).toEqual(disk);
  });

  const copiedApp = (t: ForkCase): void => {
    handChange(t, "second", "Copy the app.", ["copy app.txt -> app2.txt"]);
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("copy");
  };
  const editedCopy = (t: ForkCase): void => {
    copiedApp(t);
    t.fork.write("app2.txt", t.fork.read("app2.txt").replace("six", "SIX"));
    expect(t.pb(["record", "copyedit", "--intent", "Shout six in the copy."], { cwd: t.fork.path }).stdout).toBe("file     app2.txt\n");
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("copyedit");
  };
  const upstreamApp = (t: ForkCase, from: string, to: string): void => {
    t.up.write("app.txt", t.up.read("app.txt").replace(from, to));
    t.up.commit(to);
  };

  forkTest("recording an edit to the destination of an upstream copy records a file edit there that follows upstream", (t) => {
    editedCopy(t);
    expect(changeText(t, "copyedit")).toBe("# copyedit\n\nintent: Shout six in the copy.\n\nedits:\n- file app2.txt\n");
    expect(read(join(t.fork.path, ".patchbook/changes/copyedit/base/app2.txt.pb"))).toBe(t.up.read("app.txt"));
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    upstreamApp(t, "one", "ONE");
    expect(t.pb(["sync"], { cwd: t.fork.path }).stdout).toContain("1 of ours merged cleanly, 0 conflicts, 0 gone.");
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("app2.txt")).toBe(t.up.read("app.txt").replace("six", "SIX"));
    expect(t.fork.read("app.txt")).toBe(t.up.read("app.txt"));
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("sync names an edited copy's file edit whose base copy is missing, changes nothing, and works again once it is back", (t) => {
    editedCopy(t);
    const book = join(t.fork.path, ".patchbook");
    const copy = join(book, "changes/copyedit/base/app2.txt.pb");
    const saved = read(copy);
    rmSync(copy);
    upstreamApp(t, "one", "ONE");
    const before = snapshot(book);
    const failed = t.pb(["sync"], { cwd: t.fork.path, code: 1 });
    expect(failed.stderr).toContain("patchbook: can't sync upstream: change copyedit has no base copy of app2.txt (.patchbook/changes/copyedit/base/app2.txt.pb). ");
    expect(failed.stderr).toContain("Nothing was changed.");
    expect(failed.stderr).not.toContain("    at ");
    expect(snapshot(book)).toEqual(before);
    writeFileSync(copy, saved);
    expect(t.pb(["sync"], { cwd: t.fork.path }).stdout).toContain("1 of ours merged cleanly, 0 conflicts, 0 gone.");
  });

  for (const [lost, sides] of [["base", ["base"]], ["ours", ["ours"]], ["both", ["base", "ours"]]] as const) {
    forkTest(`status and build name the change and the ${lost} copy of an edited copy that is missing`, (t) => {
      editedCopy(t);
      for (const side of sides) rmSync(join(t.fork.path, `.patchbook/changes/copyedit/${side}/app2.txt.pb`));
      const detail = `its ${sides.join(" and ")} ${sides.length > 1 ? "copies are" : "copy is"} missing`;
      const status = t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout;
      expect(status).toContain(`invalid   changes/copyedit file app2.txt: ${detail}\n`);
      expect(t.pb(["build"], { cwd: t.fork.path, code: 1 }).stderr).toContain(`invalid   changes/copyedit file app2.txt: ${detail}\n`);
      const problems = JSON.parse(t.pb(["status", "--json"], { cwd: t.fork.path, code: 1 }).stdout).problems;
      expect(problems).toContainEqual({ problem: "invalid", file: "changes/copyedit", edit: "file app2.txt", detail });
    });
  }

  forkTest("status names the change and the edit of an edited copy whose base differs from its source", (t) => {
    editedCopy(t);
    writeFileSync(join(t.fork.path, ".patchbook/changes/copyedit/base/app2.txt.pb"), "not the source\n");
    const detail = "its base differs from upstream at the pin; run sync";
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain(`stale     changes/copyedit file app2.txt: ${detail}\n`);
    const problems = JSON.parse(t.pb(["status", "--json"], { cwd: t.fork.path, code: 1 }).stdout).problems;
    expect(problems).toContainEqual({ problem: "stale", file: "changes/copyedit", edit: "file app2.txt", detail });
  });

  forkTest("sync reports a conflict in an edited copy when upstream edits the same line, and the build refuses until it is resolved", (t) => {
    editedCopy(t);
    upstreamApp(t, "six", "6");
    expect(t.pb(["sync"], { cwd: t.fork.path }).stdout).toContain("0 of ours merged cleanly, 1 conflicts, 0 gone.");
    const before = outputs(t);
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain("conflict  app2.txt: ours has conflict markers");
    t.pb(["build"], { cwd: t.fork.path, code: 1 });
    expect(outputs(t)).toEqual(before);
    const ours = join(t.fork.path, ".patchbook/changes/copyedit/ours/app2.txt.pb");
    expect(read(ours)).toContain("<<<<<<< ours\nSIX\n=======\n6\n>>>>>>> upstream\n");
    writeFileSync(ours, t.up.read("app.txt").replace("6", "SIX"));
    t.pb(["build"], { cwd: t.fork.path });
    expect([t.fork.read("app.txt"), t.fork.read("app2.txt")]).toEqual([t.up.read("app.txt"), t.up.read("app.txt").replace("6", "SIX")]);
  });

  forkTest("record updates an edited copy in its change, and deleting the copy drops the file edit", (t) => {
    editedCopy(t);
    t.fork.write("app2.txt", t.fork.read("app2.txt").replace("two", "TWO"));
    expect(t.pb(["record", "copyedit", "--intent", "Shout two and six in the copy."], { cwd: t.fork.path }).stdout).toBe("file     app2.txt\n");
    expect(changeText(t, "copyedit")).toBe("# copyedit\n\nintent: Shout two and six in the copy.\n\nedits:\n- file app2.txt\n");
    const copy = (side: string) => join(t.fork.path, `.patchbook/changes/copyedit/${side}/app2.txt.pb`);
    expect([read(copy("base")), read(copy("ours"))]).toEqual([t.up.read("app.txt"), t.up.read("app.txt").replace("two", "TWO").replace("six", "SIX")]);
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.rm("app2.txt");
    expect(t.pb(["record", "dropcopy", "--intent", "Drop the copy."], { cwd: t.fork.path }).stdout).toBe("delete   app2.txt (file edit removed from copyedit)\n");
    expect(changeText(t, "copyedit")).toBe("# copyedit\n\nintent: Shout two and six in the copy.\n\nedits:\n");
    expect([existsSync(copy("base")), existsSync(copy("ours"))]).toEqual([false, false]);
    expect(changeText(t, "dropcopy")).toContain("- delete app2.txt");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(existsSync(join(t.fork.path, "app2.txt"))).toBe(false);
  });

  forkTest("record edits the source of a copy that has its own file edit as a file edit, and both outputs follow upstream", (t) => {
    editedCopy(t);
    t.fork.write("app.txt", t.fork.read("app.txt").replace("four", "FOUR"));
    expect(t.pb(["record", "srcedit", "--intent", "Shout four in the source."], { cwd: t.fork.path }).stdout).toBe("file     app.txt\n");
    expect(changeText(t, "srcedit")).toBe("# srcedit\n\nintent: Shout four in the source.\n\nedits:\n- file app.txt\n");
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("srcedit");
    upstreamApp(t, "one", "ONE");
    expect(t.pb(["sync"], { cwd: t.fork.path }).stdout).toContain("2 of ours merged cleanly, 0 conflicts, 0 gone.");
    t.pb(["build"], { cwd: t.fork.path });
    expect([t.fork.read("app.txt"), t.fork.read("app2.txt")]).toEqual([t.up.read("app.txt").replace("four", "FOUR"), t.up.read("app.txt").replace("six", "SIX")]);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  for (const kind of ["copy", "move"] as const) {
    forkTest(`a later ${kind} of an edited copy builds the copy's edit, which keeps following upstream`, (t) => {
      editedCopy(t);
      handChange(t, "again", "Ship the copy as app3.", [`${kind} app2.txt -> app3.txt`]);
      t.pb(["build"], { cwd: t.fork.path });
      expect(t.fork.read("app3.txt")).toBe(t.up.read("app.txt").replace("six", "SIX"));
      expect(existsSync(join(t.fork.path, "app2.txt"))).toBe(kind === "copy");
      expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
      t.fork.commit(kind);
      upstreamApp(t, "one", "ONE");
      expect(t.pb(["sync"], { cwd: t.fork.path }).stdout).toContain("1 of ours merged cleanly, 0 conflicts, 0 gone.");
      t.pb(["build"], { cwd: t.fork.path });
      expect(t.fork.read("app3.txt")).toBe(t.up.read("app.txt").replace("six", "SIX"));
      expect(t.fork.read("app.txt")).toBe(t.up.read("app.txt"));
      expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    });
  }

  forkTest("deleting an edited copy that a later copy reads keeps the edit in that copy", (t) => {
    editedCopy(t);
    handChange(t, "again", "Ship the copy as app3.", ["copy app2.txt -> app3.txt"]);
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.rm("app2.txt");
    expect(t.pb(["record", "dropcopy", "--intent", "Drop the copy."], { cwd: t.fork.path }).stdout).toBe("delete   app2.txt\n");
    expect(changeText(t, "copyedit")).toContain("- file app2.txt\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("app3.txt")).toBe(t.up.read("app.txt").replace("six", "SIX"));
    expect(existsSync(join(t.fork.path, "app2.txt"))).toBe(false);
    t.fork.commit("dropcopy");
    upstreamApp(t, "one", "ONE");
    expect(t.pb(["sync"], { cwd: t.fork.path }).stdout).toContain("1 of ours merged cleanly, 0 conflicts, 0 gone.");
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("app3.txt")).toBe(t.up.read("app.txt").replace("six", "SIX"));
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  for (const kind of ["replace", "delete"] as const) {
    forkTest(`a hand-written ${kind} of an edited copy builds after upstream changes the line the copy's edit changed`, (t) => {
      editedCopy(t);
      handChange(t, "over", "Write the copy by hand.", [`${kind} app2.txt`], kind === "replace" ? { "app2.txt": "by hand\n" } : {});
      t.pb(["build"], { cwd: t.fork.path });
      t.fork.commit(kind);
      const copy = (side: string) => read(join(t.fork.path, `.patchbook/changes/copyedit/${side}/app2.txt.pb`));
      const copies = [copy("base"), copy("ours")];
      upstreamApp(t, "six", "6");
      expect(t.pb(["sync"], { cwd: t.fork.path }).stdout).toContain("0 of ours merged cleanly, 0 conflicts, 0 gone.");
      expect([copy("base"), copy("ours")]).toEqual(copies);
      t.pb(["build"], { cwd: t.fork.path });
      expect(t.fork.read("app.txt")).toBe(t.up.read("app.txt"));
      if (kind === "replace") expect(t.fork.read("app2.txt")).toBe("by hand\n");
      else expect(existsSync(join(t.fork.path, "app2.txt"))).toBe(false);
      expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    });
  }

  forkTest("the hook commits a hand-written replace of an edited copy whose edit holds sync's conflict", (t) => {
    editedCopy(t);
    upstreamApp(t, "six", "6");
    expect(t.pb(["sync"], { cwd: t.fork.path }).stdout).toContain("0 of ours merged cleanly, 1 conflicts, 0 gone.");
    handChange(t, "over", "Write the copy by hand.", ["replace app2.txt"], { "app2.txt": "by hand\n" });
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    sh(["git", "commit", "-qm", "by hand"], { cwd: t.fork.path, env: withHook(t) });
    expect(t.fork.read("app2.txt")).toBe("by hand\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("an edited copy whose source upstream deletes is gone, since no copy reaches it", (t) => {
    editedCopy(t);
    t.up.rm("app.txt");
    t.up.commit("drop app");
    t.pb(["sync"], { cwd: t.fork.path });
    expect(reportOf(t.fork.path).gone).toEqual([{ change: "copyedit", path: "app2.txt", maybe: [] }]);
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout;
    expect(status).toContain("gone      changes/second copy app.txt -> app2.txt: app.txt no longer exists\n");
    expect(status).toContain("gone      changes/copyedit file app2.txt: no earlier copy or move of an upstream file reaches it\n");
    const problems = JSON.parse(t.pb(["status", "--json"], { cwd: t.fork.path, code: 1 }).stdout).problems;
    expect(problems).toContainEqual({
      problem: "gone", file: "changes/copyedit", edit: "file app2.txt", detail: "no earlier copy or move of an upstream file reaches it",
    });
  });

  const LOGO = Buffer.from([0, 1, 2, 0xff]);
  const keptOurs = (path: string, from: string) => `patchbook: ${path} (change copyedit): upstream changed ${from}, and sync merges only text, `
    + "so it kept ours. To take upstream's file instead, write it over the output and run patchbook record.\n";

  for (const edit of ["bytes", "mode"] as const) {
    forkTest(`an edited binary copy keeps our ${edit} and builds after upstream changes its source`, (t) => {
      writeFileSync(join(t.up.path, "logo.bin"), LOGO);
      t.up.commit("logo");
      t.pb(["sync"], { cwd: t.fork.path });
      handChange(t, "second", "Copy the logo.", ["copy logo.bin -> logo2.bin"]);
      t.pb(["build"], { cwd: t.fork.path });
      t.fork.commit("copy");
      const logo2 = join(t.fork.path, "logo2.bin");
      if (edit === "bytes") writeFileSync(logo2, Buffer.from([0, 9, 2, 0xfe]));
      else chmodSync(logo2, 0o755);
      const ours = readFileSync(logo2);
      expect(t.pb(["record", "copyedit", "--intent", "Change the copy's logo."], { cwd: t.fork.path }).stdout).toBe("file     logo2.bin\n");
      expect(changeText(t, "copyedit")).toBe("# copyedit\n\nintent: Change the copy's logo.\n\nedits:\n- file logo2.bin\n");
      t.pb(["build"], { cwd: t.fork.path });
      t.fork.commit("copyedit");
      writeFileSync(join(t.up.path, "logo.bin"), Buffer.from([0, 5, 2, 0xfd]));
      t.up.commit("new logo");
      const sync = t.pb(["sync"], { cwd: t.fork.path });
      expect(sync.stdout).toContain("0 of ours merged cleanly, 0 conflicts, 0 gone.");
      expect(sync.stderr).toContain(keptOurs("logo2.bin", "logo.bin"));
      expect(reportOf(t.fork.path).replacedUpstreamChanged).toEqual(["copyedit: logo2.bin"]);
      t.pb(["build"], { cwd: t.fork.path });
      expect(readFileSync(logo2)).toEqual(ours);
      expect(statSync(logo2).mode & 0o111).toBe(edit === "mode" ? 0o111 : 0);
      expect(readFileSync(join(t.fork.path, "logo.bin"))).toEqual(Buffer.from([0, 5, 2, 0xfd]));
      expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    });
  }

  forkTest("an edited copy keeps its text when upstream makes its source binary, and takes upstream's file once it is recorded", (t) => {
    editedCopy(t);
    const ours = t.fork.read("app2.txt");
    writeFileSync(join(t.up.path, "app.txt"), LOGO);
    t.up.commit("binary app");
    const sync = t.pb(["sync"], { cwd: t.fork.path });
    expect(sync.stdout).toContain("0 of ours merged cleanly, 0 conflicts, 0 gone.");
    expect(sync.stderr).toContain(keptOurs("app2.txt", "app.txt"));
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("app2.txt")).toBe(ours);
    expect(readFileSync(join(t.fork.path, "app.txt"))).toEqual(LOGO);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    writeFileSync(join(t.fork.path, "app2.txt"), LOGO);
    expect(t.pb(["record", "copyedit", "--intent", "Take upstream's app."], { cwd: t.fork.path }).stdout).toBe("file     app2.txt\n");
    t.pb(["build"], { cwd: t.fork.path });
    expect(readFileSync(join(t.fork.path, "app2.txt"))).toEqual(LOGO);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("a mode-only edit to a copy keeps its mode and follows upstream", (t) => {
    copiedApp(t);
    chmodSync(join(t.fork.path, "app2.txt"), 0o755);
    expect(t.pb(["record", "copyedit", "--intent", "Make the copy executable."], { cwd: t.fork.path }).stdout).toBe("file     app2.txt\n");
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("copyedit");
    upstreamApp(t, "one", "ONE");
    expect(t.pb(["sync"], { cwd: t.fork.path }).stdout).toContain("1 of ours merged cleanly, 0 conflicts, 0 gone.");
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("app2.txt")).toBe(t.up.read("app.txt"));
    expect(statSync(join(t.fork.path, "app2.txt")).mode & 0o111).toBe(0o111);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("record refuses an edit to a copy's destination into a change before the copy", (t) => {
    handChange(t, "early", "Add an early file.", ["add early.txt"], { "early.txt": "early\n" });
    copiedApp(t);
    const early = changeText(t, "early");
    t.fork.write("app2.txt", t.fork.read("app2.txt").replace("six", "SIX"));
    expect(t.pb(["record", "early"], { cwd: t.fork.path, code: 1 }).stderr).toContain("patchbook: can't record into early:\n"
      + "  file app2.txt: copy app.txt -> app2.txt in second, later in the series, has to come before it\n"
      + "Record into second or a change after it, or into a new change.\n");
    expect(changeText(t, "early")).toBe(early);
    t.pb(["record", "second"], { cwd: t.fork.path });
    expect(changeText(t, "second")).toContain("edits:\n- copy app.txt -> app2.txt\n- file app2.txt\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("app2.txt")).toBe(t.up.read("app.txt").replace("six", "SIX"));
  });

  forkTest("record keeps an edited rename of a file that a copy still builds from following upstream", (t) => {
    copiedApp(t);
    sh(["git", "mv", "app.txt", "app3.txt"], { cwd: t.fork.path });
    t.fork.write("app3.txt", t.fork.read("app3.txt").replace("six", "SIX"));
    expect(t.pb(["record", "rename", "--intent", "Rename the app."], { cwd: t.fork.path }).stdout).toBe("move     app.txt -> app3.txt\nfile     app3.txt\n");
    expect(changeText(t, "rename")).toBe("# rename\n\nintent: Rename the app.\n\nedits:\n- move app.txt -> app3.txt\n- file app3.txt\n");
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("rename");
    upstreamApp(t, "one", "ONE");
    expect(t.pb(["sync"], { cwd: t.fork.path }).stdout).toContain("1 of ours merged cleanly, 0 conflicts, 0 gone.");
    t.pb(["build"], { cwd: t.fork.path });
    expect([t.fork.read("app2.txt"), t.fork.read("app3.txt")]).toEqual([t.up.read("app.txt"), t.up.read("app.txt").replace("six", "SIX")]);
    expect(existsSync(join(t.fork.path, "app.txt"))).toBe(false);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("an edited copy of another upstream's file follows that upstream through a hooked commit and a sync of both", (t) => {
    const NOTES = "one\ntwo\nthree\nfour\nfive\n";
    const lib = new Repo(join(t.tmp, "lib"));
    lib.write("notes.txt", NOTES);
    lib.commit("lib");
    t.pb(["track", "lib", lib.path], { cwd: t.fork.path });
    handChange(t, "second", "Ship lib's notes at the root.", ["copy lib/notes.txt -> notes.txt"]);
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("copy");
    t.fork.write("notes.txt", NOTES.replace("five", "FIVE"));
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    const commit = sh(["git", "commit", "-qm", "shout five"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Shout five." } });
    expect(commit.stderr).toContain("shout-five: Shout five.\nfile     notes.txt\n");
    expect(changeText(t, "shout-five")).toBe("# shout-five\n\nintent: Shout five.\n\nedits:\n- file notes.txt\n");
    expect(read(join(t.fork.path, ".patchbook/changes/shout-five/base/notes.txt.pb"))).toBe(NOTES);
    upstreamApp(t, "one", "ONE");
    lib.write("notes.txt", NOTES.replace("one", "ONE"));
    lib.commit("shout one");
    const sync = t.pb(["sync"], { cwd: t.fork.path }).stdout;
    expect(sync).toMatch(/^upstream: pinned \w+\. 1 upstream files changed, 0 of ours merged cleanly, 0 conflicts, 0 gone\.$/m);
    expect(sync).toMatch(/^lib: pinned \w+\. 1 upstream files changed, 1 of ours merged cleanly, 0 conflicts, 0 gone\.$/m);
    t.pb(["build"], { cwd: t.fork.path });
    expect([t.fork.read("lib/notes.txt"), t.fork.read("notes.txt")]).toEqual([NOTES.replace("one", "ONE"), NOTES.replace("one", "ONE").replace("five", "FIVE")]);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("record refuses a replace into the change whose file edit it would overwrite", (t) => {
    t.fork.write("docs/guide.md", "my guide\n");
    t.pb(["record", "own", "--intent", "Own the guide."], { cwd: t.fork.path });
    handChange(t, "second", "Copy the guide.", ["copy docs/guide.md -> docs/guide2.md"]);
    writeFileSync(join(t.fork.path, ".patchbook/series"), "second\nown\n");
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.write("docs/guide.md", "our guide\n");
    expect(t.pb(["record", "own"], { cwd: t.fork.path, code: 1 }).stderr).toContain("patchbook: can't record into own:\n"
      + "  replace docs/guide.md: own already has its own copy of docs/guide.md\nRecord into a new change.\n");
    expect(t.pb(["record", "apart", "--intent", "Keep our guide apart."], { cwd: t.fork.path }).stdout).toBe("replace  docs/guide.md\n");
    t.pb(["build"], { cwd: t.fork.path });
    expect([t.fork.read("docs/guide.md"), t.fork.read("docs/guide2.md")]).toEqual(["our guide\n", "my guide\n"]);
  });

  forkTest("build of a book without occurrence keys or replaces is unchanged", (t) => {
    upstreamFile(t, "dup.md", DUP);
    t.fork.write("docs/guide.md", "my guide\n");
    t.pb(["record", "own", "--intent", "Own the guide."], { cwd: t.fork.path });
    handChange(t, "second", "Copy the guide.", ["copy docs/guide.md -> docs/guide2.md"]);
    mkdirSync(join(t.fork.path, ".patchbook/blocks"), { recursive: true });
    writeFileSync(join(t.fork.path, ".patchbook/blocks/dup.md.entries"),
      "=== entry 872887e563e7\nkind: policy\nrules: \nintent: Lead in.\n--- upstream\nExample:\n--- patched\nFor example:\n");
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("dup.md")).toBe(DUP.replaceAll("Example:", "For example:"));
    expect([t.fork.read("docs/guide.md"), t.fork.read("docs/guide2.md")]).toEqual(["my guide\n", "my guide\n"]);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  const configureSnippets = (t: ForkCase): void => {
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config) + '\n[placeholders.snippet]\nfile = ".patchbook/snippets.md"\nformat = "sections"\n');
    t.fork.write(".patchbook/snippets.md", "## v\n\nVERSION-1\n");
  };

  // A change that owns `file app.txt`, whose ours copy has `text` where upstream has "three".
  const ownedFileEdit = (t: ForkCase, text: string, placeholders: boolean): string => {
    if (placeholders) configureSnippets(t);
    const ours = t.fork.read("app.txt").replaceAll("three", text);
    handChange(t, "ver", "Name the version.", ["file app.txt"], { "app.txt": ours });
    const base = join(t.fork.path, ".patchbook/changes/ver/base/app.txt.pb");
    mkdirSync(dirname(base), { recursive: true });
    writeFileSync(base, t.fork.read("app.txt"));
    t.pb(["build"], { cwd: t.fork.path });
    return join(t.fork.path, ".patchbook/changes/ver/ours/app.txt.pb");
  };
  const SKIPPED = "skipped  app.txt: its copy in ver uses placeholders; edit that copy directly\n";

  forkTest("record skips a file edit whose ours copy uses a placeholder", (t) => {
    const copy = ownedFileEdit(t, "{{snippet:v}}", true);
    const before = read(copy);
    expect(t.fork.read("app.txt")).toContain("\nVERSION-1\n");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("one", "ONE"));
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe(SKIPPED);
    expect(read(copy)).toBe(before);
    expect(read(copy)).toContain("{{snippet:v}}");
    expect(t.fork.read("app.txt")).toStartWith("ONE\n");
  });

  forkTest("record skips a file edit with a placeholder and still records another edit", (t) => {
    const copy = ownedFileEdit(t, "{{snippet:v}}", true);
    const before = read(copy);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("one", "ONE"));
    t.fork.write("docs/guide.md", "a better guide\n");
    expect(t.pb(["record", "guide", "--intent", "Improve the guide."], { cwd: t.fork.path }).stdout).toBe(SKIPPED + "file     docs/guide.md\n");
    expect(read(copy)).toBe(before);
    expect(changeText(t, "guide")).toContain("- file docs/guide.md");
    expect(read(join(t.fork.path, ".patchbook/changes/guide/ours/docs/guide.md.pb"))).toBe("a better guide\n");
    expect(t.fork.read("app.txt")).toStartWith("ONE\n");
  });

  forkTest("record updates a file edit copy that has placeholder text but no placeholders configured", (t) => {
    const copy = ownedFileEdit(t, "{{go:name}}", false);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("one", "ONE"));
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe("file     app.txt (in ver)\nintent   ver: Shout the second line.\n");
    expect(read(copy)).toBe("ONE\ntwo\n{{go:name}}\nfour\nfive\nsix\nseven\n");
  });

  forkTest("record updates an added copy that has placeholder text but no placeholders configured", (t) => {
    handChange(t, "tpl", "Add a template.", ["add tpl.txt"], { "tpl.txt": "Hello {{go:name}}\n" });
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.write("tpl.txt", "Hello {{go:name}}!\n");
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe("update   tpl.txt (in tpl)\nintent   tpl: Shout the second line.\n");
    expect(read(join(t.fork.path, ".patchbook/changes/tpl/ours/tpl.txt.pb"))).toBe("Hello {{go:name}}!\n");
  });

  forkTest("record skips an added copy that uses a configured placeholder", (t) => {
    configureSnippets(t);
    handChange(t, "tpl", "Add a template.", ["add tpl.txt"], { "tpl.txt": "Uses {{snippet:v}}\n" });
    t.pb(["build"], { cwd: t.fork.path });
    const copy = join(t.fork.path, ".patchbook/changes/tpl/ours/tpl.txt.pb");
    expect(t.fork.read("tpl.txt")).toBe("Uses VERSION-1\n");
    t.fork.write("tpl.txt", "Uses VERSION-1!\n");
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe("skipped  tpl.txt: its copy in tpl uses placeholders; edit that copy directly\n");
    expect(read(copy)).toBe("Uses {{snippet:v}}\n");
    expect(t.fork.read("tpl.txt")).toBe("Uses VERSION-1!\n");
  });

  // Placeholders are expanded only in text, so a copy that isn't text has nothing to protect.
  const NOT_TEXT = "\u0000\u00ff {{snippet:v}}\n";

  forkTest("record updates a file edit copy that is not text even if it holds a placeholder", (t) => {
    configureSnippets(t);
    writeFileSync(join(t.up.path, "bin.dat"), "\u0000\u00ff base\n");
    t.up.commit("binary");
    t.pb(["sync"], { cwd: t.fork.path });
    handChange(t, "ver", "Name the version.", ["file bin.dat"], { "bin.dat": NOT_TEXT });
    const base = join(t.fork.path, ".patchbook/changes/ver/base/bin.dat.pb");
    mkdirSync(dirname(base), { recursive: true });
    writeFileSync(base, "\u0000\u00ff base\n");
    t.pb(["build"], { cwd: t.fork.path });
    writeFileSync(join(t.fork.path, "bin.dat"), "\u0000\u00ff hand\n");
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe("file     bin.dat (in ver)\nintent   ver: Shout the second line.\n");
    expect(read(join(t.fork.path, ".patchbook/changes/ver/ours/bin.dat.pb"))).toBe("\u0000\u00ff hand\n");
    t.pb(["build"], { cwd: t.fork.path });
  });

  forkTest("record updates an added copy that is not text even if it holds a placeholder", (t) => {
    configureSnippets(t);
    handChange(t, "bin", "Add a blob.", ["add blob.dat"], { "blob.dat": NOT_TEXT });
    t.pb(["build"], { cwd: t.fork.path });
    writeFileSync(join(t.fork.path, "blob.dat"), "\u0000\u00ff hand\n");
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe("update   blob.dat (in bin)\nintent   bin: Shout the second line.\n");
    expect(read(join(t.fork.path, ".patchbook/changes/bin/ours/blob.dat.pb"))).toBe("\u0000\u00ff hand\n");
    t.pb(["build"], { cwd: t.fork.path });
  });

  const placeholderCopyAndMissingChange = (t: ForkCase): void => {
    ownedFileEdit(t, "{{snippet:v}}", true);
    t.fork.write(".patchbook/series", t.fork.read(".patchbook/series") + "ghost\n");
    t.fork.commit("a problem");
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain("series: no change called ghost");
  };

  forkTest("the hook refuses an edit it can't record when the patchbook has a problem", (t) => {
    placeholderCopyAndMissingChange(t);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("one", "ONE"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    const state = gitState(t);
    const files = tree(t.fork.path);
    const refused = intoKeptCommit(t);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("couldn't record these hand edits:\n  app.txt\n");
    expect(gitState(t)).toBe(state);
    expect(tree(t.fork.path)).toEqual(files);
  });

  forkTest("the hook still commits with a problem when every edit is recorded", (t) => {
    placeholderCopyAndMissingChange(t);
    const head = sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout;
    t.fork.write(".patchbook/notes.md", "a note\n");
    sh(["git", "add", ".patchbook/notes.md"], { cwd: t.fork.path });
    const noEdit = intoKeptCommit(t);
    expect(noEdit.code).toBe(0);
    expect(noEdit.stderr).toContain("1 problems, so the output wasn't rebuilt.");
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).not.toBe(head);
    t.fork.write("docs/guide.md", "a better guide\n");
    sh(["git", "add", "docs/guide.md"], { cwd: t.fork.path });
    const recorded = intoKeptCommit(t);
    expect(recorded.code).toBe(0);
    expect(recorded.stderr).toContain("1 problems, so the output wasn't rebuilt.");
    expect(changeText(t, "shout-two")).toContain("- file docs/guide.md");
    expect(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: t.fork.path }).stdout).toContain(".patchbook/changes/shout-two/CHANGE.md");
  });

  const addWithItsCopyGone = (t: ForkCase): void => {
    t.fork.write("new.txt", "new file\n");
    sh(["git", "add", "new.txt"], { cwd: t.fork.path });
    expect(intoKeptCommit(t).code).toBe(0);
    t.fork.rm(".patchbook/changes/shout-two/ours/new.txt.pb");
    t.fork.commit("lose the copy");
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain("add new.txt: its ours copy is missing");
  };

  for (const [name, change] of [["deletes", ["rm", "-q", "new.txt"]], ["renames", ["mv", "new.txt", "new2.txt"]]] as const) {
    forkTest(`the hook refuses a commit that ${name} an output a problem dropped`, (t) => {
      addWithItsCopyGone(t);
      sh(["git", ...change], { cwd: t.fork.path });
      const state = gitState(t);
      const files = tree(t.fork.path);
      const refused = intoKeptCommit(t);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("couldn't record these hand edits:\n  new.txt\n");
      expect(gitState(t)).toBe(state);
      expect(tree(t.fork.path)).toEqual(files);
    });
  }

  forkTest("the hook commits a deletion the patchbook makes while it has a problem", (t) => {
    placeholderCopyAndMissingChange(t);
    const change = ".patchbook/changes/ver/CHANGE.md";
    t.fork.write(change, t.fork.read(change) + "- delete docs/guide.md\n");
    sh(["git", "add", change], { cwd: t.fork.path });
    sh(["git", "rm", "-q", "docs/guide.md"], { cwd: t.fork.path });
    const committed = intoKeptCommit(t);
    expect(committed.code).toBe(0);
    expect(committed.stderr).toContain("1 problems, so the output wasn't rebuilt.");
    expect(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: t.fork.path }).stdout).toContain("docs/guide.md");
  });

  forkTest("a symlink the fork adds stays a symlink in the build", (t) => {
    symlinkSync("app.txt", join(t.fork.path, "link"));
    t.pb(["record", "link", "--intent", "Link to the app."], { cwd: t.fork.path });
    unlinkSync(join(t.fork.path, "link"));
    t.pb(["build", "--force"], { cwd: t.fork.path });
    expect(isSymlink(join(t.fork.path, "link"))).toBe(true);
    expect(readlinkSync(join(t.fork.path, "link"))).toBe("app.txt");
  });

  forkTest("a recorded build keeps the executable bit of an upstream script", (t) => {
    t.recordFeature();
    expect(isExecutable(join(t.fork.path, "bin/run.sh"))).toBe(true);
  });

  const twoMovedUpstreams = (t: ForkCase): { lib: Repo; away: string } => {
    const lib = new Repo(join(t.tmp, "lib"));
    lib.write("src/lib.txt", "v1\n");
    lib.commit("lib");
    t.pb(["track", "lib", lib.path, "--path", "src"], { cwd: t.fork.path });
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
    t.up.commit("upstream edit");
    lib.write("src/lib.txt", "v2\n");
    lib.commit("lib v2");
    return { lib, away: join(t.tmp, "lib.away") };
  };
  const lastSync = (t: ForkCase): { upstream: SyncReport; lib?: SyncReport } =>
    Object.fromEntries(syncedAt(t.fork.path).upstreams.map((r) => [r.name, r])) as { upstream: SyncReport; lib?: SyncReport };

  const dropLibFromConfig = (t: ForkCase): void => {
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replace(/\n\[\[upstream\]\]\nname = "lib"[\s\S]*$/, "\n"));
  };

  forkTest("sync keeps the report of an upstream when a later one fails", (t) => {
    const { lib, away } = twoMovedUpstreams(t);
    const before = lockPin(t.fork.read(".patchbook/upstream.lock"), "upstream").commit;
    renameSync(lib.path, away);
    t.pb(["sync"], { cwd: t.fork.path, code: 1 });
    const pin = lockPin(t.fork.read(".patchbook/upstream.lock"), "upstream").commit;
    expect(pin).not.toBe(before);
    expect(Object.keys(lastSync(t))).toEqual(["upstream"]);
    expect(lastSync(t).upstream).toMatchObject({ from: before, to: pin, upstream: ["changed app.txt"] });
    renameSync(away, lib.path);
    const again = t.pb(["sync"], { cwd: t.fork.path }).stdout;
    expect(again).toContain("Nothing to do");
    expect(Object.keys(lastSync(t))).toEqual(["upstream", "lib"]);
    expect(lastSync(t).upstream).toMatchObject({ from: before, to: pin, upstream: ["changed app.txt"] });
    expect(lastSync(t).lib!.upstream).toEqual(["changed lib/lib.txt"]);
    expect(t.pb(["upstream", "upstream", "--diff"], { cwd: t.fork.path }).stdout).toContain("+SIX");
  });

  forkTest("sync of one upstream keeps the report of another", (t) => {
    const { lib } = twoMovedUpstreams(t);
    t.pb(["sync", "upstream"], { cwd: t.fork.path });
    const first = lastSync(t).upstream;
    lib.write("src/lib.txt", "v3\n");
    lib.commit("lib v3");
    t.pb(["sync", "lib"], { cwd: t.fork.path });
    expect(Object.keys(lastSync(t))).toEqual(["upstream", "lib"]);
    expect(lastSync(t).upstream).toEqual(first);
  });

  forkTest("sync drops the report of an upstream no longer in the config", (t) => {
    twoMovedUpstreams(t);
    t.pb(["sync"], { cwd: t.fork.path });
    expect(Object.keys(lastSync(t))).toEqual(["upstream", "lib"]);
    dropLibFromConfig(t);
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("five", "FIVE"));
    t.up.commit("another edit");
    t.pb(["sync"], { cwd: t.fork.path });
    expect(Object.keys(lastSync(t))).toEqual(["upstream"]);
  });

  describe("the report stays out of git", () => {
    const untracked = (t: ForkCase): string[] => sh(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: t.fork.path }).stdout.split("\n").filter((l) => l.startsWith("??"));
    const moveUpstream = (t: ForkCase, old: string, repl: string): void => {
      t.up.write("app.txt", t.up.read("app.txt").replaceAll(old, repl));
      t.up.commit(`${old} to ${repl}`);
    };

    forkTest("sync leaves the report untracked and ignored", (t) => {
      t.recordFeature();
      moveUpstream(t, "six", "SIX");
      t.pb(["sync"], { cwd: t.fork.path });
      expect(lastSync(t).upstream.to).toBeString();
      expect(untracked(t)).toEqual([]);
      sh(["git", "add", "-A"], { cwd: t.fork.path });
      expect(sh(["git", "diff", "--cached", "--name-only"], { cwd: t.fork.path }).stdout).not.toContain("last-sync.json");
    });

    forkTest("sync ignores the report of a repo made before the ignore existed", (t) => {
      t.recordFeature();
      moveUpstream(t, "six", "SIX");
      t.pb(["sync"], { cwd: t.fork.path });
      rmSync(join(t.fork.path, ".patchbook/.gitignore"), { force: true });
      expect(untracked(t)).toContain("?? .patchbook/last-sync.json");
      expect(t.pb(["sync"], { cwd: t.fork.path }).stdout).toContain("Nothing to do");
      expect(untracked(t)).toEqual([]);
      rmSync(join(t.fork.path, ".patchbook/.gitignore"));
      moveUpstream(t, "five", "FIVE");
      t.pb(["sync"], { cwd: t.fork.path });
      expect(untracked(t)).toEqual([]);
      expect(Object.keys(lastSync(t))).toEqual(["upstream"]);
    });

    forkTest("sync keeps the rules a user put in the patchbook gitignore", (t) => {
      const rules = join(t.fork.path, ".patchbook/.gitignore");
      writeFileSync(rules, "scratch/\n");
      for (const [old, repl] of [["six", "SIX"], ["five", "FIVE"]] as const) {
        moveUpstream(t, old, repl);
        t.pb(["sync"], { cwd: t.fork.path });
      }
      const lines = read(rules).split("\n");
      expect(lines[0]).toBe("scratch/");
      expect(lines.filter((l) => l === "last-sync.json")).toHaveLength(1);
      expect(untracked(t)).toEqual([]);
    });

    forkTest("status and upstream diff cope without the report in a fresh clone", (t) => {
      t.recordFeature();
      moveUpstream(t, "six", "SIX");
      t.pb(["sync"], { cwd: t.fork.path });
      t.pb(["build", "--commit"], { cwd: t.fork.path });
      const clone = join(t.tmp, "clone");
      sh(["git", "clone", "-q", t.fork.path, clone], { cwd: t.tmp });
      expect(existsSync(join(clone, ".patchbook/last-sync.json"))).toBe(false);
      expect(JSON.parse(t.pb(["status", "--json"], { cwd: clone }).stdout).lastSync).toBeNull();
      expect(t.pb(["upstream", "upstream", "--diff"], { cwd: t.fork.path }).stdout).toContain("+SIX");
      expect(t.pb(["upstream", "upstream", "--diff"], { cwd: clone, code: 1 }).stderr).toContain("pass --since <commit>");
    });

    const folderAtRules = (t: ForkCase): void => {
      t.recordFeature();
      moveUpstream(t, "six", "SIX");
      t.pb(["sync"], { cwd: t.fork.path });
      const rules = join(t.fork.path, ".patchbook/.gitignore");
      rmSync(rules);
      mkdirSync(rules);
    };

    forkTest("a sync with nothing to do still exits 0 and warns when the rule file cannot be used", (t) => {
      folderAtRules(t);
      const out = t.pb(["sync"], { cwd: t.fork.path });
      expect(out.stdout).toContain("Nothing to do");
      const lines = out.stderr.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toStartWith("patchbook: ");
      expect(lines[0]).toContain(".patchbook/.gitignore");
      expect(lines[0]).toContain("last-sync.json stays untracked");
    });

    forkTest("a sync that fails shows its own error when the rule file cannot be used", (t) => {
      folderAtRules(t);
      renameSync(t.up.path, `${t.up.path}.gone`);
      const out = t.pb(["sync"], { cwd: t.fork.path, code: 1 });
      expect(out.stderr).toContain("patchbook: git fetch");
      expect(out.stderr).toContain("failed");
      expect(out.stderr).toContain("last-sync.json stays untracked");
      expect(out.stderr).not.toContain("ignoreReport");
    });

    forkTest("sync appends to the patchbook gitignore without changing the bytes there", (t) => {
      t.recordFeature();
      moveUpstream(t, "six", "SIX");
      t.pb(["sync"], { cwd: t.fork.path });
      const rules = join(t.fork.path, ".patchbook/.gitignore");
      const mine = Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from(".txt\r\nscratch/\r\n")]);
      writeFileSync(rules, mine);
      moveUpstream(t, "five", "FIVE");
      t.pb(["sync"], { cwd: t.fork.path });
      const after = readFileSync(rules);
      expect(after.subarray(0, mine.length).equals(mine)).toBe(true);
      expect(after.subarray(mine.length).toString()).toBe("last-sync.json\n.gitignore\n");
      const asked = Buffer.concat([Buffer.from(".patchbook/caf"), Buffer.from([0xe9]), Buffer.from(".txt\0.patchbook/scratch/x\0.patchbook/last-sync.json\0")]);
      const checked = Bun.spawnSync(["git", "check-ignore", "--stdin", "-z"], { cwd: t.fork.path, stdin: asked });
      expect(checked.stdout.equals(asked)).toBe(true);
    });
  });

  forkTest("sync drops the report of a removed upstream when nothing moved", (t) => {
    twoMovedUpstreams(t);
    t.pb(["sync"], { cwd: t.fork.path });
    expect(Object.keys(lastSync(t))).toEqual(["upstream", "lib"]);
    dropLibFromConfig(t);
    expect(t.pb(["sync"], { cwd: t.fork.path }).stdout).toContain("Nothing to do");
    expect(Object.keys(lastSync(t))).toEqual(["upstream"]);
  });

  describe("where the OS refuses a write, so not as root", () => {
    permissionTest("sync keeps the pin when the report cannot be written", (t) => {
      const file = join(t.fork.path, ".patchbook/last-sync.json");
      const lock = (): string => t.fork.read(".patchbook/upstream.lock");
      t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
      t.up.commit("first edit");
      t.pb(["sync"], { cwd: t.fork.path });
      const reported = read(file);
      const pinned = lock();
      t.up.write("app.txt", t.up.read("app.txt").replaceAll("five", "FIVE"));
      const second = t.up.commit("second edit");
      chmodSync(file, 0o444);
      try {
        t.pb(["sync"], { cwd: t.fork.path, code: 1 });
        expect(lock()).toBe(pinned);
        expect(read(file)).toBe(reported);
      } finally {
        chmodSync(file, 0o644);
      }
      t.pb(["sync"], { cwd: t.fork.path });
      expect(lastSync(t).upstream.to).toBe(second);
      expect(lock()).not.toBe(pinned);
    }, ForkCase);

    const secondEdits = [
      ["merge", "four", "FOUR", "1 of ours merged cleanly, 0 conflicts", { merged: [{ change: "feature", path: "app.txt" }], conflicts: [] }],
      ["conflict", "two", "TWO_UP", "0 of ours merged cleanly, 1 conflicts", { merged: [], conflicts: [{ change: "feature", path: "app.txt", count: 1 }] }],
    ] as const;
    for (const blocked of ["last-sync.json", "upstream.lock"]) {
      for (const [kind, line, edited, summary, carried] of secondEdits) {
        permissionTest(`a sync that cannot write ${blocked} after a ${kind} changes nothing and reports the ${kind} when run again`, (t) => {
          t.recordFeature();
          t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
          const first = t.up.commit("first edit");
          t.pb(["sync"], { cwd: t.fork.path });
          t.up.write("app.txt", t.up.read("app.txt").replaceAll(line, edited));
          const second = t.up.commit("second edit");
          const file = join(t.fork.path, ".patchbook", blocked);
          const before = tree(t.fork.path);
          chmodSync(file, 0o444);
          try {
            t.pb(["sync"], { cwd: t.fork.path, code: 1 });
          } finally {
            chmodSync(file, 0o644);
          }
          expect(tree(t.fork.path)).toEqual(before);
          expect(t.pb(["sync"], { cwd: t.fork.path }).stdout).toContain(summary);
          expect(lastSync(t).upstream).toMatchObject({ from: first, to: second, ...carried });
        }, ForkCase);
      }
    }

    for (const name of ["config.toml", "upstream.lock", "last-sync.json", "retired.md"]) {
      forkTest(`sync refuses a ${name} that is a link`, (t) => {
        t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
        t.up.commit("first edit");
        t.pb(["sync"], { cwd: t.fork.path });
        const file = join(t.fork.path, ".patchbook", name);
        const kept = join(t.tmp, name);
        if (existsSync(file)) renameSync(file, kept);
        else writeFileSync(kept, "");
        symlinkSync(kept, file);
        const was = read(kept);
        t.up.write("app.txt", t.up.read("app.txt").replaceAll("five", "FIVE"));
        t.up.commit("second edit");
        expect(t.pb(["sync"], { cwd: t.fork.path, code: 1 }).stderr).toContain(`.patchbook/${name} is a link`);
        expect(read(kept)).toBe(was);
      });
    }

    forkTest("sync refuses a journal folder that is a link", (t) => {
      const outside = join(t.tmp, "outside-journal");
      mkdirSync(outside);
      symlinkSync(outside, join(t.fork.path, ".patchbook/sync-upstream"));
      t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
      t.up.commit("first edit");
      expect(t.pb(["sync"], { cwd: t.fork.path, code: 1 }).stderr).toContain(".patchbook/sync-upstream is a link");
      expect(readdirSync(outside)).toEqual([]);
    });

    for (const [how, link] of [["top", "dirlink"], ["nested", "other/sub"]] as const) {
      forkTest(`sync refuses to put a saved copy back through a ${how} link in the patchbook`, (t) => {
        const outside = join(t.tmp, "outside-recover");
        mkdirSync(outside);
        mkdirSync(dirname(join(t.fork.path, ".patchbook", link)), { recursive: true });
        symlinkSync(outside, join(t.fork.path, ".patchbook", link));
        const [commit, pinTree] = read(join(t.fork.path, ".patchbook/upstream.lock")).match(/[0-9a-f]{40}/g)!;
        const journal = join(t.fork.path, ".patchbook/sync-upstream");
        mkdirSync(join(journal, "before", link), { recursive: true });
        writeFileSync(join(journal, "before", link, "evil.txt"), "PWNED\n");
        const to = `${"0".repeat(40)} ${"1".repeat(40)}`;
        writeFileSync(join(journal, "pin"), JSON.stringify({ from: `${commit} ${pinTree}`, to, rewrite: false, added: "", vendor: "", copy: false, made: "" }));
        const out = t.pb(["sync"], { cwd: t.fork.path, code: 1 });
        expect(out.stderr).toContain(`its before/${link}/evil.txt is not one a sync saves`);
        expect(readdirSync(outside)).toEqual([]);
      });
    }

    for (const [how, args] of [["set", ["start.install_skill", "false"]], ["unset", ["--unset", "start.install_skill"]]] as const) {
      forkTest(`config project ${how} refuses a config TOML that is a link`, (t) => {
        const file = join(t.fork.path, ".patchbook/config.toml");
        const kept = join(t.tmp, "config.toml");
        renameSync(file, kept);
        symlinkSync(kept, file);
        const was = read(kept);
        const out = t.pb(["config", "--project", ...args], { cwd: t.fork.path, code: 1 });
        expect(out.stderr).toContain(".patchbook/config.toml is a link");
        expect(read(kept)).toBe(was);
      });
    }

    for (const name of ["config.toml", "upstream.lock"]) {
      forkTest(`track refuses a ${name} that is a link`, (t) => {
        const file = join(t.fork.path, ".patchbook", name);
        const kept = join(t.tmp, name);
        renameSync(file, kept);
        symlinkSync(kept, file);
        const was = read(kept);
        const more = new Repo(join(t.tmp, "more"));
        more.write("b.md", "b\n");
        more.commit("b");
        expect(t.pb(["track", "more", more.path], { cwd: t.fork.path, code: 1 }).stderr).toContain(`.patchbook/${name} is a link`);
        expect(read(kept)).toBe(was);
      });
    }
  });

  describe("killed by crash injection", () => {
    const killedBeforeWriting = (t: ForkCase, path: string, args: string[]): void => {
      const env = { ...t.env, CRASH_BEFORE_WRITE: path };
      sh([...crashCmd(), ...args], { cwd: t.fork.path, env, check: false });
    };

    forkTest("a sync of one upstream first undoes a killed sync of another and its report", (t) => {
      const { lib } = twoMovedUpstreams(t);
      t.pb(["sync"], { cwd: t.fork.path });
      const reported = lastSync(t);
      const lock = t.fork.read(".patchbook/upstream.lock");
      t.up.write("app.txt", t.up.read("app.txt").replaceAll("five", "FIVE"));
      t.up.commit("second edit");
      lib.write("src/lib.txt", "v3\n");
      lib.commit("lib v3");
      killedBeforeWriting(t, "/.patchbook/sync-upstream/lock", ["sync", "upstream"]);
      expect(t.fork.read(".patchbook/upstream.lock")).toBe(lock);
      expect(lastSync(t).upstream).not.toEqual(reported.upstream);
      t.pb(["sync", "lib"], { cwd: t.fork.path });
      expect(lastSync(t).upstream).toEqual(reported.upstream);
      t.pb(["sync"], { cwd: t.fork.path });
      expect(lastSync(t).lib).toMatchObject({ from: reported.lib!.to, upstream: ["changed lib/lib.txt"] });
    });

    forkTest("a killed track cannot put back a report that undoing another killed sync rolled back", (t) => {
      twoMovedUpstreams(t);
      t.pb(["sync"], { cwd: t.fork.path });
      const reported = lastSync(t);
      t.up.write("app.txt", t.up.read("app.txt").replaceAll("five", "FIVE"));
      t.up.commit("second edit");
      killedBeforeWriting(t, "/.patchbook/sync-upstream/lock", ["sync", "upstream"]);
      expect(lastSync(t).upstream).not.toEqual(reported.upstream);
      const extra = new Repo(join(t.tmp, "extra"));
      extra.write("a.md", "extra\n");
      extra.commit("start");
      killedBeforeWriting(t, "/.patchbook/sync-extra/lock", ["track", "extra", extra.path, "--vendor", "vendor/extra"]);
      t.pb(["sync", "lib"], { cwd: t.fork.path });
      expect(lastSync(t).upstream).toEqual(reported.upstream);
    });

    forkTest("undoing a killed first sync deletes the report it wrote", (t) => {
      const report = join(t.fork.path, ".patchbook/last-sync.json");
      const lock = t.fork.read(".patchbook/upstream.lock");
      t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
      t.up.commit("upstream edit");
      expect(existsSync(report)).toBe(false);
      killedBeforeWriting(t, "/.patchbook/sync-upstream/lock", ["sync"]);
      expect(existsSync(report)).toBe(true);
      t.pb(["sync", "upstream", "refs/heads/nope"], { cwd: t.fork.path, code: 1 });
      expect(existsSync(report)).toBe(false);
      expect(t.fork.read(".patchbook/upstream.lock")).toBe(lock);
    });
  });

  forkTest("sync refuses a last-sync.json that does not parse and changes nothing", (t) => {
    writeFileSync(join(t.fork.path, ".patchbook/last-sync.json"), "{ not json");
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
    t.up.commit("upstream edit");
    const before = tree(t.fork.path);
    const { stderr } = t.pb(["sync"], { cwd: t.fork.path, code: 1 });
    expect(stderr).toContain("patchbook: .patchbook/last-sync.json isn't JSON: ");
    expect(stderr).toContain("It only reports past syncs: delete it, and the next patchbook sync writes a new one.");
    expect(tree(t.fork.path)).toEqual(before);
  });

  forkTest("track adds a second upstream to a fork", (t) => {
    const lib = new Repo(join(t.tmp, "lib"));
    lib.write("src/lib.txt", "v1\n");
    lib.commit("lib");
    t.pb(["track", "lib", lib.path, "--path", "src"], { cwd: t.fork.path });
    t.pb(["build", "--commit"], { cwd: t.fork.path });
    expect(t.fork.read("lib/lib.txt")).toBe("v1\n");
    lib.write("src/lib.txt", "v2\n");
    lib.commit("lib v2");
    const check = t.pb(["check"], { cwd: t.fork.path, code: 10 }).stdout;
    expect(checkedUpstream(check, "lib").moved).toBeTruthy();
    expect(checkedUpstream(check, "upstream").moved).toBeFalsy();
    t.pb(["sync", "lib"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("lib/lib.txt")).toBe("v2\n");
    expect(words(t.fork.read("app.txt"))[1]).toBe("two");
  });

  forkTest("sync changes nothing when the pin ref cannot be written", (t) => {
    const lib = new Repo(join(t.tmp, "lib"));
    lib.write("src/lib.txt", "a\nb\nc\nd\ne\n");
    lib.commit("lib");
    t.pb(["track", "lib", lib.path, "--path", "src"], { cwd: t.fork.path });
    t.pb(["build", "--commit"], { cwd: t.fork.path });
    t.fork.write("lib/lib.txt", "A\nb\nc\nd\ne\n");
    t.pb(["record", "shout", "--intent", "Shout the first line."], { cwd: t.fork.path });
    const before = sh(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: t.fork.path }).stdout;
    const lock = read(join(t.fork.path, ".patchbook/upstream.lock"));
    const changes = join(t.fork.path, ".patchbook/changes/shout");
    const files = (): string[] => sh(["find", ".", "-type", "f", "-exec", "cat", "{}", "+"], { cwd: changes }).stdout.split("\n");
    const ours = files();
    lib.write("src/lib.txt", "a\nb\nc\nd\nE\n");
    const head = lib.commit("lib v2");
    mkdirSync(join(storeOf(t), "refs/pins"), { recursive: true });
    writeFileSync(join(storeOf(t), "refs/pins", `${head}.lock`), "");
    t.pb(["sync", "lib"], { cwd: t.fork.path, code: 1 });
    expect(files()).toEqual(ours);
    expect(read(join(t.fork.path, ".patchbook/upstream.lock"))).toBe(lock);
    expect(sh(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: t.fork.path }).stdout).toBe(before);
  });

  const trackVendored = (t: ForkCase): Repo => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "one\n");
    extra.write("lib/b.md", "bee\n");
    extra.commit("start");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.fork.path });
    t.fork.commit("track extra");
    return extra;
  };

  for (const state of ["empty", "missing"]) {
    forkTest(`status, build and the hook name a vendored copy that is ${state} without a git error`, (t) => {
      trackVendored(t);
      rmSync(join(t.fork.path, "vendor/extra"), { recursive: true });
      if (state === "empty") mkdirSync(join(t.fork.path, "vendor/extra"));
      t.fork.write("note.txt", "a note\n");
      sh(["git", "add", "note.txt"], { cwd: t.fork.path });
      const hook = { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Add a note." };
      for (const run of [
        t.pb(["status"], { cwd: t.fork.path, code: null }),
        t.pb(["build"], { cwd: t.fork.path, code: null }),
        sh(["git", "commit", "-qm", "note"], { cwd: t.fork.path, env: hook, check: false }),
      ]) {
        expect(run.stderr).not.toContain("fatal:");
        expect(run.code).toBe(1);
        expect(run.stderr).toContain("vendor/extra");
        expect(run.stderr).toContain("sync");
      }
    });
  }

  forkTest("a partial commit moves the pin only with the vendored copy", (t) => {
    const extra = trackVendored(t);
    extra.write("a.md", "two\n");
    extra.commit("bump");
    t.pb(["sync", "extra"], { cwd: t.fork.path });
    t.fork.write("note.txt", "a note\n");
    sh(["git", "add", "note.txt"], { cwd: t.fork.path });
    const commit = (...paths: string[]) =>
      sh(["git", "commit", "-qm", "note", "--", ...paths], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1" }, check: false });
    const [head, porcelain] = [sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout, sh(["git", "status", "--short"], { cwd: t.fork.path }).stdout];
    const refused = commit("note.txt", ".patchbook/upstream.lock");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("it moves the pin of extra in .patchbook/upstream.lock but not its vendored copy, vendor/extra");
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).toBe(head);
    expect(sh(["git", "status", "--short"], { cwd: t.fork.path }).stdout).toBe(porcelain);
    expect(commit("note.txt", ".patchbook/upstream.lock", "vendor/extra").code).toBe(0);
    expect(sh(["git", "show", "HEAD:vendor/extra/a.md"], { cwd: t.fork.path }).stdout).toBe("two\n");
    sh(["git", "clone", "-q", ".", "../clone"], { cwd: t.fork.path });
    expect(t.pb(["status"], { cwd: join(t.tmp, "clone"), code: null }).stdout).toContain("no problems");
  });

  const staged = (t: ForkCase): string[] => {
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    const names = sh(["git", "diff", "--cached", "--name-only"], { cwd: t.fork.path }).stdout.split("\n").filter(Boolean);
    sh(["git", "reset", "-q"], { cwd: t.fork.path });
    return names;
  };

  const harms: [string, (vendor: string) => void][] = [
    ["an empty", (vendor) => {
      rmSync(vendor, { recursive: true });
      mkdirSync(vendor);
    }],
    ["a missing", (vendor) => rmSync(vendor, { recursive: true })],
    ["a hand-edited", (vendor) => writeFileSync(join(vendor, "a.md"), "HAND EDIT\n")],
    ["a half-written", (vendor) => {
      rmSync(join(vendor, "lib"), { recursive: true });
      writeFileSync(join(vendor, "a.md"), "half\n");
    }],
  ];
  for (const [state, harm] of harms) {
    forkTest(`sync rewrites ${state} vendored copy when upstream has not moved`, (t) => {
      trackVendored(t);
      const before = tree(t.fork.path);
      harm(join(t.fork.path, "vendor/extra"));
      t.pb(["status"], { cwd: t.fork.path, code: 1 });

      const synced = t.pb(["sync", "extra"], { cwd: t.fork.path });
      expect(synced.stdout).toContain("matches the pin");
      expect(synced.stdout).toContain("Rewrote the vendored copy, which did not.");
      expect(tree(t.fork.path)).toEqual(before);
      expect(staged(t)).toEqual([]);
      expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
      expect(t.pb(["sync", "extra"], { cwd: t.fork.path }).stdout).toContain("Nothing to do.");
    });
  }

  const notAFolder: [string, (t: ForkCase, vendor: string) => string | null][] = [
    ["a symlink to a missing path", (t, vendor) => {
      symlinkSync(join(t.tmp, "nowhere"), vendor);
      return null;
    }],
    ["a symlink to a folder outside the repo", (t, vendor) => {
      const outside = join(t.tmp, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "a.md"), "outside\n");
      symlinkSync(outside, vendor);
      return join(outside, "a.md");
    }],
  ];
  for (const [state, harm] of notAFolder) {
    forkTest(`sync rewrites ${state} at the vendor path when upstream has not moved`, (t) => {
      trackVendored(t);
      const before = tree(t.fork.path);
      const vendor = join(t.fork.path, "vendor/extra");
      rmSync(vendor, { recursive: true });
      const outside = harm(t, vendor);

      const synced = t.pb(["sync", "extra"], { cwd: t.fork.path });
      expect(synced.stdout).toContain("Rewrote the vendored copy, which did not.");
      if (outside) expect(readFileSync(outside, "utf8")).toBe("outside\n");
      expect(lstatSync(vendor).isDirectory()).toBe(true);
      expect(tree(t.fork.path)).toEqual(before);
      expect(staged(t)).toEqual([]);
      expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    });
  }

  forkTest("a symlink at the vendor path comes back as a link when the rewrite does not verify", (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "one\n");
    extra.write("debug.log", "noise\n");
    extra.commit("start");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.fork.path });
    t.fork.write(".gitignore", "vendor/extra/*.log\n");
    t.fork.commit("track extra, hide its logs");
    const outside = join(t.tmp, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "a.md"), "outside\n");
    const vendor = join(t.fork.path, "vendor/extra");
    rmSync(vendor, { recursive: true });
    symlinkSync(outside, vendor);

    expect(t.pb(["sync", "extra"], { cwd: t.fork.path, code: 1 }).stderr).toContain("Does a .gitignore hide upstream files?");
    expect(lstatSync(vendor).isSymbolicLink()).toBe(true);
    expect(readlinkSync(vendor)).toBe(outside);
    expect(readFileSync(join(outside, "a.md"), "utf8")).toBe("outside\n");
    expect(readdirSync(outside)).toEqual(["a.md"]);
  });

  forkTest("sync leaves a vendored copy that gitignore hides as it was when upstream has not moved", (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "one\n");
    extra.write("debug.log", "noise\n");
    extra.commit("start");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.fork.path });
    t.fork.write(".gitignore", "vendor/extra/*.log\n");
    t.fork.commit("track extra, hide its logs");
    const before = tree(t.fork.path);

    const synced = t.pb(["sync", "extra"], { cwd: t.fork.path, code: 1 });
    expect(synced.stderr).toContain("Does a .gitignore hide upstream files?");
    expect(tree(t.fork.path)).toEqual(before);
  });

  const hooked = (t: ForkCase, args: string[]) =>
    sh(["git", ...args], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Move the files out." }, check: false });

  forkTest("a commit that moves the last file out of a vendored copy says the copy is empty", (t) => {
    trackVendored(t);
    sh(["git", "mv", "vendor/extra/a.md", "moved-a.md"], { cwd: t.fork.path });
    sh(["git", "mv", "vendor/extra/lib/b.md", "moved-b.md"], { cwd: t.fork.path });
    const commit = hooked(t, ["commit", "-qm", "move them out"]);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("the vendored copy of extra (vendor/extra) is empty or missing");
    expect(commit.stderr).toContain("Run: patchbook sync extra, or delete the vendor line of upstream extra in .patchbook/config.toml");
    expect(commit.stderr).not.toContain("write-tree");
  });

  for (const how of ["empty", "missing"]) {
    forkTest(`status says the vendored copy is ${how}`, (t) => {
      trackVendored(t);
      rmSync(join(t.fork.path, "vendor/extra"), { recursive: true });
      if (how === "empty") mkdirSync(join(t.fork.path, "vendor/extra"), { recursive: true });
      const status = t.pb(["status"], { cwd: t.fork.path, code: 1 });
      expect(status.stderr).toContain("the vendored copy of extra (vendor/extra) is empty or missing");
      expect(status.stderr).toContain("Run: patchbook sync extra, or delete the vendor line of upstream extra in .patchbook/config.toml");
    });
  }

  for (const rule of ["vendor/extra/", "vendor/extra/*", "vendor/"]) {
    forkTest(`a vendored copy that gitignore hides says which rule hides it ${rule}`, (t) => {
      trackVendored(t);
      t.fork.write(".gitignore", `${rule}\n`);
      const message = `.gitignore hides the vendored copy of extra (vendor/extra), by the rule ${rule} at .gitignore:1`;
      for (const args of [["status"], ["build"]]) {
        const out = t.pb(args, { cwd: t.fork.path, code: 1 });
        expect(out.stderr).toContain(message);
        expect(out.stderr).toContain("change that rule, or move the vendor folder of upstream extra in .patchbook/config.toml");
        expect(out.stderr).not.toContain("git add --");
      }
      const commit = hooked(t, ["commit", "-qam", "hidden"]);
      expect(commit.code).not.toBe(0);
      expect(commit.stderr).toContain(message);
      expect(commit.stderr).not.toContain("git add --");
      expect(snapshot(join(t.fork.path, "vendor/extra"))).toEqual({ "a.md": "one\n", "lib/b.md": "bee\n" });
    });
  }

  for (const what of ["file", "link"]) {
    forkTest(`a vendor path that is a ${what} says the vendored copy is not a folder`, (t) => {
      trackVendored(t);
      const vendor = join(t.fork.path, "vendor/extra");
      rmSync(vendor, { recursive: true });
      if (what === "file") writeFileSync(vendor, "x\n");
      else symlinkSync(join(t.tmp, "extra"), vendor);
      for (const args of [["status"], ["build"]]) {
        const out = t.pb(args, { cwd: t.fork.path, code: 1 });
        expect(out.stderr).toContain(`the vendored copy of extra (vendor/extra) is a ${what}, not a folder`);
        expect(out.stderr).toContain("Delete it, then run: patchbook sync extra");
        expect(out.stderr).not.toContain("write-tree");
      }
      unlinkSync(vendor);
      t.pb(["sync", "extra"], { cwd: t.fork.path });
      expect(snapshot(vendor)).toEqual({ "a.md": "one\n", "lib/b.md": "bee\n" });
    });
  }

  const vendoredInHead = (t: ForkCase): string[] =>
    sh(["git", "ls-tree", "-r", "--name-only", "HEAD"], { cwd: t.fork.path }).stdout.split("\n").filter((p) => p.startsWith("vendor/"));
  const pinnedCopy = ["vendor/extra/a.md", "vendor/extra/lib/b.md"];

  for (const flag of ["-qm", "-qam"]) {
    forkTest(`a commit after the advised sync keeps the vendored copy with git commit ${flag.slice(1)}`, (t) => {
      trackVendored(t);
      sh(["git", "mv", "vendor/extra/a.md", "moved-a.md"], { cwd: t.fork.path });
      sh(["git", "mv", "vendor/extra/lib/b.md", "moved-b.md"], { cwd: t.fork.path });
      expect(hooked(t, ["commit", "-qm", "move them out"]).code).not.toBe(0);

      t.pb(["sync", "extra"], { cwd: t.fork.path });
      expect(hooked(t, ["commit", flag, "move them out"]).code).toBe(0);
      expect(vendoredInHead(t)).toEqual(pinnedCopy);
      expect(sh(["git", "status", "--short"], { cwd: t.fork.path }).stdout).not.toContain("vendor");
      expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    });
  }

  forkTest("a commit after a killed sync and a repair does not record the stale index", (t) => {
    trackVendored(t);
    const vendor = join(t.fork.path, "vendor/extra");
    rmSync(join(vendor, "lib"), { recursive: true });
    writeFileSync(join(vendor, "a.md"), "half written\n");
    t.fork.write("note.txt", "a note\n");
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    const blocked = hooked(t, ["commit", "-qm", "after the kill"]);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain("differs from the pin");

    t.pb(["sync", "extra"], { cwd: t.fork.path });
    expect(hooked(t, ["commit", "-qm", "after the kill"]).code).toBe(0);
    expect(vendoredInHead(t)).toEqual(pinnedCopy);
    expect(sh(["git", "show", "HEAD:vendor/extra/a.md"], { cwd: t.fork.path }).stdout).toBe("one\n");
    expect(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: t.fork.path }).stdout).not.toContain("vendor/");
  });

  forkTest("a commit stages a vendored copy that matches the pin and is missing from the index", (t) => {
    trackVendored(t);
    sh(["git", "rm", "-rq", "--cached", "vendor/extra"], { cwd: t.fork.path });
    t.fork.write("note.txt", "a note\n");
    sh(["git", "add", "note.txt"], { cwd: t.fork.path });
    expect(hooked(t, ["commit", "-qm", "note"]).code).toBe(0);
    expect(vendoredInHead(t)).toEqual(pinnedCopy);
  });

  forkTest("a commit does not record a vendored copy that differs from the pin", (t) => {
    trackVendored(t);
    const head = sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout;
    writeFileSync(join(t.fork.path, "vendor/extra/a.md"), "HAND EDIT\n");
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    const commit = hooked(t, ["commit", "-qm", "edit the copy"]);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("differs from the pin");
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).toBe(head);
    expect(vendoredInHead(t)).toEqual(pinnedCopy);
    expect(sh(["git", "show", "HEAD:vendor/extra/a.md"], { cwd: t.fork.path }).stdout).toBe("one\n");
  });

  forkTest("init refuses vendor in the fork layout and writes nothing", (t) => {
    sh(["git", "clone", "-q", t.up.path, "plain"], { cwd: t.tmp });
    const plain = join(t.tmp, "plain");
    const init = t.pb(["init", "--upstream", t.up.path, "--vendor", "lib"], { cwd: plain, code: 1 });
    expect(init.stderr).toContain("--vendor needs --output-to");
    expect(init.stderr).toContain("the root upstream of a fork builds into the whole repo");
    expect(existsSync(join(plain, ".patchbook"))).toBe(false);
    expect(sh(["git", "remote"], { cwd: plain }).stdout).not.toContain("upstream");
  });

  const trackHidden = (t: ForkCase): void => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "one\n");
    extra.write("debug.log", "noise\n");
    extra.commit("start");
    t.fork.write(".gitignore", "deep/vendor/extra/*.log\n");
    const tracked = t.pb(["track", "extra", extra.path, "--vendor", "deep/vendor/extra"], { cwd: t.fork.path, code: 1 });
    expect(tracked.stderr).toContain("the vendored copy of extra hashes to");
  };

  forkTest("sync leaves no vendor folder behind when the first copy does not verify", (t) => {
    trackHidden(t);
    expect(existsSync(join(t.fork.path, "deep"))).toBe(false);
  });

  forkTest("a first copy that does not verify leaves the folders that were there", (t) => {
    t.fork.write("deep/notes.txt", "mine\n");
    trackHidden(t);
    expect(readdirSync(join(t.fork.path, "deep"))).toEqual(["notes.txt"]);
  });

  const leftover = "couldn't delete .patchbook/sync-extra";
  const inJournal = (t: ForkCase): string[] => staged(t).filter((p) => p.startsWith(".patchbook/sync-"));
  const outsideJournal = (t: ForkCase): Record<string, string> =>
    Object.fromEntries(Object.entries(tree(t.fork.path)).filter(([p]) => !p.startsWith(".patchbook/sync-")));

  describe.skipIf(process.getuid?.() === 0)("where chmod blocks deletes, so not as root", () => {
    const moveWithAReadOnlyOldCopy = (t: ForkCase): Repo => {
      const extra = trackVendored(t);
      chmodSync(join(t.fork.path, "vendor/extra/lib"), 0o555);
      extra.write("a.md", "two\n");
      extra.commit("move");
      const first = t.pb(["sync", "extra"], { cwd: t.fork.path });
      expect(first.stdout).toContain("extra: pinned");
      expect(first.stderr).toContain(leftover);
      expect(first.stderr).toContain("git ignores it");
      return extra;
    };
    const unlock = (t: ForkCase): void => void sh(["chmod", "-R", "u+w", "."], { cwd: t.fork.path });

    forkTest("sync finishes and warns when the old vendored copy cannot be deleted", (t) => {
      try {
        const extra = moveWithAReadOnlyOldCopy(t);
        expect(t.fork.read("vendor/extra/a.md")).toBe("two\n");
        expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
        expect(inJournal(t)).toEqual([]);

        const unmoved = t.pb(["sync", "extra"], { cwd: t.fork.path });
        expect(unmoved.stdout).toContain("Nothing to do.");
        expect(unmoved.stderr).toContain(leftover);

        extra.write("a.md", "three\n");
        extra.commit("move again");
        const moved = t.pb(["sync", "extra"], { cwd: t.fork.path });
        expect(moved.stdout).toContain("extra: pinned");
        expect(moved.stderr).toContain(leftover);
        expect(t.fork.read("vendor/extra/a.md")).toBe("three\n");
        expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
        expect(inJournal(t)).toEqual([]);
      } finally {
        unlock(t);
      }
      const cleared = t.pb(["sync", "extra"], { cwd: t.fork.path });
      expect(cleared.stderr).toBe("");
      expect(existsSync(join(t.fork.path, ".patchbook/sync-extra"))).toBe(false);
    });

    forkTest("a sync that fails after an old copy could not be deleted puts back the copy it found", (t) => {
      try {
        const extra = moveWithAReadOnlyOldCopy(t);
        t.fork.commit("sync extra");
        t.fork.write(".gitignore", "*.log\n");
        extra.write("c.log", "hidden\n");
        extra.commit("ship a log");
        const before = outsideJournal(t);

        const failed = t.pb(["sync", "extra"], { cwd: t.fork.path, code: 1 });
        expect(failed.stderr).toContain("Does a .gitignore hide upstream files?");
        expect(outsideJournal(t)).toEqual(before);
        expect(t.fork.read("vendor/extra/a.md")).toBe("two\n");
      } finally {
        unlock(t);
      }
    });

    forkTest("a leftover stays ignored when its gitignore is deleted", (t) => {
      try {
        moveWithAReadOnlyOldCopy(t);
        rmSync(join(t.fork.path, ".patchbook/sync-extra/.gitignore"));
        expect(t.pb(["sync", "extra"], { cwd: t.fork.path }).stderr).toContain(leftover);
        expect(inJournal(t)).toEqual([]);
      } finally {
        unlock(t);
      }
    });

    forkTest("sync warns about an old copy it can neither delete nor move and moves no pin past it", (t) => {
      const extra = trackVendored(t);
      t.fork.write(".patchbook/sync-extra/.gitignore", "*\n");
      t.fork.write(".patchbook/sync-extra/old/a.md", "one\n");
      try {
        chmodSync(join(t.fork.path, ".patchbook/sync-extra/old"), 0o555);
        const unmoved = t.pb(["sync", "extra"], { cwd: t.fork.path });
        expect(unmoved.stdout).toContain("Nothing to do.");
        expect(unmoved.stderr).toContain(leftover);
        expect(inJournal(t)).toEqual([]);

        extra.write("a.md", "two\n");
        extra.commit("move");
        const before = outsideJournal(t);
        const moved = t.pb(["sync", "extra"], { cwd: t.fork.path, code: 1 });
        expect(moved.stderr).toContain("couldn't delete .patchbook/sync-extra/old");
        expect(outsideJournal(t)).toEqual(before);
      } finally {
        unlock(t);
      }
      expect(t.pb(["sync", "extra"], { cwd: t.fork.path }).stdout).toContain("extra: pinned");
      expect(existsSync(join(t.fork.path, ".patchbook/sync-extra"))).toBe(false);
    });
  });

  for (const moved of [false, true]) {
    forkTest(`sync deletes a plain file at its journal path when upstream ${moved ? "has" : "has not"} moved`, (t) => {
      const extra = trackVendored(t);
      const j = join(t.fork.path, ".patchbook/sync-extra");
      writeFileSync(j, "not a folder\n");
      if (moved) {
        extra.write("a.md", "two\n");
        extra.commit("move");
      }

      const synced = t.pb(["sync", "extra"], { cwd: t.fork.path });
      expect(synced.stdout).toContain(moved ? "extra: pinned" : "Nothing to do.");
      expect(synced.stderr).toBe("");
      expect(existsSync(j)).toBe(false);
      expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    });
  }
});
