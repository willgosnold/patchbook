import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { UpstreamCheck } from "../../src/api.ts";
import { CMD, Case, Repo, TIMEOUT, crashCmd, dedent, isRoot, permissionTest, sh, words } from "../helpers";
import { read, isSymlink, tree, storeOf, checkedUpstream, lockPin, lockNames, withPin, gc, markerScript, setRemote, snapshot, ForkCase, VendorCase, forkTest, vendorTest } from "../e2e-fixtures.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const pinOf = (t: { repo: Repo }): string => lockPin(read(join(t.repo.path, ".patchbook/upstream.lock")), "plugin").commit;

const inStore = (store: string, commit: string): boolean => sh(["git", "cat-file", "-e", `${commit}^{commit}`], { cwd: store, check: false }).code === 0;
const dropRefs = (store: string): void => {
  for (const ref of sh(["git", "for-each-ref", "--format=%(refname)"], { cwd: store }).stdout.split("\n").filter(Boolean)) {
    sh(["git", "update-ref", "-d", ref], { cwd: store });
  }
};

describe("VendorTest", () => {
  class FolderCase extends Case {
    readonly repo: Repo;

    constructor() {
      super();
      const up = new Repo(join(this.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      this.repo = new Repo(join(this.tmp, "repo"));
      this.repo.write("README.md", "mine\n");
      this.repo.commit("start");
      this.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: this.repo.path });
    }
  }
  const folderTest = (name: string, body: (t: FolderCase) => void): void => {
    test(name, () => {
      const t = new FolderCase();
      try {
        body(t);
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);
  };
  const trackExtra = (t: FolderCase, vendor: string): void => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "one\n");
    extra.write("lib/b.md", "bee\n");
    extra.commit("start");
    t.pb(["track", "extra", extra.path, "--vendor", vendor], { cwd: t.repo.path });
    t.pb(["build"], { cwd: t.repo.path });
  };
  const gitIn = (t: FolderCase, args: string[], env: Record<string, string> = {}): string =>
    sh(["git", ...args], { cwd: t.repo.path, env: { ...t.env, ...env } }).stdout;
  const hookedCommit = (t: FolderCase, args: string[]) =>
    sh(["git", "commit", ...args], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1" }, check: false });
  const inHead = (t: FolderCase, dir: string): string[] =>
    gitIn(t, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter((p) => p.startsWith(`${dir}/`));
  const pinnedFiles = (dir: string): string[] => [`${dir}/a.md`, `${dir}/lib/b.md`];
  /** Commit everything but the vendored copy, so HEAD and the index hold no copy while the disk does. */
  const commitWithoutCopy = (t: FolderCase, vendor: string): void => {
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["--literal-pathspecs", "rm", "-rq", "--cached", "--", vendor]);
    gitIn(t, ["commit", "-qm", "setup"]);
  };

  folderTest("a partial commit records only what the user named", (t) => {
    trackExtra(t, "vendor/extra");
    commitWithoutCopy(t, "vendor/extra");
    t.repo.write("kept.txt", "kept\n");
    t.repo.write("other.txt", "other\n");
    gitIn(t, ["add", "kept.txt", "other.txt"]);
    const commit = hookedCommit(t, ["-qm", "partial", "--", "kept.txt"]);
    expect(commit.code).toBe(0);
    expect(gitIn(t, ["show", "--name-only", "--format=", "HEAD"]).trim()).toBe("kept.txt");
    expect(gitIn(t, ["diff", "--cached", "--name-only"]).trim()).toBe("other.txt");
    expect(gitIn(t, ["ls-files", "--others", "--exclude-standard", "vendor"]).trim().split("\n")).toEqual(pinnedFiles("vendor/extra"));
  });

  for (const [vendor, sibling, change] of [["x*", "xylo.txt", "edit"], ["lib/ex*", "lib/ex-notes.md", "delete"]] as const) {
    folderTest(`the hook touches only the vendor folder when its name has a glob ${change}`, (t) => {
      t.repo.write(sibling, "notes\n");
      trackExtra(t, vendor);
      commitWithoutCopy(t, vendor);
      if (change === "edit") t.repo.write(sibling, "notes, edited\n");
      else t.repo.rm(sibling);
      t.repo.write("note.txt", "a note\n");
      gitIn(t, ["add", "note.txt"]);
      const commit = hookedCommit(t, ["-qm", "note"]);
      expect(commit.stderr).not.toContain("failed");
      expect(commit.code).toBe(0);
      expect(inHead(t, vendor)).toEqual(pinnedFiles(vendor));
      expect(gitIn(t, ["show", `HEAD:${sibling}`])).toBe("notes\n");
      expect(gitIn(t, ["status", "--short", "--", sibling]).trim()).toBe(change === "edit" ? `M ${sibling}` : `D ${sibling}`);
      expect(Object.keys(tree(join(t.repo.path, "out/extra"))).sort()).toEqual(["a.md", "lib/b.md"]);
    });
  }

  folderTest("a commit never records a tracked ignored file inside the vendored copy and says it replaced it", (t) => {
    t.repo.write(".gitignore", "*.log\n");
    trackExtra(t, "vendor/extra");
    t.repo.write("vendor/extra/x.log", "log\n");
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["add", "-f", "vendor/extra/x.log"]);
    gitIn(t, ["commit", "-qm", "setup"]);
    t.repo.write("vendor/extra/x.log", "log, edited\n");
    t.repo.write("note.txt", "a note\n");
    gitIn(t, ["add", "note.txt"]);
    const commit = hookedCommit(t, ["-qm", "note"]);
    expect(commit.code).toBe(0);
    expect(commit.stderr).toContain(replacedLine);
    expect(inHead(t, "vendor/extra")).toEqual(pinnedFiles("vendor/extra"));
    expect(gitIn(t, ["status", "--short", "vendor"]).trim()).toBe("");
  });

  folderTest("a commit after the advised sync replaces a file the index holds at the vendor path", (t) => {
    trackExtra(t, "vendor/extra");
    rmSync(join(t.repo.path, "vendor/extra"), { recursive: true });
    t.repo.write("vendor/extra", "a file\n");
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "a file in the way"]);
    rmSync(join(t.repo.path, "vendor/extra"));
    t.pb(["sync", "extra"], { cwd: t.repo.path });
    t.repo.write("note.txt", "a note\n");
    gitIn(t, ["add", "note.txt"]);
    const commit = hookedCommit(t, ["-qm", "put the copy back"]);
    expect(commit.stderr).toContain(replacedLine);
    expect(commit.code).toBe(0);
    expect(inHead(t, "vendor/extra")).toEqual(pinnedFiles("vendor/extra"));
    expect(gitIn(t, ["status", "--short"]).trim()).toBe("");
  });

  folderTest("an empty pin does not hide a file the index holds at the vendor path", (t) => {
    trackExtra(t, "vendor/extra");
    t.repo.write("vendor/extra/marker.txt", "x\n");
    rmSync(join(t.repo.path, "vendor/extra"), { recursive: true });
    t.repo.write("vendor/extra", "a file\n");
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "a file in the way"]);
    const extra = new Repo(join(t.tmp, "extra"));
    sh(["git", "rm", "-rq", "."], { cwd: extra.path });
    extra.commit("empty");
    rmSync(join(t.repo.path, "vendor/extra"));
    t.pb(["sync", "extra"], { cwd: t.repo.path });
    expect(lockPin(t.repo.read(".patchbook/upstream.lock"), "extra").tree).toBe(EMPTY_TREE);
    t.pb(["build"], { cwd: t.repo.path, code: null });
    t.repo.write("note.txt", "a note\n");
    gitIn(t, ["add", "note.txt", ".patchbook/upstream.lock", ".patchbook/build.lock"]);
    const commit = hookedCommit(t, ["-qm", "empty pin"]);
    expect(commit.code).toBe(0);
    expect(lockPin(gitIn(t, ["show", "HEAD:.patchbook/upstream.lock"]), "extra").tree).toBe(EMPTY_TREE);
    expect(gitIn(t, ["ls-tree", "HEAD", "vendor/extra"])).toBe("");
  });

  folderTest("an unstaged sync then an unrelated commit leaves the vendored copy at the pin in head", (t) => {
    trackExtra(t, "vendor/extra");
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "setup"]);
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "two\n");
    extra.commit("bump");
    t.pb(["sync", "extra"], { cwd: t.repo.path });
    t.repo.write("note.txt", "a note\n");
    gitIn(t, ["add", "note.txt"]);
    const head = gitIn(t, ["rev-parse", "HEAD"]);
    const commit = hookedCommit(t, ["-qm", "an unrelated note"]);
    expect(commit.code).toBe(1);
    expect(commit.stderr).toContain("aren't in this commit:\n  .patchbook/upstream.lock");
    expect(commit.stderr).not.toContain("pinned copy");
    expect(gitIn(t, ["rev-parse", "HEAD"])).toBe(head);
    expect(gitIn(t, ["show", "HEAD:vendor/extra/a.md"])).toBe("one\n");
    expect(gitIn(t, ["diff", "--cached", "--name-only"]).trim()).toBe("note.txt");
    gitIn(t, ["clone", "-q", ".", "../clone"]);
    expect(t.pb(["status"], { cwd: join(t.tmp, "clone") }).stdout).toContain("no problems");
  });

  folderTest("the hook leaves a vendor folder alone when the index has no lock for it", (t) => {
    trackExtra(t, "vendor/extra");
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["reset", "-q", "--", ".patchbook/upstream.lock", "vendor"]);
    t.repo.write("note.txt", "a note\n");
    gitIn(t, ["add", "note.txt"]);
    const commit = hookedCommit(t, ["-qm", "no lock staged"]);
    expect(commit.code).toBe(1);
    expect(commit.stderr).toContain("aren't in this commit:\n  .patchbook/upstream.lock");
    expect(commit.stderr).not.toContain("pinned copy");
    expect(gitIn(t, ["ls-files", "vendor"])).toBe("");
  });

  for (const [index, where] of [["alt", "the git dir"], ["next-index-copy", "the git dir"], ["next-index-7.lock", "another folder"]] as const) {
    for (const what of ["removal", "edit"]) {
      folderTest(`a full commit through a custom git index file named ${index} in ${where} restores the pin after a staged ${what}`, (t) => {
        trackExtra(t, "vendor/extra");
        gitIn(t, ["add", "-A"]);
        gitIn(t, ["commit", "-qm", "setup"]);
        const dir = where === "the git dir" ? join(t.repo.path, ".git") : join(t.tmp, "elsewhere");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, index);
        copyFileSync(join(t.repo.path, ".git/index"), file);
        const env = { GIT_INDEX_FILE: file };
        if (what === "removal") {
          gitIn(t, ["rm", "-rq", "--cached", "vendor/extra"], env);
        } else {
          t.repo.write("vendor/extra/a.md", "junk\n");
          gitIn(t, ["add", "vendor/extra/a.md"], env);
          t.repo.write("vendor/extra/a.md", "one\n");
        }
        t.repo.write("note.txt", "a note\n");
        gitIn(t, ["add", "note.txt"], env);
        const commit = sh(["git", "commit", "-qm", "note"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1", ...env }, check: false });
        expect(commit.code).toBe(0);
        expect(inHead(t, "vendor/extra")).toEqual(pinnedFiles("vendor/extra"));
        expect(gitIn(t, ["show", "HEAD:vendor/extra/a.md"])).toBe("one\n");
      });
    }
  }

  const replacedLine = "patchbook: the pre-commit hook staged the pinned copy of extra under vendor/extra, in place of what the index held";

  folderTest("untracking the vendored copy alone is refused and leaves the removal staged", (t) => {
    trackExtra(t, "vendor/extra");
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "setup"]);
    const head = gitIn(t, ["rev-parse", "HEAD"]);
    gitIn(t, ["rm", "-r", "-q", "--cached", "vendor/extra"]);
    const commit = hookedCommit(t, ["-qm", "stop tracking the copy"]);
    expect(commit.code).toBe(1);
    expect(commit.stderr).toContain("nothing would be left to commit");
    expect(commit.stderr).toContain("vendor/extra");
    expect(commit.stderr).toContain("PATCHBOOK_HOOK=0");
    expect(commit.stderr).toContain("delete the upstream's vendor line");
    expect(gitIn(t, ["rev-parse", "HEAD"])).toBe(head);
    expect(gitIn(t, ["diff", "--cached", "--name-only"]).trim().split("\n")).toEqual(pinnedFiles("vendor/extra"));
  });

  folderTest("a staged edit to the vendored copy undone on disk is refused when nothing else is staged", (t) => {
    trackExtra(t, "vendor/extra");
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "setup"]);
    const head = gitIn(t, ["rev-parse", "HEAD"]);
    t.repo.write("vendor/extra/a.md", "junk\n");
    gitIn(t, ["add", "vendor/extra/a.md"]);
    t.repo.write("vendor/extra/a.md", "one\n");
    const commit = hookedCommit(t, ["-qm", "commit with a staged copy edit"]);
    expect(commit.code).toBe(1);
    expect(commit.stderr).toContain("nothing would be left to commit");
    expect(gitIn(t, ["rev-parse", "HEAD"])).toBe(head);
    expect(gitIn(t, ["diff", "--cached", "--name-only"]).trim()).toBe("vendor/extra/a.md");
  });

  const stageLock = (t: FolderCase, edit: (text: string) => string): void => {
    const path = join(t.repo.path, ".patchbook/upstream.lock");
    const good = readFileSync(path, "utf8");
    writeFileSync(path, edit(good));
    gitIn(t, ["add", ".patchbook/upstream.lock"]);
    writeFileSync(path, good);
  };

  folderTest("a pin tree missing from the repo is refused before the index changes", (t) => {
    trackExtra(t, "vendor/extra");
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "setup"]);
    const missing = "1".repeat(40);
    const lock = join(t.repo.path, ".patchbook/upstream.lock");
    writeFileSync(lock, readFileSync(lock, "utf8").replace(/"tree": "[0-9a-f]{40}"/, `"tree": "${missing}"`));
    gitIn(t, ["add", ".patchbook/upstream.lock"]);
    t.repo.write("note.txt", "a note\n");
    gitIn(t, ["add", "note.txt"]);
    const head = gitIn(t, ["rev-parse", "HEAD"]);
    const index = gitIn(t, ["ls-files", "-s"]);
    const commit = hookedCommit(t, ["-qm", "pin to a tree the repo lacks"]);
    expect(commit.code).toBe(1);
    expect(commit.stderr).toContain("patchbook: vendor/extra");
    expect(commit.stderr).toContain(`differs from the pin (tree ${missing.slice(0, 7)})`);
    expect(commit.stderr).toContain("run sync");
    expect(commit.stderr).not.toContain("fatal:");
    expect(gitIn(t, ["rev-parse", "HEAD"])).toBe(head);
    expect(gitIn(t, ["ls-files", "-s"])).toBe(index);
  });

  folderTest("an upstream.lock in the index that cannot be read is refused without a stack trace", (t) => {
    trackExtra(t, "vendor/extra");
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "setup"]);
    stageLock(t, () => "{ not json");
    t.repo.write("note.txt", "a note\n");
    gitIn(t, ["add", "note.txt"]);
    const head = gitIn(t, ["rev-parse", "HEAD"]);
    const index = gitIn(t, ["ls-files", "-s"]);
    const commit = hookedCommit(t, ["-qm", "a lock that is not json"]);
    expect(commit.code).toBe(1);
    expect(commit.stderr).toContain("patchbook:");
    expect(commit.stderr).toContain(".patchbook/upstream.lock");
    expect(commit.stderr).not.toMatch(/\n\s+at /);
    expect(gitIn(t, ["rev-parse", "HEAD"])).toBe(head);
    expect(gitIn(t, ["ls-files", "-s"])).toBe(index);
  });

  folderTest("the hook restores the pinned copy through an upstream.lock that is a link", (t) => {
    trackExtra(t, "vendor/extra");
    const [inside, outside] = [join(t.repo.path, ".patchbook/upstream.lock"), join(t.tmp, "outside-upstream.lock")];
    renameSync(inside, outside);
    symlinkSync(outside, inside);
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "setup"]);
    gitIn(t, ["rm", "-r", "-q", "--cached", "vendor/extra"]);
    t.repo.write("note.txt", "a note\n");
    gitIn(t, ["add", "note.txt"]);
    const commit = hookedCommit(t, ["-qm", "a note"]);
    expect(commit.stderr).toContain(replacedLine);
    expect(commit.code).toBe(0);
    expect(inHead(t, "vendor/extra")).toEqual(pinnedFiles("vendor/extra"));
    expect(gitIn(t, ["status", "--short"]).trim()).toBe("");
  });

  folderTest("an unstaged sync through an upstream.lock that is a link to a file in the repo is refused like a plain lock", (t) => {
    trackExtra(t, "vendor/extra");
    const [link, target] = [join(t.repo.path, ".patchbook/upstream.lock"), join(t.repo.path, "pins/upstream.lock")];
    mkdirSync(dirname(target));
    renameSync(link, target);
    symlinkSync("../pins/upstream.lock", link);
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "setup"]);
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "two\n");
    extra.commit("bump");
    expect(t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 }).stderr).toContain(".patchbook/upstream.lock is a link");
    rmSync(link);
    copyFileSync(target, link);
    t.pb(["sync", "extra"], { cwd: t.repo.path });
    renameSync(link, target);
    symlinkSync("../pins/upstream.lock", link);
    t.repo.write("note.txt", "a note\n");
    gitIn(t, ["add", "note.txt"]);
    const head = gitIn(t, ["rev-parse", "HEAD"]);
    const commit = hookedCommit(t, ["-qm", "an unrelated note"]);
    expect(commit.code).toBe(1);
    expect(commit.stderr).toContain("aren't in this commit:\n  pins/upstream.lock");
    expect(commit.stderr).not.toContain("pinned copy");
    expect(gitIn(t, ["rev-parse", "HEAD"])).toBe(head);
    expect(gitIn(t, ["diff", "--cached", "--name-only"]).trim()).toBe("note.txt");

    gitIn(t, ["add", "-A"]);
    expect(hookedCommit(t, ["-qm", "sync and a note"]).code).toBe(0);
    expect(gitIn(t, ["show", "HEAD:vendor/extra/a.md"])).toBe("two\n");
    expect(gitIn(t, ["show", "HEAD:out/extra/a.md"])).toBe("two\n");
    gitIn(t, ["clone", "-q", ".", "../clone"]);
    expect(t.pb(["status"], { cwd: join(t.tmp, "clone") }).stdout).toContain("no problems");
  });

  const bumpUpstream = (t: FolderCase, name: string): void => {
    const up = new Repo(join(t.tmp, name));
    up.write("a.md", "two\n");
    up.commit("bump");
    t.pb(["sync", name], { cwd: t.repo.path });
  };
  const uncommittedSyncOfExtra = (t: FolderCase): void => {
    trackExtra(t, "vendor/extra");
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "setup"]);
    bumpUpstream(t, "extra");
    t.repo.write("note.txt", "a note\n");
    gitIn(t, ["add", "note.txt"]);
  };
  const refusedLeavingWork = (t: FolderCase, args: string[]): string => {
    const [head, porcelain, note, cached] = [gitIn(t, ["rev-parse", "HEAD"]), gitIn(t, ["status", "--short"]), t.repo.read("note.txt"), gitIn(t, ["diff", "--cached"])];
    const copy = t.repo.read("vendor/extra/a.md");
    const commit = hookedCommit(t, args);
    expect(commit.code).toBe(1);
    expect(gitIn(t, ["rev-parse", "HEAD"])).toBe(head);
    expect(gitIn(t, ["status", "--short"])).toBe(porcelain);
    expect(gitIn(t, ["diff", "--cached"])).toBe(cached);
    expect(t.repo.read("note.txt")).toBe(note);
    expect(t.repo.read("vendor/extra/a.md")).toBe(copy);
    return commit.stderr;
  };
  const cloneStatus = (t: FolderCase): string => {
    gitIn(t, ["clone", "-q", ".", "../clone"]);
    return t.pb(["status"], { cwd: join(t.tmp, "clone"), code: null }).stdout;
  };

  folderTest("a partial commit that names the lock but not the vendored copy is refused", (t) => {
    uncommittedSyncOfExtra(t);
    const stderr = refusedLeavingWork(t, ["-qm", "lock only", "--", "note.txt", ".patchbook/upstream.lock"]);
    expect(stderr).toContain("refusing this commit: it moves the pin of extra in .patchbook/upstream.lock but not its vendored copy, vendor/extra");
    expect(stderr).toContain("add these to the paths you named: .patchbook/upstream.lock vendor/extra");
    expect(stderr).toContain("or make a full commit with `git commit` and no paths");
    expect(gitIn(t, ["show", "HEAD:vendor/extra/a.md"])).toBe("one\n");
    expect(gitIn(t, ["show", "HEAD:.patchbook/upstream.lock"])).not.toContain(lockPin(t.repo.read(".patchbook/upstream.lock"), "extra").tree);
  });

  folderTest("a partial commit that names only part of the vendored copy is refused", (t) => {
    trackExtra(t, "vendor/extra");
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "setup"]);
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("lib/b.md", "bee, moved\n");
    extra.commit("bump lib");
    bumpUpstream(t, "extra");
    t.repo.write("note.txt", "a note\n");
    gitIn(t, ["add", "note.txt"]);
    const stderr = refusedLeavingWork(t, ["-qm", "lock and one file", "--", "note.txt", ".patchbook/upstream.lock", "vendor/extra/a.md"]);
    expect(stderr).toContain("it moves the pin of extra in .patchbook/upstream.lock but not its vendored copy, vendor/extra");
  });

  folderTest("a partial commit that names the lock and the vendored copy commits both", (t) => {
    uncommittedSyncOfExtra(t);
    const commit = hookedCommit(t, ["-qm", "note and sync", "--", "note.txt", ".patchbook/upstream.lock", "vendor/extra"]);
    expect(commit.stderr).not.toContain("refusing");
    expect(commit.code).toBe(0);
    expect(gitIn(t, ["show", "HEAD:vendor/extra/a.md"])).toBe("two\n");
    expect(gitIn(t, ["show", "HEAD:.patchbook/upstream.lock"])).toBe(t.repo.read(".patchbook/upstream.lock"));
    expect(gitIn(t, ["show", "--name-only", "--format=", "HEAD"]).split("\n")).toEqual(
      expect.arrayContaining(["note.txt", ".patchbook/upstream.lock", "vendor/extra/a.md"]),
    );
    expect(cloneStatus(t)).toContain("no problems");
  });

  folderTest("a full commit after the refused partial commit records the lock and the copy together", (t) => {
    uncommittedSyncOfExtra(t);
    refusedLeavingWork(t, ["-qm", "lock only", "--", "note.txt", ".patchbook/upstream.lock"]);
    gitIn(t, ["add", "-A"]);
    expect(hookedCommit(t, ["-qm", "full"]).code).toBe(0);
    expect(gitIn(t, ["show", "HEAD:vendor/extra/a.md"])).toBe("two\n");
    expect(cloneStatus(t)).toContain("no problems");
  });

  folderTest("a partial commit that leaves the lock and the copy alone still commits", (t) => {
    uncommittedSyncOfExtra(t);
    gitIn(t, ["add", "-A"]);
    expect(hookedCommit(t, ["-qm", "sync"]).code).toBe(0);
    t.repo.write("later.txt", "later\n");
    gitIn(t, ["add", "later.txt"]);
    t.repo.write("README.md", "edited\n");
    expect(hookedCommit(t, ["-qm", "later", "--", "later.txt"]).code).toBe(0);
    expect(gitIn(t, ["show", "--name-only", "--format=", "HEAD"]).trim()).toBe("later.txt");
    expect(gitIn(t, ["status", "--short"]).trim()).toBe("M README.md");
  });

  folderTest("a partial commit with a pin that already disagrees with the copy in HEAD but does not move it still commits", (t) => {
    uncommittedSyncOfExtra(t);
    expect(hookedCommit(t, ["-qm", "lock only, unhooked", "--no-verify", "--", ".patchbook/upstream.lock"]).code).toBe(0);
    t.repo.write("later.txt", "later\n");
    gitIn(t, ["add", "later.txt"]);
    expect(hookedCommit(t, ["-qm", "later", "--", "later.txt"]).code).toBe(0);
    const files = gitIn(t, ["show", "--name-only", "--format=", "HEAD"]).split("\n");
    expect(files).toContain("later.txt");
    expect(files.filter((p) => p.startsWith("vendor/") || p === ".patchbook/upstream.lock")).toEqual([]);
  });

  folderTest("a partial commit moving the pin of one of two vendored upstreams needs only that copy", (t) => {
    trackExtra(t, "vendor/extra");
    const more = new Repo(join(t.tmp, "more"));
    more.write("a.md", "one\n");
    more.commit("start");
    t.pb(["track", "more", more.path, "--vendor", "vendor/more"], { cwd: t.repo.path });
    t.pb(["build"], { cwd: t.repo.path });
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "setup"]);
    bumpUpstream(t, "extra");
    t.repo.write("note.txt", "a note\n");
    gitIn(t, ["add", "note.txt"]);
    const stderr = refusedLeavingWork(t, ["-qm", "wrong copy", "--", "note.txt", ".patchbook/upstream.lock", "vendor/more"]);
    expect(stderr).toContain("it moves the pin of extra in .patchbook/upstream.lock but not its vendored copy, vendor/extra");
    expect(stderr).not.toContain("vendor/more");
    expect(hookedCommit(t, ["-qm", "right copy", "--", "note.txt", ".patchbook/upstream.lock", "vendor/extra"]).code).toBe(0);
    expect(gitIn(t, ["show", "HEAD:vendor/extra/a.md"])).toBe("two\n");
    expect(cloneStatus(t)).toContain("no problems");
  });

  folderTest("a partial commit moving the pins of two vendored upstreams names both copies", (t) => {
    trackExtra(t, "vendor/extra");
    const more = new Repo(join(t.tmp, "more"));
    more.write("a.md", "one\n");
    more.commit("start");
    t.pb(["track", "more", more.path, "--vendor", "vendor/more"], { cwd: t.repo.path });
    t.pb(["build"], { cwd: t.repo.path });
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "setup"]);
    bumpUpstream(t, "extra");
    bumpUpstream(t, "more");
    t.repo.write("note.txt", "a note\n");
    gitIn(t, ["add", "note.txt"]);
    const stderr = refusedLeavingWork(t, ["-qm", "one copy", "--", "note.txt", ".patchbook/upstream.lock", "vendor/more"]);
    expect(stderr).toContain("the pin of extra in .patchbook/upstream.lock but not its vendored copy, vendor/extra");
    expect(stderr).not.toContain("pin of more");
    expect(hookedCommit(t, ["-qm", "both copies", "--", "note.txt", ".patchbook/upstream.lock", "vendor/extra", "vendor/more"]).code).toBe(0);
    expect(cloneStatus(t)).toContain("no problems");
  });

  const linkedLock = (t: FolderCase, dir = "pins"): void => {
    trackExtra(t, "vendor/extra");
    const [link, target] = [join(t.repo.path, ".patchbook/upstream.lock"), join(t.repo.path, dir, "upstream.lock")];
    mkdirSync(dirname(target));
    renameSync(link, target);
    symlinkSync(`../${dir}/upstream.lock`, link);
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "setup"]);
    rmSync(link);
    copyFileSync(target, link);
    bumpUpstream(t, "extra");
    renameSync(link, target);
    symlinkSync(`../${dir}/upstream.lock`, link);
    t.repo.write("note.txt", "a note\n");
    gitIn(t, ["add", "note.txt"]);
  };

  for (const named of [["pins/upstream.lock"], [".patchbook/upstream.lock", "pins/upstream.lock"]]) {
    folderTest(`a partial commit naming ${named.join(" and ")} of a linked lock but not the copy is refused`, (t) => {
      linkedLock(t);
      const stderr = refusedLeavingWork(t, ["-qm", "lock only", "--", "note.txt", ...named]);
      expect(stderr).toContain("it moves the pin of extra in .patchbook/upstream.lock but not its vendored copy, vendor/extra");
      expect(stderr).toContain("add these to the paths you named: .patchbook/upstream.lock pins/upstream.lock vendor/extra");
    });
  }

  folderTest("a partial commit naming a linked lock's target in a folder whose name starts with two dots but not the copy is refused", (t) => {
    linkedLock(t, "..pins");
    const stderr = refusedLeavingWork(t, ["-qm", "lock only", "--", "note.txt", "..pins/upstream.lock"]);
    expect(stderr).toContain("it moves the pin of extra in .patchbook/upstream.lock but not its vendored copy, vendor/extra");
  });

  folderTest("a partial commit naming the linked lock, its target and the copy commits all three", (t) => {
    linkedLock(t);
    const commit = hookedCommit(t, ["-qm", "note and sync", "--", "note.txt", ".patchbook/upstream.lock", "pins/upstream.lock", "vendor/extra"]);
    expect(commit.stderr).not.toContain("refusing");
    expect(commit.code).toBe(0);
    expect(gitIn(t, ["show", "HEAD:vendor/extra/a.md"])).toBe("two\n");
    expect(gitIn(t, ["ls-tree", "HEAD", ".patchbook/upstream.lock"])).toMatch(/^120000 /);
    expect(cloneStatus(t)).toContain("no problems");
  });

  folderTest("the refusal of an unstaged lock says to name the copy with it", (t) => {
    trackExtra(t, "vendor/extra");
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "setup"]);
    bumpUpstream(t, "extra");
    t.repo.write("note.txt", "a note\n");
    gitIn(t, ["add", "note.txt"]);
    const stderr = refusedLeavingWork(t, ["-qm", "note", "--", "note.txt"]);
    expect(stderr).toContain("aren't in this commit:\n  .patchbook/upstream.lock");
    expect(adviced(stderr, /name (.+?) in `git commit <path>`/)).toEqual([".patchbook/upstream.lock", "vendor/extra"]);
    expect(stderr).not.toContain("(or name them in `git commit <path>`)");
  });

  const adviced = (stderr: string, pattern: RegExp): string[] => (pattern.exec(stderr)?.[1] ?? "").split(" ").filter(Boolean);

  folderTest("a partial commit leaves the pin alone when HEAD's lock is a link out of the repo", (t) => {
    trackExtra(t, "vendor/extra");
    const [link, outside] = [join(t.repo.path, ".patchbook/upstream.lock"), join(t.tmp, "outside/upstream.lock")];
    mkdirSync(dirname(outside));
    renameSync(link, outside);
    symlinkSync("../../outside/upstream.lock", link);
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "setup"]);
    rmSync(link);
    copyFileSync(outside, link);
    bumpUpstream(t, "extra");
    renameSync(link, outside);
    symlinkSync("../../outside/upstream.lock", link);
    t.repo.write("note.txt", "a note\n");
    gitIn(t, ["add", "note.txt"]);
    const commit = hookedCommit(t, ["-qm", "note", "--", "note.txt"]);
    expect(commit.stderr).not.toContain("refusing");
    expect(commit.code).toBe(0);
    expect(gitIn(t, ["show", "--name-only", "--format=", "HEAD"]).split("\n")).toContain("note.txt");
  });

  folderTest("the refusal of an unstaged linked lock names the link, its target and the copy, and they commit", (t) => {
    linkedLock(t);
    const stderr = refusedLeavingWork(t, ["-qm", "note", "--", "note.txt", ".patchbook/upstream.lock"]);
    const named = adviced(stderr, /name (.+?) in `git commit <path>`/);
    expect(named.sort()).toEqual([".patchbook/upstream.lock", "pins/upstream.lock", "vendor/extra"]);
    const commit = hookedCommit(t, ["-qm", "note", "--", "note.txt", ...named]);
    expect(commit.stderr).not.toContain("refusing");
    expect(commit.code).toBe(0);
    expect(cloneStatus(t)).toContain("no problems");
  });

  const trackedFiles = [".patchbook/config.toml", ".patchbook/build.lock", ".patchbook/series"];
  const firstVendoring = (t: FolderCase, staged: string[]): void => {
    trackExtra(t, "vendor/extra");
    t.repo.write("note.txt", "a note\n");
    gitIn(t, ["add", "note.txt", ...staged]);
  };

  folderTest("a partial commit that first vendors an upstream says to add the copy before naming it", (t) => {
    firstVendoring(t, [...trackedFiles, ".patchbook/upstream.lock"]);
    const stderr = refusedLeavingWork(t, ["-qm", "track", "--", "note.txt", ...trackedFiles, ".patchbook/upstream.lock"]);
    expect(stderr).toContain("it moves the pin of extra in .patchbook/upstream.lock but not its vendored copy, vendor/extra");
    gitIn(t, ["add", ...adviced(stderr, /run `git add (.+?)` first, then add these/)]);
    const named = adviced(stderr, /add these to the paths you named: (.+?), or make a full commit/);
    expect(named).toEqual([".patchbook/upstream.lock", "vendor/extra"]);
    const commit = hookedCommit(t, ["-qm", "track", "--", "note.txt", ...trackedFiles, ...named]);
    expect(commit.stderr).not.toContain("refusing");
    expect(commit.code).toBe(0);
    expect(gitIn(t, ["show", "HEAD:vendor/extra/a.md"])).toBe("one\n");
    expect(cloneStatus(t)).toContain("no problems");
  });

  folderTest("the refusal of an unstaged lock that first vendors an upstream says to add the lock and the copy first", (t) => {
    firstVendoring(t, trackedFiles);
    const stderr = refusedLeavingWork(t, ["-qm", "track", "--", "note.txt", ...trackedFiles]);
    expect(stderr).toContain("aren't in this commit:\n  .patchbook/upstream.lock");
    gitIn(t, ["add", ...adviced(stderr, /run `git add (.+?)` first, then name/)]);
    const named = adviced(stderr, /name (.+?) in `git commit <path>`/);
    expect(named.sort()).toEqual([".patchbook/upstream.lock", "vendor/extra"]);
    const commit = hookedCommit(t, ["-qm", "track", "--", "note.txt", ...trackedFiles, ...named]);
    expect(commit.stderr).not.toContain("refusing");
    expect(commit.code).toBe(0);
    expect(cloneStatus(t)).toContain("no problems");
  });

  folderTest("a partial commit naming a copy that differs from the pin is refused for the edit", (t) => {
    uncommittedSyncOfExtra(t);
    t.repo.write("vendor/extra/a.md", "hand edit\n");
    const stderr = refusedLeavingWork(t, ["-qm", "edited copy", "--", "note.txt", ".patchbook/upstream.lock", "vendor/extra"]);
    expect(stderr).toContain("differs from the pin");
    expect(stderr).toContain("Never edit the vendored copy");
    expect(stderr).not.toContain("it moves the pin of extra");
  });

  folderTest("the full commit the refusal advises commits the lock and the copy", (t) => {
    uncommittedSyncOfExtra(t);
    const stderr = refusedLeavingWork(t, ["-qm", "lock only", "--", "note.txt", ".patchbook/upstream.lock"]);
    gitIn(t, ["add", ...adviced(stderr, /\(run `git add (.+?)` first\)/)]);
    const commit = hookedCommit(t, ["-qm", "full"]);
    expect(commit.stderr).not.toContain("refusing");
    expect(commit.code).toBe(0);
    expect(gitIn(t, ["show", "HEAD:vendor/extra/a.md"])).toBe("two\n");
    expect(cloneStatus(t)).toContain("no problems");
  });

  folderTest("a commit that changes nothing in the copy says nothing about it", (t) => {
    trackExtra(t, "vendor/extra");
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "setup"]);
    t.repo.write("README.md", "edited\n");
    const commit = hookedCommit(t, ["-qam", "readme"]);
    expect(commit.code).toBe(0);
    expect(commit.stderr).not.toContain("pinned copy");
  });

  folderTest("an --allow-empty commit is not refused and records the copy", (t) => {
    trackExtra(t, "vendor/extra");
    commitWithoutCopy(t, "vendor/extra");
    const commit = hookedCommit(t, ["-qm", "empty", "--allow-empty"]);
    expect(commit.code).toBe(0);
    expect(inHead(t, "vendor/extra")).toEqual(pinnedFiles("vendor/extra"));
  });

  folderTest("the hook stages the vendored copy and leaves an unstaged edit elsewhere unstaged", (t) => {
    trackExtra(t, "vendor/extra");
    t.repo.write("README.md", "mine\n");
    gitIn(t, ["add", "-A"]);
    gitIn(t, ["commit", "-qm", "setup"]);
    t.repo.write("README.md", "edited, not staged\n");
    t.repo.write("mine.txt", "the user's staged change\n");
    gitIn(t, ["add", "mine.txt"]);
    gitIn(t, ["rm", "-rq", "--cached", "vendor/extra"]);
    expect(hookedCommit(t, ["-qm", "mine"]).code).toBe(0);
    expect(inHead(t, "vendor/extra")).toEqual(pinnedFiles("vendor/extra"));
    expect(gitIn(t, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").filter((p) => !p.startsWith("vendor/"))).toEqual(["mine.txt"]);
    expect(gitIn(t, ["show", "HEAD:README.md"])).toBe("mine\n");
    expect(gitIn(t, ["status", "--short"]).trim()).toBe("M README.md");
  });

  vendorTest("a missing output is reported, scaffold writes its entries, a patched entry builds", (t) => {
    t.missingScaffoldPatchBuild();
  });

  vendorTest("build --commit leaves out files outside the build", (t) => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    t.repo.write("notes.md", "scratch\n");
    t.repo.write("README.md", "mine, edited\n");
    t.repo.write("staged.md", "staged\n");
    sh(["git", "add", "staged.md"], { cwd: t.repo.path });
    t.pb(["build", "--commit"], { cwd: t.repo.path });
    const files = words(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: t.repo.path }).stdout);
    expect(files).toContain("skills/hello/SKILL.md");
    expect(files).toContain(".patchbook/build.lock");
    expect(files).toContain("vendor/extra/a.md");
    expect(files).not.toContain("notes.md");
    expect(files).not.toContain("README.md");
    expect(files).not.toContain("staged.md");
    expect(sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout).toBe(" M README.md\nA  staged.md\n?? notes.md\n");
  });

  vendorTest("build --commit takes the placeholder file so a clone builds", (t) => {
    t.missingScaffoldPatchBuild();
    t.pb(["build", "--commit"], { cwd: t.repo.path });
    const clone = join(t.tmp, "clone");
    sh(["git", "clone", "-q", t.repo.path, clone], { cwd: t.tmp });
    t.pb(["build"], { cwd: clone });
    expect(read(join(clone, "skills/hello/SKILL.md"))).toContain("Say hello in T3.");
    expect(sh(["git", "status", "--porcelain"], { cwd: clone }).stdout).toBe("");
    expect(sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout).toBe("");
  });

  vendorTest("build --commit leaves out an ignored placeholder file", (t) => {
    writeFileSync(join(t.repo.path, ".git/info/exclude"), ".patchbook/snippets.md\n");
    t.missingScaffoldPatchBuild();
    t.pb(["build", "--commit"], { cwd: t.repo.path });
    expect(sh(["git", "ls-files", ".patchbook/snippets.md"], { cwd: t.repo.path }).stdout).toBe("");
    expect(sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout).toBe("");
  });

  vendorTest("commit stops on a placeholder file left out of it", (t) => {
    t.missingScaffoldPatchBuild();
    t.pb(["build", "--commit"], { cwd: t.repo.path });
    t.repo.write(".patchbook/snippets.md", "## greet\n\nSay hi in T3.\n");
    t.repo.write("README.md", "mine, edited\n");
    sh(["git", "add", "README.md"], { cwd: t.repo.path });
    const head = sh(["git", "rev-parse", "HEAD"], { cwd: t.repo.path }).stdout;
    const commit = sh(["git", "commit", "-qm", "readme"], { cwd: t.repo.path, check: false, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("the patchbook has changes that aren't in this commit:\n  .patchbook/snippets.md");
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.repo.path }).stdout).toBe(head);
    expect(read(join(t.repo.path, "skills/hello/SKILL.md"))).toContain("Say hello in T3.");
  });

  vendorTest("first commit after build takes the output", (t) => {
    t.missingScaffoldPatchBuild();
    sh(["git", "add", ".patchbook"], { cwd: t.repo.path });
    sh(["git", "commit", "-qm", "built"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(sh(["git", "show", "HEAD:skills/hello/SKILL.md"], { cwd: t.repo.path }).stdout).toContain("Say hello in T3.");
    expect(existsSync(join(t.repo.path, ".patchbook/changes/shout"))).toBe(false);
    expect(sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout).toBe("");
  });

  const builtAndCommitted = (t: VendorCase): void => {
    t.missingScaffoldPatchBuild();
    sh(["git", "add", ".patchbook"], { cwd: t.repo.path });
    sh(["git", "commit", "-qm", "built"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
  };

  vendorTest("commit refuses an output folder replaced by a file", (t) => {
    builtAndCommitted(t);
    rmSync(join(t.repo.path, "skills/hello"), { recursive: true });
    t.repo.write("skills/hello", "x\n");
    sh(["git", "add", "-A"], { cwd: t.repo.path });
    const before = { files: tree(t.repo.path), staged: sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout };
    const commit = sh(["git", "commit", "-qm", "hello is a file"], { cwd: t.repo.path, check: false, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("skills/hello");
    expect(commit.stderr).toContain("can't record a folder turned into a file");
    expect(commit.stderr).toContain("PATCHBOOK_HOOK=0");
    expect(commit.stderr).not.toContain("fatal");
    expect(tree(t.repo.path)).toEqual(before.files);
    expect(sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout).toBe(before.staged);
  });

  const ignoredFolderBecomesFile = (t: VendorCase): void => {
    t.repo.write(".gitignore", "skills/hello/\n");
    sh(["git", "add", ".gitignore"], { cwd: t.repo.path });
    builtAndCommitted(t);
    expect(sh(["git", "ls-files", "skills"], { cwd: t.repo.path }).stdout).toBe("");
    rmSync(join(t.repo.path, "skills/hello"), { recursive: true });
    t.repo.write("skills/hello", "x\n");
  };

  vendorTest("commit refuses an ignored output folder replaced by a file", (t) => {
    ignoredFolderBecomesFile(t);
    sh(["git", "add", "-A"], { cwd: t.repo.path });
    const before = { files: tree(t.repo.path), staged: sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout };
    const commit = sh(["git", "commit", "-qm", "hello is a file"], { cwd: t.repo.path, check: false, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("skills/hello is a file now");
    expect(commit.stderr).toContain("skills/hello/SKILL.md");
    expect(commit.stderr).toContain("can't record a folder turned into a file");
    expect(tree(t.repo.path)).toEqual(before.files);
    expect(sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout).toBe(before.staged);
  });

  vendorTest("record refuses an ignored output folder replaced by a file", (t) => {
    ignoredFolderBecomesFile(t);
    const before = tree(t.repo.path);
    const out = t.pb(["record", "--intent", "Make hello a file."], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("skills/hello is a file now");
    expect(out.stderr).toContain("skills/hello/SKILL.md");
    expect(tree(t.repo.path)).toEqual(before);
  });

  vendorTest("commit ignores an output folder replaced by a file that is not staged", (t) => {
    builtAndCommitted(t);
    rmSync(join(t.repo.path, "skills/hello"), { recursive: true });
    t.repo.write("skills/hello", "x\n");
    t.repo.write("README.md", "mine, edited\n");
    sh(["git", "add", "README.md"], { cwd: t.repo.path });
    const commit = sh(["git", "commit", "-qm", "readme"], { cwd: t.repo.path, check: false, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(commit.code).toBe(0);
    expect(sh(["git", "ls-tree", "-r", "--name-only", "HEAD", "--", "skills"], { cwd: t.repo.path }).stdout).toBe("skills/hello/SKILL.md\n");
    expect(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: t.repo.path }).stdout).toBe("README.md\n");
  });

  vendorTest("build --commit with nothing in the output", (t) => {
    const repo = new Repo(join(t.tmp, "empty"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    t.pb(["init", "--upstream", t.up.path, "--path", "plugin", "--output-from", "nothing", "--output-to", "nothing"], { cwd: repo.path });
    t.pb(["build", "--commit"], { cwd: repo.path });
    expect(words(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: repo.path }).stdout)).toContain(".patchbook/build.lock");
    expect(sh(["git", "status", "--porcelain"], { cwd: repo.path }).stdout).toBe("");
  });

  vendorTest("an added file and a move build into a folder-layout output", (t) => {
    t.missingScaffoldPatchBuild();
    const change = join(t.repo.path, ".patchbook/changes/support");
    mkdirSync(join(change, "ours/skills/support"), { recursive: true });
    writeFileSync(join(change, "ours/skills/support/SKILL.md.pb"), "---\nname: support\n---\n");
    writeFileSync(join(change, "CHANGE.md"), dedent(`
      # support

      intent: Ship the agent briefs inside a support skill.

      edits:
      - add skills/support/SKILL.md
      - move agents -> skills/support/agents
    `).trimStart());
    writeFileSync(join(t.repo.path, ".patchbook/series"), "support\n");
    t.pb(["build"], { cwd: t.repo.path });
    expect(t.repo.read("skills/support/agents/helper.md")).toBe("A helper.\n");
    expect(existsSync(join(t.repo.path, "skills/support/SKILL.md"))).toBe(true);
  });

  vendorTest("record in a folder-layout output records an added file", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.write("skills/hello/notes.txt", "added by hand\n");
    t.pb(["record", "notes", "--intent", "Add notes."], { cwd: t.repo.path });
    expect(read(join(t.repo.path, ".patchbook/changes/notes/CHANGE.md"))).toContain("- add skills/hello/notes.txt");
    t.pb(["build"], { cwd: t.repo.path });
    expect(t.repo.read("skills/hello/notes.txt")).toBe("added by hand\n");
  });

  vendorTest("record turns an edited paragraph into a block entry, and updates, adds and drops entries", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    // A patched paragraph keeps its placeholder, and the model writes its intent again.
    let out = t.recordEdit("Say hello in T3.", "Say hello in T3. Smile.");
    expect(out).toMatch(/^entry    hello\/SKILL\.md \[[0-9a-f]{12}\] updated\nintent   hello\/SKILL\.md \[[0-9a-f]{12}\]: Shout the second line\.\n$/);
    expect(read(entries)).toContain("rules: t3\nintent: Shout the second line.\n");
    expect(read(entries)).toContain("--- patched\n{{snippet:greet}} Smile.");
    expect(read(join(t.tmp, "prompt.txt"))).toContain("Speak T3.");
    // An upstream paragraph gets a new entry, with the model's intent.
    out = t.recordEdit("Then wave.", "Then wave twice.");
    expect(out).toContain("intent: Shout the second line.");
    expect(read(entries)).toContain("--- upstream\nThen wave.\n--- patched\nThen wave twice.");
    expect(read(entries)).toContain("kind: policy");
    // A new paragraph joins the one before it.
    t.recordEdit("# Hello\n", "# Hello\n\nHi first.\n", "--intent", "Greet first.");
    expect(read(entries)).toContain("--- patched\n# Hello\n\nHi first.");
    // A deleted paragraph, and one put back as upstream had it.
    t.recordEdit("Then wave twice.\n", "", "--intent", "No waving.");
    expect(read(entries)).toContain("--- upstream\nThen wave.\n--- patched\n\n");
    t.recordEdit("# Hello\n\nHi first.\n", "# Hello\n");
    expect(read(entries)).not.toContain("Hi first.");
  });

  vendorTest("record prompt breaks a paragraph edit into lines only at newlines", (t) => {
    t.missingScaffoldPatchBuild();
    t.recordEdit("Then wave.", "Then\fwave\u2028twice.");
    expect(read(join(t.tmp, "prompt.txt"))).toContain("@@ -1 +1 @@\n-Then wave.\n+Then\fwave\u2028twice.\n");
  });

  forkTest("record writes a quoted edit line for a name that starts or ends with whitespace or holds an arrow", (t) => {
    const names = [" lead.txt", "trail.txt ", "\uFEFFbom-lead.txt", "bom-trail.txt\uFEFF", "arrow -> name.txt"];
    for (const name of names) t.fork.write(name, `${JSON.stringify(name)}\n`);
    const out = t.pb(["record", "names", "--intent", "Add files whose names need quoting."], { cwd: t.fork.path }).stdout;
    const file = join(t.fork.path, ".patchbook/changes/names/CHANGE.md");
    const change = read(file);
    for (const name of names) {
      expect(out).toContain(`${"add".padEnd(9)}${name}\n`);
      expect(change).toContain(`\n- add "${name}"\n`);
    }
    t.pb(["build"], { cwd: t.fork.path });
    expect(read(join(t.fork.path, ".patchbook/build.lock")).split("\n").filter(Boolean).map((l) => l.replace(/^(?:\d{6} )?[0-9a-f]{40} /, ""))).toEqual(expect.arrayContaining(names));
    for (const name of names) rmSync(join(t.fork.path, name));
    t.pb(["build", "--force"], { cwd: t.fork.path });
    for (const name of names) expect(read(join(t.fork.path, name))).toBe(`${JSON.stringify(name)}\n`);
  });

  forkTest("a hand-written edit line with whitespace at the end of a path is refused and a quoted one builds", (t) => {
    const dir = join(t.fork.path, ".patchbook/changes/hand");
    const file = join(dir, "CHANGE.md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(t.fork.path, ".patchbook/series"), "hand\n");
    writeFileSync(file, "# hand\n\nintent: Move the guide.\n\nedits:\n- move docs/guide.md -> moved.txt \n");
    const refused = t.pb(["build"], { cwd: t.fork.path, code: 1 });
    expect(refused.stderr).toContain(`${file}:6: the path "moved.txt " starts or ends with whitespace; write it in double quotes: "moved.txt "`);
    expect(existsSync(join(t.fork.path, "moved.txt "))).toBe(false);
    writeFileSync(file, '# hand\n\nintent: Move the guide.\n\nedits:\n- move docs/guide.md -> "moved.txt "\n');
    t.pb(["build"], { cwd: t.fork.path });
    expect(read(join(t.fork.path, "moved.txt "))).toBe("a guide\n");
    expect(existsSync(join(t.fork.path, "moved.txt"))).toBe(false);
  });

  forkTest("a hand-written edit path that ends in a slash is refused and nothing is built", (t) => {
    const dir = join(t.fork.path, ".patchbook/changes/hand");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(t.fork.path, ".patchbook/series"), "hand\n");
    writeFileSync(join(dir, "CHANGE.md"), "# hand\n\nintent: Move the guide.\n\nedits:\n- move docs/guide.md -> moved /\n");
    const before = tree(t.fork.path);
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout;
    expect(status).toContain("changes/hand move docs/guide.md -> moved /: ");
    expect(status).toContain("no slash at the end");
    expect(t.pb(["build"], { cwd: t.fork.path, code: 1 }).stderr).toContain("nothing built");
    expect(tree(t.fork.path)).toEqual(before);
  });

  forkTest("record keeps a hand-written move whose source ends in an arrow and build moves that file", (t) => {
    t.up.write("a ->", "AAA\n");
    t.up.write("a", "alpha\n");
    t.up.commit("names that end in an arrow");
    t.pb(["sync"], { cwd: t.fork.path });
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "mv", "--intent", "Shout two and move a file."], { cwd: t.fork.path });
    const file = join(t.fork.path, ".patchbook/changes/mv/CHANGE.md");
    writeFileSync(file, read(file) + '- move "a ->" -> b.txt\n');
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("three", "THREE"));
    t.pb(["record", "mv", "--intent", "Shout two and move a file."], { cwd: t.fork.path });
    expect(read(file)).toContain('\n- move "a ->" -> b.txt\n');
    t.pb(["build"], { cwd: t.fork.path });
    expect(read(join(t.fork.path, "b.txt"))).toBe("AAA\n");
    expect(read(join(t.fork.path, "a"))).toBe("alpha\n");
    expect(existsSync(join(t.fork.path, "a ->"))).toBe(false);
    expect(existsSync(join(t.fork.path, "-> b.txt"))).toBe(false);
  });

  vendorTest("record skips a paragraph edit whose entry uses a placeholder that is empty", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    t.repo.write(".patchbook/snippets.md", "## none\n\n## greet\n\nSay hello in T3.\n");
    writeFileSync(entries, read(entries).replaceAll("--- patched\n{{snippet:greet}}", "--- patched\n{{snippet:none}}{{snippet:greet}}"));
    t.pb(["build"], { cwd: t.repo.path });
    const recorded = read(entries);
    const skill = "skills/hello/SKILL.md";
    t.repo.write(skill, t.repo.read(skill).replaceAll("Say hello in T3.", "Say hello in T3. Smile."));
    const out = t.pb(["record", "--intent", "Smile."], { cwd: t.repo.path }).stdout;
    expect(out).toContain("skipped  hello/SKILL.md: its block entry uses {{snippet:none}}, which is empty, so the edit can't show where it goes; edit its block entries directly");
    expect(read(entries)).toBe(recorded);
    expect(t.repo.read(skill)).toContain("Say hello in T3. Smile.");
    const before = tree(t.repo.path);
    expect(t.pb(["status"], { cwd: t.repo.path, code: 1 }).stdout).toContain(`unrecorded ${skill}:`);
    const json = JSON.parse(t.pb(["status", "--json"], { cwd: t.repo.path, code: 1 }).stdout);
    expect(json.problems).toMatchObject([{ problem: "unrecorded", file: skill }]);
    expect(tree(t.repo.path)).toEqual(before);
    expect(t.pb(["build"], { cwd: t.repo.path, code: 1 }).stderr).toContain("changed since the last build");
  });

  vendorTest("record paragraph edit with an intent keeps the intent of a change named unnamed", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    t.repo.write("skills/hello/notes.txt", "added by hand\n");
    t.pb(["record", "unnamed", "--intent", "Add notes."], { cwd: t.repo.path });
    t.recordEdit("Then wave.", "Then wave twice.", "--intent", "Wave twice.");
    expect(read(entries)).toContain("--- patched\nThen wave twice.");
    expect(read(join(t.repo.path, ".patchbook/changes/unnamed/CHANGE.md"))).toContain("intent: Add notes.");
    expect(read(join(t.repo.path, ".patchbook/changes/unnamed/CHANGE.md"))).not.toContain("Wave twice.");
  });

  vendorTest("record of a paragraph edit uses a given intent for the new entry and says nothing more", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    const out = t.recordEdit("Then wave.", "Then wave twice.", "--intent", "Wave twice.");
    expect(out).toMatch(/^entry    hello\/SKILL\.md \[[0-9a-f]+\] added\n$/);
    expect(read(entries)).toContain("intent: Wave twice.");
    expect(existsSync(join(t.repo.path, ".patchbook/changes"))).toBe(false);
  });

  vendorTest("record deleting a file with block entries with no name or intent asks the model", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.write("skills/hello/notes.txt", "added by hand\n");
    t.pb(["record", "unnamed", "--intent", "Add notes."], { cwd: t.repo.path });
    unlinkSync(join(t.repo.path, "skills/hello/SKILL.md"));
    expect(t.pb(["record"], { cwd: t.repo.path }).stdout).toBe("shout: Shout the second line.\ndelete   hello/SKILL.md\n");
    expect(read(join(t.tmp, "prompt.txt"))).toContain("hello/SKILL.md");
    expect(read(join(t.repo.path, ".patchbook/changes/shout/CHANGE.md"))).toContain("- delete skills/hello/SKILL.md");
    const kept = read(join(t.repo.path, ".patchbook/changes/unnamed/CHANGE.md"));
    expect(kept).toContain("intent: Add notes.");
    expect(kept).not.toContain("delete");
  });

  vendorTest("record deleting a file with block entries names the change from the intent", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.write("skills/hello/notes.txt", "added by hand\n");
    t.pb(["record", "unnamed", "--intent", "Add notes."], { cwd: t.repo.path });
    unlinkSync(join(t.repo.path, "skills/hello/SKILL.md"));
    t.pb(["record", "--intent", "Drop the skill."], { cwd: t.repo.path });
    const kept = read(join(t.repo.path, ".patchbook/changes/unnamed/CHANGE.md"));
    expect(kept).toContain("intent: Add notes.");
    expect(kept).toContain("- add skills/hello/notes.txt");
    const dropped = read(join(t.repo.path, ".patchbook/changes/drop-the-skill/CHANGE.md"));
    expect(dropped).toContain("intent: Drop the skill.");
    expect(dropped).toContain("- delete skills/hello/SKILL.md");
  });

  vendorTest("record deleting a file with block entries removes its block entries", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    unlinkSync(join(t.repo.path, "skills/hello/SKILL.md"));
    expect(t.pb(["record", "--intent", "Drop the skill."], { cwd: t.repo.path }).stdout).toBe("drop-the-skill: Drop the skill.\ndelete   hello/SKILL.md\n");
    expect(existsSync(entries)).toBe(false);
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.repo.path });
    expect(existsSync(join(t.repo.path, "skills/hello/SKILL.md"))).toBe(false);
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  vendorTest("record deleting one file keeps the block entries of another", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    t.up.write("plugin/skills/bye/SKILL.md", "# Bye\n\nOpen Cursor and say bye.\n");
    t.up.commit("more");
    t.pb(["sync"], { cwd: t.repo.path });
    t.pb(["scaffold"], { cwd: t.repo.path });
    const kept = join(t.repo.path, ".patchbook/blocks/skills/bye/SKILL.md.entries");
    expect(existsSync(kept)).toBe(true);
    unlinkSync(join(t.repo.path, "skills/hello/SKILL.md"));
    t.pb(["record", "--intent", "Drop the skill."], { cwd: t.repo.path });
    expect(existsSync(entries)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  vendorTest("hook recording a delete removes the block entries from the tree", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    t.pb(["hook", "install"], { cwd: t.repo.path });
    sh(["git", "add", "-A"], { cwd: t.repo.path });
    sh(["git", "commit", "-qm", "built"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Built it." } });
    unlinkSync(join(t.repo.path, "skills/hello/SKILL.md"));
    sh(["git", "commit", "-qam", "drop"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Drop the skill." }, check: false });
    expect(read(join(t.repo.path, ".patchbook/changes/drop-the-skill/CHANGE.md"))).toContain("- delete skills/hello/SKILL.md");
    expect(existsSync(entries)).toBe(false);
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  const SKILL_X = "---\nname: x\n---\n\nThe x skill.\n";
  const extraSkill = (t: VendorCase): Repo => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("skills/x/SKILL.md", SKILL_X);
    extra.commit("x");
    t.pb(["track", "extra", extra.path, "--mount", "extra"], { cwd: t.repo.path });
    t.pb(["build"], { cwd: t.repo.path });
    return extra;
  };

  vendorTest("hook records a skill copied from another upstream as a copy, and the copy follows that upstream", (t) => {
    const extra = extraSkill(t);
    t.pb(["hook", "install"], { cwd: t.repo.path });
    sh(["git", "add", "-A"], { cwd: t.repo.path });
    sh(["git", "commit", "-qm", "built"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } });
    t.repo.write("skills/x/SKILL.md", SKILL_X);
    sh(["git", "add", "-A"], { cwd: t.repo.path });
    const commit = sh(["git", "commit", "-qm", "ship x"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Ship extra's x skill." } });
    expect(commit.stderr).toContain("ship-extra-s-x: Ship extra's x skill.\ncopy     extra/skills/x -> skills/x\n");
    const change = join(t.repo.path, ".patchbook/changes/ship-extra-s-x");
    expect(read(join(change, "CHANGE.md"))).toBe("# ship-extra-s-x\n\nintent: Ship extra's x skill.\n\nedits:\n- copy extra/skills/x -> skills/x\n");
    expect(existsSync(join(change, "ours"))).toBe(false);
    extra.write("skills/x/SKILL.md", SKILL_X.replace("The x skill.", "The x skill, revised upstream."));
    extra.commit("revise");
    t.pb(["sync"], { cwd: t.repo.path });
    t.pb(["build"], { cwd: t.repo.path });
    expect(t.repo.read("skills/x/SKILL.md")).toBe(SKILL_X.replace("The x skill.", "The x skill, revised upstream."));
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  vendorTest("record of a folder copied from another upstream ships a file that upstream adds to the folder later", (t) => {
    const extra = extraSkill(t);
    t.repo.write("skills/x/SKILL.md", SKILL_X);
    expect(t.pb(["record", "x", "--intent", "Ship x."], { cwd: t.repo.path }).stdout).toBe("copy     extra/skills/x -> skills/x\n");
    extra.write("skills/x/notes.md", "notes\n");
    extra.commit("notes");
    t.pb(["sync"], { cwd: t.repo.path });
    t.pb(["build"], { cwd: t.repo.path });
    expect(t.repo.read("skills/x/notes.md")).toBe("notes\n");
  });

  const SKILL_A = "---\nname: a\n---\n\nFirst paragraph of a.\n\nSecond paragraph of a.\n\nThird paragraph of a.\n";
  const REVISED = (text: string) => text.replace("Second paragraph of a.", "Second paragraph of a, revised upstream.");
  const committedSkillA = (t: VendorCase, more: Record<string, string> = {}): void => {
    t.missingScaffoldPatchBuild();
    t.up.write("plugin/skills/a/SKILL.md", SKILL_A);
    t.up.write("plugin/skills/a/notes.md", "Notes on a.\n");
    for (const [name, text] of Object.entries(more)) t.up.write(`plugin/skills/a/${name}`, text);
    t.up.commit("a");
    t.pb(["sync"], { cwd: t.repo.path });
    t.pb(["build"], { cwd: t.repo.path });
    t.pb(["hook", "install"], { cwd: t.repo.path });
    sh(["git", "add", "-A"], { cwd: t.repo.path });
    sh(["git", "commit", "-qm", "built"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } });
  };
  const commitRename = (t: VendorCase, edit: (text: string) => string) => {
    sh(["git", "mv", "skills/a", "skills/a2"], { cwd: t.repo.path });
    t.repo.write("skills/a2/SKILL.md", edit(t.repo.read("skills/a2/SKILL.md")));
    sh(["git", "add", "-A"], { cwd: t.repo.path });
    return sh(["git", "commit", "-qm", "rename a"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Ship a as a2." } });
  };

  vendorTest("hook records a renamed and edited skill as a move and a file edit, and the renamed skill follows upstream", (t) => {
    committedSkillA(t);
    const commit = commitRename(t, (text) => text.replace("name: a\n", "name: a2\n"));
    expect(commit.stderr).toContain("ship-a-as-a2: Ship a as a2.\nmove     skills/a -> skills/a2\nfile     a2/SKILL.md\n");
    expect(read(join(t.repo.path, ".patchbook/changes/ship-a-as-a2/CHANGE.md")))
      .toBe("# ship-a-as-a2\n\nintent: Ship a as a2.\n\nedits:\n- move skills/a -> skills/a2\n- file skills/a/SKILL.md\n");
    t.up.write("plugin/skills/a/SKILL.md", REVISED(SKILL_A));
    t.up.commit("revise");
    expect(t.pb(["sync"], { cwd: t.repo.path }).stdout).toContain("1 of ours merged cleanly");
    t.pb(["build"], { cwd: t.repo.path });
    expect(t.repo.read("skills/a2/SKILL.md")).toBe(REVISED(SKILL_A).replace("name: a\n", "name: a2\n"));
    expect(t.repo.read("skills/a2/notes.md")).toBe("Notes on a.\n");
    expect(existsSync(join(t.repo.path, "skills/a"))).toBe(false);
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  vendorTest("hook records a renamed skill with no edit as a move alone", (t) => {
    committedSkillA(t);
    const commit = commitRename(t, (text) => text);
    expect(commit.stderr).toContain("ship-a-as-a2: Ship a as a2.\nmove     skills/a -> skills/a2\n");
    const change = join(t.repo.path, ".patchbook/changes/ship-a-as-a2");
    expect(read(join(change, "CHANGE.md"))).toBe("# ship-a-as-a2\n\nintent: Ship a as a2.\n\nedits:\n- move skills/a -> skills/a2\n");
    expect(existsSync(join(change, "ours"))).toBe(false);
  });

  vendorTest("record of a renamed and edited skill shows the model the move and the edit alone", (t) => {
    committedSkillA(t);
    sh(["git", "mv", "skills/a", "skills/a2"], { cwd: t.repo.path });
    t.repo.write("skills/a2/SKILL.md", t.repo.read("skills/a2/SKILL.md").replace("name: a\n", "name: a2\n"));
    t.pb(["record"], { cwd: t.repo.path });
    const prompt = read(join(t.tmp, "prompt.txt"));
    expect(prompt).toContain("Changed paths:\nmove skills/a -> skills/a2\na2/SKILL.md: changed, +1 -1 lines\n\n"
      + "--- built/a2/SKILL.md\n+++ disk/a2/SKILL.md\n@@ -1,5 +1,5 @@\n ---\n-name: a\n+name: a2\n ---\n \n First paragraph of a.\n");
    expect(prompt).not.toContain("added");
    expect(prompt).not.toContain("/dev/null");
    expect(prompt.split("a2/SKILL.md: ")).toHaveLength(2);
  });

  vendorTest("record of a renamed and edited skill that a copy still builds from writes the edit on the new path and shows the model the edit alone", (t) => {
    committedSkillA(t);
    t.repo.write("skills/b/SKILL.md", SKILL_A);
    t.repo.write("skills/b/notes.md", "Notes on a.\n");
    expect(t.pb(["record", "twin", "--intent", "Ship a as b too."], { cwd: t.repo.path }).stdout).toBe("copy     skills/a -> skills/b\n");
    sh(["git", "add", "-A"], { cwd: t.repo.path });
    sh(["git", "commit", "-qm", "twin"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } });
    sh(["git", "mv", "skills/a", "skills/a2"], { cwd: t.repo.path });
    t.repo.write("skills/a2/SKILL.md", t.repo.read("skills/a2/SKILL.md").replace("name: a\n", "name: a2\n"));
    expect(t.pb(["record"], { cwd: t.repo.path }).stdout).toBe("shout: Shout the second line.\nmove     skills/a -> skills/a2\nfile     a2/SKILL.md\n");
    expect(read(join(t.tmp, "prompt.txt"))).toContain("Changed paths:\nmove skills/a -> skills/a2\na2/SKILL.md: changed, +1 -1 lines\n\n"
      + "--- built/a2/SKILL.md\n+++ disk/a2/SKILL.md\n@@ -1,5 +1,5 @@\n ---\n-name: a\n+name: a2\n ---\n \n First paragraph of a.\n");
    expect(read(join(t.repo.path, ".patchbook/changes/shout/CHANGE.md"))).toContain("edits:\n- move skills/a -> skills/a2\n- file skills/a2/SKILL.md\n");
    t.up.write("plugin/skills/a/SKILL.md", REVISED(SKILL_A));
    t.up.commit("revise");
    expect(t.pb(["sync"], { cwd: t.repo.path }).stdout).toContain("1 of ours merged cleanly, 0 conflicts, 0 gone.");
    t.pb(["build"], { cwd: t.repo.path });
    expect([t.repo.read("skills/a2/SKILL.md"), t.repo.read("skills/b/SKILL.md")]).toEqual([REVISED(SKILL_A).replace("name: a\n", "name: a2\n"), REVISED(SKILL_A)]);
    expect(existsSync(join(t.repo.path, "skills/a"))).toBe(false);
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  vendorTest("hook records an edit to a copy of a skill with block entries as a file edit on the copy, which follows upstream", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    const skill = t.repo.read("skills/hello/SKILL.md");
    t.repo.write("skills/hello2/SKILL.md", skill);
    expect(t.pb(["record", "twin", "--intent", "Ship hello twice."], { cwd: t.repo.path }).stdout).toBe("copy     skills/hello -> skills/hello2\n");
    t.pb(["hook", "install"], { cwd: t.repo.path });
    sh(["git", "add", "-A"], { cwd: t.repo.path });
    sh(["git", "commit", "-qm", "twin"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } });
    t.repo.write("skills/hello2/SKILL.md", skill.replace("Then wave.", "Then wave twice."));
    sh(["git", "add", "-A"], { cwd: t.repo.path });
    const commit = sh(["git", "commit", "-qm", "wave"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Wave twice." } });
    expect(commit.stderr).toContain("wave-twice: Wave twice.\nfile     hello2/SKILL.md\n");
    const change = join(t.repo.path, ".patchbook/changes/wave-twice");
    expect(read(join(change, "CHANGE.md"))).toContain("edits:\n- file skills/hello2/SKILL.md\n");
    expect(read(join(change, "base/skills/hello2/SKILL.md.pb"))).toBe(t.up.read("plugin/skills/hello/SKILL.md"));
    expect(existsSync(entries)).toBe(true);
    expect(sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout).toBe("");
    t.up.write("plugin/skills/hello/SKILL.md", t.up.read("plugin/skills/hello/SKILL.md").replace("# Hello", "# Hello there"));
    t.up.commit("there");
    expect(t.pb(["sync"], { cwd: t.repo.path }).stdout).toContain("1 of ours merged cleanly, 0 conflicts, 0 gone.");
    t.pb(["build"], { cwd: t.repo.path });
    expect([t.repo.read("skills/hello/SKILL.md"), t.repo.read("skills/hello2/SKILL.md")])
      .toEqual([skill.replace("# Hello", "# Hello there"), skill.replace("# Hello", "# Hello there").replace("Then wave.", "Then wave twice.")]);
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  vendorTest("record of a renamed skill with no edit shows the model the move and no diff", (t) => {
    committedSkillA(t);
    sh(["git", "mv", "skills/a", "skills/a2"], { cwd: t.repo.path });
    t.pb(["record"], { cwd: t.repo.path });
    expect(read(join(t.tmp, "prompt.txt"))).toContain("Changed paths:\nmove skills/a -> skills/a2\n\n");
    expect(read(join(t.tmp, "prompt.txt"))).not.toContain("added");
  });

  vendorTest("record of a skill copied from another upstream shows the model the copy and no diff", (t) => {
    extraSkill(t);
    t.repo.write("skills/x/SKILL.md", SKILL_X);
    t.pb(["record"], { cwd: t.repo.path });
    const prompt = read(join(t.tmp, "prompt.txt"));
    expect(prompt).toContain("Changed paths:\ncopy extra/skills/x -> skills/x\n\n");
    expect(prompt).not.toContain("added");
    expect(prompt).not.toContain("/dev/null");
  });

  vendorTest("hook records a renamed skill that holds an empty file as one folder move, and the empty file follows upstream", (t) => {
    committedSkillA(t, { "empty.keep": "" });
    expect(t.repo.read("skills/a/empty.keep")).toBe("");
    const commit = commitRename(t, (text) => text);
    expect(commit.stderr).toContain("ship-a-as-a2: Ship a as a2.\nmove     skills/a -> skills/a2\n");
    expect(read(join(t.repo.path, ".patchbook/changes/ship-a-as-a2/CHANGE.md")))
      .toBe("# ship-a-as-a2\n\nintent: Ship a as a2.\n\nedits:\n- move skills/a -> skills/a2\n");
    t.up.write("plugin/skills/a/empty.keep", "filled upstream\n");
    t.up.write("plugin/skills/a/more.md", "More on a.\n");
    t.up.commit("fill and add");
    t.pb(["sync"], { cwd: t.repo.path });
    t.pb(["build"], { cwd: t.repo.path });
    expect(t.repo.read("skills/a2/empty.keep")).toBe("filled upstream\n");
    expect(t.repo.read("skills/a2/more.md")).toBe("More on a.\n");
    expect(existsSync(join(t.repo.path, "skills/a"))).toBe(false);
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  vendorTest("record of a renamed skill with block entries keeps the entries, and the build still applies them", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    const before = read(entries);
    renameSync(join(t.repo.path, "skills/hello"), join(t.repo.path, "skills/hi"));
    expect(t.pb(["record", "hi", "--intent", "Call it hi."], { cwd: t.repo.path }).stdout).toBe("move     skills/hello -> skills/hi\n");
    expect(read(entries)).toBe(before);
    rmSync(join(t.repo.path, "skills/hi"), { recursive: true });
    t.pb(["build", "--force"], { cwd: t.repo.path });
    expect(t.repo.read("skills/hi/SKILL.md")).toContain("Say hello in T3.");
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  const copyOfHello = (t: VendorCase): void => {
    mkdirSync(join(t.repo.path, ".patchbook/changes/dup"), { recursive: true });
    writeFileSync(join(t.repo.path, ".patchbook/changes/dup/CHANGE.md"), "# dup\n\nintent: Copy the skill.\n\nedits:\n- copy skills/hello/SKILL.md -> skills/copy/SKILL.md\n");
    writeFileSync(join(t.repo.path, ".patchbook/series"), "dup\n");
    t.pb(["build"], { cwd: t.repo.path });
    expect(read(join(t.repo.path, "skills/copy/SKILL.md"))).toContain("Say hello in T3.");
  };

  vendorTest("record deleting one output keeps the block entries another output still uses", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    copyOfHello(t);
    unlinkSync(join(t.repo.path, "skills/copy/SKILL.md"));
    t.pb(["record", "--intent", "Drop the copy."], { cwd: t.repo.path });
    expect(existsSync(entries)).toBe(true);
    t.pb(["build"], { cwd: t.repo.path });
    expect(read(join(t.repo.path, "skills/hello/SKILL.md"))).toContain("Say hello in T3.");
  });

  vendorTest("record deleting every output of one file removes its block entries", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    copyOfHello(t);
    unlinkSync(join(t.repo.path, "skills/hello/SKILL.md"));
    unlinkSync(join(t.repo.path, "skills/copy/SKILL.md"));
    t.pb(["record", "--intent", "Drop both."], { cwd: t.repo.path });
    expect(existsSync(entries)).toBe(false);
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  permissionTest("record that cannot save the delete keeps the block entries", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    unlinkSync(join(t.repo.path, "skills/hello/SKILL.md"));
    const changes = join(t.repo.path, ".patchbook/changes");
    mkdirSync(changes, { recursive: true });
    chmodSync(changes, 0o555);
    try {
      expect(t.pb(["record", "--intent", "Drop the skill."], { cwd: t.repo.path, code: 1 }).stdout).toBe("");
    } finally {
      chmodSync(changes, 0o755);
    }
    expect(existsSync(entries)).toBe(true);
  }, VendorCase);

  vendorTest("record of a paragraph writes the intent itself for a model reply whose intent is not a string", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    t.repo.write("skills/hello/SKILL.md", t.repo.read("skills/hello/SKILL.md").replaceAll("Then wave.", "Then wave twice."));
    writeFileSync(join(t.tmp, "bin/claude"), `#!/bin/sh\ncat > /dev/null\necho '{"intent": null}'\n`);
    const run = t.pb(["record"], { cwd: t.repo.path });
    expect(run.stdout).toMatch(/intent {3}by patchbook for hello\/SKILL\.md \[[0-9a-f]{12}\] \(claude didn't return a usable name and intent: claude's reply: intent is null\)\. /);
    expect(read(entries)).toMatch(/--- patched\nThen wave twice\./);
    expect(read(entries)).toContain('kind: policy\nrules: \nintent (by patchbook): Rewrites the paragraph that starts "Then wave." in hello/SKILL.md.\n');
  });

  vendorTest("record notes come in path order", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.write("skills/hello/AGENTS.md", "added by hand\n");
    const out = t.recordEdit("Then wave.", "Then wave twice.", "--intent", "Wave twice.");
    expect(out).toMatch(/^wave-twice: Wave twice\.\nadd {6}hello\/AGENTS\.md\nentry {4}hello\/SKILL\.md \[[0-9a-f]{12}\] added\n$/);
  });

  vendorTest("record of a file a hook made fails before writing block entries", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    writeFileSync(join(t.repo.path, ".patchbook/hooks.ts"), dedent(`
      export const finish = (out: Map<string, { data: Uint8Array; mode: number }>) => {
        out.set("z/gen.md", { data: new TextEncoder().encode("gen\\n"), mode: 0o644 });
      };
    `));
    t.pb(["build"], { cwd: t.repo.path });
    const before = read(entries);
    t.repo.write("skills/z/gen.md", "gen edited\n");
    t.repo.write("skills/hello/SKILL.md", t.repo.read("skills/hello/SKILL.md").replaceAll("Then wave.", "Then wave twice."));
    expect(t.pb(["record", "--intent", "Wave twice."], { cwd: t.repo.path, code: 1 }).stderr).toContain("z/gen.md is built from nothing");
    expect(read(entries)).toBe(before);
  });

  vendorTest("record skips a file with block entries that a hook leaves out and was put back", (t) => {
    t.missingScaffoldPatchBuild();
    const skill = t.repo.read("skills/hello/SKILL.md");
    writeFileSync(join(t.repo.path, ".patchbook/hooks.ts"), dedent(`
      export const finish = (out: Map<string, { data: Uint8Array; mode: number }>) => {
        out.delete("hello/SKILL.md");
      };
    `));
    t.pb(["build"], { cwd: t.repo.path });
    expect(existsSync(join(t.repo.path, "skills/hello/SKILL.md"))).toBe(false);
    t.repo.write("skills/hello/SKILL.md", skill);
    expect(t.pb(["record", "--intent", "Keep the skill."], { cwd: t.repo.path }).stdout)
      .toBe("skipped  hello/SKILL.md: a hook leaves it out of the build; change the hook to keep it\n");
    expect(existsSync(join(t.repo.path, ".patchbook/changes/keep-the-skill"))).toBe(false);
    expect(t.pb(["status"], { cwd: t.repo.path, code: 1 }).stdout).toContain("unrecorded skills/hello/SKILL.md");
  });

  const holderAndTwin = (t: VendorCase, copy: string): string => {
    const changes = join(t.repo.path, ".patchbook/changes");
    mkdirSync(join(changes, "holder/ours/skills/hello"), { recursive: true });
    writeFileSync(join(changes, "holder/ours/skills/hello/tpl.md.pb"), copy);
    writeFileSync(join(changes, "holder/CHANGE.md"), "# holder\n\nintent: Greet.\n\nedits:\n- add skills/hello/tpl.md\n");
    mkdirSync(join(changes, "twin"));
    writeFileSync(join(changes, "twin/CHANGE.md"), "# twin\n\nintent: Greet twice.\n\nedits:\n- copy skills/hello/tpl.md -> skills/hello/tpl2.md\n");
    const series = join(t.repo.path, ".patchbook/series");
    writeFileSync(series, (existsSync(series) ? read(series) : "") + "holder\ntwin\n");
    t.pb(["build"], { cwd: t.repo.path });
    return join(changes, "holder/ours/skills/hello/tpl.md.pb");
  };
  vendorTest("record replaces each of two outputs that share one copy when both are edited", (t) => {
    t.missingScaffoldPatchBuild();
    const copy = holderAndTwin(t, "Then hi.\n");
    t.repo.write("skills/hello/tpl.md", "Then hey.\n");
    t.repo.write("skills/hello/tpl2.md", "Then yo.\n");
    expect(t.pb(["record"], { cwd: t.repo.path }).stdout).toBe("shout: Shout the second line.\nreplace  hello/tpl.md\nreplace  hello/tpl2.md\n");
    expect(read(copy)).toBe("Then hi.\n");
    t.pb(["build"], { cwd: t.repo.path });
    expect([t.repo.read("skills/hello/tpl.md"), t.repo.read("skills/hello/tpl2.md")]).toEqual(["Then hey.\n", "Then yo.\n"]);
  });

  vendorTest("record deletes one output of a copy and skips the other whose copy uses placeholders", (t) => {
    t.missingScaffoldPatchBuild();
    const copy = holderAndTwin(t, "Then {{snippet:greet}}\n");
    unlinkSync(join(t.repo.path, "skills/hello/tpl.md"));
    t.repo.write("skills/hello/tpl2.md", "Then hi.\n");
    expect(t.pb(["record"], { cwd: t.repo.path }).stdout).toBe("shout: Shout the second line.\ndelete   hello/tpl.md\n"
      + "skipped  hello/tpl2.md: its copy in holder uses placeholders; edit that copy directly\n");
    expect(read(copy)).toBe("Then {{snippet:greet}}\n");
    expect(read(join(t.repo.path, ".patchbook/changes/holder/CHANGE.md"))).toContain("- add skills/hello/tpl.md");
  });

  vendorTest("record that cannot update the build.lock saves nothing", (t) => {
    if (process.getuid?.() === 0) return;
    t.missingScaffoldPatchBuild();
    t.repo.write("skills/hello/notes.txt", "added by hand\n");
    const lock = join(t.repo.path, ".patchbook/build.lock");
    chmodSync(lock, 0o444);
    try {
      const r = t.pb(["record", "--intent", "Add notes."], { cwd: t.repo.path, code: 1 });
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("permission denied");
      expect(existsSync(join(t.repo.path, ".patchbook/changes/add-notes"))).toBe(false);
      expect(read(join(t.repo.path, ".patchbook/series"))).not.toContain("add-notes");
    } finally {
      chmodSync(lock, 0o644);
    }
    t.pb(["record", "--intent", "Add notes."], { cwd: t.repo.path });
    expect(read(join(t.repo.path, ".patchbook/changes/add-notes/CHANGE.md"))).toContain("- add skills/hello/notes.txt");
  });

  vendorTest("record ignores output the patchbook changed", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    writeFileSync(entries, read(entries).replaceAll("{{snippet:greet}}", "Say hi in T3."));
    expect(t.pb(["record"], { cwd: t.repo.path }).stdout).toContain("nothing to record");
    expect(read(entries)).toContain("Say hi in T3.");
  });

  vendorTest("upstream rewording a patched block leaves an orphan with the nearest new block", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.commit("built");
    const skill = "plugin/skills/hello/SKILL.md";
    t.up.write(skill, t.up.read(skill).replaceAll("say hello", "say hi"));
    t.up.commit("reword");
    t.pb(["check"], { cwd: t.repo.path, code: 10 });
    t.pb(["sync"], { cwd: t.repo.path });
    const status = t.pb(["status"], { cwd: t.repo.path, code: 1 }).stdout;
    expect(status).toContain("orphan");
    expect(status).toContain("missing");
    expect(status).toMatch(/nearest new blocks: line 7 \[[0-9a-f]{12}\] 90%/);
  });

  vendorTest("a folder-layout repo holds no copy of upstream", (t) => {
    expect(existsSync(join(t.repo.path, "vendor"))).toBe(false);
    expect(read(join(t.repo.path, ".patchbook/config.toml"))).toContain('layout = "folder"');
    expect(readdirSync(join(t.tmp, "store/upstreams")).length).toBe(1);
  });

  vendorTest("upstream lists, prints, exports and diffs the files of an upstream", (t) => {
    const files = words(t.pb(["upstream", "plugin"], { cwd: t.repo.path }).stdout);
    expect(files).toEqual(["README.md", "agents/helper.md", "skills/hello/SKILL.md"]);
    expect(t.pb(["upstream", "plugin", "README.md"], { cwd: t.repo.path }).stdout).toBe("For Cursor users.\n");
    t.pb(["upstream", "plugin", "--export", join(t.tmp, "out")], { cwd: t.repo.path });
    expect(existsSync(join(t.tmp, "out/agents/helper.md"))).toBe(true);
    t.up.write("plugin/README.md", "For everyone.\n");
    t.up.commit("readme");
    t.pb(["sync"], { cwd: t.repo.path });
    const diff = t.pb(["upstream", "plugin", "--diff"], { cwd: t.repo.path }).stdout;
    expect(diff).toContain("-For Cursor users.");
    expect(diff).toContain("a/README.md");
  });

  vendorTest("sync pins the head when another fetch lands in the store", (t) => {
    t.up.write("plugin/README.md", "For others.\n");
    const older = t.up.commit("older");
    t.up.write("plugin/README.md", "For everyone.\n");
    const head = t.up.commit("head");
    sh(["git", "tag", "-a", "-m", "release", "v1"], { cwd: t.up.path });
    const bin = join(t.tmp, "bin/git");
    const raced = join(t.tmp, "raced");
    writeFileSync(bin, `#!/bin/sh
case " $* " in *" fetch "*) fetch=yes ;; esac
if [ "$fetch" = yes ] && [ ! -e '${raced}' ]; then
  : > '${raced}'
  '${Bun.which("git")}' "$@" || exit $?
  exec '${Bun.which("git")}' fetch --quiet --depth=1 '${t.up.path}' ${older}
fi
exec '${Bun.which("git")}' "$@"
`);
    chmodSync(bin, 0o755);
    t.pb(["sync"], { cwd: t.repo.path });
    expect(existsSync(raced)).toBe(true);
    expect(pinOf(t)).toBe(head);
    const store = join(t.tmp, "store/upstreams", readdirSync(join(t.tmp, "store/upstreams"))[0]!);
    expect(sh(["git", "for-each-ref", "refs/patchbook"], { cwd: store }).stdout).toBe("");
    expect(sh(["git", "for-each-ref", "refs/tags"], { cwd: store }).stdout).toBe("");
  });

  vendorTest("a failed fetch names the upstream and the ref it was asked for", (t) => {
    const err = t.pb(["sync", "plugin", "no-such-ref"], { cwd: t.repo.path, code: 1 }).stderr;
    expect(err).toContain(`git fetch ${JSON.stringify(t.up.path)} no-such-ref failed:`);
    expect(err).toContain("fatal:");
    expect(err).not.toContain("refs/patchbook");
  });

  vendorTest("store keeps pinned commits through gc", (t) => {
    t.up.write("plugin/README.md", "For everyone.\n");
    t.up.commit("readme");
    t.pb(["sync"], { cwd: t.repo.path });
    const store = join(t.tmp, "store/upstreams", readdirSync(join(t.tmp, "store/upstreams"))[0]!);
    sh(["git", "gc", "-q", "--prune=now"], { cwd: store });
    rmSync(t.up.path, { recursive: true });
    expect(words(t.pb(["upstream", "plugin"], { cwd: t.repo.path }).stdout)).toEqual(["README.md", "agents/helper.md", "skills/hello/SKILL.md"]);
    const diff = t.pb(["upstream", "plugin", "--diff"], { cwd: t.repo.path }).stdout;
    expect(diff).toContain("-For Cursor users.");
    expect(diff).toContain("+For everyone.");
  });

  vendorTest("store keeps a pin it held without a ref", (t) => {
    const store = join(t.tmp, "store/upstreams", readdirSync(join(t.tmp, "store/upstreams"))[0]!);
    for (const ref of sh(["git", "for-each-ref", "--format=%(refname)"], { cwd: store }).stdout.split("\n").filter(Boolean)) {
      sh(["git", "update-ref", "-d", ref], { cwd: store });
    }
    expect(words(t.pb(["upstream", "plugin"], { cwd: t.repo.path }).stdout)).toEqual(["README.md", "agents/helper.md", "skills/hello/SKILL.md"]);
    sh(["git", "gc", "-q", "--prune=now"], { cwd: store });
    rmSync(t.up.path, { recursive: true });
    expect(words(t.pb(["upstream", "plugin"], { cwd: t.repo.path }).stdout)).toEqual(["README.md", "agents/helper.md", "skills/hello/SKILL.md"]);
  });

  vendorTest("check keeps the pin it compares with and leaves the head it fetches to gc", (t) => {
    const store = storeOf(t);
    const pin = pinOf(t);
    dropRefs(store);
    t.up.write("plugin/README.md", "For everyone.\n");
    const head = t.up.commit("readme");
    t.pb(["check"], { cwd: t.repo.path, code: 10 });
    gc(store);
    expect(inStore(store, pin)).toBe(true);
    expect(inStore(store, head)).toBe(false);
    rmSync(t.up.path, { recursive: true });
    expect(words(t.pb(["upstream", "plugin"], { cwd: t.repo.path }).stdout)).toEqual(["README.md", "agents/helper.md", "skills/hello/SKILL.md"]);
  });

  vendorTest("check keeps the pin when the head moved but not the tree", (t) => {
    const store = storeOf(t);
    const pin = pinOf(t);
    dropRefs(store);
    t.up.write("other/ignored.md", "Still not followed.\n");
    t.up.commit("outside the path");
    t.pb(["check"], { cwd: t.repo.path });
    gc(store);
    expect(inStore(store, pin)).toBe(true);
  });

  vendorTest("check warns once when the pin ref cannot be written", (t) => {
    const store = storeOf(t);
    const pin = pinOf(t);
    dropRefs(store);
    mkdirSync(join(store, "refs/pins"), { recursive: true });
    writeFileSync(join(store, "refs/pins", `${pin}.lock`), "");
    t.up.write("plugin/README.md", "For everyone.\n");
    t.up.commit("readme");
    const out = t.pb(["check"], { cwd: t.repo.path, code: 10 });
    expect(out.stderr.split(`couldn't keep ${pin.slice(0, 7)}`).length - 1).toBe(1);
  });

  vendorTest("check keeps the pin when the head has not moved", (t) => {
    const store = storeOf(t);
    const pin = pinOf(t);
    dropRefs(store);
    t.pb(["check"], { cwd: t.repo.path });
    gc(store);
    expect(inStore(store, pin)).toBe(true);
    rmSync(t.up.path, { recursive: true });
    expect(words(t.pb(["upstream", "plugin"], { cwd: t.repo.path }).stdout)).toEqual(["README.md", "agents/helper.md", "skills/hello/SKILL.md"]);
  });

  vendorTest("check passes when the pin is gone from the store and from upstream", (t) => {
    const store = storeOf(t);
    const pin = pinOf(t);
    dropRefs(store);
    gc(store);
    expect(inStore(store, pin)).toBe(false);
    sh(["git", "commit", "-q", "--amend", "-m", "amended"], { cwd: t.up.path });
    sh(["git", "reflog", "expire", "--expire=now", "--all"], { cwd: t.up.path });
    sh(["git", "gc", "-q", "--prune=now"], { cwd: t.up.path });
    const out = JSON.parse(t.pb(["check"], { cwd: t.repo.path }).stdout);
    expect(out.moved).toBe(false);
    expect(out.upstreams.map((u: UpstreamCheck) => [u.name, u.moved])).toEqual([["plugin", false]]);
    expect(inStore(store, pin)).toBe(false);
  });

  vendorTest("sync keeps no ref for a commit whose vendored copy does not match", (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    t.repo.write(".gitignore", "*.log\n");
    extra.write("c.log", "hidden\n");
    const head = extra.commit("log");
    expect(t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 }).stderr).toContain("the vendored copy of extra hashes to");
    const stores = readdirSync(join(t.tmp, "store/upstreams")).map((d) => join(t.tmp, "store/upstreams", d));
    for (const store of stores) {
      expect(sh(["git", "rev-parse", "--verify", "--quiet", `refs/pins/${head}`], { cwd: store, check: false }).code).not.toBe(0);
    }
  });

  vendorTest("sync leaves a vendored upstream as it was when the ref cannot be written", (t) => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "one\ntwo\nthree\nfour\nfive\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    const change = join(t.repo.path, ".patchbook/changes/tweak");
    mkdirSync(change, { recursive: true });
    writeFileSync(join(change, "CHANGE.md"), "# tweak\n\nintent: Shout the first line.\n\nedits:\n- file extra/a.md\n");
    mkdirSync(join(change, "base/extra"), { recursive: true });
    mkdirSync(join(change, "ours/extra"), { recursive: true });
    writeFileSync(join(change, "base/extra/a.md.pb"), "one\ntwo\nthree\nfour\nfive\n");
    writeFileSync(join(change, "ours/extra/a.md.pb"), "ONE\ntwo\nthree\nfour\nfive\n");
    writeFileSync(join(t.repo.path, ".patchbook/series"), "tweak\n");
    t.pb(["build"], { cwd: t.repo.path });
    extra.write("a.md", "one\ntwo\nthree\nfour\nFIVE\n");
    extra.write("c.md", "c\n");
    const head = extra.commit("more");
    for (const d of readdirSync(join(t.tmp, "store/upstreams"))) {
      const pins = join(t.tmp, "store/upstreams", d, "refs/pins");
      mkdirSync(pins, { recursive: true });
      writeFileSync(join(pins, `${head}.lock`), "");
    }
    const before = [snapshot(join(t.repo.path, ".patchbook")), snapshot(join(t.repo.path, "vendor/extra"))];
    expect(t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 }).stderr).toContain(`refs/pins/${head}`);
    expect([snapshot(join(t.repo.path, ".patchbook")), snapshot(join(t.repo.path, "vendor/extra"))]).toEqual(before);
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.repo.path });
  });

  vendorTest("sync keeps a ref that was there when the vendored copy does not match", (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    t.repo.write(".gitignore", "*.log\n");
    extra.write("c.log", "hidden\n");
    const head = extra.commit("log");
    const store = readdirSync(join(t.tmp, "store/upstreams")).map((d) => join(t.tmp, "store/upstreams", d)).find((s) => !inStore(s, pinOf(t)))!;
    sh(["git", "fetch", "-q", "--depth=1", extra.path, head], { cwd: store });
    sh(["git", "update-ref", `refs/pins/${head}`, head], { cwd: store });
    t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(sh(["git", "rev-parse", "--verify", "--quiet", `refs/pins/${head}`], { cwd: store }).stdout.trim()).toBe(head);
  });

  for (const layout of ["folder", "vendored"]) {
    for (const before of [false, true]) {
      permissionTest(`sync keeps no new ref when it fails after the keep, in the ${layout} layout${before ? ", unless it was there" : ""}`, (t) => {
        const extra = new Repo(join(t.tmp, "extra"));
        extra.write("a.md", "one\ntwo\nthree\nfour\nfive\n");
        extra.commit("a");
        t.pb(["track", "extra", extra.path, ...(layout === "vendored" ? ["--vendor", "vendor/extra"] : [])], { cwd: t.repo.path });
        const change = join(t.repo.path, ".patchbook/changes/tweak");
        mkdirSync(change, { recursive: true });
        writeFileSync(join(change, "CHANGE.md"), "# tweak\n\nintent: Shout the first line.\n\nedits:\n- file extra/a.md\n");
        mkdirSync(join(change, "base/extra"), { recursive: true });
        mkdirSync(join(change, "ours/extra"), { recursive: true });
        writeFileSync(join(change, "base/extra/a.md.pb"), "one\ntwo\nthree\nfour\nfive\n");
        writeFileSync(join(change, "ours/extra/a.md.pb"), "ONE\ntwo\nthree\nfour\nfive\n");
        writeFileSync(join(t.repo.path, ".patchbook/series"), "tweak\n");
        extra.write("a.md", "one\ntwo\nthree\nfour\nFIVE\n");
        const head = extra.commit("more");
        const store = readdirSync(join(t.tmp, "store/upstreams")).map((d) => join(t.tmp, "store/upstreams", d)).find((s) => !inStore(s, pinOf(t)))!;
        const refOf = (): string => sh(["git", "rev-parse", "--verify", "--quiet", `refs/pins/${head}`], { cwd: store, check: false }).stdout.trim();
        if (before) {
          sh(["git", "fetch", "-q", "--depth=1", extra.path, head], { cwd: store });
          sh(["git", "update-ref", `refs/pins/${head}`, head], { cwd: store });
        }
        const lock = read(join(t.repo.path, ".patchbook/upstream.lock"));
        sh(["chmod", "-R", "a-w", join(change, "ours")], { cwd: t.repo.path });
        try {
          t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
        } finally {
          sh(["chmod", "-R", "u+w", join(change, "ours")], { cwd: t.repo.path });
        }
        expect(refOf()).toBe(before ? head : "");
        expect(read(join(t.repo.path, ".patchbook/upstream.lock"))).toBe(lock);
      }, VendorCase);
    }
  }

  const extraWithAChange = (t: VendorCase, vendored: boolean): Repo => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "one\ntwo\nthree\nfour\nfive\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, ...(vendored ? ["--vendor", "vendor/extra"] : [])], { cwd: t.repo.path });
    const change = join(t.repo.path, ".patchbook/changes/tweak");
    mkdirSync(change, { recursive: true });
    writeFileSync(join(change, "CHANGE.md"), "# tweak\n\nintent: Shout the first line.\n\nedits:\n- file extra/a.md\n");
    mkdirSync(join(change, "base/extra"), { recursive: true });
    mkdirSync(join(change, "ours/extra"), { recursive: true });
    writeFileSync(join(change, "base/extra/a.md.pb"), "one\ntwo\nthree\nfour\nfive\n");
    writeFileSync(join(change, "ours/extra/a.md.pb"), "ONE\ntwo\nthree\nfour\nfive\n");
    writeFileSync(join(t.repo.path, ".patchbook/series"), "tweak\n");
    t.pb(["build"], { cwd: t.repo.path });
    extra.write("a.md", "one\ntwo\nthree\nfour\nFIVE\n");
    return extra;
  };
  const killSync = (t: VendorCase, call: string, name = "extra"): void => {
    const bin = join(t.tmp, "crash");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase "$*" in *"${call}"*) kill -9 $PPID;; esac\nexec ${Bun.which("git")} "$@"\n`, { mode: 0o755 });
    const path = t.env["PATH"]!;
    t.env["PATH"] = `${bin}:${path}`;
    expect(t.pb(["sync", name], { cwd: t.repo.path, code: null }).code).not.toBe(0);
    t.env["PATH"] = path;
  };
  const pinRefs = (t: Case, commit: string): number => readdirSync(join(t.tmp, "store/upstreams"))
    .map((d) => join(t.tmp, "store/upstreams", d))
    .filter((s) => inStore(s, commit) && sh(["git", "rev-parse", "--verify", "--quiet", `refs/pins/${commit}`], { cwd: s, check: false }).code === 0)
    .length;

  vendorTest("a sync recovers a journal whose saved copies and old vendored copy hold symlinks", (t) => {
    const extra = extraWithAChange(t, true);
    const repo = t.repo.path;
    symlinkSync("a.md", join(extra.path, "ln"));
    extra.commit("ln");
    t.pb(["sync", "extra"], { cwd: repo });
    const [commit, tree] = read(join(repo, ".patchbook/upstream.lock")).match(/[0-9a-f]{40}/g)!;
    const saved = "changes/tweak/ours/extra";
    const journal = join(repo, ".patchbook/sync-extra");
    mkdirSync(join(journal, "before", saved), { recursive: true });
    writeFileSync(join(journal, "before", saved, "a.md.pb"), "SAVED\n");
    symlinkSync("a.md", join(journal, "before", saved, "ln.pb"));
    mkdirSync(join(journal, "old"));
    writeFileSync(join(journal, "old/a.md"), "one\ntwo\nthree\nfour\nFIVE\n");
    symlinkSync("a.md", join(journal, "old/ln"));
    writeFileSync(join(journal, "pin"), JSON.stringify({ from: `${commit} ${tree}`, to: "", rewrite: true, added: "", vendor: "vendor/extra", copy: true, made: "" }));
    t.pb(["sync", "extra"], { cwd: repo });
    expect(existsSync(journal)).toBe(false);
    expect(read(join(repo, ".patchbook", saved, "a.md.pb"))).toBe("SAVED\n");
    expect(readlinkSync(join(repo, ".patchbook", saved, "ln.pb"))).toBe("a.md");
    expect(readlinkSync(join(repo, "vendor/extra/ln"))).toBe("a.md");
  });

  const failedSyncs: [string, (t: VendorCase, extra: Repo) => void][] = [
    ["the repo's .gitignore hides an upstream file", (t, extra) => {
      t.repo.write(".gitignore", "*.log\n");
      extra.write("c.log", "hidden\n");
      extra.commit("v2");
    }],
    ["the upstream's own .gitignore hides one of its files", (_, extra) => {
      extra.write(".gitignore", "*.log\n");
      extra.write("x.log", "kept\n");
      sh(["git", "add", "-f", "x.log"], { cwd: extra.path });
      extra.commit("v2");
    }],
    ["a file name is too long to write", (_, extra) => {
      const blob = sh(["git", "hash-object", "-w", "a.md"], { cwd: extra.path }).stdout.trim();
      sh(["git", "add", "a.md"], { cwd: extra.path });
      sh(["git", "update-index", "--add", "--cacheinfo", `100644,${blob},z${"x".repeat(300)}`], { cwd: extra.path });
      sh(["git", "commit", "-qm", "v2"], { cwd: extra.path });
    }],
  ];
  for (const [why, move] of failedSyncs) {
    vendorTest(`a failed sync leaves the vendored copy and the changes as they were when ${why}`, (t) => {
      const extra = extraWithAChange(t, true);
      move(t, extra);
      const before = tree(t.repo.path);
      t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
      expect(tree(t.repo.path)).toEqual(before);
      expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
    });
  }

  vendorTest("a failed sync to a new upstream path at the same commit leaves the vendored copy as it was", (t) => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("x/a.md", "x\n");
    extra.write("y/a.md", "y\n");
    extra.write("y/c.log", "hidden\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--path", "x", "--vendor", "vendor/extra"], { cwd: t.repo.path });
    t.repo.write(".patchbook/config.toml", t.repo.read(".patchbook/config.toml").replace('path = "x"', 'path = "y"'));
    t.repo.write(".gitignore", "*.log\n");
    const before = tree(t.repo.path);
    t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(tree(t.repo.path)).toEqual(before);
  });

  describe("where chmod blocks writes, so not as root", () => {
    for (const [what, blocked] of [["a change file", ".patchbook/changes/tweak/base"], ["the lock", ".patchbook/upstream.lock"]] as const) {
      for (const layout of ["folder", "vendored"]) {
        permissionTest(`a failed sync leaves the changes as they were when ${what} cannot be written, in the ${layout} layout`, (t) => {
          const extra = extraWithAChange(t, layout === "vendored");
          extra.commit("v2");
          sh(["chmod", "-R", "a-w", blocked], { cwd: t.repo.path });
          const before = tree(t.repo.path);
          try {
            t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
          } finally {
            sh(["chmod", "-R", "u+w", blocked], { cwd: t.repo.path });
          }
          expect(tree(t.repo.path)).toEqual(before);
          expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
        }, VendorCase);
      }
    }

    permissionTest("a killed sync keeps its journal while a saved change file cannot be read", (t) => {
      const extra = extraWithAChange(t, true);
      extra.write("c.log", "hidden\n");
      extra.commit("v2");
      t.repo.commit("follow extra");
      const before = tree(t.repo.path);
      killSync(t, "write-tree --prefix=vendor/extra/");
      const ours = ".patchbook/changes/tweak/ours/extra/a.md.pb";
      const saved = ".patchbook/sync-extra/before/changes/tweak/ours";
      t.repo.write(`${saved}/extra/a.md.pb`, t.repo.read(ours));
      t.repo.write(ours, "ONE\ntwo\nthree\nfour\nFIVE\n");
      t.repo.write(".gitignore", "*.log\n");
      sh(["chmod", "000", saved], { cwd: t.repo.path });
      try {
        expect(t.pb(["sync", "extra"], { cwd: t.repo.path, code: null }).code).not.toBe(0);
      } finally {
        sh(["chmod", "755", saved], { cwd: t.repo.path });
      }
      t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
      expect(tree(t.repo.path)).toEqual({ ...before, ".gitignore": "*.log\n" });
    }, VendorCase);

    permissionTest("a failed sync of the fork's own upstream drops its ref though an upstream on that remote pins the commit", (t) => {
      t.pb(["track", "mirror", t.up.path], { cwd: t.fork.path });
      t.fork.commit("track mirror");
      t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
      const head = t.up.commit("v2");
      t.pb(["sync", "mirror"], { cwd: t.fork.path });
      const lock = join(t.fork.path, ".patchbook/upstream.lock");
      chmodSync(lock, 0o444);
      try {
        t.pb(["sync", "upstream"], { cwd: t.fork.path, code: 1 });
      } finally {
        chmodSync(lock, 0o644);
      }
      expect(pinRefs(t, head)).toBe(1);
      expect(sh(["git", "rev-parse", "--verify", "--quiet", `refs/pins/${head}`], { cwd: t.fork.path, check: false }).code).not.toBe(0);
    }, ForkCase);
  });

  for (const [when, call] of [["checks the new copy", "write-tree --prefix=vendor/extra/"], ["keeps the new commit", "update-ref refs/pins/"]] as const) {
    vendorTest(`a sync killed while it ${when} is put right by the next sync`, (t) => {
      const extra = extraWithAChange(t, true);
      extra.write("c.log", "hidden\n");
      const head = extra.commit("v2");
      t.repo.commit("follow extra");
      const before = tree(t.repo.path);
      killSync(t, call);
      expect(sh(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: t.repo.path }).stdout).not.toContain(".patchbook");

      t.repo.write(".gitignore", "*.log\n");
      t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
      expect(tree(t.repo.path)).toEqual({ ...before, ".gitignore": "*.log\n" });
      expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
      expect(pinRefs(t, head)).toBe(0);

      t.repo.rm(".gitignore");
      t.pb(["sync", "extra"], { cwd: t.repo.path });
      expect(t.repo.read("vendor/extra/c.log")).toBe("hidden\n");
      expect(t.repo.read(".patchbook/changes/tweak/ours/extra/a.md.pb")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
      const ignored = sh(["git", "status", "--porcelain", "--ignored", "--untracked-files=all"], { cwd: t.repo.path }).stdout;
      expect(ignored.split("\n").filter((line) => line.startsWith("!!"))).toEqual(["!! .patchbook/.gitignore", "!! .patchbook/last-sync.json"]);
      expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
    });
  }

  vendorTest("a rewrite killed while it checks the new copy is undone and done again by the next sync", (t) => {
    extraWithAChange(t, true);
    t.repo.commit("follow extra");
    const before = tree(t.repo.path);
    rmSync(join(t.repo.path, "vendor/extra"), { recursive: true });
    mkdirSync(join(t.repo.path, "vendor/extra"));
    killSync(t, "write-tree --prefix=vendor/extra/");
    expect(existsSync(join(t.repo.path, ".patchbook/sync-extra/pin"))).toBe(true);
    expect(sh(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: t.repo.path }).stdout).not.toContain(".patchbook");

    expect(t.pb(["sync", "extra"], { cwd: t.repo.path }).stdout).toContain("Rewrote the vendored copy, which did not.");
    expect(tree(t.repo.path)).toEqual(before);
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  vendorTest("a killed rewrite of a symlink at the vendor path that leads out of the repo is left for the user, and the folder it leads to is untouched", (t) => {
    extraWithAChange(t, true);
    t.repo.commit("follow extra");
    const outside = join(t.tmp, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "a.md"), "outside\n");
    const vendor = join(t.repo.path, "vendor/extra");
    rmSync(vendor, { recursive: true });
    symlinkSync(outside, vendor);
    killSync(t, "write-tree --prefix=vendor/extra/");
    const journal = join(t.repo.path, ".patchbook/sync-extra");
    expect(existsSync(join(journal, "pin"))).toBe(true);

    expect(t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 }).stderr).toContain("its old leads outside the repo");
    expect(existsSync(join(journal, "pin"))).toBe(true);
    expect(readdirSync(outside)).toEqual(["a.md"]);
    rmSync(journal, { recursive: true });
    expect(t.pb(["sync", "extra"], { cwd: t.repo.path }).stdout).toContain("matches the pin");
    expect(lstatSync(vendor).isDirectory()).toBe(true);
    expect(readdirSync(outside)).toEqual(["a.md"]);
    expect(readFileSync(join(outside, "a.md"), "utf8")).toBe("outside\n");
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  const killARewrite = (t: VendorCase): Record<string, string> => {
    const extra = extraWithAChange(t, true);
    extra.commit("v2");
    t.repo.commit("follow extra");
    t.pb(["sync", "extra"], { cwd: t.repo.path });
    t.repo.commit("sync extra");
    const synced = tree(t.repo.path);
    rmSync(join(t.repo.path, "vendor/extra"), { recursive: true });
    mkdirSync(join(t.repo.path, "vendor/extra"));
    killSync(t, "write-tree --prefix=vendor/extra/");
    return synced;
  };

  for (const [how, change] of [
    ["has changed since", (t: VendorCase) => sh(["git", "checkout", "HEAD~1", "--", ".patchbook/upstream.lock"], { cwd: t.repo.path })],
    ["no longer parses", (t: VendorCase) => t.repo.write(".patchbook/upstream.lock", "<<<<<<< HEAD\n")],
  ] as const) {
    vendorTest(`a killed rewrite is left for the user when the lock ${how}`, (t) => {
      const synced = killARewrite(t);
      change(t);
      t.repo.write("vendor/extra/mine.txt", "mine\n");
      const before = tree(t.repo.path);

      expect(t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 }).stderr).toContain(".patchbook/sync-extra holds a sync of extra");
      expect(tree(t.repo.path)).toEqual(before);

      rmSync(join(t.repo.path, ".patchbook/sync-extra"), { recursive: true });
      sh(["git", "checkout", "HEAD", "--", ".patchbook"], { cwd: t.repo.path });
      expect(t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 }).stderr).toContain("vendor/extra/mine.txt");
      rmSync(join(t.repo.path, "vendor/extra/mine.txt"));
      expect(t.pb(["sync", "extra"], { cwd: t.repo.path }).stdout).toContain("Nothing to do.");
      expect(tree(t.repo.path)).toEqual(synced);
    });
  }

  const changed = "upstream.lock has changed since";
  const unreadable = "its record can't be read";
  const lockChanges: [string, (t: VendorCase) => void, boolean, string][] = [
    ["the lock has changed since", (t) => sh(["git", "checkout", "HEAD~1", "--", ".patchbook/upstream.lock"], { cwd: t.repo.path }), false, changed],
    ["the lock has changed since the sync wrote it", (t) => {
      t.repo.write(".patchbook/sync-extra/lock", t.repo.read(".patchbook/upstream.lock"));
      sh(["git", "checkout", "HEAD~1", "--", ".patchbook/upstream.lock"], { cwd: t.repo.path });
    }, true, changed],
    ["the lock no longer parses", (t) => t.repo.write(".patchbook/upstream.lock", "<<<<<<< HEAD\n"), true, changed],
    ["its record cannot be read", (t) => t.repo.write(".patchbook/sync-extra/pin", ""), true, unreadable],
    ["its record has no to", (t) => t.repo.write(".patchbook/sync-extra/pin", '{"from": "x"}'), true, unreadable],
    ["its record has a copy that is not true or false", (t) => {
      t.repo.write(".patchbook/sync-extra/pin", '{"from": "x", "to": "y", "rewrite": false, "added": "", "vendor": "", "copy": "yes", "made": ""}');
    }, true, unreadable],
    ["its record is a list", (t) => t.repo.write(".patchbook/sync-extra/pin", "[]"), true, unreadable],
  ];
  for (const [how, change, refLeft, why] of lockChanges) {
    vendorTest(`a killed sync is left for the user when ${how}`, (t) => {
      const extra = extraWithAChange(t, true);
      extra.commit("v2");
      t.repo.commit("follow extra");
      t.pb(["sync", "extra"], { cwd: t.repo.path });
      t.repo.commit("sync extra");
      extra.write("b.md", "b\n");
      const head = extra.commit("v3");
      killSync(t, "write-tree --prefix=vendor/extra/");
      change(t);
      const before = tree(t.repo.path);
      const { stderr } = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
      expect(stderr).toContain(`.patchbook/sync-extra holds a sync of extra that stopped partway, but ${why}.`);
      expect(stderr).toContain("old/ holds the vendored copy as it was");
      expect(stderr).not.toContain("before/");
      expect(tree(t.repo.path)).toEqual(before);
      expect(pinRefs(t, head)).toBe(refLeft ? 1 : 0);
    });
  }

  vendorTest("a killed sync left for the user stops a sync or track of another upstream", (t) => {
    const extra = extraWithAChange(t, true);
    extra.commit("v2");
    t.repo.commit("follow extra");
    killSync(t, "write-tree --prefix=vendor/extra/");
    t.repo.write(".patchbook/sync-extra/pin", "");
    const more = new Repo(join(t.tmp, "more"));
    more.write("m.md", "m\n");
    more.commit("m");
    for (const args of [["sync", "plugin"], ["track", "more", more.path]]) {
      expect(t.pb(args, { cwd: t.repo.path, code: 1 }).stderr).toContain(".patchbook/sync-extra holds a sync of extra");
    }
  });

  for (const [by, args] of [["the next sync", ["sync", "extra"]], ["a plain sync that reaches another upstream first", ["sync"]]] as const) {
    vendorTest(`a lock torn by a killed sync is put back by ${by}`, (t) => {
      const extra = extraWithAChange(t, true);
      extra.write("c.log", "hidden\n");
      extra.commit("v2");
      const before = tree(t.repo.path);
      killSync(t, "write-tree --prefix=vendor/extra/");
      const lock = t.repo.read(".patchbook/upstream.lock");
      t.repo.write(".patchbook/sync-extra/lock", lock);
      t.repo.write(".patchbook/upstream.lock", lock.slice(0, lock.length / 2));
      t.repo.write(".gitignore", "*.log\n");
      t.pb([...args], { cwd: t.repo.path, code: 1 });
      expect(tree(t.repo.path)).toEqual({ ...before, ".gitignore": "*.log\n" });
      expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
    });
  }

  const killedThenChanged: [string, (t: VendorCase) => void][] = [
    ["its vendor folder's parent was removed", (t) => rmSync(join(t.repo.path, "vendor"), { recursive: true })],
    ["a change file was replaced by a link", (t) => {
      const ours = ".patchbook/changes/tweak/ours/extra/a.md.pb";
      t.repo.write(".patchbook/sync-extra/before/changes/tweak/ours/extra/a.md.pb", t.repo.read(ours));
      rmSync(join(t.repo.path, ours));
      symlinkSync(join(t.tmp, "victim.txt"), join(t.repo.path, ours));
    }],
  ];
  for (const [what, change] of killedThenChanged) {
    vendorTest(`a killed sync is put right by the next sync when ${what}`, (t) => {
      const extra = extraWithAChange(t, true);
      extra.write("c.log", "hidden\n");
      extra.commit("v2");
      t.repo.commit("follow extra");
      const before = tree(t.repo.path);
      writeFileSync(join(t.tmp, "victim.txt"), "not patchbook's\n");
      killSync(t, "write-tree --prefix=vendor/extra/");
      change(t);
      t.repo.write(".gitignore", "*.log\n");
      t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
      expect(readFileSync(join(t.tmp, "victim.txt"), "utf8")).toBe("not patchbook's\n");
      expect(tree(t.repo.path)).toEqual({ ...before, ".gitignore": "*.log\n" });
    });
  }

  vendorTest("track refuses a change folder that is a link before it puts back a killed sync", (t) => {
    const extra = extraWithAChange(t, true);
    extra.write("c.log", "hidden\n");
    extra.commit("v2");
    t.repo.commit("follow extra");
    killSync(t, "write-tree --prefix=vendor/extra/");
    t.repo.write(".patchbook/sync-extra/before/changes/tweak/ours/extra/a.md.pb", "PLANTED\n");
    const outside = join(t.tmp, "outside-tweak");
    renameSync(join(t.repo.path, ".patchbook/changes/tweak"), outside);
    symlinkSync(outside, join(t.repo.path, ".patchbook/changes/tweak"));
    const more = new Repo(join(t.tmp, "more"));
    more.write("b.md", "b\n");
    more.commit("b");
    const out = t.pb(["track", "more", more.path], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain(".patchbook/changes/tweak/ours/extra leads outside the repo");
    expect(read(join(outside, "ours/extra/a.md.pb"))).toBe("ONE\ntwo\nthree\nfour\nfive\n");
  });

  vendorTest("a failed sync leaves the vendored copy as it was when its folder name has a newline", (t) => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/plain"], { cwd: t.repo.path });
    t.repo.write(".patchbook/config.toml", t.repo.read(".patchbook/config.toml").replace('vendor = "vendor/plain"', 'vendor = "vendor/copy\\nother"'));
    renameSync(join(t.repo.path, "vendor/plain"), join(t.repo.path, "vendor/copy\nother"));
    t.repo.write("vendor/copy/unrelated.txt", "not upstream's\n");
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
    t.repo.write(".gitignore", "*.log\n");
    extra.write("c.log", "hidden\n");
    extra.commit("v2");
    const before = tree(t.repo.path);
    t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(tree(t.repo.path)).toEqual(before);
  });

  vendorTest("a killed sync keeps the ref of a commit another upstream on that remote has pinned since", (t) => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("x/a.md", "x\n");
    extra.write("y/a.md", "y\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--path", "x"], { cwd: t.repo.path });
    t.pb(["track", "other", extra.path, "--path", "y"], { cwd: t.repo.path });
    t.repo.commit("follow extra and other");
    extra.write("x/a.md", "x2\n");
    extra.write("y/a.md", "y2\n");
    const head = extra.commit("v2");
    killSync(t, "update-ref refs/pins/");
    sh(["git", "clone", "-q", t.repo.path, "mate"], { cwd: t.tmp });
    const mate = new Repo(join(t.tmp, "mate"));
    t.pb(["sync", "other"], { cwd: mate.path });
    mate.commit("sync other");
    sh(["git", "pull", "-q", "--ff-only", mate.path, "main"], { cwd: t.repo.path });
    t.pb(["sync", "extra", "refs/heads/nope"], { cwd: t.repo.path, code: 1 });
    expect(pinRefs(t, head)).toBe(1);
  });

  vendorTest("a killed sync drops its ref when only an upstream on another remote has pinned that commit", (t) => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("x/a.md", "x\n");
    extra.write("y/a.md", "y\n");
    extra.commit("a");
    sh(["git", "clone", "-q", extra.path, "mirror"], { cwd: t.tmp });
    const mirror = join(t.tmp, "mirror");
    t.pb(["track", "extra", extra.path, "--path", "x"], { cwd: t.repo.path });
    t.pb(["track", "other", mirror, "--path", "y"], { cwd: t.repo.path });
    extra.write("x/a.md", "x2\n");
    extra.write("y/a.md", "y2\n");
    const head = extra.commit("v2");
    sh(["git", "pull", "-q", "--ff-only"], { cwd: mirror });
    t.pb(["sync", "other"], { cwd: t.repo.path });
    killSync(t, "update-ref refs/pins/");
    t.pb(["sync", "extra", "refs/heads/nope"], { cwd: t.repo.path, code: 1 });
    expect(pinRefs(t, head)).toBe(1);
  });

  forkTest("a failed sync drops its ref though the fork's own upstream on that remote pins the commit", (t) => {
    t.pb(["track", "mirror", t.up.path, "--vendor", "vendor/mirror"], { cwd: t.fork.path });
    t.fork.commit("track mirror");
    t.up.write("c.log", "hidden\n");
    const head = t.up.commit("v2");
    t.pb(["sync", "upstream"], { cwd: t.fork.path });
    t.fork.commit("sync");
    t.fork.write(".gitignore", "*.log\n");
    expect(t.pb(["sync", "mirror"], { cwd: t.fork.path, code: 1 }).stderr).toContain("the vendored copy of mirror hashes to");
    expect(pinRefs(t, head)).toBe(0);
  });

  describe("killed by crash injection", () => {
    for (const file of ["pin", "lock"]) {
      vendorTest(`a sync killed before it deletes its journal ${file} keeps its ref once an older commit is checked out`, (t) => {
        const extra = extraWithAChange(t, true);
        extra.commit("v2");
        t.repo.commit("follow extra");
        t.pb(["sync", "extra"], { cwd: t.repo.path });
        t.repo.commit("sync extra");
        extra.write("b.md", "b\n");
        const head = extra.commit("v3");
        const env = { ...t.env, CRASH_BEFORE_RM: `/.patchbook/sync-extra/${file}` };
        sh([...crashCmd(), "sync", "extra"], { cwd: t.repo.path, env, check: false });
        expect(t.repo.read(".patchbook/upstream.lock")).toContain(head);
        expect(existsSync(join(t.repo.path, ".patchbook/sync-extra", file))).toBe(true);
        t.repo.commit("sync extra to v3");
        sh(["git", "checkout", "-q", "HEAD~2"], { cwd: t.repo.path });
        t.pb(["sync", "extra"], { cwd: t.repo.path, code: null });
        expect(pinRefs(t, head)).toBe(1);
      });
    }
  });

  vendorTest("a plain sync puts back a torn lock before it recovers an earlier upstream", (t) => {
    const extra = extraWithAChange(t, true);
    extra.write("c.log", "hidden\n");
    extra.commit("v2");
    const more = new Repo(join(t.tmp, "more"));
    more.write("m.md", "m\n");
    more.commit("m");
    t.pb(["track", "more", more.path], { cwd: t.repo.path });
    more.write("m.md", "m2\n");
    more.commit("v2");
    t.repo.commit("follow extra and more");
    const before = tree(t.repo.path);
    killSync(t, "write-tree --prefix=vendor/extra/");
    killSync(t, "update-ref refs/pins/", "more");
    const lock = t.repo.read(".patchbook/upstream.lock");
    t.repo.write(".patchbook/sync-more/lock", lock);
    t.repo.write(".patchbook/upstream.lock", lock.slice(0, lock.length / 2));
    t.repo.write(".gitignore", "*.log\n");
    t.pb(["sync"], { cwd: t.repo.path, code: 1 });
    expect(tree(t.repo.path)).toEqual({ ...before, ".gitignore": "*.log\n" });
  });

  vendorTest("a killed sync puts back a deleted change file with its mode", (t) => {
    const extra = extraWithAChange(t, true);
    extra.write("c.log", "hidden\n");
    extra.commit("v2");
    const ours = ".patchbook/changes/tweak/ours/extra/a.md.pb";
    chmodSync(join(t.repo.path, ours), 0o755);
    t.repo.commit("follow extra");
    const before = tree(t.repo.path);
    killSync(t, "write-tree --prefix=vendor/extra/");
    t.repo.write(".patchbook/sync-extra/before/changes/tweak/ours/extra/a.md.pb", t.repo.read(ours), 0o755);
    rmSync(join(t.repo.path, ours));
    t.repo.write(".gitignore", "*.log\n");
    t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(tree(t.repo.path)).toEqual({ ...before, ".gitignore": "*.log\n" });
    expect(statSync(join(t.repo.path, ours)).mode & 0o777).toBe(0o755);
  });

  for (const command of ["status", "build"]) {
    vendorTest(`${command} keeps a pin it held without a ref`, (t) => {
      const store = storeOf(t);
      const pin = pinOf(t);
      dropRefs(store);
      t.pb([command], { cwd: t.repo.path, code: null });
      gc(store);
      expect(inStore(store, pin)).toBe(true);
    });

    vendorTest(`${command} keeps the pin of a vendored upstream held without a ref`, (t) => {
      t.missingScaffoldPatchBuild();
      const extra = new Repo(join(t.tmp, "extra"));
      extra.write("a.md", "a\n");
      const pin = extra.commit("a");
      t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
      const store = readdirSync(join(t.tmp, "store/upstreams")).map((d) => join(t.tmp, "store/upstreams", d)).find((s) => inStore(s, pin))!;
      dropRefs(store);
      t.pb([command], { cwd: t.repo.path });
      gc(store);
      expect(inStore(store, pin)).toBe(true);
    });
  }

  vendorTest("sync keeps the pin it moves from", (t) => {
    const store = storeOf(t);
    const pin = pinOf(t);
    dropRefs(store);
    t.up.write("plugin/README.md", "For everyone.\n");
    t.up.commit("readme");
    t.pb(["sync"], { cwd: t.repo.path });
    gc(store);
    expect(inStore(store, pin)).toBe(true);
  });

  vendorTest("upstream diff keeps the previous pin", (t) => {
    const store = storeOf(t);
    t.up.write("plugin/README.md", "For everyone.\n");
    t.up.commit("readme");
    t.pb(["sync"], { cwd: t.repo.path });
    dropRefs(store);
    t.pb(["upstream", "plugin", "--diff"], { cwd: t.repo.path });
    gc(store);
    rmSync(t.up.path, { recursive: true });
    expect(t.pb(["upstream", "plugin", "--diff"], { cwd: t.repo.path }).stdout).toContain("-For Cursor users.");
  });

  vendorTest("upstream since does not keep the commit it is given", (t) => {
    const store = storeOf(t);
    const first = pinOf(t);
    t.up.write("plugin/README.md", "For everyone.\n");
    t.up.commit("readme");
    t.pb(["sync"], { cwd: t.repo.path });
    dropRefs(store);
    gc(store);
    expect(inStore(store, first)).toBe(false);
    t.pb(["upstream", "plugin", "--since", first], { cwd: t.repo.path });
    gc(store);
    expect(inStore(store, first)).toBe(false);
  });

  vendorTest("reads need no write to the pin ref", (t) => {
    t.missingScaffoldPatchBuild();
    const store = storeOf(t);
    writeFileSync(join(store, "refs/pins", `${pinOf(t)}.lock`), "");
    const files = t.pb(["upstream", "plugin"], { cwd: t.repo.path });
    expect(words(files.stdout)).toEqual(["README.md", "agents/helper.md", "skills/hello/SKILL.md"]);
    expect(files.stderr).toBe("");
    expect(t.pb(["status"], { cwd: t.repo.path }).stderr).toBe("");
  });

  vendorTest("reads go on when the pin ref cannot be written", (t) => {
    const store = storeOf(t);
    const pin = pinOf(t);
    dropRefs(store);
    mkdirSync(join(store, "refs/pins"), { recursive: true });
    writeFileSync(join(store, "refs/pins", `${pin}.lock`), "");
    const files = t.pb(["upstream", "plugin"], { cwd: t.repo.path });
    expect(words(files.stdout)).toEqual(["README.md", "agents/helper.md", "skills/hello/SKILL.md"]);
    expect(files.stderr).toContain(`couldn't keep ${pin.slice(0, 7)} in the store`);
  });

  vendorTest("status warns against editing a vendored copy", (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    t.repo.write("vendor/extra/a.md", "edited\n");
    expect(t.pb(["status"], { cwd: t.repo.path, code: 1 }).stderr).toContain("Never edit the vendored copy");
  });

  vendorTest("other upstream paths do not move the pin", (t) => {
    t.up.write("other/ignored.md", "changed\n");
    t.up.commit("elsewhere");
    const out = JSON.parse(t.pb(["check"], { cwd: t.repo.path }).stdout);
    expect(out.moved).toBeFalsy();
  });

  vendorTest("a patchbook folder in upstream still moves the pin in the folder layout", (t) => {
    t.up.write("plugin/.patchbook/notes.md", "notes\n");
    t.up.commit("a folder named .patchbook");
    const out = t.pb(["check"], { cwd: t.repo.path, code: 10 }).stdout;
    expect(checkedUpstream(out, "plugin").moved).toBe(true);
    expect(checkedUpstream(out, "plugin").files).toEqual(["added .patchbook/notes.md"]);
  });

  vendorTest("two upstreams build together", (t) => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("skills/tool/SKILL.md", "---\nname: tool\n---\n\nUse the tool.\n");
    extra.write("skills/unwanted/SKILL.md", "---\nname: unwanted\n---\n");
    extra.commit("extra");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    expect(existsSync(join(t.repo.path, "vendor/extra/skills/tool/SKILL.md"))).toBe(true);
    const change = join(t.repo.path, ".patchbook/changes/ship-tool");
    mkdirSync(change, { recursive: true });
    writeFileSync(join(change, "CHANGE.md"), "# ship-tool\n\nintent: Ship extra's tool skill.\n\nedits:\n- move extra/skills/tool -> skills/tool\n");
    writeFileSync(join(t.repo.path, ".patchbook/series"), "ship-tool\n");
    t.pb(["build"], { cwd: t.repo.path });
    expect(t.repo.read("skills/tool/SKILL.md")).toContain("Use the tool.");
    expect(existsSync(join(t.repo.path, "skills/unwanted"))).toBe(false);
    expect(lockNames(read(join(t.repo.path, ".patchbook/upstream.lock")))).toEqual(["extra", "plugin"]);
    extra.write("skills/tool/SKILL.md", "---\nname: tool\n---\n\nUse the new tool.\n");
    extra.commit("v2");
    const check = t.pb(["check"], { cwd: t.repo.path, code: 10 }).stdout;
    expect(checkedUpstream(check, "extra").files).toEqual(["changed extra/skills/tool/SKILL.md"]);
    t.pb(["sync"], { cwd: t.repo.path });
    t.pb(["build"], { cwd: t.repo.path });
    expect(t.repo.read("skills/tool/SKILL.md")).toContain("Use the new tool.");
  });

  vendorTest("a blockTerms hook that returns an array of terms makes status ask for an entry", (t) => {
    writeFileSync(join(t.repo.path, ".patchbook/hooks.ts"), dedent(`
      export function blockTerms(path: string, block: string) {
        return block.includes("wave") ? ["ba"] : [];
      }
    `));
    expect(t.pb(["status"], { cwd: t.repo.path, code: 1 }).stdout).toContain("needs an entry (ba)");
  });

  vendorTest("a blockTerms hook that returns a string is refused, not read as its characters", (t) => {
    const hooks = join(t.repo.path, ".patchbook/hooks.ts");
    writeFileSync(hooks, dedent(`
      export function blockTerms(path: string, block: string) {
        return block.includes("wave") ? "ba" : [];
      }
    `));
    const status = t.pb(["status"], { cwd: t.repo.path, code: 1 });
    expect(status.stderr).toContain(`${hooks}: blockTerms must return an array or iterable of strings, not a string`);
    expect(status.stdout).not.toContain("needs an entry");
  });

  vendorTest("a check hook that returns a string is refused as not a list of problems", (t) => {
    writeFileSync(join(t.repo.path, ".patchbook/hooks.ts"), 'export function check() {\n  return "problem";\n}\n');
    expect(t.pb(["status"], { cwd: t.repo.path, code: 1 }).stderr).toContain("check must return a list of problems");
  });

  vendorTest("a mistyped hook gets did you mean from a similarity of 0.6, and the list of hooks below it", (t) => {
    const hooks = join(t.repo.path, ".patchbook/hooks.ts");
    writeFileSync(hooks, "export function chexy() {}\n");
    expect(t.pb(["status"], { cwd: t.repo.path, code: 1 }).stderr).toContain("\"chexy\" isn't a hook; did you mean `check`?\n");
    writeFileSync(hooks, "export function cqhqeqcqkqqq() {}\n");
    expect(t.pb(["status"], { cwd: t.repo.path, code: 1 }).stderr).toContain("\"cqhqeqcqkqqq\" isn't a hook. The hooks are placeholder, blockTerms, finish, check.\n");
  });

  vendorTest("a check hook may return any kind of problem", (t) => {
    writeFileSync(join(t.repo.path, ".patchbook/hooks.ts"), dedent(`
      export function check() {
        return [
          { detail: "out of order", file: "skills/hello/SKILL.md", problem: "check" },
          { problem: "leak", file: "skills/hello/SKILL.md", line: 3, terms: ["from-hook"] },
        ];
      }
    `));
    const problems: Record<string, unknown>[] = JSON.parse(t.pb(["status", "--json"], { cwd: t.repo.path, code: 1 }).stdout).problems;
    const keys = (problem: string) => Object.keys(problems.find((p) => p["problem"] === problem && p["file"] === "skills/hello/SKILL.md" && p["hash"] === undefined)!);
    expect(keys("check")).toEqual(["detail", "file", "problem"]);
    expect(keys("leak")).toEqual(["problem", "file", "line", "terms"]);
  });

  vendorTest("absolute output folder is used as given", (t) => {
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replaceAll('to = "skills"', `to = "${join(t.repo.path, "skills")}"`));
    t.missingScaffoldPatchBuild();
    expect(existsSync(join(t.repo.path, t.repo.path))).toBe(false);
  });

  vendorTest("absolute output folder reached through a link above the repo is used as given", (t) => {
    symlinkSync(t.tmp, join(t.tmp, "via"));
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replaceAll('to = "skills"', `to = "${join(t.tmp, "via/adapted/skills")}"`));
    t.missingScaffoldPatchBuild();
    expect(t.repo.read("skills/hello/SKILL.md")).toContain("Hello");
  });

  const setOutputFolder = (t: VendorCase, to: string): void => {
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replace(/^to = .*$/m, () => `to = ${JSON.stringify(to)}`));
  };

  vendorTest("output folder cannot be the repo root", (t) => {
    t.missingScaffoldPatchBuild();
    for (const to of [".", "", "./", "skills/.."]) {
      setOutputFolder(t, to);
      const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain("is the repo root");
      expect(out.stderr).not.toContain("ENOENT");
      expect(existsSync(join(t.repo.path, ".patchbook/config.toml"))).toBe(true);
      expect(existsSync(join(t.repo.path, ".patchbook/series"))).toBe(true);
      expect(t.repo.read("README.md")).toBe("mine\n");
      expect(existsSync(join(t.repo.path, "skills/hello/SKILL.md"))).toBe(true);
    }
  });

  vendorTest("output folder cannot be inside the patchbook", (t) => {
    t.missingScaffoldPatchBuild();
    for (const to of [".patchbook", ".patchbook/out", join(t.repo.path, ".patchbook/changes")]) {
      setOutputFolder(t, to);
      const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain("is inside .patchbook");
      expect(existsSync(join(t.repo.path, ".patchbook/config.toml"))).toBe(true);
    }
  });

  vendorTest("output folder must be inside the repo", (t) => {
    t.missingScaffoldPatchBuild();
    for (const to of ["..", "../elsewhere", join(t.tmp, "elsewhere")]) {
      setOutputFolder(t, to);
      const out = t.pb(["build"], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain("is outside the repo");
      expect(existsSync(join(t.tmp, "elsewhere"))).toBe(false);
    }
  });

  vendorTest("output folder cannot overlap a vendored copy", (t) => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    for (const to of ["vendor/extra", "vendor/extra/skills"]) {
      setOutputFolder(t, to);
      const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain("overlaps the vendored copy vendor/extra");
      expect(t.repo.read("vendor/extra/a.md")).toBe("a\n");
    }
    setOutputFolder(t, "vendor");
    t.pb(["build", "--force"], { cwd: t.repo.path });
    expect(t.repo.read("vendor/extra/a.md")).toBe("a\n");
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  test("init rejects an empty output folder", () => {
    const t = new VendorCase();
    try {
      const repo = new Repo(join(t.tmp, "fresh"));
      repo.write("README.md", "mine\n");
      repo.commit("start");
      const out = t.pb(["init", "--upstream", t.up.path, "--output-to", ""], { cwd: repo.path, code: 1 });
      expect(out.stderr).toContain("is the repo root");
      expect(sh(["git", "remote"], { cwd: repo.path }).stdout).not.toContain("upstream");
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  vendorTest("output folder cannot be a file", (t) => {
    t.missingScaffoldPatchBuild();
    setOutputFolder(t, "README.md");
    const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("is not a folder");
    expect(t.repo.read("README.md")).toBe("mine\n");
  });

  vendorTest("a copy into a git name in the output folder is invalid", (t) => {
    const change = join(t.repo.path, ".patchbook/changes/into-git");
    mkdirSync(change, { recursive: true });
    writeFileSync(join(change, "CHANGE.md"), "# into-git\n\nintent: Write into a git name.\n\nedits:\n- copy skills/hello/SKILL.md -> skills/agents/.git/x\n");
    writeFileSync(join(t.repo.path, ".patchbook/series"), "into-git\n");
    const detail = "skills/agents/.git/x would be written into .git";
    expect(t.pb(["status"], { cwd: t.repo.path, code: 1 }).stdout).toContain(detail);
    const before = tree(t.repo.path);
    expect(t.pb(["build"], { cwd: t.repo.path, code: 1 }).stderr).toContain(detail);
    expect(tree(t.repo.path)).toEqual(before);
    expect(existsSync(join(t.repo.path, "skills/agents/.git"))).toBe(false);
  });

  function writeChange(t: VendorCase, name: string, edits: string[]): void {
    const change = join(t.repo.path, ".patchbook/changes", name);
    mkdirSync(change, { recursive: true });
    writeFileSync(join(change, "CHANGE.md"), `# ${name}\n\nintent: Write somewhere new.\n\nedits:\n${edits.map((e) => `- ${e}\n`).join("")}`);
    writeFileSync(join(t.repo.path, ".patchbook/series"), `${name}\n`);
  }

  vendorTest("a copy into a git name under the from folder is invalid when to differs", (t) => {
    t.missingScaffoldPatchBuild();
    setOutputFolder(t, "out");
    t.pb(["build", "--force"], { cwd: t.repo.path });
    writeChange(t, "into-git", ["copy skills/hello/SKILL.md -> skills/.git/x"]);
    const detail = "skills/.git/x would be written into .git";
    const status = t.pb(["status"], { cwd: t.repo.path, code: 1 });
    expect(status.stdout).toContain("changes/into-git copy skills/hello/SKILL.md -> skills/.git/x");
    expect(status.stdout).toContain(detail);
    const before = tree(t.repo.path);
    expect(t.pb(["build"], { cwd: t.repo.path, code: 1 }).stderr).toContain(detail);
    expect(tree(t.repo.path)).toEqual(before);
    expect(existsSync(join(t.repo.path, "out/.git"))).toBe(false);
  });

  vendorTest("a copy into a patchbook name under the from folder builds into the output folder", (t) => {
    t.missingScaffoldPatchBuild();
    setOutputFolder(t, "out");
    writeChange(t, "into-dot-patchbook", ["copy skills/hello/SKILL.md -> skills/.patchbook/x.md"]);
    t.pb(["build", "--force"], { cwd: t.repo.path });
    expect(t.repo.read("out/.patchbook/x.md")).toContain("Say hello in T3.");
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  vendorTest("destinations that only look like kept names build", (t) => {
    t.missingScaffoldPatchBuild();
    const dests = [".patchbookx/a", "docs/.patchbook-notes", ".github/x", ".gitignore"];
    writeChange(t, "look-alikes", dests.map((d) => `copy skills/hello/SKILL.md -> skills/${d}`));
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.repo.path });
    for (const d of dests) expect(t.repo.read(`skills/${d}`)).toContain("Say hello in T3.");
  });

  vendorTest("a copy into a vendored copy names the copy", (t) => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    setOutputFolder(t, "vendor");
    writeChange(t, "into-vendor", ["copy skills/hello/SKILL.md -> skills/extra/x.md"]);
    const status = t.pb(["status"], { cwd: t.repo.path, code: 1 });
    expect(status.stdout).toContain("skills/extra/x.md would be written into the vendored copy vendor/extra");
    expect(existsSync(join(t.repo.path, "vendor/extra/x.md"))).toBe(false);
  });

  vendorTest("hook still warns and commits for a copy into a vendored copy", (t) => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    setOutputFolder(t, "vendor");
    t.pb(["build", "--force"], { cwd: t.repo.path });
    t.repo.commit("built");
    writeChange(t, "into-vendor", ["copy skills/hello/SKILL.md -> skills/extra/x.md"]);
    const problems = JSON.parse(t.pb(["status", "--json"], { cwd: t.repo.path, code: 1 }).stdout).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).not.toHaveProperty("refuse");
    sh(["git", "add", "-A"], { cwd: t.repo.path });
    const before = sh(["git", "rev-parse", "HEAD"], { cwd: t.repo.path }).stdout;
    const committed = sh(["git", "commit", "-qm", "into vendor"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1" }, check: false });
    expect(committed.code).toBe(0);
    expect(committed.stderr).toContain("1 problems, so the output wasn't rebuilt.");
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.repo.path }).stdout).not.toBe(before);
    expect(existsSync(join(t.repo.path, "vendor/extra/x.md"))).toBe(false);
  });

  vendorTest("output folder cannot be inside the git dir", (t) => {
    t.missingScaffoldPatchBuild();
    const gitConfig = t.repo.read(".git/config");
    for (const to of [".git", ".git/hooks"]) {
      setOutputFolder(t, to);
      const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain("inside .git");
      expect(existsSync(join(t.repo.path, ".git/hello"))).toBe(false);
      expect(existsSync(join(t.repo.path, ".git/hooks/hello"))).toBe(false);
    }
    expect(t.repo.read(".git/config")).toBe(gitConfig);
  });

  vendorTest("output folder cannot be a dangling link", (t) => {
    t.missingScaffoldPatchBuild();
    symlinkSync(".patchbook/nope", join(t.repo.path, "dangle"));
    setOutputFolder(t, "dangle");
    const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("is a link to nothing");
    expect(existsSync(join(t.repo.path, ".patchbook/nope"))).toBe(false);
  });

  vendorTest("output folder overlaps a vendored copy at the repo root", (t) => {
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replaceAll('name = "plugin"\n', 'name = "plugin"\nvendor = "."\n'));
    const out = t.pb(["status"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("overlaps the vendored copy, which is the repo root");
  });

  vendorTest("a vendored copy inside another upstream's output folder builds and checks clean", (t) => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("b.md", "b\n");
    extra.commit("b");
    t.pb(["track", "other", extra.path, "--mount", "skills/other", "--vendor", "skills/vendored-other"], { cwd: t.repo.path });
    const built = t.pb(["build"], { cwd: t.repo.path });
    expect(built.stdout).toContain("built");
    expect(t.repo.read("skills/other/b.md")).toBe("b\n");
    expect(t.repo.read("skills/vendored-other/b.md")).toBe("b\n");
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  vendorTest("a vendored copy inside another upstream's output folder survives a build and a hook commit", (t) => {
    t.missingScaffoldPatchBuild();
    t.up.write("plugin/skills/vendored-other/clash.md", "plugin's own file at a path the copy holds\n");
    t.up.commit("plugin ships a file where the copy will sit");
    t.pb(["sync"], { cwd: t.repo.path });
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("b.md", "b\n");
    extra.write("deep/n.txt", "n\n");
    extra.commit("b");
    t.pb(["track", "other", extra.path, "--mount", "other", "--vendor", "skills/vendored-other"], { cwd: t.repo.path });
    const copy = join(t.repo.path, "skills/vendored-other");
    const pinned = { "b.md": "b\n", [join("deep", "n.txt")]: "n\n" };
    expect(tree(copy)).toEqual(pinned);

    const built = t.pb(["build"], { cwd: t.repo.path });
    expect(built.stderr).toContain("left 1 upstream files out of the build because they would land in a vendored copy: skills/vendored-other (1).");
    expect(tree(copy)).toEqual(pinned);
    t.pb(["scaffold"], { cwd: t.repo.path });
    sh(["git", "add", "-A"], { cwd: t.repo.path });
    sh(["git", "commit", "-qm", "built"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } });

    t.repo.write("skills/hello/SKILL.md", `${t.repo.read("skills/hello/SKILL.md")}\nExtra.\n`);
    sh(["git", "add", "-A"], { cwd: t.repo.path });
    const committed = sh(["git", "commit", "-qm", "edit hello"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Add a line." } });
    expect(committed.stderr).toContain("left 1 upstream files out of the build because they would land in a vendored copy: skills/vendored-other (1).");
    expect(tree(copy)).toEqual(pinned);
    const committedCopy = sh(["git", "ls-tree", "-r", "--name-only", "HEAD", "skills/vendored-other"], { cwd: t.repo.path }).stdout.trim().split("\n");
    expect(committedCopy).toEqual(["skills/vendored-other/b.md", "skills/vendored-other/deep/n.txt"]);
    expect(sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout).toBe("");
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  vendorTest("a vendored copy inside its own upstream's output folder is refused everywhere", (t) => {
    const config = join(t.repo.path, ".patchbook/config.toml");
    const before = read(config);
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("b.md", "b\n");
    extra.commit("b");

    const tracked = t.pb(["track", "other", extra.path, "--mount", "skills/other", "--vendor", "skills/other/copy"], { cwd: t.repo.path, code: 1 });
    expect(tracked.stderr).toContain("the vendored copy of other (skills/other/copy) overlaps the folder other builds into (skills/other). A build writes there, but a vendored copy must match upstream exactly.");
    expect(tracked.stderr).toContain("Change vendor for other or [output] to.");
    expect(read(config)).toBe(before);
    expect(existsSync(join(t.repo.path, "skills/other"))).toBe(false);

    writeFileSync(config, before.replaceAll('name = "plugin"\n', 'name = "plugin"\nvendor = "skills/vendored"\n'));
    const status = t.pb(["status"], { cwd: t.repo.path, code: 1 });
    expect(status.stderr).toContain("the vendored copy of plugin (skills/vendored) overlaps the folder plugin builds into (skills). A build writes there, but a vendored copy must match upstream exactly.");
    expect(status.stderr).toContain("Change vendor for plugin or [output] to.");
  });

  for (const [where, to, link] of [["itself", "out", "out"], ["an ancestor", "lnk/out", "lnk"]] as const) {
    vendorTest(`output folder cannot be ${where === "itself" ? "a link" : "under a link"}`, (t) => {
      t.missingScaffoldPatchBuild();
      t.repo.write("real/keep.md", "keep\n");
      symlinkSync("real", join(t.repo.path, link));
      setOutputFolder(t, to);
      t.repo.commit("a link to a folder in the repo");
      const before = tree(t.repo.path);
      for (const args of [["build", "--force"], ["build"], ["status"]]) {
        const out = t.pb(args, { cwd: t.repo.path, code: 1 });
        expect(out.stderr).toContain("is a link");
        expect(out.stderr).not.toContain("outside the output folder");
        expect(tree(t.repo.path)).toEqual(before);
      }
      expect(isSymlink(join(t.repo.path, link))).toBe(true);
    });
  }

  const linkBecomesFolder = (t: VendorCase): void => {
    t.missingScaffoldPatchBuild();
    symlinkSync("../real", join(t.up.path, "plugin/skills/d"));
    t.up.commit("d is a link");
    t.pb(["sync"], { cwd: t.repo.path });
    t.pb(["build"], { cwd: t.repo.path });
    expect(isSymlink(join(t.repo.path, "skills/d"))).toBe(true);
    t.repo.commit("built with the link");
    t.up.rm("plugin/skills/d");
    t.up.write("plugin/skills/d/f.md", "in a folder\n");
    t.up.commit("d is a folder");
    t.pb(["sync"], { cwd: t.repo.path });
    t.pb(["build", "--force"], { cwd: t.repo.path });
    expect(lstatSync(join(t.repo.path, "skills/d")).isDirectory()).toBe(true);
    expect(sh(["git", "ls-files", "-s", "skills/d"], { cwd: t.repo.path }).stdout).toContain("120000");
  };

  vendorTest("build after a link in the output became a folder", (t) => {
    linkBecomesFolder(t);
    const out = t.pb(["build"], { cwd: t.repo.path });
    expect(out.stdout).toContain("built");
    expect(out.stderr).not.toContain("EISDIR");
    expect(t.repo.read("skills/d/f.md")).toBe("in a folder\n");
  });

  vendorTest("commit after a link in the output became a folder", (t) => {
    linkBecomesFolder(t);
    t.repo.write("NOTES.md", "notes\n");
    sh(["git", "add", "NOTES.md", ".patchbook"], { cwd: t.repo.path });
    const commit = sh(["git", "commit", "-qm", "notes"], { cwd: t.repo.path, check: false, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(commit.stderr).not.toContain("EISDIR");
    expect(commit.code).toBe(0);
    expect(sh(["git", "show", "--stat", "--format=%s", "HEAD"], { cwd: t.repo.path }).stdout).toContain("NOTES.md");
    expect(t.repo.read("skills/d/f.md")).toBe("in a folder\n");
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  const builtThenReplaced = (t: VendorCase, kind: "link" | "file", fill: (folder: string) => void): string => {
    t.missingScaffoldPatchBuild();
    t.repo.write(".gitignore", ".DS_Store\n");
    if (kind === "link") symlinkSync("../real", join(t.up.path, "plugin/skills/x"));
    else t.up.write("plugin/skills/x", "from upstream\n");
    t.up.commit("x");
    t.pb(["sync"], { cwd: t.repo.path });
    t.pb(["build"], { cwd: t.repo.path });
    t.repo.commit("built with x");
    const at = join(t.repo.path, "skills/x");
    unlinkSync(at);
    mkdirSync(at);
    fill(at);
    return at;
  };

  const restored = (t: VendorCase, kind: "link" | "file", at: string): void => {
    const out = t.pb(["build", "--force"], { cwd: t.repo.path });
    expect(out.stdout).toContain("built");
    expect(out.stderr).not.toContain("EISDIR");
    if (kind === "link") expect(readlinkSync(at)).toBe("../real");
    else expect(t.repo.read("skills/x")).toBe("from upstream\n");
  };

  for (const kind of ["link", "file"] as const) {
    vendorTest(`build --force over an empty folder that replaced a ${kind}`, (t) => {
      const at = builtThenReplaced(t, kind, () => {});
      expect(t.pb(["build"], { cwd: t.repo.path, code: 1 }).stderr).toContain("  x\n");
      restored(t, kind, at);
    });

    vendorTest(`build --force over a folder of empty folders that replaced a ${kind}`, (t) => {
      const at = builtThenReplaced(t, kind, (folder) => mkdirSync(join(folder, "y/z"), { recursive: true }));
      restored(t, kind, at);
    });
  }

  for (const kind of ["link"] as const) {
    vendorTest(`build --force refuses a folder of ignored files that replaced a ${kind}`, (t) => {
      const at = builtThenReplaced(t, kind, (folder) => writeFileSync(join(folder, ".DS_Store"), "kept\n"));
      const edited = "hand edit\n";
      t.repo.write("skills/hello/SKILL.md", edited);
      const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain("x is a folder");
      expect(out.stderr).toContain("Nothing was changed");
      expect(out.stderr).not.toContain("EISDIR");
      expect(read(join(at, ".DS_Store"))).toBe("kept\n");
      expect(t.repo.read("skills/hello/SKILL.md")).toBe(edited);
    });
  }

  for (const [what, below, named] of [["a subfolder", "locked", "x/locked"], ["a folder", "", "x"]] as const) {
    permissionTest(`build --force refuses a folder with ${what} it cannot read`, () => {
      const t = new VendorCase();
      let locked = "";
      try {
        const at = builtThenReplaced(t, "link", (folder) => {
          locked = join(folder, below);
          mkdirSync(locked, { recursive: true });
          writeFileSync(join(locked, "x"), "kept\n");
          chmodSync(locked, 0o000);
        });
        const edited = "hand edit\n";
        t.repo.write("skills/hello/SKILL.md", edited);
        const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
        expect(out.stderr).toContain(`${named} is a folder that can't be read, so a build won't replace x.`);
        expect(out.stderr).toContain("Nothing was changed");
        expect(out.stderr).not.toContain("ENOTEMPTY");
        expect(lstatSync(at).isDirectory()).toBe(true);
        expect(t.repo.read("skills/hello/SKILL.md")).toBe(edited);
      } finally {
        if (locked) chmodSync(locked, 0o755);
        t.cleanup();
      }
    });
  }

  test("track rejects a mount that puts the output under a git folder in the folder layout", () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("a.md", "a\n");
      up.commit("start");
      const more = new Repo(join(t.tmp, "more"));
      more.write("d/m.md", "m\n");
      more.commit("start");
      const repo = new Repo(join(t.tmp, "adapted"));
      repo.write("README.md", "mine\n");
      repo.commit("start");
      const bare = t.pb(["init", "--upstream", up.path, "--output-to", "out/.git/x"], { cwd: repo.path, code: 1 });
      expect(bare.stderr).toContain("inside .git");
      expect(existsSync(join(repo.path, ".patchbook"))).toBe(false);
      t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: repo.path });
      const config = join(repo.path, ".patchbook/config.toml");
      const before = { config: read(config), tree: tree(repo.path) };
      for (const mount of [".git/x", "a/.git", "./.git/x", "x/../.git/y"]) {
        const tracked = t.pb(["track", "m", more.path, "--mount", mount], { cwd: repo.path, code: 1 });
        expect(tracked.stderr).toContain("inside .git");
        expect(read(config)).toBe(before.config);
        expect(tree(repo.path)).toEqual(before.tree);
      }
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  const spellings: [string, (t: VendorCase, to: string) => string][] = [
    ["", (_, to) => to],
    [" spelled from the physical repo path", (t, to) => join(realpathSync(t.repo.path), to)],
    [" spelled through a link above the repo", (t, to) => join(t.tmp, "via/adapted", to)],
    [" spelled through a link to the repo", (t, to) => join(t.tmp, "alias", to)],
  ];

  for (const [spelled, spell] of spellings) {
    vendorTest(`output folder cannot be under a link to the repo root${spelled}`, (t) => {
      t.missingScaffoldPatchBuild();
      symlinkSync(t.tmp, join(t.tmp, "via"));
      symlinkSync(t.repo.path, join(t.tmp, "alias"));
      symlinkSync(".", join(t.repo.path, "lnkroot"));
      setOutputFolder(t, spell(t, "lnkroot/out"));
      t.repo.commit("a link to the repo root");
      const before = tree(t.repo.path);
      for (const args of [["build", "--force"], ["build"], ["status"]]) {
        const out = t.pb(args, { cwd: t.repo.path, code: 1 });
        expect(out.stderr).toContain("is under lnkroot, which is a link");
        expect(tree(t.repo.path)).toEqual(before);
      }
    });
  }

  test("init rejects an output folder under a link to the repo root spelled through a link above the repo", () => {
    const t = new VendorCase();
    try {
      symlinkSync(t.tmp, join(t.tmp, "via"));
      const repo = new Repo(join(t.tmp, "fresh"));
      repo.write("README.md", "mine\n");
      symlinkSync(".", join(repo.path, "lnkroot"));
      repo.commit("a link to the repo root");
      const out = t.pb(["init", "--upstream", t.up.path, "--output-to", join(t.tmp, "via/fresh/lnkroot/out")], { cwd: repo.path, code: 1 });
      expect(out.stderr).toContain("is under lnkroot, which is a link");
      expect(existsSync(join(repo.path, ".patchbook"))).toBe(false);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  vendorTest("output folder under a link spelled through a link above the repo names the link in the repo", (t) => {
    t.missingScaffoldPatchBuild();
    symlinkSync(t.tmp, join(t.tmp, "via"));
    t.repo.write("real/keep.md", "keep\n");
    symlinkSync("real", join(t.repo.path, "lnk"));
    setOutputFolder(t, join(t.tmp, "via/adapted/lnk/out"));
    t.repo.commit("a link to a folder in the repo");
    const before = tree(t.repo.path);
    const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("is under lnk, which is a link");
    expect(tree(t.repo.path)).toEqual(before);
  });

  vendorTest("output folder cannot be under a link that leaves the repo and comes back to its root", (t) => {
    t.missingScaffoldPatchBuild();
    mkdirSync(join(t.tmp, "elsewhere"));
    symlinkSync(t.repo.path, join(t.tmp, "elsewhere/back"));
    symlinkSync(join(t.tmp, "elsewhere"), join(t.repo.path, "ext"));
    setOutputFolder(t, "ext/back/out");
    t.repo.commit("a link out of the repo");
    const before = tree(t.repo.path);
    const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("is under ext/back, which is a link");
    expect(tree(t.repo.path)).toEqual(before);
  });

  vendorTest("output folder cannot be under a link to the repo root reached through a link into the repo", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.write("real/keep.md", "keep\n");
    symlinkSync("..", join(t.repo.path, "real/lnkroot"));
    symlinkSync(join(t.repo.path, "real"), join(t.tmp, "side"));
    setOutputFolder(t, join(t.tmp, "side/lnkroot/out"));
    t.repo.commit("a link to the repo root in a folder");
    const before = tree(t.repo.path);
    const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain(`is under ${join(t.tmp, "side/lnkroot")}, which is a link`);
    expect(tree(t.repo.path)).toEqual(before);
  });

  const readsAsDotPatchbook = [
    [".PATCHBOOK", ".PATCHBOOK"],
    [".Patchbook/x", ".Patchbook/x"],
    [".patchbook.", ".patchbook."],
    [".patchbook and a space", ".patchbook /x"],
    [".PATCHBOOK with dots and spaces", "./.PATCHBOOK. . /y"],
    [".patchbook and a backslash", ".patchbook\\x"],
    [".patchbook:x", ".patchbook:x"],
  ] as const;

  for (const [what, to] of readsAsDotPatchbook) {
    vendorTest(`output folder ${what} is a name Windows or a Mac reads as .patchbook and is rejected`, (t) => {
      t.missingScaffoldPatchBuild();
      setOutputFolder(t, to);
      const before = tree(t.repo.path);
      for (const args of [["build", "--force"], ["status"]]) {
        const out = t.pb(args, { cwd: t.repo.path, code: 1 });
        expect(out.stderr).toContain(`[output] to ${JSON.stringify(to)} is inside .patchbook`);
        expect(tree(t.repo.path)).toEqual(before);
      }
    });
  }

  vendorTest("output folder named like .patchbook but not read as it builds and stages", (t) => {
    t.missingScaffoldPatchBuild();
    for (const to of [".patchbookx", "x.patchbook", ".patchbook.x", "out/.PATCHBOOK", "out/.patchbook."]) {
      setOutputFolder(t, to);
      t.pb(["build", "--force"], { cwd: t.repo.path });
      expect(t.repo.read(`${to}/hello/SKILL.md`)).toContain("Say hello in T3.");
    }
    sh(["git", "add", "-A"], { cwd: t.repo.path });
  });

  const gitReadsAsDotGit = [
    [".git as a folder", "skills/.git"],
    [".git.", ".git."],
  ] as const;

  for (const [what, to] of gitReadsAsDotGit) {
    vendorTest(`output folder ${what} is a name git reads as .git and is rejected`, (t) => {
      t.missingScaffoldPatchBuild();
      setOutputFolder(t, to);
      const before = tree(t.repo.path);
      for (const args of [["build", "--force"], ["status"]]) {
        const out = t.pb(args, { cwd: t.repo.path, code: 1 });
        expect(out.stderr).toContain("inside .git");
        expect(tree(t.repo.path)).toEqual(before);
      }
    });
  }

  vendorTest("an output folder named like .git but not read as it builds and stages", (t) => {
    t.missingScaffoldPatchBuild();
    for (const to of [".gitx", "git~2", ".git.x", "a.git", ".git\u200c.", ".git\ufffd"]) {
      setOutputFolder(t, to);
      t.pb(["build", "--force"], { cwd: t.repo.path });
      expect(t.repo.read(`${to}/hello/SKILL.md`)).toContain("Say hello in T3.");
    }
    sh(["git", "-c", "core.protectHFS=true", "add", "-A"], { cwd: t.repo.path });
  });

  test("init and track reject names git reads as .git in both layouts", () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("a.md", "a\n");
      up.commit("start");
      const more = new Repo(join(t.tmp, "more"));
      more.write("d/m.md", "m\n");
      more.commit("start");
      const folder = new Repo(join(t.tmp, "adapted"));
      folder.write("README.md", "mine\n");
      folder.commit("start");
      for (const to of [".git."]) {
        const out = t.pb(["init", "--upstream", up.path, "--output-to", to], { cwd: folder.path, code: 1 });
        expect(out.stderr).toContain("inside .git");
        expect(existsSync(join(folder.path, ".patchbook"))).toBe(false);
      }
      t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: folder.path });
      t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
      for (const cwd of [folder.path, join(t.tmp, "fork")]) {
        const config = join(cwd, ".patchbook/config.toml");
        const before = { config: read(config), tree: tree(cwd) };
        for (const mount of [".git.", ".GIT/x"]) {
          const tracked = t.pb(["track", "m", more.path, "--mount", mount], { cwd, code: 1 });
          expect(tracked.stderr).toContain("inside .git");
          expect(read(config)).toBe(before.config);
          expect(tree(cwd)).toEqual(before.tree);
        }
      }
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  test("init and track reject names Windows or a Mac reads as .patchbook", () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("a.md", "a\n");
      up.commit("start");
      const more = new Repo(join(t.tmp, "more"));
      more.write("d/m.md", "m\n");
      more.commit("start");
      const folder = new Repo(join(t.tmp, "adapted"));
      folder.write("README.md", "mine\n");
      folder.commit("start");
      for (const to of [".PATCHBOOK", ".patchbook.", ".patchbook /x", "./.Patchbook. /y"]) {
        const out = t.pb(["init", "--upstream", up.path, "--output-to", to], { cwd: folder.path, code: 1 });
        expect(out.stderr).toContain("inside .patchbook");
        expect(existsSync(join(folder.path, ".patchbook"))).toBe(false);
      }
      t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
      const fork = join(t.tmp, "fork");
      const config = join(fork, ".patchbook/config.toml");
      const before = { config: read(config), tree: tree(fork) };
      for (const mount of [".PATCHBOOK", ".patchbook.", ".patchbook /x", "./.Patchbook. /y"]) {
        const tracked = t.pb(["track", "m", more.path, "--mount", mount], { cwd: fork, code: 1 });
        expect(tracked.stderr).toContain("inside .patchbook");
        expect(read(config)).toBe(before.config);
        expect(tree(fork)).toEqual(before.tree);
      }
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  vendorTest("an absolute output folder reached through a link above the repo builds twice", (t) => {
    symlinkSync(t.tmp, join(t.tmp, "via"));
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replaceAll('to = "skills"', `to = "${join(t.tmp, "via/adapted/skills")}"`));
    t.missingScaffoldPatchBuild();
    t.pb(["build"], { cwd: t.repo.path });
    t.pb(["build", "--force"], { cwd: t.repo.path });
    expect(t.repo.read("skills/hello/SKILL.md")).toContain("Hello");
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  vendorTest("an absolute output folder reached through a link to the repo itself builds twice", (t) => {
    symlinkSync(t.repo.path, join(t.tmp, "alias"));
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replaceAll('to = "skills"', `to = "${join(t.tmp, "alias/skills")}"`));
    t.missingScaffoldPatchBuild();
    t.pb(["build"], { cwd: t.repo.path });
    t.pb(["build", "--force"], { cwd: t.repo.path });
    expect(t.repo.read("skills/hello/SKILL.md")).toContain("Hello");
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  vendorTest("an absolute output folder reached through a link above the repo but outside it is rejected", (t) => {
    symlinkSync(t.tmp, join(t.tmp, "via"));
    t.missingScaffoldPatchBuild();
    setOutputFolder(t, join(t.tmp, "via/elsewhere"));
    const before = tree(t.repo.path);
    const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("is outside the repo");
    expect(tree(t.repo.path)).toEqual(before);
  });

  vendorTest("build never deletes through a link into the patchbook", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.write("skills/d/retired.md", "hand\n");
    t.repo.commit("a file under skills/d");
    rmSync(join(t.repo.path, "skills/d"), { recursive: true });
    symlinkSync("../.patchbook", join(t.repo.path, "skills/d"));
    t.repo.write(".gitignore", "/skills/d\n");
    const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
    expect(existsSync(join(t.repo.path, ".patchbook/retired.md"))).toBe(true);
    expect(out.stderr).toContain("is really inside .patchbook");
  });

  vendorTest("build never deletes a patchbook that links into the output", (t) => {
    t.missingScaffoldPatchBuild();
    renameSync(join(t.repo.path, ".patchbook"), join(t.repo.path, "skills/.pb"));
    symlinkSync("skills/.pb", join(t.repo.path, ".patchbook"));
    const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
    for (const f of ["config.toml", "series", "retired.md"]) {
      expect(existsSync(join(t.repo.path, "skills/.pb", f))).toBe(true);
    }
    expect(out.stderr).toContain(".patchbook is a link");
  });

  test("a rejected init can be retried", () => {
    const t = new VendorCase();
    try {
      const repo = new Repo(join(t.tmp, "fresh"));
      repo.write("README.md", "mine\n");
      repo.commit("start");
      t.pb(["init", "--upstream", t.up.path, "--output-to", ""], { cwd: repo.path, code: 1 });
      expect(existsSync(join(repo.path, ".patchbook"))).toBe(false);
      t.pb(["init", "--upstream", t.up.path, "--output-to", "out"], { cwd: repo.path });
      expect(existsSync(join(repo.path, ".patchbook/config.toml"))).toBe(true);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  test("init rejects a vendored copy at the repo root", () => {
    const t = new VendorCase();
    try {
      const repo = new Repo(join(t.tmp, "fresh"));
      repo.write("README.md", "mine\n");
      repo.commit("start");
      const out = t.pb(["init", "--upstream", t.up.path, "--output-to", "out", "--vendor", "."], { cwd: repo.path, code: 1 });
      expect(out.stderr).toContain("overlaps the vendored copy, which is the repo root");
      expect(repo.read("README.md")).toBe("mine\n");
      expect(existsSync(join(repo.path, ".git"))).toBe(true);
      expect(existsSync(join(repo.path, ".patchbook"))).toBe(false);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  vendorTest("a rejected track leaves the config alone", (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    const config = join(t.repo.path, ".patchbook/config.toml");
    const before = read(config);
    const out = t.pb(["track", "extra", extra.path, "--vendor", "skills"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("overlaps the vendored copy skills");
    expect(read(config)).toBe(before);
    t.pb(["track", "extra", extra.path], { cwd: t.repo.path });
  });

  vendorTest("a remote helper in a cloned config is refused for a store upstream", (t) => {
    const helperRan = markerScript(t, "git-remote-pbtest");
    setRemote(join(t.repo.path, ".patchbook/config.toml"), "pbtest::x");
    t.repo.commit("follow a remote helper");
    sh(["git", "clone", "-q", t.repo.path, "fresh"], { cwd: t.tmp });
    for (const command of ["check", "status"]) {
      expect(t.pb([command], { cwd: join(t.tmp, "fresh"), code: 1 }).stderr).toContain("transport 'pbtest' not allowed");
    }
    expect(existsSync(helperRan)).toBe(false);
  });

  for (const name of ["file", "ssh", "git"]) {
    vendorTest(`a cloned config naming the ${name} helper runs no git remote ${name} for a store upstream`, (t) => {
      const helperRan = markerScript(t, `git-remote-${name}`);
      setRemote(join(t.repo.path, ".patchbook/config.toml"), `${name}::x`);
      t.repo.commit("follow a remote helper");
      sh(["git", "clone", "-q", t.repo.path, "fresh"], { cwd: t.tmp });
      for (const command of ["check", "status"]) t.pb([command], { cwd: join(t.tmp, "fresh"), code: 1 });
      expect(existsSync(helperRan)).toBe(false);
    });
  }

  const sentinelOf = (t: Case): string => join(t.tmp, "sibling", "keep.txt");
  const plantSentinel = (t: Case): void => {
    mkdirSync(join(t.tmp, "sibling"));
    writeFileSync(sentinelOf(t), "precious\n");
  };
  const unsafeVendors: [string, string, string][] = [
    ["the repo root", ".", "the repo root"],
    ["a sibling of the repo", "../sibling", "is outside the repo"],
    ["the git dir", ".git", "is inside .git"],
  ];

  for (const [what, vendor, why] of unsafeVendors) {
    if (what !== "the repo root") test(`init refuses a vendored copy at ${what} and writes nothing`, () => {
      const t = new VendorCase();
      try {
        plantSentinel(t);
        const repo = new Repo(join(t.tmp, "fresh"));
        repo.write("README.md", "mine\n");
        repo.commit("start");
        const before = tree(repo.path);
        const out = t.pb(["init", "--upstream", t.up.path, "--output-to", "out", "--vendor", vendor], { cwd: repo.path, code: 1 });
        expect(out.stderr).toContain(why);
        expect(out.stderr).not.toContain("EINVAL");
        expect(existsSync(join(repo.path, ".git"))).toBe(true);
        expect(repo.read("README.md")).toBe("mine\n");
        expect(existsSync(join(repo.path, ".patchbook"))).toBe(false);
        expect(tree(repo.path)).toEqual(before);
        expect(read(sentinelOf(t))).toBe("precious\n");
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);

    if (what !== "the repo root") vendorTest(`track refuses a vendored copy at ${what} and writes nothing`, (t) => {
      plantSentinel(t);
      const extra = new Repo(join(t.tmp, "extra"));
      extra.write("a.md", "a\n");
      extra.commit("a");
      const config = join(t.repo.path, ".patchbook/config.toml");
      const configBefore = read(config);
      const before = tree(t.repo.path);
      const out = t.pb(["track", "extra", extra.path, "--vendor", vendor], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain(why);
      expect(out.stderr).not.toContain("EINVAL");
      expect(existsSync(join(t.repo.path, ".git"))).toBe(true);
      expect(t.repo.read("README.md")).toBe("mine\n");
      expect(read(config)).toBe(configBefore);
      expect(tree(t.repo.path)).toEqual(before);
      expect(read(sentinelOf(t))).toBe("precious\n");
    });

    if (what !== "the repo root") vendorTest(`a config that vendors at ${what} is refused before sync touches anything`, (t) => {
      plantSentinel(t);
      const extra = new Repo(join(t.tmp, "extra"));
      extra.write("a.md", "a\n");
      extra.commit("a");
      t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
      const config = join(t.repo.path, ".patchbook/config.toml");
      writeFileSync(config, read(config).replaceAll('vendor = "vendor/extra"', `vendor = ${JSON.stringify(vendor)}`));
      const before = tree(t.repo.path);
      const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain(why);
      expect(out.stderr).not.toContain("EINVAL");
      expect(existsSync(join(t.repo.path, ".git"))).toBe(true);
      expect(tree(t.repo.path)).toEqual(before);
      expect(read(sentinelOf(t))).toBe("precious\n");
    });

    vendorTest(`a sync journal that names ${what} is left for the user and nothing is deleted`, (t) => {
      plantSentinel(t);
      const extra = new Repo(join(t.tmp, "extra"));
      extra.write("a.md", "a\n");
      extra.commit("a");
      t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
      const pin = lockPin(t.repo.read(".patchbook/upstream.lock"), "extra");
      const journal = join(t.repo.path, ".patchbook/sync-extra");
      mkdirSync(join(journal, "old"), { recursive: true });
      writeFileSync(join(journal, "old/planted.txt"), "from the journal\n");
      const record = { from: `${pin.commit} ${pin.tree}`, to: "", rewrite: true, added: "", vendor, copy: false, made: "" };
      writeFileSync(join(journal, "pin"), JSON.stringify(record));
      const before = tree(t.repo.path);
      const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain(".patchbook/sync-extra holds a sync of extra");
      expect(out.stderr).toContain(why);
      expect(existsSync(join(t.repo.path, ".git"))).toBe(true);
      expect(tree(t.repo.path)).toEqual(before);
      expect(read(sentinelOf(t))).toBe("precious\n");
      expect(read(join(journal, "old/planted.txt"))).toBe("from the journal\n");
    });
  }

  vendorTest("a sync journal that names a folder the config does not vendor is left for the user and nothing is deleted", (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    const pin = lockPin(t.repo.read(".patchbook/upstream.lock"), "extra");
    t.repo.write("docs/a.md", "mine\n");
    t.repo.commit("my own notes");
    t.repo.write("docs/a.md", "edited since the commit\n");
    const journal = join(t.repo.path, ".patchbook/sync-extra");
    mkdirSync(join(journal, "old"), { recursive: true });
    writeFileSync(join(journal, "old/planted.txt"), "from the journal\n");
    const record = { from: `${pin.commit} ${pin.tree}`, to: "", rewrite: true, added: "", vendor: "docs", copy: false, made: "" };
    writeFileSync(join(journal, "pin"), JSON.stringify(record));
    const before = tree(t.repo.path);
    const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain(".patchbook/sync-extra holds a sync of extra");
    expect(out.stderr).toContain(JSON.stringify("docs"));
    expect(out.stderr).toContain("vendor/extra");
    expect(tree(t.repo.path)).toEqual(before);
    expect(t.repo.read("docs/a.md")).toBe("edited since the commit\n");
    expect(read(join(journal, "old/planted.txt"))).toBe("from the journal\n");
  });

  const plantJournal = (t: VendorCase, vendor: string, copy: boolean): string => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, ...(vendor ? ["--vendor", vendor] : [])], { cwd: t.repo.path });
    const pin = lockPin(t.repo.read(".patchbook/upstream.lock"), "extra");
    const journal = join(t.repo.path, ".patchbook/sync-extra");
    mkdirSync(journal, { recursive: true });
    const record = { from: `${pin.commit} ${pin.tree}`, to: "", rewrite: true, added: "", vendor, copy, made: "" };
    writeFileSync(join(journal, "pin"), JSON.stringify(record));
    return journal;
  };

  vendorTest("a sync journal that puts back upstream.lock as a link out of the repo is left for the user and nothing is written through it", (t) => {
    const journal = plantJournal(t, "", false);
    const outside = join(t.tmp, "outside.txt");
    writeFileSync(outside, "not patchbook's\n");
    mkdirSync(join(journal, "before"));
    symlinkSync(outside, join(journal, "before/upstream.lock"));
    writeFileSync(join(journal, "lock"), "from the journal\n");
    t.repo.write(".patchbook/upstream.lock", "");
    const before = tree(t.repo.path);
    const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(read(outside)).toBe("not patchbook's\n");
    expect(tree(t.repo.path)).toEqual(before);
    expect(out.stderr).toContain(".patchbook/sync-extra holds a sync of extra");
    expect(out.stderr).toContain("before/upstream.lock");
  });

  vendorTest("a sync journal whose lock is a link out of the repo is left for the user and its target is not read", (t) => {
    const journal = plantJournal(t, "", false);
    const outside = join(t.tmp, "outside.txt");
    writeFileSync(outside, "a secret outside the repo\n");
    symlinkSync(outside, join(journal, "lock"));
    t.repo.write(".patchbook/upstream.lock", "");
    const before = tree(t.repo.path);
    const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(t.repo.read(".patchbook/upstream.lock")).not.toContain("a secret");
    expect(tree(t.repo.path)).toEqual(before);
    expect(out.stderr).toContain(".patchbook/sync-extra holds a sync of extra");
    expect(out.stderr).toContain("its lock ");
  });

  vendorTest("a sync journal that puts a change file back under a link out of the repo is left for the user", (t) => {
    const journal = plantJournal(t, "", false);
    const outside = join(t.tmp, "outside");
    mkdirSync(outside);
    rmSync(join(t.repo.path, ".patchbook/changes"), { recursive: true, force: true });
    symlinkSync(outside, join(t.repo.path, ".patchbook/changes"));
    mkdirSync(join(journal, "before/changes/tweak/ours"), { recursive: true });
    writeFileSync(join(journal, "before/changes/tweak/ours/a.md.pb"), "from the journal\n");
    const before = tree(t.repo.path);
    const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(readdirSync(outside)).toEqual([]);
    expect(tree(t.repo.path)).toEqual(before);
    expect(out.stderr).toContain(".patchbook/changes is a link");
  });

  vendorTest("a sync journal that puts last-sync.json back through a link out of the repo is left for the user", (t) => {
    const journal = plantJournal(t, "", false);
    const outside = join(t.tmp, "outside.txt");
    writeFileSync(outside, "not patchbook's\n");
    symlinkSync(outside, join(t.repo.path, ".patchbook/last-sync.json"));
    mkdirSync(join(journal, "before"));
    writeFileSync(join(journal, "before/last-sync.json"), "from the journal\n");
    const before = tree(t.repo.path);
    const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(read(outside)).toBe("not patchbook's\n");
    expect(tree(t.repo.path)).toEqual(before);
    expect(out.stderr).toContain(".patchbook/last-sync.json is a link");
  });

  vendorTest("a sync journal whose before links to a folder out of the repo is left for the user and no link is put back", (t) => {
    const journal = plantJournal(t, "", false);
    const outside = join(t.tmp, "outside");
    mkdirSync(join(outside, "ours"), { recursive: true });
    writeFileSync(join(outside, "ours/secret.pb"), "a secret outside the repo\n");
    mkdirSync(join(journal, "before/changes"), { recursive: true });
    symlinkSync(outside, join(journal, "before/changes/tweak"));
    const before = tree(t.repo.path);
    const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(existsSync(join(t.repo.path, ".patchbook/changes/tweak"))).toBe(false);
    expect(tree(t.repo.path)).toEqual(before);
    expect(out.stderr).toContain("before/changes/tweak");
  });

  vendorTest("a sync journal that is a link to a folder out of the repo is left for the user and nothing in it is moved", (t) => {
    const journal = plantJournal(t, "vendor/extra", true);
    const outside = join(t.tmp, "outside");
    renameSync(journal, outside);
    mkdirSync(join(outside, "old"));
    writeFileSync(join(outside, "old/a.md"), "not patchbook's\n");
    symlinkSync(outside, journal);
    const before = tree(t.repo.path);
    const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(read(join(outside, "old/a.md"))).toBe("not patchbook's\n");
    expect(tree(t.repo.path)).toEqual(before);
    expect(out.stderr).toContain(".patchbook/sync-extra is a link");
  });

  vendorTest("a sync journal whose pin is a link out of the repo is left for the user and its target is not read", (t) => {
    const journal = plantJournal(t, "vendor/extra", true);
    const outside = join(t.tmp, "outside.txt");
    renameSync(join(journal, "pin"), outside);
    writeFileSync(outside, read(outside).replace('"vendor/extra"', '"vendor/a-secret"'));
    symlinkSync(outside, join(journal, "pin"));
    const before = tree(t.repo.path);
    const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).not.toContain("a-secret");
    expect(tree(t.repo.path)).toEqual(before);
    expect(out.stderr).toContain("its pin ");
  });

  vendorTest("a sync journal whose old/ is a link out of the repo is left for the user and the vendored copy does not become a link", (t) => {
    const journal = plantJournal(t, "vendor/extra", true);
    const outside = join(t.tmp, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "a.md"), "not patchbook's\n");
    symlinkSync(outside, join(journal, "old"));
    const before = tree(t.repo.path);
    const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(lstatSync(join(t.repo.path, "vendor/extra")).isDirectory()).toBe(true);
    expect(readdirSync(outside)).toEqual(["a.md"]);
    expect(read(join(outside, "a.md"))).toBe("not patchbook's\n");
    expect(tree(t.repo.path)).toEqual(before);
    expect(out.stderr).toContain(".patchbook/sync-extra holds a sync of extra");
    expect(out.stderr).toContain("its old ");
  });

  vendorTest("track refuses a vendor folder that holds a git repo and leaves the pin it found as it was", (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    const config = join(t.repo.path, ".patchbook/config.toml");
    const unfollowed = read(config);
    t.pb(["track", "extra", extra.path], { cwd: t.repo.path });
    writeFileSync(config, unfollowed);
    const lock = join(t.repo.path, ".patchbook/upstream.lock");
    const pins = read(lock);
    expect(lockNames(pins)).toContain("extra");
    mkdirSync(join(t.repo.path, "lib"));
    sh(["git", "init", "-q", "-b", "main", join(t.repo.path, "lib")], { cwd: t.repo.path });
    const out = t.pb(["track", "extra", extra.path, "--vendor", "lib"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("holds lib/.git");
    expect(read(lock)).toBe(pins);
  });

  const gitFile = "gitdir: ../elsewhere\n";
  const nestedGits: [string, string, string, (repo: { path: string }) => void][] = [
    ["a repo of its own", "lib", "lib/.git", (repo) => {
      mkdirSync(join(repo.path, "lib"));
      sh(["git", "init", "-q", "-b", "main", join(repo.path, "lib")], { cwd: repo.path });
      writeFileSync(join(repo.path, "lib/wip.txt"), "uncommitted\n");
    }],
    ["a linked worktree", "wt", "wt/.git", (repo) => {
      sh(["git", "worktree", "add", "-q", "--detach", join(repo.path, "wt"), "HEAD"], { cwd: repo.path });
      writeFileSync(join(repo.path, "wt/wip2.txt"), "uncommitted\n");
    }],
  ];

  for (const [what, vendor, found, make] of nestedGits) {
    test(`init refuses a vendor folder that is ${what} and writes nothing`, () => {
      const t = new VendorCase();
      try {
        const repo = new Repo(join(t.tmp, "fresh"));
        repo.write("README.md", "mine\n");
        repo.commit("start");
        make(repo);
        const before = tree(repo.path);
        const out = t.pb(["init", "--upstream", t.up.path, "--output-to", "out", "--vendor", vendor], { cwd: repo.path, code: 1 });
        expect(out.stderr).toContain(`holds ${found}`);
        expect(existsSync(join(repo.path, ".patchbook"))).toBe(false);
        expect(tree(repo.path)).toEqual(before);
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);

    vendorTest(`track refuses a vendor folder that is ${what} and leaves it whole`, (t) => {
      make(t.repo);
      const extra = new Repo(join(t.tmp, "extra"));
      extra.write("a.md", "a\n");
      extra.commit("a");
      const config = join(t.repo.path, ".patchbook/config.toml");
      const configBefore = read(config);
      const before = tree(t.repo.path);
      const out = t.pb(["track", "extra", extra.path, "--vendor", vendor], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain(`holds ${found}`);
      expect(read(config)).toBe(configBefore);
      expect(tree(t.repo.path)).toEqual(before);
    });

    if (what !== "a linked worktree") vendorTest(`sync refuses a vendored copy that became ${what} and leaves it whole`, (t) => {
      const extra = new Repo(join(t.tmp, "extra"));
      extra.write("a.md", "a\n");
      extra.commit("a");
      t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
      extra.write("b.md", "b\n");
      extra.commit("b");
      mkdirSync(join(t.repo.path, "vendor/extra/inner"), { recursive: true });
      make({ path: join(t.repo.path, "vendor/extra/inner") });
      const before = tree(t.repo.path);
      const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain(`holds vendor/extra/inner/${found}`);
      expect(tree(t.repo.path)).toEqual(before);
    });
  }

  vendorTest("sync refuses to rewrite a vendored copy that holds a git file", (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    writeFileSync(join(t.repo.path, "vendor/extra/a.md"), "edited by hand\n");
    writeFileSync(join(t.repo.path, "vendor/extra/.git"), gitFile);
    const before = tree(t.repo.path);
    const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("holds vendor/extra/.git");
    expect(tree(t.repo.path)).toEqual(before);
  });

  vendorTest("a vendor folder that holds a link named git is refused without following it", (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    mkdirSync(join(t.repo.path, "lib"));
    symlinkSync(join(t.tmp, "nowhere"), join(t.repo.path, "lib/.Git"));
    const out = t.pb(["track", "extra", extra.path, "--vendor", "lib"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("holds lib/.Git");
    expect(isSymlink(join(t.repo.path, "lib/.Git"))).toBe(true);
  });

  vendorTest("a vendor folder that is a link to a repo is not searched for git", (t) => {
    const outside = new Repo(join(t.tmp, "outside"));
    outside.write("keep.txt", "precious\n");
    outside.commit("start");
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    symlinkSync(outside.path, join(t.repo.path, "lnk"));
    t.pb(["track", "extra", extra.path, "--vendor", "lnk"], { cwd: t.repo.path });
    expect(isSymlink(join(t.repo.path, "lnk"))).toBe(false);
    expect(read(join(outside.path, "keep.txt"))).toBe("precious\n");
    expect(existsSync(join(outside.path, ".git"))).toBe(true);
  });

  const extraAt = (t: VendorCase): Repo => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    return extra;
  };
  const nestRepo = (root: string, dir: string): void => {
    sh(["git", "init", "-q", "-b", "main", join(root, dir)], { cwd: root });
    writeFileSync(join(root, dir, "wip.txt"), "uncommitted\n");
  };
  const lockOf = (t: VendorCase): string => t.repo.read(".patchbook/upstream.lock");

  const userFiles: [string, string, (repo: Repo) => void][] = [
    ["a file of your own", "vendor/extra/new.md", (repo) => repo.write("vendor/extra/new.md", "my notes\n")],
    ["a file in a folder of your own", "vendor/extra/deep/er/n.md", (repo) => repo.write("vendor/extra/deep/er/n.md", "nested\n")],
    ["a file git ignores", "vendor/extra/.env", (repo) => {
      appendFileSync(join(repo.path, ".gitignore"), ".env\n");
      repo.write("vendor/extra/.env", "SECRET=1\n");
    }],
    ["a link of your own", "vendor/extra/link", (repo) => {
      mkdirSync(join(repo.path, "vendor/extra"), { recursive: true });
      symlinkSync("../../README.md", join(repo.path, "vendor/extra/link"));
    }],
    ["a file at a path upstream has with other bytes", "vendor/extra/a.md", (repo) => repo.write("vendor/extra/a.md", "mine, not upstream's\n")],
  ];

  const statusOf = (t: VendorCase): string => {
    const r = t.pb(["status"], { cwd: t.repo.path, code: null });
    return `${r.code}\n${r.stdout}${r.stderr}`;
  };

  const noJournal = (t: VendorCase): void => {
    expect(existsSync(join(t.repo.path, ".patchbook/sync-extra"))).toBe(false);
  };

  for (const [what, found, make] of userFiles) {
    vendorTest(`track refuses a vendor folder that holds ${what} and keeps it`, (t) => {
      const extra = extraAt(t);
      make(t.repo);
      const config = join(t.repo.path, ".patchbook/config.toml");
      const configBefore = read(config);
      const lock = lockOf(t);
      const status = statusOf(t);
      const before = tree(t.repo.path);
      const out = t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain("upstream extra");
      expect(out.stderr).toContain("vendor/extra");
      expect(out.stderr).toContain(found);
      expect(out.stderr).toContain("Nothing was changed.");
      expect(read(config)).toBe(configBefore);
      expect(read(config)).not.toContain("extra");
      expect(lockOf(t)).toBe(lock);
      expect(tree(t.repo.path)).toEqual(before);
      noJournal(t);
      expect(statusOf(t)).toBe(status);
    });

    test(`init refuses a vendor folder that holds ${what} and writes nothing`, () => {
      const t = new VendorCase();
      try {
        const repo = new Repo(join(t.tmp, "fresh"));
        repo.write("README.md", "mine\n");
        repo.commit("start");
        const extra = extraAt(t);
        make(repo);
        const before = tree(repo.path);
        const out = t.pb(["init", "--upstream", extra.path, "--name", "extra", "--output-to", "out", "--vendor", "vendor/extra"], { cwd: repo.path, code: 1 });
        expect(out.stderr).toContain(found);
        expect(out.stderr).toContain("Nothing was changed.");
        expect(existsSync(join(repo.path, ".patchbook"))).toBe(false);
        expect(tree(repo.path)).toEqual(before);
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);

    if (!what.endsWith("other bytes")) {
      vendorTest(`sync refuses to replace a vendored copy that holds ${what}`, (t) => {
        const extra = extraAt(t);
        t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
        extra.write("b.md", "b\n");
        extra.commit("b");
        make(t.repo);
        const lock = lockOf(t);
        const before = tree(t.repo.path);
        const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
        expect(out.stderr).toContain("upstream extra");
        expect(out.stderr).toContain(found);
        expect(out.stderr).toContain("Nothing was changed.");
        expect(lockOf(t)).toBe(lock);
        expect(tree(t.repo.path)).toEqual(before);
        noJournal(t);
      });

      vendorTest(`sync ${what === "a file git ignores" ? "leaves" : "refuses to rewrite"} a vendored copy that holds ${what}`, (t) => {
        const extra = extraAt(t);
        t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
        make(t.repo);
        const lock = lockOf(t);
        const before = tree(t.repo.path);
        if (what === "a file git ignores") {
          expect(t.pb(["sync", "extra"], { cwd: t.repo.path }).stdout).toContain("Nothing to do.");
          expect(tree(t.repo.path)).toEqual(before);
          return;
        }
        const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
        expect(out.stderr).toContain("upstream extra");
        expect(out.stderr).toContain(found);
        expect(out.stderr).toContain("Nothing was changed.");
        expect(lockOf(t)).toBe(lock);
        expect(tree(t.repo.path)).toEqual(before);
        noJournal(t);
      });
    }
  }

  vendorTest("track refuses a vendor path that is a file of yours and keeps it", (t) => {
    const extra = extraAt(t);
    t.repo.write("vendor/extra", "my file\n");
    const config = join(t.repo.path, ".patchbook/config.toml");
    const configBefore = read(config);
    const before = tree(t.repo.path);
    const out = t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("upstream extra");
    expect(out.stderr).toContain("vendor/extra");
    expect(out.stderr).toContain("Nothing was changed.");
    expect(read(config)).toBe(configBefore);
    expect(tree(t.repo.path)).toEqual(before);
  });

  for (const [what, moves] of [["moved pin", true], ["unchanged upstream", false]] as const) {
    vendorTest(`sync with a ${what} refuses a vendor path that is a file of yours and keeps it`, (t) => {
      const extra = extraAt(t);
      t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
      if (moves) {
        extra.write("b.md", "b\n");
        extra.commit("b");
      }
      rmSync(join(t.repo.path, "vendor/extra"), { recursive: true });
      t.repo.write("vendor/extra", "my file\n");
      const lock = lockOf(t);
      const before = tree(t.repo.path);
      const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain("upstream extra");
      expect(out.stderr).toContain("vendor/extra");
      expect(out.stderr).toContain("Nothing was changed.");
      expect(t.repo.read("vendor/extra")).toBe("my file\n");
      expect(lockOf(t)).toBe(lock);
      expect(tree(t.repo.path)).toEqual(before);
      noJournal(t);
    });
  }

  describe.skipIf(!!process.env["PATCHBOOK_CMD"])("killed by a preload, so only from source", () => {
    const killedSync = (t: VendorCase): Repo => {
      const extra = extraAt(t);
      t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
      extra.write("b.md", "b\n");
      extra.commit("b");
      const env = { ...t.env, CRASH_BEFORE_WRITE: "/.patchbook/sync-extra/lock" };
      sh([...crashCmd(), "sync", "extra"], { cwd: t.repo.path, env, check: false });
      expect(existsSync(join(t.repo.path, ".patchbook/sync-extra/old"))).toBe(true);
      return extra;
    };

    vendorTest("a sync after a killed sync refuses to delete a file added to the copy and keeps it", (t) => {
      killedSync(t);
      t.repo.write("vendor/extra/mine.md", "my notes\n");
      const before = tree(t.repo.path);
      const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain("vendor/extra/mine.md");
      expect(out.stderr).toContain("sync-extra");
      expect(t.repo.read("vendor/extra/mine.md")).toBe("my notes\n");
      expect(tree(t.repo.path)).toEqual(before);
      expect(existsSync(join(t.repo.path, ".patchbook/sync-extra/old"))).toBe(true);
    });

    vendorTest("a sync after a killed sync goes through once the file is moved out", (t) => {
      killedSync(t);
      t.repo.write("vendor/extra/mine.md", "my notes\n");
      t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
      renameSync(join(t.repo.path, "vendor/extra/mine.md"), join(t.repo.path, "mine.md"));
      t.pb(["sync", "extra"], { cwd: t.repo.path });
      expect(t.repo.read("vendor/extra/b.md")).toBe("b\n");
      expect(t.repo.read("mine.md")).toBe("my notes\n");
      noJournal(t);
    });

    vendorTest("a sync after a killed sync with nothing of yours in the copy still finishes", (t) => {
      killedSync(t);
      t.pb(["sync", "extra"], { cwd: t.repo.path });
      expect(t.repo.read("vendor/extra/b.md")).toBe("b\n");
      noJournal(t);
    });

    vendorTest("a killed sync is left for the user when upstream.lock is now a link into the repo", (t) => {
      killedSync(t);
      const [link, target] = [join(t.repo.path, ".patchbook/upstream.lock"), join(t.repo.path, "pins/upstream.lock")];
      mkdirSync(dirname(target));
      writeFileSync(join(t.repo.path, ".patchbook/sync-extra/lock"), read(link));
      renameSync(link, target);
      symlinkSync("../pins/upstream.lock", link);
      writeFileSync(target, "");
      const before = tree(t.repo.path);
      expect(t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 }).stderr).toContain(".patchbook/upstream.lock is a link");
      expect(readlinkSync(link)).toBe("../pins/upstream.lock");
      expect(read(target)).toBe("");
      expect(tree(t.repo.path)).toEqual(before);
    });
  });

  vendorTest("a refusal names a few files and counts the rest", (t) => {
    const extra = extraAt(t);
    for (let i = 1; i <= 8; i++) t.repo.write(`vendor/extra/mine${i}.md`, `${i}\n`);
    const before = tree(t.repo.path);
    const out = t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("holds 8 files");
    expect(out.stderr).toContain("vendor/extra/mine1.md");
    expect(out.stderr).toContain("vendor/extra/mine5.md");
    expect(out.stderr).not.toContain("vendor/extra/mine6.md");
    expect(out.stderr).toContain("and 3 more");
    expect(tree(t.repo.path)).toEqual(before);
  });

  vendorTest("a refused sync goes through once the file is moved out", (t) => {
    const extra = extraAt(t);
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    extra.write("b.md", "b\n");
    extra.commit("b");
    t.repo.write("vendor/extra/new.md", "my notes\n");
    t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    renameSync(join(t.repo.path, "vendor/extra/new.md"), join(t.repo.path, "new.md"));
    t.pb(["sync", "extra"], { cwd: t.repo.path });
    expect(t.repo.read("vendor/extra/b.md")).toBe("b\n");
    expect(t.repo.read("new.md")).toBe("my notes\n");
    expect(statusOf(t)).not.toContain("Never edit the vendored copy");
  });

  vendorTest("track into an empty or missing vendor folder still works", (t) => {
    const extra = extraAt(t);
    mkdirSync(join(t.repo.path, "vendor/empty"), { recursive: true });
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/empty"], { cwd: t.repo.path });
    expect(t.repo.read("vendor/empty/a.md")).toBe("a\n");
    t.pb(["track", "other", extra.path, "--vendor", "vendor/missing"], { cwd: t.repo.path });
    expect(t.repo.read("vendor/missing/a.md")).toBe("a\n");
    expect(statusOf(t)).not.toContain("differs from the pin");
  });

  vendorTest("track into a folder that holds exactly upstream's files still works", (t) => {
    const extra = extraAt(t);
    t.repo.write("vendor/extra/a.md", "a\n");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    expect(t.repo.read("vendor/extra/a.md")).toBe("a\n");
    expect(statusOf(t)).not.toContain("differs from the pin");
  });

  vendorTest("sync of an untouched vendored copy still works", (t) => {
    const extra = extraAt(t);
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    extra.write("b.md", "b\n");
    extra.commit("b");
    t.pb(["sync", "extra"], { cwd: t.repo.path });
    expect(t.repo.read("vendor/extra/b.md")).toBe("b\n");
    rmSync(join(t.repo.path, "vendor/extra/a.md"));
    t.pb(["sync", "extra"], { cwd: t.repo.path });
    expect(t.repo.read("vendor/extra/a.md")).toBe("a\n");
  });

  vendorTest("sync still rewrites an upstream path edited by hand", (t) => {
    const extra = extraAt(t);
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    extra.write("b.md", "b\n");
    extra.commit("b");
    t.repo.write("vendor/extra/a.md", "edited by hand\n");
    t.pb(["sync", "extra"], { cwd: t.repo.path });
    expect(t.repo.read("vendor/extra/a.md")).toBe("a\n");
  });

  describe.skipIf(process.getuid?.() === 0)("where chmod hides a folder, so not as root", () => {
    const unhide = (t: Case): void => {
      sh(["chmod", "-R", "u+rwx", t.tmp], { cwd: t.tmp });
    };
    const hidden: [string, number][] = [["no access", 0o000], ["no read", 0o311]];

    for (const [how, mode] of hidden) {
      vendorTest(`track refuses a vendor folder with a folder it cannot read ${how}`, (t) => {
        const extra = extraAt(t);
        mkdirSync(join(t.repo.path, "lib/locked"), { recursive: true });
        nestRepo(t.repo.path, "lib/locked");
        const config = join(t.repo.path, ".patchbook/config.toml");
        const configBefore = read(config);
        const before = tree(t.repo.path);
        const locked = join(t.repo.path, "lib/locked");
        chmodSync(locked, mode);
        try {
          const out = t.pb(["track", "extra", extra.path, "--vendor", "lib"], { cwd: t.repo.path, code: 1 });
          expect(out.stderr).toContain("can't read lib/locked");
          expect(out.stderr).not.toContain("EACCES");
        } finally {
          unhide(t);
        }
        expect(read(config)).toBe(configBefore);
        expect(tree(t.repo.path)).toEqual(before);
      });

      vendorTest(`sync refuses a vendored copy with a folder it cannot read ${how} and moves nothing`, (t) => {
        const extra = extraAt(t);
        t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
        extra.write("b.md", "b\n");
        extra.commit("b");
        const locked = join(t.repo.path, "vendor/extra/locked");
        mkdirSync(locked);
        nestRepo(t.repo.path, "vendor/extra/locked");
        const before = tree(t.repo.path);
        chmodSync(locked, mode);
        try {
          const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
          expect(out.stderr).toContain("can't read vendor/extra/locked");
          expect(out.stderr).not.toContain("EACCES");
          expect(existsSync(join(t.repo.path, ".patchbook/sync-extra"))).toBe(false);
        } finally {
          unhide(t);
        }
        expect(tree(t.repo.path)).toEqual(before);
      });

      vendorTest(`sync refuses a vendor folder it cannot read ${how} by name not by a raw error`, (t) => {
        const extra = extraAt(t);
        t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
        extra.write("b.md", "b\n");
        extra.commit("b");
        const vendor = join(t.repo.path, "vendor/extra");
        const before = tree(t.repo.path);
        chmodSync(vendor, mode);
        try {
          const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
          expect(out.stderr).toContain("can't read vendor/extra");
          expect(out.stderr).not.toContain("EACCES");
          expect(out.stderr).not.toContain("rename");
        } finally {
          unhide(t);
        }
        expect(existsSync(join(t.repo.path, ".patchbook/sync-extra"))).toBe(false);
        expect(tree(t.repo.path)).toEqual(before);
      });
    }

    vendorTest("track refuses a vendor folder it cannot read by name and writes nothing", (t) => {
      const extra = extraAt(t);
      mkdirSync(join(t.repo.path, "lib"));
      const config = join(t.repo.path, ".patchbook/config.toml");
      const configBefore = read(config);
      chmodSync(join(t.repo.path, "lib"), 0o000);
      try {
        const out = t.pb(["track", "extra", extra.path, "--vendor", "lib"], { cwd: t.repo.path, code: 1 });
        expect(out.stderr).toContain("can't read lib");
        expect(out.stderr).not.toContain("EACCES");
      } finally {
        unhide(t);
      }
      expect(read(config)).toBe(configBefore);
    });

    vendorTest("a sync killed after the copy moved is not finished over a folder it cannot read", (t) => {
      const extra = extraAt(t);
      t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
      extra.write("b.md", "b\n");
      extra.commit("b");
      killSync(t, "write-tree --prefix=vendor/extra/");
      const locked = join(t.repo.path, "vendor/extra/locked");
      mkdirSync(locked);
      nestRepo(t.repo.path, "vendor/extra/locked");
      const before = tree(t.repo.path);
      chmodSync(locked, 0o000);
      try {
        const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
        expect(out.stderr).toContain("can't read vendor/extra/locked");
      } finally {
        unhide(t);
      }
      expect(tree(t.repo.path)).toEqual(before);
      expect(existsSync(join(t.repo.path, ".patchbook/sync-extra/old/a.md"))).toBe(true);
    });
  });

  vendorTest("a sync killed after the copy moved is not finished over a repo made in the vendor folder", (t) => {
    const extra = extraAt(t);
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    extra.write("b.md", "b\n");
    extra.commit("b");
    killSync(t, "write-tree --prefix=vendor/extra/");
    const journal = ".patchbook/sync-extra";
    expect(existsSync(join(t.repo.path, journal, "old/a.md"))).toBe(true);
    mkdirSync(join(t.repo.path, "vendor/extra/proj"));
    nestRepo(t.repo.path, "vendor/extra/proj");
    const before = tree(t.repo.path);
    const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("vendor/extra/proj/.git");
    expect(out.stderr).toContain(`${journal} holds a sync of extra`);
    expect(out.stderr).toContain("sync again");
    expect(tree(t.repo.path)).toEqual(before);
    rmSync(join(t.repo.path, "vendor/extra/proj"), { recursive: true });
    t.pb(["sync", "extra"], { cwd: t.repo.path });
    expect(existsSync(join(t.repo.path, journal))).toBe(false);
    expect(t.repo.read("vendor/extra/b.md")).toBe("b\n");
  });

  vendorTest("a sync killed before the copy moved keeps a repo made in a vendor folder that did not exist", (t) => {
    const extra = extraAt(t);
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    extra.write("b.md", "b\n");
    extra.commit("b");
    rmSync(join(t.repo.path, "vendor/extra"), { recursive: true });
    killSync(t, "write-tree --prefix=vendor/extra/");
    rmSync(join(t.repo.path, "vendor/extra"), { recursive: true, force: true });
    mkdirSync(join(t.repo.path, "vendor/extra"));
    nestRepo(t.repo.path, "vendor/extra");
    const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("vendor/extra/.git");
    expect(existsSync(join(t.repo.path, "vendor/extra/wip.txt"))).toBe(true);
  });

  /** Runs `act` once, just before the first git call whose arguments contain `call`, as a user's own command would while a sync works. */
  const doDuring = (t: VendorCase, call: string, act: (git: string) => string): void => {
    const bin = join(t.tmp, "race");
    mkdirSync(bin, { recursive: true });
    const git = Bun.which("git")!;
    const mark = join(t.tmp, "raced");
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase "$*" in *"${call}"*) if [ ! -e "${mark}" ]; then touch "${mark}"; ${act(git)}; fi;; esac\nexec ${git} "$@"\n`, { mode: 0o755 });
    t.env["PATH"] = `${bin}:${t.env["PATH"]}`;
  };
  const makeRepoLater = (t: VendorCase) => (git: string): string =>
    `${git} init -q -b main "${t.repo.path}/vendor/extra/proj" && echo uncommitted > "${t.repo.path}/vendor/extra/proj/wip.txt"`;

  vendorTest("sync keeps a repo made in the vendored copy while it fetches", (t) => {
    const extra = extraAt(t);
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    extra.write("b.md", "b\n");
    extra.commit("b");
    const lock = lockOf(t);
    doDuring(t, "fetch", makeRepoLater(t));
    const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("vendor/extra/proj/.git");
    expect(read(join(t.repo.path, "vendor/extra/proj/wip.txt"))).toBe("uncommitted\n");
    expect(existsSync(join(t.repo.path, ".patchbook/sync-extra"))).toBe(false);
    expect(lockOf(t)).toBe(lock);
    expect(t.repo.read("vendor/extra/a.md")).toBe("a\n");
  });

  vendorTest("sync keeps a repo made in the vendored copy while it rewrites a copy that does not match the pin", (t) => {
    const extra = extraAt(t);
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    writeFileSync(join(t.repo.path, "vendor/extra/a.md"), "edited by hand\n");
    doDuring(t, "ls-tree", makeRepoLater(t));
    const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("vendor/extra/proj/.git");
    expect(read(join(t.repo.path, "vendor/extra/proj/wip.txt"))).toBe("uncommitted\n");
    expect(existsSync(join(t.repo.path, ".patchbook/sync-extra"))).toBe(false);
    expect(t.repo.read("vendor/extra/a.md")).toBe("edited by hand\n");
  });

  vendorTest("sync keeps a repo made in the vendored copy while it pins the new commit", (t) => {
    const extra = extraAt(t);
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    extra.write("b.md", "b\n");
    const head = extra.commit("b");
    const lock = lockOf(t);
    doDuring(t, `update-ref refs/pins/${head}`, makeRepoLater(t));
    const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("the vendored copy of extra (vendor/extra) holds vendor/extra/proj/.git");
    expect(read(join(t.repo.path, "vendor/extra/proj/wip.txt"))).toBe("uncommitted\n");
    expect(existsSync(join(t.repo.path, ".patchbook/sync-extra"))).toBe(false);
    expect(lockOf(t)).toBe(lock);
    expect(t.repo.read("vendor/extra/a.md")).toBe("a\n");
    expect(existsSync(join(t.repo.path, "vendor/extra/b.md"))).toBe(false);
    expect(pinRefs(t, head)).toBe(0);
  });

  vendorTest("a recovery keeps a repo made in the vendored copy while it releases the ref", (t) => {
    const extra = extraAt(t);
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    extra.write("b.md", "b\n");
    extra.commit("b");
    killSync(t, "write-tree --prefix=vendor/extra/");
    const journal = join(t.repo.path, ".patchbook/sync-extra");
    expect(existsSync(join(journal, "old/a.md"))).toBe(true);
    doDuring(t, "update-ref -d", makeRepoLater(t));
    const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain(".patchbook/sync-extra holds a sync of extra that stopped partway, and the vendored copy (vendor/extra) holds vendor/extra/proj/.git");
    expect(read(join(t.repo.path, "vendor/extra/proj/wip.txt"))).toBe("uncommitted\n");
    expect(existsSync(join(journal, "old/a.md"))).toBe(true);
    rmSync(join(t.repo.path, "vendor/extra/proj"), { recursive: true });
    t.pb(["sync", "extra"], { cwd: t.repo.path });
    expect(existsSync(journal)).toBe(false);
    expect(t.repo.read("vendor/extra/b.md")).toBe("b\n");
  });

  /** A commit on top of upstream's head whose tree also holds a blob at `path`, which `git add` refuses to stage for a `.git` and only `git mktree` can store. */
  const withBlobAt = (t: Case, up: Repo, path: string): void => {
    const git = (args: string[], input = ""): string => {
      const r = Bun.spawnSync(["git", ...args], { cwd: up.path, env: t.env, stdin: Buffer.from(input), stdout: "pipe" });
      return r.stdout.toString().trim();
    };
    const blob = git(["hash-object", "-w", "--stdin"], "a\n");
    const entry = (parts: string[]): string =>
      parts.length === 1 ? `100644 blob ${blob}\t${parts[0]}` : `040000 tree ${git(["mktree"], entry(parts.slice(1)) + "\n")}\t${parts[0]}`;
    const treeId = git(["mktree"], `${git(["ls-tree", "HEAD"])}\n${entry(path.split("/"))}\n`);
    git(["update-ref", "refs/heads/main", git(["commit-tree", treeId, "-p", "HEAD", "-m", `with ${path}`])]);
  };
  const upstreamWithDotGit = (t: Case, name: string, path = ".git"): Repo => {
    const up = new Repo(join(t.tmp, name));
    up.write("a.md", "a\n");
    up.commit("a");
    withBlobAt(t, up, path);
    return up;
  };

  vendorTest("an upstream that holds a .git is refused by track and sync before anything is written", (t) => {
    const other = extraAt(t);
    t.pb(["track", "other", other.path, "--vendor", "vendor/other"], { cwd: t.repo.path });
    const gentry = upstreamWithDotGit(t, "gentry");
    const refused = "upstream gentry holds .git";
    const config = join(t.repo.path, ".patchbook/config.toml");
    const kept = read(config);
    const out = t.pb(["track", "gentry", gentry.path, "--vendor", "vendor/gentry"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain(refused);
    expect(out.stderr).toContain("vendor/gentry");
    expect(read(config)).toBe(kept);
    expect(readdirSync(join(t.repo.path, ".patchbook")).filter((n) => n.startsWith("sync-"))).toEqual([]);
    expect(existsSync(join(t.repo.path, "vendor/gentry/a.md"))).toBe(false);
    writeFileSync(config, `${kept}\n[[upstream]]\nname = "gentry"\nremote = ${JSON.stringify(gentry.path)}\nbranch = "main"\nmount = "gentry"\nvendor = "vendor/gentry"\n`);
    const before = tree(t.repo.path);
    const again = t.pb(["sync", "gentry"], { cwd: t.repo.path, code: 1 });
    expect(again.stderr).toContain(refused);
    expect(readdirSync(join(t.repo.path, ".patchbook")).filter((n) => n.startsWith("sync-"))).toEqual([]);
    expect(tree(t.repo.path)).toEqual(before);
    other.write("b.md", "b\n");
    other.commit("b");
    t.pb(["sync", "other"], { cwd: t.repo.path });
    expect(t.repo.read("vendor/other/b.md")).toBe("b\n");
  });

  vendorTest("a refused track vendor leaves no upstream block and status as it was", (t) => {
    const config = join(t.repo.path, ".patchbook/config.toml");
    const kept = readFileSync(config);
    const status = t.pb(["status"], { cwd: t.repo.path, code: null });
    const evil = upstreamWithDotGit(t, "evil", ".git/config");
    const out = t.pb(["track", "evil", evil.path, "--vendor", "vendor/evil"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("upstream evil holds .git/config, which git reads as .git, so it can't be vendored into vendor/evil. Nothing was changed.");
    expect(readFileSync(config)).toEqual(kept);
    expect(t.pb(["status"], { cwd: t.repo.path, code: null })).toEqual(status);
  });

  vendorTest("an upstream that holds a .git is refused when a sync would only rewrite the copy", (t) => {
    const gentry = extraAt(t);
    t.pb(["track", "gentry", gentry.path], { cwd: t.repo.path });
    withBlobAt(t, gentry, ".git");
    t.pb(["check"], { cwd: t.repo.path, code: 1 }); // fetches the commit; no patchbook can pin it now, so the lock is the one an older patchbook wrote
    const [commit, treeId] = sh(["git", "rev-parse", "HEAD", "HEAD^{tree}"], { cwd: gentry.path }).stdout.split("\n");
    const lock = join(t.repo.path, ".patchbook/upstream.lock");
    writeFileSync(lock, withPin(read(lock), { name: "gentry", commit: commit!, tree: treeId! }));
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replaceAll('name = "gentry"', 'name = "gentry"\nvendor = "vendor/gentry"'));
    const before = tree(t.repo.path);
    const out = t.pb(["sync", "gentry"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("upstream gentry holds .git, which git reads as .git, so it can't be vendored");
    expect(tree(t.repo.path)).toEqual(before);
  });

  describe("an upstream that is not vendored and holds a path git reads as .git", () => {
    const spellings = [".git/config", "GIT~1/config", ".git./config", ".g‌it/config"];

    const dotGitCase = (): { t: Case; repo: Repo; out: string; good: Repo } => {
      const t = new Case();
      const up = new Repo(join(t.tmp, "up"));
      up.write("README.md", "up\n");
      up.commit("start");
      const repo = new Repo(join(t.tmp, "mine"));
      repo.write("README.md", "mine\n");
      repo.commit("start");
      t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: repo.path });
      repo.commit("init");
      const good = new Repo(join(t.tmp, "good"));
      good.write("g.md", "g\n");
      good.commit("g");
      t.pb(["track", "good", good.path], { cwd: repo.path });
      t.pb(["build"], { cwd: repo.path });
      return { t, repo, out: join(repo.path, "out"), good };
    };

    for (const path of spellings) {
      const refused = (name: string): string => `upstream ${name} holds ${path}, which git reads as .git, so a build would put a git repo of its own in your tree. Nothing was changed.`;

      test(`track refuses an upstream that holds ${path} before it pins and builds nothing`, () => {
        const { t, repo, out } = dotGitCase();
        try {
          const evil = upstreamWithDotGit(t, "evil", path);
          const before = tree(repo.path);
          const tracked = t.pb(["track", "evil", evil.path], { cwd: repo.path, code: 1 });
          expect(tracked.stderr).toContain(refused("evil"));
          expect(tree(repo.path)).toEqual(before);
          t.pb(["build"], { cwd: repo.path });
          expect(existsSync(join(out, "evil"))).toBe(false);
          expect(tree(repo.path)).toEqual(before);
        } finally {
          t.cleanup();
        }
      }, TIMEOUT);

      test(`every command that builds refuses a pin that holds ${path}`, () => {
        const { t, repo, out, good } = dotGitCase();
        try {
          withBlobAt(t, good, path);
          expect(t.pb(["check"], { cwd: repo.path, code: 1 }).stderr).toContain(refused("good"));
          expect(t.pb(["sync"], { cwd: repo.path, code: 1 }).stderr).toContain(refused("good"));
          const lockPath = join(repo.path, ".patchbook/upstream.lock");
          const head = sh(["git", "rev-parse", "HEAD", "HEAD^{tree}"], { cwd: good.path }).stdout.split("\n");
          writeFileSync(lockPath, withPin(read(lockPath), { name: "good", commit: head[0]!, tree: head[1]! }));
          const built = tree(out);
          const lock = read(lockPath);
          for (const args of [["build"], ["build", "--force"], ["status"], ["status", "--json"], ["scaffold"]]) {
            const r = t.pb(args, { cwd: repo.path, code: 1 });
            expect(r.stderr).toContain(refused("good"));
            expect(r.stderr).not.toMatch(/^\s+at /m);
          }
          sh(["git", "add", ".patchbook"], { cwd: repo.path });
          const hooked = sh(["git", "commit", "-q", "--allow-empty", "-m", "hook"], { cwd: repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1" }, check: false });
          expect(hooked.code).not.toBe(0);
          expect(hooked.stderr).toContain(refused("good"));
          expect(existsSync(join(out, "good", path.split("/")[0]!))).toBe(false);
          expect(tree(out)).toEqual(built);
          expect(read(lockPath)).toBe(lock);
        } finally {
          t.cleanup();
        }
      }, TIMEOUT);
    }

    test("a refused track leaves a CRLF config byte for byte and status as it was", () => {
      const { t, repo } = dotGitCase();
      try {
        const config = join(repo.path, ".patchbook/config.toml");
        writeFileSync(config, read(config).replaceAll("\n", "\r\n"));
        const kept = readFileSync(config);
        const status = t.pb(["status"], { cwd: repo.path, code: null });
        const evil = upstreamWithDotGit(t, "evil", ".git/config");
        const out = t.pb(["track", "evil", evil.path], { cwd: repo.path, code: 1 });
        expect(out.stderr).toContain("upstream evil holds .git/config, which git reads as .git, so a build would put a git repo of its own in your tree. Nothing was changed.");
        expect(readFileSync(config)).toEqual(kept);
        expect(t.pb(["status"], { cwd: repo.path, code: null })).toEqual(status);
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);
  });

  const exportCase = (path: string | null): { t: Case; repo: Repo } => {
    const t = new Case();
    const base = new Repo(join(t.tmp, "base"));
    base.write("README.md", "base\n");
    base.commit("start");
    const repo = new Repo(join(t.tmp, "mine"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    t.pb(["init", "--upstream", base.path, "--output-to", "out"], { cwd: repo.path });
    repo.commit("init");
    const evil = new Repo(join(t.tmp, "evil"));
    evil.write("a.md", "a\n");
    evil.commit("a");
    t.pb(["track", "evil", evil.path], { cwd: repo.path });
    if (path !== null) {
      withBlobAt(t, evil, path);
      t.pb(["check"], { cwd: repo.path, code: null });
      const [commit, treeId] = sh(["git", "rev-parse", "HEAD", "HEAD^{tree}"], { cwd: evil.path }).stdout.split("\n");
      const lock = join(repo.path, ".patchbook/upstream.lock");
      writeFileSync(lock, withPin(read(lock), { name: "evil", commit: commit!, tree: treeId! }));
    }
    return { t, repo };
  };

  describe("an upstream tree path with a part of .., . or nothing", () => {
    const refusedPath = (path: string, part: string, name = "evil"): string =>
      `upstream ${name} holds ${path}, which has a part named ${JSON.stringify(part)}, so a write could land outside the folder it belongs in. Nothing was changed.`;
    const climbs: [string, string][] = [["../escape.txt", ".."], ["../../../escape.txt", ".."], ["sub/../x.txt", ".."], ["./x.txt", "."]];

    const outside = (t: Case): string => join(t.tmp, "escape.txt");

    for (const [path, part] of climbs) {
      test(`export refuses an upstream that holds ${path} and writes nothing outside`, () => {
        const { t, repo } = exportCase(path);
        try {
          repo.write("d1/d2/d3/escape.txt", "mine\n");
          repo.write("d1/d2/d3/x.txt", "mine\n");
          const before = tree(repo.path);
          const dest = join(repo.path, "d1/d2/d3/exp");
          const out = t.pb(["upstream", "evil", "--export", dest], { cwd: repo.path, code: 1 });
          expect(out.stderr).toContain(refusedPath(path, part));
          expect(out.stdout).toBe("");
          expect(existsSync(dest)).toBe(false);
          expect(tree(repo.path)).toEqual(before);
          expect(existsSync(outside(t))).toBe(false);
        } finally {
          t.cleanup();
        }
      }, TIMEOUT);

      test(`track refuses an upstream that holds ${path} before it pins`, () => {
        const { t, repo } = exportCase(null);
        try {
          const bad = new Repo(join(t.tmp, "bad"));
          bad.write("a.md", "a\n");
          bad.commit("a");
          withBlobAt(t, bad, path);
          const before = tree(repo.path);
          const out = t.pb(["track", "evil2", bad.path], { cwd: repo.path, code: 1 });
          expect(out.stderr).toContain(refusedPath(path, part, "evil2"));
          expect(tree(repo.path)).toEqual(before);
          expect(existsSync(outside(t))).toBe(false);
        } finally {
          t.cleanup();
        }
      }, TIMEOUT);

      test(`track vendor refuses an upstream that holds ${path} and writes nothing outside`, () => {
        const { t, repo } = exportCase(null);
        try {
          const bad = new Repo(join(t.tmp, "bad"));
          bad.write("a.md", "a\n");
          bad.commit("a");
          withBlobAt(t, bad, path);
          const before = tree(repo.path);
          const out = t.pb(["track", "evil2", bad.path, "--vendor", "vendor/evil2"], { cwd: repo.path, code: 1 });
          expect(out.stderr).toContain(refusedPath(path, part, "evil2"));
          expect(tree(repo.path)).toEqual(before);
          expect(existsSync(outside(t))).toBe(false);
        } finally {
          t.cleanup();
        }
      }, TIMEOUT);
    }

    const [path, part] = ["../escape.txt", ".."] as const;

    test("build refuses a pin that holds a path climbing out of its mount", () => {
      const { t, repo } = exportCase(path);
      try {
        const before = tree(repo.path);
        const out = t.pb(["build"], { cwd: repo.path, code: 1 });
        expect(out.stderr).toContain(refusedPath(path, part));
        expect(tree(repo.path)).toEqual(before);
        expect(existsSync(join(repo.path, "out/escape.txt"))).toBe(false);
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);

    test("the hook refuses a commit while the pin holds a path climbing out of its mount", () => {
      const { t, repo } = exportCase(path);
      try {
        sh(["git", "add", ".patchbook"], { cwd: repo.path });
        const hooked = sh(["git", "commit", "-q", "--allow-empty", "-m", "hook"], { cwd: repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1" }, check: false });
        expect(hooked.code).not.toBe(0);
        expect(hooked.stderr).toContain(refusedPath(path, part));
        expect(existsSync(join(repo.path, "out/escape.txt"))).toBe(false);
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);

    test("check and sync refuse a new commit that holds a path climbing out of its mount", () => {
      const { t, repo } = exportCase(null);
      try {
        const evil = new Repo(join(t.tmp, "evil"));
        withBlobAt(t, evil, path);
        const lock = read(join(repo.path, ".patchbook/upstream.lock"));
        const before = tree(repo.path);
        expect(t.pb(["check"], { cwd: repo.path, code: 1 }).stderr).toContain(refusedPath(path, part));
        expect(t.pb(["sync", "evil"], { cwd: repo.path, code: 1 }).stderr).toContain(refusedPath(path, part));
        expect(read(join(repo.path, ".patchbook/upstream.lock"))).toBe(lock);
        expect(tree(repo.path)).toEqual(before);
        expect(existsSync(join(repo.path, "out/escape.txt"))).toBe(false);
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);

    test("sync refuses a new commit that holds a climbing path and leaves the vendored copy", () => {
      const { t, repo } = exportCase(null);
      try {
        const vendored = new Repo(join(t.tmp, "vendored"));
        vendored.write("v.md", "v\n");
        vendored.commit("v");
        t.pb(["track", "vend", vendored.path, "--vendor", "vendor/vend"], { cwd: repo.path });
        withBlobAt(t, vendored, path);
        const lock = read(join(repo.path, ".patchbook/upstream.lock"));
        const before = tree(repo.path);
        const out = t.pb(["sync", "vend"], { cwd: repo.path, code: 1 });
        expect(out.stderr).toContain(refusedPath(path, part, "vend"));
        expect(read(join(repo.path, ".patchbook/upstream.lock"))).toBe(lock);
        expect(tree(repo.path)).toEqual(before);
        expect(existsSync(join(repo.path, "vendor/escape.txt"))).toBe(false);
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);

    test("a fork init refuses a merge base that holds a climbing path and writes nothing", () => {
      const t = new Case();
      try {
        const up = new Repo(join(t.tmp, "upstream"));
        up.write("a.md", "a\n");
        up.commit("a");
        withBlobAt(t, up, path);
        const mine = new Repo(join(t.tmp, "mine"));
        mine.write("README.md", "mine\n");
        mine.commit("mine");
        sh(["git", "fetch", "-q", up.path, "main"], { cwd: mine.path });
        const bad = sh(["git", "rev-parse", "FETCH_HEAD"], { cwd: mine.path }).stdout.trim();
        const onBad = sh(["git", "commit-tree", "HEAD^{tree}", "-p", bad, "-m", "mine on upstream"], { cwd: mine.path }).stdout.trim();
        sh(["git", "update-ref", "refs/heads/main", onBad], { cwd: mine.path });
        const before = tree(mine.path);
        const out = t.pb(["init", "--upstream", up.path], { cwd: mine.path, code: 1 });
        expect(out.stderr).toContain(refusedPath(path, part, "upstream"));
        expect(existsSync(join(mine.path, ".patchbook"))).toBe(false);
        expect(tree(mine.path)).toEqual(before);
        expect(sh(["git", "remote"], { cwd: mine.path }).stdout).not.toContain("upstream");
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);

    test("an upstream with dots in its names still tracks, builds and exports", () => {
      const { t, repo } = exportCase(null);
      try {
        const dots = new Repo(join(t.tmp, "dots"));
        for (const p of ["..a/b.md", ".hidden/x.md", "a..b", "...", "dir/.../y.md"]) dots.write(p, "d\n");
        dots.commit("dots");
        t.pb(["track", "dots", dots.path], { cwd: repo.path });
        t.pb(["build"], { cwd: repo.path });
        expect(repo.read("out/dots/..a/b.md")).toBe("d\n");
        expect(repo.read("out/dots/dir/.../y.md")).toBe("d\n");
        t.pb(["upstream", "dots", "--export", join(repo.path, "exp")], { cwd: repo.path });
        expect(repo.read("exp/.hidden/x.md")).toBe("d\n");
        expect(repo.read("exp/a..b")).toBe("d\n");
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);
  });

  describe("upstream --export", () => {

    for (const path of [".git/config", "GIT~1/config"]) {
      test(`export refuses an upstream that holds ${path} and writes nothing`, () => {
        const { t, repo } = exportCase(path);
        try {
          const dest = join(repo.path, "exp");
          const before = tree(repo.path);
          const config = repo.read(".git/config");
          const out = t.pb(["upstream", "evil", "--export", dest], { cwd: repo.path, code: 1 });
          expect(out.stderr).toContain(`upstream evil holds ${path}, which git reads as .git, so it can't be exported into ${join(realpathSync(repo.path), "exp")}. Nothing was changed.`);
          expect(out.stdout).toBe("");
          expect(existsSync(dest)).toBe(false);
          expect(tree(repo.path)).toEqual(before);
          expect(repo.read(".git/config")).toBe(config);
        } finally {
          t.cleanup();
        }
      }, TIMEOUT);
    }

    test("export to the repo root leaves the repo's own git config", () => {
      const { t, repo } = exportCase(".git/config");
      try {
        const before = tree(repo.path);
        const config = repo.read(".git/config");
        t.pb(["upstream", "evil", "--export", "."], { cwd: repo.path, code: 1 });
        expect(repo.read(".git/config")).toBe(config);
        expect(tree(repo.path)).toEqual(before);
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);

    test("export refuses a folder that is not empty and writes nothing", () => {
      const { t, repo } = exportCase(null);
      try {
        const dest = join(repo.path, "exp");
        repo.write("exp/a.md", "mine, not upstream's\n");
        repo.write("exp/other.txt", "other\n");
        const before = tree(repo.path);
        const out = t.pb(["upstream", "evil", "--export", dest], { cwd: repo.path, code: 1 });
        expect(out.stderr).toContain(`can't export upstream evil into ${realpathSync(dest)}, which already exists and isn't empty. Name a new or empty folder. Nothing was changed.`);
        expect(out.stdout).toBe("");
        expect(tree(repo.path)).toEqual(before);
        expect(repo.read("exp/a.md")).toBe("mine, not upstream's\n");
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);

    test("export refuses a destination that is a file and the repo root", () => {
      const { t, repo } = exportCase(null);
      try {
        const before = tree(repo.path);
        const file = join(repo.path, "README.md");
        expect(t.pb(["upstream", "evil", "--export", file], { cwd: repo.path, code: 1 }).stderr).toContain(`which already exists and isn't empty`);
        expect(t.pb(["upstream", "evil", "--export", "."], { cwd: repo.path, code: 1 }).stderr).toContain(`which already exists and isn't empty`);
        expect(tree(repo.path)).toEqual(before);
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);

    test("export still writes into a new folder and an empty one", () => {
      const { t, repo } = exportCase(null);
      try {
        t.pb(["upstream", "evil", "--export", join(repo.path, "fresh")], { cwd: repo.path });
        expect(repo.read("fresh/a.md")).toBe("a\n");
        mkdirSync(join(repo.path, "empty"));
        t.pb(["upstream", "evil", "--export", join(repo.path, "empty")], { cwd: repo.path });
        expect(repo.read("empty/a.md")).toBe("a\n");
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);
  });

  test("init refuses an upstream that holds a .git and leaves no patchbook", () => {
    const t = new Case();
    try {
      const evil = upstreamWithDotGit(t, "evil");
      const repo = new Repo(join(t.tmp, "mine"));
      repo.write("README.md", "mine\n");
      repo.commit("start");
      const before = tree(repo.path);
      const out = t.pb(["init", "--upstream", evil.path, "--output-to", "out"], { cwd: repo.path, code: 1 });
      expect(out.stderr).toContain("upstream evil holds .git, which git reads as .git");
      expect(tree(repo.path)).toEqual(before);
      expect(existsSync(join(repo.path, ".patchbook"))).toBe(false);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  test("init refused in a patchbook folder with no config leaves every file in it", () => {
    const t = new Case();
    try {
      const evil = upstreamWithDotGit(t, "evil", "GIT~1/config");
      const repo = new Repo(join(t.tmp, "mine"));
      repo.write("README.md", "mine\n");
      repo.commit("start");
      repo.write(".patchbook/notes.txt", "keep me\n");
      const before = tree(repo.path);
      const out = t.pb(["init", "--upstream", evil.path, "--output-to", "out"], { cwd: repo.path, code: 1 });
      expect(out.stderr).toContain("upstream evil holds GIT~1/config, which git reads as .git, so a build would put a git repo of its own in your tree. Nothing was changed.");
      expect(tree(repo.path)).toEqual(before);
      expect(existsSync(join(repo.path, ".patchbook/config.toml"))).toBe(false);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  const brokenLinks: [string, string, (t: Case, repo: Repo) => string][] = [
    ["out of the repo", "lnk/copy", (t, repo) => (symlinkSync(join(t.tmp, "gone/missing/deep"), join(repo.path, "lnk")), "lnk")],
    ["into a missing folder of the patchbook", "lnkdp/x", (_t, repo) => (symlinkSync(".patchbook/nope", join(repo.path, "lnkdp")), "lnkdp")],
    ["to the patchbook before it exists", "lnkpb/x", (_t, repo) => (symlinkSync(".patchbook", join(repo.path, "lnkpb")), "lnkpb")],
    ["two levels up", "a/lnk/copy/more", (t, repo) => (mkdirSync(join(repo.path, "a")), symlinkSync(join(t.tmp, "gone"), join(repo.path, "a/lnk")), "a/lnk")],
  ];

  for (const [what, vendor, link] of brokenLinks) {
    test(`init refuses a vendor folder behind a broken link ${what} and writes nothing`, () => {
      const t = new VendorCase();
      try {
        const repo = new Repo(join(t.tmp, "fresh"));
        repo.write("README.md", "mine\n");
        repo.commit("start");
        const name = link(t, repo);
        const before = tree(repo.path);
        const out = t.pb(["init", "--upstream", t.up.path, "--output-to", "out", "--vendor", vendor], { cwd: repo.path, code: 1 });
        expect(out.stderr).toContain(`is under ${name}, which is a link to nothing`);
        expect(out.stderr).not.toContain("ENOENT");
        expect(existsSync(join(repo.path, ".patchbook"))).toBe(false);
        expect(tree(repo.path)).toEqual(before);
        expect(existsSync(join(t.tmp, "gone"))).toBe(false);
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);

    if (what !== "to the patchbook before it exists") vendorTest(`track refuses a vendor folder behind a broken link ${what} and writes nothing`, (t) => {
      const extra = new Repo(join(t.tmp, "extra"));
      extra.write("a.md", "a\n");
      extra.commit("a");
      const name = link(t, t.repo);
      const config = join(t.repo.path, ".patchbook/config.toml");
      const configBefore = read(config);
      const before = tree(t.repo.path);
      const out = t.pb(["track", "extra", extra.path, "--vendor", vendor], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain(`is under ${name}, which is a link to nothing`);
      expect(out.stderr).not.toContain("ENOENT");
      expect(read(config)).toBe(configBefore);
      expect(tree(t.repo.path)).toEqual(before);
      expect(existsSync(join(t.tmp, "gone"))).toBe(false);
    });
  }

  vendorTest("a config that vendors behind a broken link is refused before sync touches anything", (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    symlinkSync(join(t.tmp, "gone/missing"), join(t.repo.path, "lnk"));
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replaceAll('vendor = "vendor/extra"', 'vendor = "lnk/copy"'));
    const before = tree(t.repo.path);
    const out = t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("is under lnk, which is a link to nothing");
    expect(tree(t.repo.path)).toEqual(before);
    expect(existsSync(join(t.tmp, "gone"))).toBe(false);
  });

  vendorTest("track in a fork refuses a vendored copy at the repo root", (t) => {
    t.pb(["clone", t.up.path, "fork"], { cwd: t.tmp });
    const fork = join(t.tmp, "fork");
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    const before = tree(fork);
    const out = t.pb(["track", "extra", extra.path, "--vendor", "."], { cwd: fork, code: 1 });
    expect(out.stderr).toContain("(.) is the repo root");
    expect(tree(fork)).toEqual(before);
  });

  vendorTest("a fork config that vendors at the repo root is refused on load", (t) => {
    t.pb(["clone", t.up.path, "fork"], { cwd: t.tmp });
    const fork = join(t.tmp, "fork");
    const config = join(fork, ".patchbook/config.toml");
    writeFileSync(config, read(config).replaceAll('mount = ""\n', 'mount = ""\nvendor = "."\n'));
    const before = tree(fork);
    const out = t.pb(["sync"], { cwd: fork, code: 1 });
    expect(out.stderr).toContain("(.) is the repo root");
    expect(tree(fork)).toEqual(before);
  });

  const casefold = (): boolean => {
    const dir = mkdtempSync(join(tmpdir(), "cf"));
    try {
      const probe = 'mount -t tmpfs -o casefold=utf8-12.1.0 none "$1" && mkdir "$1/w" && chattr +F "$1/w" && touch "$1/w/aB" && test -e "$1/w/Ab"';
      return sh(["unshare", "-rm", "sh", "-c", probe, "sh", dir], { cwd: dir, check: false }).code === 0;
    } catch {
      return false;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  // As root, unshare -r maps no other user, so the namespace cannot reach the runner's bun.
  test.skipIf(process.platform !== "linux" || isRoot || !casefold())("init refuses a patchbook in capitals on a case-insensitive folder", () => {
    const t = new VendorCase();
    try {
      const mount = join(t.tmp, "cf");
      mkdirSync(mount);
      const script = [
        'm=$1; shift',
        'mount -t tmpfs -o casefold=utf8-12.1.0 none "$m" && mkdir "$m/w" && chattr +F "$m/w" && cd "$m/w" || exit 90',
        'git init -q -b main repo && cd repo && echo mine > README.md && git add -A && git commit -qm start || exit 91',
        '"$@" init --upstream "$UP" --output-to out --vendor .PATCHBOOK',
        'echo "code=$?"; ls -A',
      ].join("\n");
      const out = sh(["unshare", "-rm", "sh", "-c", script, "sh", mount, ...CMD], { cwd: t.tmp, check: false, env: { ...t.env, UP: t.up.path } });
      expect(out.stdout).toContain("code=1");
      expect(out.stderr).toContain("is inside .patchbook");
      expect(out.stderr).not.toContain("EINVAL");
      expect(out.stdout).not.toContain(".patchbook");
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  vendorTest("track refuses a vendored copy behind a link out of the repo", (t) => {
    plantSentinel(t);
    symlinkSync(join(t.tmp, "sibling"), join(t.repo.path, "out"));
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    const before = read(join(t.repo.path, ".patchbook/config.toml"));
    const out = t.pb(["track", "extra", extra.path, "--vendor", "out/copy"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("is outside the repo");
    expect(read(join(t.repo.path, ".patchbook/config.toml"))).toBe(before);
    expect(readdirSync(join(t.tmp, "sibling"))).toEqual(["keep.txt"]);
  });

  vendorTest("track refuses a vendored copy behind a link to the patchbook", (t) => {
    symlinkSync(".patchbook", join(t.repo.path, "alias"));
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    const before = tree(t.repo.path);
    const out = t.pb(["track", "extra", extra.path, "--vendor", "alias/copy"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("is inside .patchbook");
    expect(tree(t.repo.path)).toEqual(before);
  });

  vendorTest("build never changes the git dir of a linked worktree", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.write("skills/zz/config", "stale\n");
    t.repo.commit("a file under skills/zz");
    const worktree = join(t.tmp, "wt");
    sh(["git", "worktree", "add", "-q", worktree, "-b", "wt"], { cwd: t.repo.path });
    rmSync(join(worktree, "skills/zz"), { recursive: true });
    symlinkSync(join(t.repo.path, ".git"), join(worktree, "skills/zz"));
    writeFileSync(join(worktree, ".gitignore"), "/skills/zz\n");
    const config = t.repo.read(".git/config");
    const out = t.pb(["build", "--force"], { cwd: worktree, code: 1 });
    expect(out.stderr).toContain("is really inside .git");
    expect(t.repo.read(".git/config")).toBe(config);
    expect(isSymlink(join(worktree, "skills/zz"))).toBe(true);
  });

  for (const [how, ignored] of [["an ignored", true], ["a visible", false]] as const) {
    for (const [where, file, target] of [["the repo root", "README.md", ".."], ["a sibling folder", "x.md", "../notes"]] as const) {
      vendorTest(`build never deletes through ${how} link to ${where}`, (t) => {
        t.missingScaffoldPatchBuild();
        t.repo.write("notes/x.md", "keep\n");
        t.repo.write(`skills/zz/${file}`, "stale\n");
        t.repo.commit("a file under skills/zz");
        rmSync(join(t.repo.path, "skills/zz"), { recursive: true });
        symlinkSync(target, join(t.repo.path, "skills/zz"));
        if (ignored) t.repo.write(".gitignore", "/skills/zz\n");
        const before = tree(t.repo.path);
        const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
        expect(out.stderr).toContain("really goes to");
        expect(out.stderr).toContain("outside the output folder");
        expect(tree(t.repo.path)).toEqual(before);
      });
    }
  }

  vendorTest("build refuses a dangling link in the output before changing anything", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.write("skills/old.md", "stale\n");
    t.repo.commit("a stale file");
    rmSync(join(t.repo.path, "skills/hello"), { recursive: true });
    symlinkSync("../.patchbook/nope", join(t.repo.path, "skills/hello"));
    t.repo.write(".gitignore", "/skills/hello\n");
    const before = tree(t.repo.path);
    const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("hello/SKILL.md is under hello, which is a link to nothing");
    expect(out.stderr).not.toContain("EEXIST");
    expect(tree(t.repo.path)).toEqual(before);
  });

  vendorTest("commit in a refused state records nothing", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.write("skills/d/retired.md", "hand\n");
    t.repo.commit("a file under skills/d");
    rmSync(join(t.repo.path, "skills/d"), { recursive: true });
    symlinkSync("../.patchbook", join(t.repo.path, "skills/d"));
    t.repo.write(".gitignore", "/skills/d\n");
    t.repo.write("skills/hello/SKILL.md", t.repo.read("skills/hello/SKILL.md").replaceAll("Then wave.", "Then bow."));
    const before = tree(t.repo.path);
    const commit = sh(["git", "commit", "-q", "--allow-empty", "-m", "edit"], { cwd: t.repo.path, check: false, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("is really inside .patchbook");
    expect(commit.stderr).not.toContain("fatal");
    expect(tree(t.repo.path)).toEqual(before);
  });

  vendorTest("commit refuses an output folder replaced by a link", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.commit("built");
    renameSync(join(t.repo.path, "skills/hello"), join(t.repo.path, "skills/hello.bak"));
    symlinkSync("../.patchbook", join(t.repo.path, "skills/hello"));
    sh(["git", "add", "-A"], { cwd: t.repo.path });
    const before = { files: tree(t.repo.path), staged: sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout };
    const commit = sh(["git", "commit", "-q", "--allow-empty", "-m", "link hello"], { cwd: t.repo.path, check: false, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("skills/hello is a link");
    expect(commit.stderr).toContain("skills/hello/SKILL.md");
    expect(commit.stderr).not.toContain("fatal");
    expect(tree(t.repo.path)).toEqual(before.files);
    expect(sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout).toBe(before.staged);
  });

  vendorTest("commit never writes the build through an output folder linked outside the repo", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.commit("built");
    const built = t.repo.read("skills/hello/SKILL.md");
    t.repo.write(".patchbook/snippets.md", "## greet\n\nSay hi in T3.\n");
    t.repo.write("skills/hello/SKILL.md", built.replace("Say hello in T3.", "Say hi in T3."));
    sh(["git", "add", "-A"], { cwd: t.repo.path });
    const outside = join(t.tmp, "outside-hello");
    renameSync(join(t.repo.path, "skills/hello"), outside);
    writeFileSync(join(outside, "SKILL.md"), built);
    symlinkSync(outside, join(t.repo.path, "skills/hello"));
    const head = sh(["git", "rev-parse", "HEAD"], { cwd: t.repo.path }).stdout;
    const commit = sh(["git", "commit", "-q", "-m", "say hi"], { cwd: t.repo.path, check: false, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain(`hello/SKILL.md really goes to ${realpathSync(join(outside, "SKILL.md"))}, outside the output folder. Nothing was changed.`);
    expect(read(join(outside, "SKILL.md"))).toBe(built);
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.repo.path }).stdout).toBe(head);
  });

  vendorTest("commit refuses an output folder replaced by a link before any build", (t) => {
    t.repo.write("skills/hello/SKILL.md", "tracked before the first build\n");
    t.repo.commit("existing output");
    rmSync(join(t.repo.path, "skills/hello"), { recursive: true });
    symlinkSync("../.patchbook", join(t.repo.path, "skills/hello"));
    sh(["git", "add", "-A"], { cwd: t.repo.path });
    const before = { files: tree(t.repo.path), staged: sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout };
    const commit = sh(["git", "commit", "-q", "--allow-empty", "-m", "link hello"], { cwd: t.repo.path, check: false, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("skills/hello is a link");
    expect(commit.stderr).toContain("skills/hello/SKILL.md");
    expect(tree(t.repo.path)).toEqual(before.files);
    expect(sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout).toBe(before.staged);
  });

  vendorTest("record in a refused state records nothing", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.write("skills/d/retired.md", "hand\n");
    t.repo.commit("a file under skills/d");
    rmSync(join(t.repo.path, "skills/d"), { recursive: true });
    symlinkSync("../.patchbook", join(t.repo.path, "skills/d"));
    t.repo.write(".gitignore", "/skills/d\n");
    t.repo.write("skills/hello/SKILL.md", t.repo.read("skills/hello/SKILL.md").replaceAll("Then wave.", "Then bow."));
    const before = tree(t.repo.path);
    const out = t.pb(["record"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("is really inside .patchbook");
    expect(tree(t.repo.path)).toEqual(before);
  });

  vendorTest("output folder cannot be under a file or a dangling link", (t) => {
    t.missingScaffoldPatchBuild();
    symlinkSync(".patchbook/nope", join(t.repo.path, "dangle"));
    for (const [to, why] of [
      ["README.md/out", "is under README.md, which is not a folder"],
      ["dangle/out", "is under dangle, which is a link to nothing"],
    ] as const) {
      setOutputFolder(t, to);
      const before = tree(t.repo.path);
      const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain(why);
      expect(out.stderr).not.toContain("ENOTDIR");
      expect(out.stderr).not.toContain("EEXIST");
      expect(tree(t.repo.path)).toEqual(before);
    }
  });

  test("init rejects an output folder under a file", () => {
    const t = new VendorCase();
    try {
      const repo = new Repo(join(t.tmp, "fresh"));
      repo.write("README.md", "mine\n");
      repo.commit("start");
      const out = t.pb(["init", "--upstream", t.up.path, "--output-to", "README.md/out"], { cwd: repo.path, code: 1 });
      expect(out.stderr).toContain("is under README.md, which is not a folder");
      expect(existsSync(join(repo.path, ".patchbook"))).toBe(false);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  vendorTest("absolute placeholder file is used as given", (t) => {
    const snippets = join(t.repo.path, "snippets.md");
    writeFileSync(snippets, t.repo.read(".patchbook/snippets.md"));
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replaceAll('file = ".patchbook/snippets.md"', `file = "${snippets}"`));
    t.missingScaffoldPatchBuild();
  });

  vendorTest("an [upstream] table that is not a list is rejected", (t) => {
    t.missingScaffoldPatchBuild();
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replaceAll('[[upstream]]\nname = "plugin"\n', "[upstream]\n"));
    expect(t.pb(["status"], { cwd: t.repo.path, code: 1 }).stderr).toContain("Use [[upstream]] with a name");
  });
});
