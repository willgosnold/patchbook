import { describe, expect } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Case, Repo, dedent, sh } from "../helpers";
import { read, isSymlink, isExecutable, ForkCase, forkTest, vendorTest, installManager } from "../e2e-fixtures.ts";

describe("ModeTest", () => {
  const hookCommit = (t: Case, repo: Repo, message: string, intent: string): void => {
    sh(["git", "commit", "-qam", message], { cwd: repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: intent } });
  };
  const lockLines = (t: ForkCase): string[] => read(join(t.fork.path, ".patchbook/build.lock")).split("\n").filter(Boolean);
  const changeText = (t: ForkCase, name: string): string => read(join(t.fork.path, ".patchbook/changes", name, "CHANGE.md"));
  const oursOf = (t: ForkCase, change: string, path: string): string => join(t.fork.path, ".patchbook/changes", change, "ours", `${path}.pb`);
  const NEW_LOCK_LINE = /^(100644|100755|120000) [0-9a-f]{40} \S/;

  const settled = (t: ForkCase): void => {
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout).toBe("");
  };

  forkTest("hook keeps a mode change in the fork layout", (t) => {
    chmodSync(join(t.fork.path, "app.txt"), 0o755);
    hookCommit(t, t.fork, "make it executable", "Make the app executable.");
    expect(isExecutable(join(t.fork.path, "app.txt"))).toBe(true);
    expect(sh(["git", "show", "--summary", "--format=", "HEAD"], { cwd: t.fork.path }).stdout).toContain("mode change 100644 => 100755 app.txt");
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout).toBe("");
    expect(changeText(t, "make-the-app-executable")).toContain("- file app.txt");
    t.pb(["build"], { cwd: t.fork.path });
    expect(isExecutable(join(t.fork.path, "app.txt"))).toBe(true);
    settled(t);
  });

  vendorTest("hook keeps a mode change in the folder layout", (t) => {
    t.missingScaffoldPatchBuild();
    t.up.write("plugin/skills/hello/notes.txt", "notes\n");
    t.up.commit("notes");
    t.pb(["sync"], { cwd: t.repo.path });
    t.pb(["build"], { cwd: t.repo.path });
    t.pb(["hook", "install"], { cwd: t.repo.path });
    sh(["git", "add", "-A"], { cwd: t.repo.path });
    sh(["git", "commit", "-qm", "built"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Built it." } });
    const notes = join(t.repo.path, "skills/hello/notes.txt");
    chmodSync(notes, 0o755);
    hookCommit(t, t.repo, "make it executable", "Make the notes executable.");
    expect(isExecutable(notes)).toBe(true);
    expect(sh(["git", "show", "--summary", "--format=", "HEAD"], { cwd: t.repo.path }).stdout).toContain("mode change 100644 => 100755 skills/hello/notes.txt");
    expect(sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout).toBe("");
    expect(read(join(t.repo.path, ".patchbook/changes/make-the-notes-executable/CHANGE.md"))).toContain("- file skills/hello/notes.txt");
    t.pb(["build"], { cwd: t.repo.path });
    expect(isExecutable(notes)).toBe(true);
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  forkTest("record of a mode change alone records a file edit", (t) => {
    chmodSync(join(t.fork.path, "app.txt"), 0o755);
    const out = t.pb(["record", "--intent", "Make the app executable."], { cwd: t.fork.path }).stdout;
    expect(out).toBe("make-the-app-executable: Make the app executable.\nfile     app.txt\n");
    expect(changeText(t, "make-the-app-executable")).toContain("- file app.txt");
    expect(readFileSync(oursOf(t, "make-the-app-executable", "app.txt"), "utf8")).toBe(t.fork.read("app.txt"));
    expect(isExecutable(oursOf(t, "make-the-app-executable", "app.txt"))).toBe(true);
    t.pb(["build"], { cwd: t.fork.path });
    expect(isExecutable(join(t.fork.path, "app.txt"))).toBe(true);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("record of a file made not executable records it", (t) => {
    chmodSync(join(t.fork.path, "bin/run.sh"), 0o644);
    t.pb(["record", "--intent", "Stop running the script."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    expect(isExecutable(join(t.fork.path, "bin/run.sh"))).toBe(false);
    expect(lockLines(t)).toContainEqual(expect.stringMatching(/^100644 [0-9a-f]{40} bin\/run\.sh$/));
  });

  forkTest("build treats a mode-only change as a hand edit", (t) => {
    chmodSync(join(t.fork.path, "app.txt"), 0o755);
    const refused = t.pb(["build"], { cwd: t.fork.path, code: 1 });
    expect(refused.stderr).toContain("these output files changed since the last build:\n  app.txt");
    expect(isExecutable(join(t.fork.path, "app.txt"))).toBe(true);
    t.pb(["build", "--force"], { cwd: t.fork.path });
    expect(isExecutable(join(t.fork.path, "app.txt"))).toBe(false);
  });

  const contentAndMode = (t: ForkCase, path: string, change: string): void => {
    const file = join(t.fork.path, path);
    t.fork.write(path, t.fork.read(path) + "more\n");
    chmodSync(file, 0o755);
    const out = t.pb(["record"], { cwd: t.fork.path }).stdout;
    expect(out).toContain(`(in ${change})`);
    expect(isExecutable(oursOf(t, change, path))).toBe(true);
    t.pb(["build"], { cwd: t.fork.path });
    expect(isExecutable(file)).toBe(true);
    expect(t.fork.read(path)).toContain("more\n");
    rmSync(file);
    t.pb(["build", "--force"], { cwd: t.fork.path });
    expect(isExecutable(file)).toBe(true);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  };

  forkTest("record keeps a mode change made with an edit to an added file", (t) => {
    t.fork.write("tool.sh", "echo one\n");
    t.pb(["record", "--intent", "Add a tool."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    contentAndMode(t, "tool.sh", "add-a-tool");
  });

  forkTest("record keeps a mode change made with an edit to a replaced file", (t) => {
    const dir = join(t.fork.path, ".patchbook/changes/rep");
    mkdirSync(join(dir, "ours/docs"), { recursive: true });
    writeFileSync(join(dir, "CHANGE.md"), "# rep\n\nintent: Replace the guide.\n\nedits:\n- replace docs/guide.md\n");
    writeFileSync(join(dir, "ours/docs/guide.md.pb"), "replaced\n");
    writeFileSync(join(t.fork.path, ".patchbook/series"), "rep\n");
    t.pb(["build"], { cwd: t.fork.path });
    contentAndMode(t, "docs/guide.md", "rep");
  });

  forkTest("record keeps a mode change made with an edit to an owned file", (t) => {
    t.recordFeature();
    contentAndMode(t, "app.txt", "feature");
  });

  forkTest("sync keeps a recorded mode", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    chmodSync(join(t.fork.path, "app.txt"), 0o755);
    t.pb(["record", "shout", "--intent", "Shout the second line."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("record");
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("seven", "SEVEN"));
    t.up.commit("upstream edits the last line");
    t.pb(["sync"], { cwd: t.fork.path });
    expect(isExecutable(oursOf(t, "shout", "app.txt"))).toBe(true);
    t.pb(["build"], { cwd: t.fork.path });
    const app = join(t.fork.path, "app.txt");
    expect(isExecutable(app)).toBe(true);
    expect(t.fork.read("app.txt")).toContain("TWO");
    expect(t.fork.read("app.txt")).toContain("SEVEN");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  vendorTest("record skips a mode change to a file with block entries", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    const before = read(entries);
    const skill = join(t.repo.path, "skills/hello/SKILL.md");
    chmodSync(skill, 0o755);
    const out = t.pb(["record", "--intent", "Run the skill."], { cwd: t.repo.path }).stdout;
    expect(out).toBe(
      "skipped  hello/SKILL.md: block entries hold no mode, so the mode change was not recorded; "
      + "to set it, make your finish hook in .patchbook/hooks.ts run out.get(\"hello/SKILL.md\")!.mode = 0o755;\n",
    );
    expect(read(entries)).toBe(before);
    writeFileSync(join(t.repo.path, ".patchbook/hooks.ts"), dedent(`
      export const finish = (out: Map<string, { data: Uint8Array; mode: number }>) => { out.get("hello/SKILL.md")!.mode = 0o755; };
    `));
    t.pb(["build"], { cwd: t.repo.path });
    expect(isExecutable(skill)).toBe(true);
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  vendorTest("record of an edit and a mode change to a file with block entries records the entries", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    const skill = join(t.repo.path, "skills/hello/SKILL.md");
    t.repo.write("skills/hello/SKILL.md", t.repo.read("skills/hello/SKILL.md").replaceAll("Then wave.", "Then wave twice."));
    chmodSync(skill, 0o755);
    const out = t.pb(["record", "--intent", "Wave twice."], { cwd: t.repo.path }).stdout;
    expect(out).toMatch(/^entry {4}hello\/SKILL\.md \[[0-9a-f]{12}\] added\n/);
    expect(out).toContain("skipped  hello/SKILL.md: block entries hold no mode, so the mode change was not recorded;");
    expect(read(entries)).toContain("Then wave twice.");
    t.pb(["build", "--force"], { cwd: t.repo.path });
    expect(t.repo.read("skills/hello/SKILL.md")).toContain("Then wave twice.");
  });

  vendorTest("record without file modes of an edit and a chmod to a file with block entries has no mode note", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    sh(["git", "config", "core.fileMode", "false"], { cwd: t.repo.path });
    const skill = join(t.repo.path, "skills/hello/SKILL.md");
    t.repo.write("skills/hello/SKILL.md", t.repo.read("skills/hello/SKILL.md").replaceAll("Then wave.", "Then wave twice."));
    chmodSync(skill, 0o755);
    const out = t.pb(["record", "--intent", "Wave twice."], { cwd: t.repo.path }).stdout;
    expect(out).toMatch(/^entry {4}hello\/SKILL\.md \[[0-9a-f]{12}\] added\n$/);
    expect(out).not.toContain("mode change was not recorded");
    expect(read(entries)).toContain("Then wave twice.");
  });

  forkTest("build.lock holds the mode of each built file", (t) => {
    symlinkSync("app.txt", join(t.fork.path, "link"));
    t.pb(["record", "link", "--intent", "Link to the app."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    const lines = lockLines(t);
    expect(lines.every((l) => NEW_LOCK_LINE.test(l))).toBe(true);
    const oid = (path: string): string => sh(["git", "hash-object", path], { cwd: t.fork.path }).stdout.trim();
    expect(lines).toContain(`100644 ${oid("app.txt")} app.txt`);
    expect(lines).toContain(`100755 ${oid("bin/run.sh")} bin/run.sh`);
    sh(["git", "add", "link"], { cwd: t.fork.path });
    const linkOid = sh(["git", "ls-files", "-s", "link"], { cwd: t.fork.path }).stdout.split(/\s+/)[1];
    expect(lines.filter((l) => l.endsWith(" link"))).toEqual([`120000 ${linkOid} link`]);
  });

  const oldLock = (t: ForkCase): void => {
    const path = join(t.fork.path, ".patchbook/build.lock");
    writeFileSync(path, lockLines(t).map((l) => l.replace(/^\d{6} /, "") + "\n").join(""));
  };

  forkTest("an old-format build.lock still reads", (t) => {
    t.recordFeature();
    oldLock(t);
    expect(lockLines(t).some((l) => NEW_LOCK_LINE.test(l))).toBe(false);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toContain("no hand edits");
    const ours = join(t.fork.path, ".patchbook/changes/feature/ours/app.txt.pb");
    writeFileSync(ours, read(ours).replaceAll("TWO", "Two"));
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("app.txt")).toContain("Two");
  });

  forkTest("an old-format build.lock still counts a content change as a hand edit", (t) => {
    t.recordFeature();
    oldLock(t);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("TWO", "Two"));
    const refused = t.pb(["build"], { cwd: t.fork.path, code: 1 });
    expect(refused.stderr).toContain("app.txt");
    expect(refused.stderr).not.toContain("bin/run.sh");
  });

  forkTest("the build after an old-format build.lock writes the new format", (t) => {
    t.recordFeature();
    oldLock(t);
    t.pb(["build"], { cwd: t.fork.path });
    const lines = lockLines(t);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => NEW_LOCK_LINE.test(l))).toBe(true);
    chmodSync(join(t.fork.path, "app.txt"), 0o755);
    t.pb(["record", "--intent", "Make the app executable."], { cwd: t.fork.path });
    expect(lockLines(t)).toContainEqual(expect.stringMatching(/^100755 [0-9a-f]{40} app\.txt$/));
  });

  forkTest("a file edit recorded before modes keeps the upstream mode", (t) => {
    const dir = join(t.fork.path, ".patchbook/changes/old");
    mkdirSync(join(dir, "base/bin"), { recursive: true });
    mkdirSync(join(dir, "ours/bin"), { recursive: true });
    writeFileSync(join(dir, "CHANGE.md"), "# old\n\nintent: Say more.\n\nedits:\n- file bin/run.sh\n");
    writeFileSync(join(dir, "base/bin/run.sh.pb"), "#!/bin/sh\necho run\n");
    writeFileSync(join(dir, "ours/bin/run.sh.pb"), "#!/bin/sh\necho run more\n");
    expect(isExecutable(join(dir, "ours/bin/run.sh.pb"))).toBe(false);
    writeFileSync(join(t.fork.path, ".patchbook/series"), "old\n");
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("bin/run.sh")).toContain("echo run more");
    expect(isExecutable(join(t.fork.path, "bin/run.sh"))).toBe(true);
    expect(lockLines(t)).toContainEqual(expect.stringMatching(/^100755 [0-9a-f]{40} bin\/run\.sh$/));
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("record of a content edit to an executable keeps it executable and follows upstream", (t) => {
    t.fork.write("bin/run.sh", "#!/bin/sh\necho run more\n", 0o755);
    t.pb(["record", "--intent", "Say more."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    expect(isExecutable(join(t.fork.path, "bin/run.sh"))).toBe(true);
    t.fork.commit("record");
    chmodSync(join(t.up.path, "bin/run.sh"), 0o644);
    t.up.commit("upstream stops running it");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    expect(isExecutable(join(t.fork.path, "bin/run.sh"))).toBe(false);
  });

  forkTest("sync carries an upstream mode change to a file edit", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "--intent", "Shout the second line."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("record");
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("seven", "SEVEN"), 0o755);
    t.up.commit("upstream edits the last line and makes it executable");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("app.txt")).toContain("TWO");
    expect(t.fork.read("app.txt")).toContain("SEVEN");
    expect(isExecutable(join(t.fork.path, "app.txt"))).toBe(true);
    t.fork.commit("sync");
    chmodSync(join(t.up.path, "app.txt"), 0o644);
    t.up.commit("upstream stops making it executable");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    expect(isExecutable(join(t.fork.path, "app.txt"))).toBe(false);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("record of a retargeted upstream symlink keeps it a symlink", (t) => {
    symlinkSync("app.txt", join(t.up.path, "link"));
    t.up.commit("link");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("link");
    const link = join(t.fork.path, "link");
    unlinkSync(link);
    symlinkSync("docs/guide.md", link);
    t.pb(["record", "--intent", "Point the link at the guide."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    expect(readlinkSync(link)).toBe("docs/guide.md");
    t.fork.commit("retarget");
    unlinkSync(link);
    symlinkSync("bin/run.sh", link);
    hookCommit(t, t.fork, "retarget again", "Point the link at the script.");
    expect(readlinkSync(link)).toBe("bin/run.sh");
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout).toBe("");
    t.pb(["build"], { cwd: t.fork.path });
    expect(readlinkSync(link)).toBe("bin/run.sh");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  const baseBuilt = (t: ForkCase, files: Record<string, [text: string, mode: number]>): void => {
    for (const [path, [text, mode]] of Object.entries(files)) {
      writeFileSync(join(t.fork.path, path), text);
      chmodSync(join(t.fork.path, path), mode);
    }
    const out = sh(["git", "ls-files"], { cwd: t.fork.path }).stdout.split("\n").filter((p) => p && !p.startsWith(".patchbook/"));
    const oid = (p: string): string => sh(["git", "hash-object", p], { cwd: t.fork.path }).stdout.trim();
    writeFileSync(join(t.fork.path, ".patchbook/build.lock"), out.map((p) => `${oid(p)} ${p}\n`).join(""));
  };
  const replaceCopy = (t: ForkCase, path: string, text: string): void => {
    const dir = join(t.fork.path, ".patchbook/changes/rep");
    mkdirSync(dirname(join(dir, "ours", `${path}.pb`)), { recursive: true });
    writeFileSync(join(dir, "CHANGE.md"), `# rep\n\nintent: Replace it.\n\nedits:\n- replace ${path}\n`);
    writeFileSync(join(dir, "ours", `${path}.pb`), text);
    chmodSync(join(dir, "ours", `${path}.pb`), 0o644);
    writeFileSync(join(t.fork.path, ".patchbook/series"), "rep\n");
  };
  const emptyHookCommit = (t: ForkCase): void => {
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    sh(["git", "commit", "-q", "--allow-empty", "-m", "hook"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Hook it." } });
  };

  forkTest("a replace made before modes still builds at upstream's mode", (t) => {
    replaceCopy(t, "bin/run.sh", "#!/bin/sh\necho replaced\n");
    baseBuilt(t, { "bin/run.sh": ["#!/bin/sh\necho replaced\n", 0o755] });
    t.pb(["build"], { cwd: t.fork.path });
    expect(isExecutable(join(t.fork.path, "bin/run.sh"))).toBe(true);
    emptyHookCommit(t);
    expect(isExecutable(join(t.fork.path, "bin/run.sh"))).toBe(true);
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout).toBe("");
    expect(t.fork.read("bin/run.sh")).toContain("replaced");
  });

  forkTest("a replace made before modes keeps a mode recorded after it", (t) => {
    replaceCopy(t, "bin/run.sh", "#!/bin/sh\necho replaced\n");
    baseBuilt(t, { "bin/run.sh": ["#!/bin/sh\necho replaced\n", 0o755] });
    t.pb(["build"], { cwd: t.fork.path });
    expect(isExecutable(join(t.fork.path, "bin/run.sh"))).toBe(true);
    chmodSync(join(t.fork.path, "bin/run.sh"), 0o644);
    t.pb(["record", "--intent", "Stop running it."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    expect(isExecutable(join(t.fork.path, "bin/run.sh"))).toBe(false);
    emptyHookCommit(t);
    expect(isExecutable(join(t.fork.path, "bin/run.sh"))).toBe(false);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("a replace made before modes over a plain file stays plain", (t) => {
    replaceCopy(t, "docs/guide.md", "replaced\n");
    chmodSync(join(t.fork.path, ".patchbook/changes/rep/ours/docs/guide.md.pb"), 0o755);
    baseBuilt(t, { "docs/guide.md": ["replaced\n", 0o644] });
    t.pb(["build"], { cwd: t.fork.path });
    expect(isExecutable(join(t.fork.path, "docs/guide.md"))).toBe(false);
    emptyHookCommit(t);
    expect(isExecutable(join(t.fork.path, "docs/guide.md"))).toBe(false);
    chmodSync(join(t.fork.path, "docs/guide.md"), 0o755);
    t.pb(["record", "--intent", "Run the guide."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    expect(isExecutable(join(t.fork.path, "docs/guide.md"))).toBe(true);
  });

  forkTest("an old-format build.lock does not hide a mode change", (t) => {
    t.recordFeature();
    oldLock(t);
    const extra = join(t.fork.path, "extra.txt");
    chmodSync(extra, 0o755);
    expect(t.pb(["build"], { cwd: t.fork.path, code: 1 }).stderr).toContain("these output files changed since the last build:\n  extra.txt");
    expect(isExecutable(extra)).toBe(true);
    sh(["git", "commit", "-qam", "run it"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Run extra." } });
    expect(isExecutable(extra)).toBe(true);
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout).toBe("");
    expect(sh(["git", "show", "--summary", "--format=", "HEAD"], { cwd: t.fork.path }).stdout).toContain("mode change 100644 => 100755 extra.txt");
    t.pb(["build"], { cwd: t.fork.path });
    expect(isExecutable(extra)).toBe(true);
    expect(lockLines(t)).toContainEqual(expect.stringMatching(/^100755 [0-9a-f]{40} extra\.txt$/));
  });

  forkTest("a file edit made before modes builds a mode recorded after it", (t) => {
    const dir = join(t.fork.path, ".patchbook/changes/old");
    mkdirSync(join(dir, "base/bin"), { recursive: true });
    mkdirSync(join(dir, "ours/bin"), { recursive: true });
    writeFileSync(join(dir, "CHANGE.md"), "# old\n\nintent: Say more.\n\nedits:\n- file bin/run.sh\n");
    writeFileSync(join(dir, "base/bin/run.sh.pb"), "#!/bin/sh\necho run\n");
    writeFileSync(join(dir, "ours/bin/run.sh.pb"), "#!/bin/sh\necho run more\n");
    writeFileSync(join(t.fork.path, ".patchbook/series"), "old\n");
    t.pb(["build"], { cwd: t.fork.path });
    expect(isExecutable(join(t.fork.path, "bin/run.sh"))).toBe(true);
    chmodSync(join(t.fork.path, "bin/run.sh"), 0o644);
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe("file     bin/run.sh (in old)\nintent   old: Shout the second line.\n");
    t.pb(["build"], { cwd: t.fork.path });
    expect(isExecutable(join(t.fork.path, "bin/run.sh"))).toBe(false);
    expect(t.fork.read("bin/run.sh")).toContain("echo run more");
    emptyHookCommit(t);
    expect(isExecutable(join(t.fork.path, "bin/run.sh"))).toBe(false);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("record of a deleted replace output drops the base copy a mode change wrote", (t) => {
    replaceCopy(t, "docs/guide.md", "replaced\n");
    t.pb(["build"], { cwd: t.fork.path });
    const guide = join(t.fork.path, "docs/guide.md");
    chmodSync(guide, 0o755);
    t.pb(["record", "--intent", "Run the guide."], { cwd: t.fork.path });
    const rep = join(t.fork.path, ".patchbook/changes/rep");
    expect(existsSync(join(rep, "base/docs/guide.md.pb"))).toBe(true);
    t.pb(["build"], { cwd: t.fork.path });
    rmSync(guide);
    t.pb(["record", "--intent", "Drop the guide."], { cwd: t.fork.path });
    expect(sh(["find", ".", "-type", "f"], { cwd: rep }).stdout.trim()).toBe("./CHANGE.md");
    t.pb(["build"], { cwd: t.fork.path });
    expect(existsSync(guide)).toBe(false);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });
});

describe("ExecBitTest", () => {
  type Bit = 0o644 | 0o755;
  type Cell = { path: "hook" | "record" | "install"; fileMode: "true" | "false"; edit: boolean; bit: Bit; owner: "change" | "upstream" };

  const commit = (t: ForkCase, message: string, intent: string, args: string[] = []): void => {
    sh(["git", "commit", "-q", "-m", message, ...args], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: intent } });
  };
  const git = (t: ForkCase, ...args: string[]): string => sh(["git", ...args], { cwd: t.fork.path }).stdout;
  const setFileMode = (t: ForkCase, on: "true" | "false"): void => void git(t, "config", "core.fileMode", on);
  const headMode = (t: ForkCase, path: string): string => git(t, "ls-tree", "HEAD", "--", path).split(" ")[0]!;
  const porcelain = (t: ForkCase): string => git(t, "status", "--porcelain");
  const gitMode = (bit: Bit): string => (bit === 0o755 ? "100755" : "100644");
  const bitOf = (p: string): Bit => (isExecutable(p) ? 0o755 : 0o644);
  const headCopy = (t: ForkCase, path: string): { mode: string; at: string } => {
    const line = git(t, "ls-tree", "-r", "HEAD", "--", ".patchbook/changes").split("\n").find((l) => l.endsWith(`/ours/${path}.pb`)) ?? "";
    return { mode: line.split(" ")[0]!, at: line.split("\t")[1] ?? "" };
  };
  const freshBuild = (t: ForkCase): string => {
    const fresh = join(t.tmp, "fresh");
    sh(["git", "clone", "-q", t.fork.path, fresh], { cwd: t.tmp });
    sh(["git", "config", "core.fileMode", "true"], { cwd: fresh });
    t.pb(["build", "--force"], { cwd: fresh });
    return fresh;
  };

  const cell = (t: ForkCase, c: Cell): void => {
    const from: Bit = c.bit === 0o755 ? 0o644 : 0o755;
    const file = c.path === "install" ? ".husky/pre-commit" : c.owner === "change" ? "mine.sh" : from === 0o755 ? "bin/run.sh" : "app.txt";
    const disk = join(t.fork.path, file);
    if (c.owner === "change") {
      t.fork.write(file, "echo one\n", from);
      git(t, "add", file);
      commit(t, "add the script", "Add the script.");
    }
    setFileMode(t, c.fileMode);
    if (c.edit) appendFileSync(disk, "echo two\n");
    chmodSync(disk, c.bit);
    if (c.path === "hook") {
      git(t, "add", file);
      if (c.fileMode === "false") git(t, "update-index", `--chmod=${c.bit === 0o755 ? "+" : "-"}x`, file);
      commit(t, "change the script", "Change the script.");
    } else if (c.path === "record") {
      expect(t.pb(["record", "--intent", "Change the script."], { cwd: t.fork.path }).stdout).toContain(file);
      t.pb(["build"], { cwd: t.fork.path });
      expect(bitOf(disk)).toBe(c.bit);
      git(t, "add", "-A");
      commit(t, "record the script", "Record the script.");
    } else {
      installManager(t.fork, ".husky");
      t.pb(["hook", "install"], { cwd: t.fork.path });
      commit(t, "hook install", "Stage the hook.");
    }
    expect(headMode(t, file)).toBe(gitMode(c.bit));
    expect(porcelain(t)).toBe("");
    setFileMode(t, "true");
    t.pb(["build"], { cwd: t.fork.path });
    expect(bitOf(disk)).toBe(c.bit);
    expect(porcelain(t)).toBe("");
    expect(bitOf(join(freshBuild(t), file))).toBe(c.bit);
  };

  const BITS = [[0o755, "a program bit"], [0o644, "a plain bit"]] as const;
  const EDITS = [[true, "with an edit"], [false, "alone"]] as const;
  const OWNERS = [["change", "on a file we added"], ["upstream", "on an upstream file"]] as const;
  for (const [bit, bitName] of BITS) {
    for (const [edit, editName] of EDITS) {
      for (const [owner, ownerName] of OWNERS) {
        for (const fileMode of ["true", "false"] as const) {
          forkTest(`commit with file modes ${fileMode} records ${bitName} ${editName} ${ownerName}`, (t) => cell(t, { path: "hook", fileMode, edit, bit, owner }));
        }
        forkTest(`record with file modes true records ${bitName} ${editName} ${ownerName}`, (t) => cell(t, { path: "record", fileMode: "true", edit, bit, owner }));
      }
      forkTest(`hook install with file modes true takes the disk bit ${bitName} ${editName} on a script we added`, (t) =>
        cell(t, { path: "install", fileMode: "true", edit, bit, owner: "change" }));
    }
  }

  forkTest("hook install with file modes false keeps the exec bit of a script we added through the next build", (t) => {
    const script = join(t.fork.path, ".husky/pre-commit");
    setFileMode(t, "false");
    t.fork.write(".husky/pre-commit", "echo checks\n", 0o755);
    git(t, "add", ".husky/pre-commit");
    git(t, "update-index", "--chmod=+x", ".husky/pre-commit");
    commit(t, "add husky script", "Add the pre-commit script.");
    expect(headMode(t, ".husky/pre-commit")).toBe("100755");
    expect(headCopy(t, ".husky/pre-commit").mode).toBe("100755");
    chmodSync(script, 0o644);
    writeFileSync(script, "echo checks --run\n");
    installManager(t.fork, ".husky");
    t.pb(["hook", "install"], { cwd: t.fork.path });
    commit(t, "husky script edit", "Edit the pre-commit script.");
    expect(headMode(t, ".husky/pre-commit")).toBe("100755");
    expect(headCopy(t, ".husky/pre-commit").mode).toBe("100755");
    setFileMode(t, "true");
    t.pb(["build", "--force"], { cwd: t.fork.path });
    expect(isExecutable(script)).toBe(true);
    expect(porcelain(t)).toBe("");
    expect(bitOf(join(freshBuild(t), ".husky/pre-commit"))).toBe(0o755);
  });

  forkTest("commit with file modes false commits a new program and its copy at 755", (t) => {
    setFileMode(t, "false");
    t.fork.write("new.sh", "echo new\n", 0o755);
    git(t, "add", "new.sh");
    git(t, "update-index", "--chmod=+x", "new.sh");
    commit(t, "add new.sh", "Add a program.");
    expect(headMode(t, "new.sh")).toBe("100755");
    expect(headCopy(t, "new.sh").mode).toBe("100755");
    expect(bitOf(join(freshBuild(t), "new.sh"))).toBe(0o755);
  });

  const upstreamProgram = (t: ForkCase): void => {
    setFileMode(t, "false");
    t.up.write("new.sh", "echo up\n", 0o755);
    t.up.commit("add new.sh");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    git(t, "add", "-A");
  };

  forkTest("commit with file modes false commits a program from upstream at 755", (t) => {
    upstreamProgram(t);
    commit(t, "take upstream", "Take upstream.");
    expect(headMode(t, "new.sh")).toBe("100755");
    expect(existsSync(join(t.fork.path, ".patchbook/changes"))).toBe(false);
  });

  forkTest("commit with file modes false puts back an upstream program committed at 644 and leaves its unstaged work", (t) => {
    upstreamProgram(t);
    sh(["git", "commit", "-q", "-m", "take upstream"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } });
    expect(headMode(t, "new.sh")).toBe("100644");
    appendFileSync(join(t.fork.path, "new.sh"), "echo wip\n");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    git(t, "add", "app.txt");
    commit(t, "shout", "Shout the second line.");
    expect(headMode(t, "new.sh")).toBe("100755");
    expect(git(t, "show", "HEAD:new.sh")).toBe("echo up\n");
    expect(porcelain(t)).toBe(" M new.sh\n");
  });

  forkTest("commit of named paths with file modes false commits a program from upstream at 755", (t) => {
    upstreamProgram(t);
    commit(t, "take upstream", "Take upstream.", ["--", "new.sh", ".patchbook"]);
    expect(headMode(t, "new.sh")).toBe("100755");
    expect(git(t, "ls-files", "-s", "new.sh")).toStartWith("100755 ");
  });

  for (const fileMode of ["true", "false"] as const) {
    forkTest(`commit with file modes ${fileMode} records an executable file over a link we added at its committed bit`, (t) => {
      setFileMode(t, fileMode);
      symlinkSync("app.txt", join(t.fork.path, "link"));
      git(t, "add", "link");
      commit(t, "add the link", "Add the link.");
      unlinkSync(join(t.fork.path, "link"));
      t.fork.write("link", "run\n", 0o755);
      git(t, "add", "link");
      if (fileMode === "false") git(t, "update-index", "--chmod=+x", "link");
      commit(t, "make the link a program", "Make the link a program.");
      expect(headMode(t, "link")).toBe("100755");
      const fresh = freshBuild(t);
      expect(isSymlink(join(fresh, "link"))).toBe(false);
      expect(bitOf(join(fresh, "link"))).toBe(0o755);
    });
  }

  forkTest("commit with file modes false leaves the committed mode of a copy it did not write", (t) => {
    t.fork.write("new.sh", "echo new\n", 0o755);
    git(t, "add", "new.sh");
    commit(t, "add new.sh", "Add a program.");
    const copy = headCopy(t, "new.sh");
    expect(copy.mode).toBe("100755");
    setFileMode(t, "false");
    chmodSync(join(t.fork.path, copy.at), 0o644);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    git(t, "add", "app.txt");
    commit(t, "shout", "Shout the second line.");
    expect(headCopy(t, "new.sh").mode).toBe("100755");
  });

  forkTest("commit after a manual record with file modes false commits the chosen bit", (t) => {
    setFileMode(t, "false");
    git(t, "update-index", "--chmod=+x", "app.txt");
    t.pb(["record", "--intent", "Run the app."], { cwd: t.fork.path });
    git(t, "add", "-A");
    commit(t, "run the app", "Run the app.");
    expect(headMode(t, "app.txt")).toBe("100755");
    expect(headCopy(t, "app.txt").mode).toBe("100755");
    expect(bitOf(join(freshBuild(t), "app.txt"))).toBe(0o755);
  });

  forkTest("hook install that cannot record keeps a hook script that is only staged", (t) => {
    installManager(t.fork, ".husky");
    t.fork.write(".husky/pre-commit", "echo mine\n", 0o755);
    git(t, "add", ".husky/pre-commit");
    rmSync(join(t.fork.path, ".husky/pre-commit"));
    mkdirSync(join(t.fork.path, ".patchbook/changes/patchbook-hook"), { recursive: true });
    t.pb(["hook", "install"], { cwd: t.fork.path, code: 1 });
    expect(git(t, "show", ":.husky/pre-commit")).toBe("echo mine\n");
  });

  for (const [file, own, bitName] of [["app.txt", 0o755, "a program bit"], ["bin/run.sh", 0o644, "a plain bit"]] as const) {
    forkTest(`commit after a manual record with file modes false puts ${bitName} back to upstream's`, (t) => {
      const up: Bit = own === 0o755 ? 0o644 : 0o755;
      chmodSync(join(t.fork.path, file), own);
      git(t, "add", file);
      commit(t, "own the bit", "Own the bit.");
      expect(headCopy(t, file).mode).toBe(gitMode(own));
      setFileMode(t, "false");
      git(t, "update-index", `--chmod=${up === 0o755 ? "+" : "-"}x`, file);
      t.pb(["record", "--intent", "Take upstream's bit."], { cwd: t.fork.path });
      git(t, "add", "-A");
      commit(t, "take upstream's bit", "Take upstream's bit.");
      expect(headMode(t, file)).toBe(gitMode(up));
      expect(headCopy(t, file).mode).toBe(gitMode(up));
      expect(bitOf(join(freshBuild(t), file))).toBe(up);
    });
  }
});
