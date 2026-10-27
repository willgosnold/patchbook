import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Case, Repo, TIMEOUT, sh } from "../helpers";
import { read, ForkCase, forkTest, committedFiles, initFork } from "../e2e-fixtures.ts";

describe("MergeTest", () => {
  const ATTRIBUTES = "series merge=union\nbuild.lock merge=union\n";
  const attributesOf = (repo: Repo): string => repo.read(".patchbook/.gitattributes");
  const lockPath = (t: ForkCase): string => join(t.fork.path, ".patchbook/build.lock");
  const seriesPath = (t: ForkCase): string => join(t.fork.path, ".patchbook/series");
  const git = (t: ForkCase, args: string[], check = true) => sh(["git", ...args], { cwd: t.fork.path, check });
  const conflicted = (ours: string, theirs: string): string => `<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> b2\n`;

  /** Two branches off main that each record a change, the second one next to the first in build.lock. */
  const twoBranches = (t: ForkCase): void => {
    git(t, ["switch", "-qc", "b1"]);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "shout", "--intent", "Shout the second line."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("b1");
    git(t, ["switch", "-q", "main"]);
    git(t, ["switch", "-qc", "b2"]);
    t.fork.write("app2.txt", "second\n");
    t.pb(["record", "second", "--intent", "Add app2.txt."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("b2");
    git(t, ["switch", "-q", "main"]);
  };

  forkTest("clone writes .patchbook/.gitattributes into the first commit, and no root .gitattributes", (t) => {
    expect(attributesOf(t.fork)).toBe(ATTRIBUTES);
    expect(git(t, ["ls-tree", "-r", "--name-only", "HEAD"]).stdout.split("\n")).toContain(".patchbook/.gitattributes");
    expect(existsSync(join(t.fork.path, ".gitattributes"))).toBe(false);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  test("init writes .patchbook/.gitattributes in both layouts", () => {
    const t = new Case();
    try {
      const mine = initFork(t);
      expect(attributesOf(mine)).toBe(ATTRIBUTES);
      expect(existsSync(join(mine.path, ".gitattributes"))).toBe(false);
      const up = new Repo(join(t.tmp, "upstream"));
      const adapted = new Repo(join(t.tmp, "adapted"));
      adapted.write("README.md", "mine\n");
      adapted.commit("start");
      t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: adapted.path });
      expect(attributesOf(adapted)).toBe(ATTRIBUTES);
      expect(t.pb(["status"], { cwd: adapted.path }).stdout).toContain("no problems");
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  forkTest("branches that each record a change merge without a conflict, and the next build rewrites build.lock", (t) => {
    twoBranches(t);
    git(t, ["merge", "-q", "b1"]);
    const merged = git(t, ["merge", "b2", "-m", "merge b2"], false);
    expect(merged.stdout + merged.stderr).not.toContain("CONFLICT");
    expect(merged.code).toBe(0);
    expect(read(seriesPath(t)).split("\n").filter(Boolean)).toEqual(["shout", "second"]);
    const paths = (): string[] => read(lockPath(t)).split("\n").filter(Boolean).map((l) => l.replace(/^(?:\d{6} )?[0-9a-f]{40} /, ""));
    expect(paths()).toContain("app2.txt");
    expect(new Set(paths()).size).toBeLessThan(paths().length); // the union keeps both sides' line for app.txt
    t.pb(["build"], { cwd: t.fork.path });
    expect(new Set(paths()).size).toBe(paths().length);
    expect(t.fork.read("app.txt")).toContain("TWO");
    expect(t.fork.read("app2.txt")).toBe("second\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("status reports a build.lock with merge conflict markers, and build rewrites it", (t) => {
    const lock = read(lockPath(t));
    writeFileSync(lockPath(t), conflicted(lock, lock));
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout;
    expect(status).toContain("conflict  build.lock: has merge conflict markers; run `patchbook build` to rewrite it\n");
    expect(status).toContain("1 conflict");
    const json = JSON.parse(t.pb(["status", "--json"], { cwd: t.fork.path, code: 1 }).stdout).problems;
    expect(json).toEqual([{ problem: "conflict", file: "build.lock", detail: "has merge conflict markers; run `patchbook build` to rewrite it" }]);
    t.pb(["build"], { cwd: t.fork.path });
    expect(read(lockPath(t))).toBe(lock);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("build refuses a hand edit even when build.lock has merge conflict markers", (t) => {
    const lock = read(lockPath(t));
    writeFileSync(lockPath(t), conflicted(lock, lock));
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    expect(t.pb(["build"], { cwd: t.fork.path, code: 1 }).stderr).toContain("app.txt");
  });

  forkTest("status reports a series with merge conflict markers once, not a bad name for each marker line", (t) => {
    t.recordFeature();
    writeFileSync(seriesPath(t), conflicted("feature\n", "other\n"));
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout;
    expect(status).toContain("conflict  series: has a merge conflict; keep both sides' change names, then run `patchbook build`\n");
    expect(status).not.toContain("valid change name");
    expect(status.match(/has a merge conflict/g)).toHaveLength(1);
    const refused = t.pb(["build"], { cwd: t.fork.path, code: 1 });
    expect(refused.stderr).toContain("has a merge conflict; keep both sides' change names");
    expect(refused.stderr).not.toContain("valid change name");
  });

  forkTest("the hook refuses a commit while series has merge conflict markers", (t) => {
    t.recordFeature();
    writeFileSync(seriesPath(t), conflicted("feature\n", "other\n"));
    git(t, ["add", "-A"]);
    const run = sh(["git", "commit", "-qm", "conflicted"], { cwd: t.fork.path, check: false, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("refusing this commit: series has a merge conflict");
    expect(run.stderr).not.toContain("valid change name");
  });

  forkTest("build adds a missing .patchbook/.gitattributes once, and the next hook commit stages it", (t) => {
    git(t, ["rm", "-q", ".patchbook/.gitattributes"]);
    t.fork.commit("an older fork");
    const first = t.pb(["build"], { cwd: t.fork.path });
    expect(first.stderr).toContain("patchbook: added .patchbook/.gitattributes, so branches that each record a change merge without a conflict");
    expect(attributesOf(t.fork)).toBe(ATTRIBUTES);
    expect(t.pb(["build"], { cwd: t.fork.path }).stderr).not.toContain(".gitattributes");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    git(t, ["add", "app.txt"]);
    sh(["git", "commit", "-qm", "shout"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Shout the second line." } });
    expect(committedFiles(t.fork)).toContain(".patchbook/.gitattributes");
    expect(existsSync(join(t.fork.path, ".gitattributes"))).toBe(false);
  });

  forkTest("build --commit commits a missing .patchbook/.gitattributes", (t) => {
    git(t, ["rm", "-q", ".patchbook/.gitattributes"]);
    t.fork.commit("an older fork");
    t.pb(["build", "--commit"], { cwd: t.fork.path });
    expect(git(t, ["ls-tree", "-r", "--name-only", "HEAD"]).stdout.split("\n")).toContain(".patchbook/.gitattributes");
  });

  forkTest("build keeps a .gitattributes in .patchbook that is already there", (t) => {
    writeFileSync(join(t.fork.path, ".patchbook/.gitattributes"), "series merge=union\n");
    const built = t.pb(["build"], { cwd: t.fork.path });
    expect(attributesOf(t.fork)).toBe("series merge=union\n");
    expect(built.stderr).not.toContain(".gitattributes");
  });
});
