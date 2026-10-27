import { describe, expect } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Repo, permissionTest, sh } from "../helpers";
import { read, lockPin, ForkCase, forkTest } from "../e2e-fixtures.ts";

describe("ReadOnlyLockTest", () => {
  const upstreamLock = (t: ForkCase) => join(t.fork.path, ".patchbook/upstream.lock");
  const refused = (lock: string) => `patchbook: couldn't write ${realpathSync(lock)}: permission denied\n`;

  permissionTest("sync names the lock when it cannot write it", (t) => {
    const lock = upstreamLock(t);
    t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
    const head = t.up.commit("upstream edit");
    const before = read(lock);
    sh(["chmod", "a-w", lock], { cwd: t.fork.path });
    try {
      expect(t.pb(["sync"], { cwd: t.fork.path, code: 1 }).stderr).toBe(refused(lock));
    } finally {
      sh(["chmod", "u+w", lock], { cwd: t.fork.path });
    }
    expect(read(lock)).toBe(before);
    t.pb(["sync"], { cwd: t.fork.path });
    expect(lockPin(read(lock), "upstream").commit).toBe(head);
  }, ForkCase);

  permissionTest("track names the lock when it cannot write it and can be retried", (t) => {
    const lock = upstreamLock(t);
    const lib = new Repo(join(t.tmp, "lib"));
    lib.write("a.txt", "lib\n");
    const commit = lib.commit("lib");
    const config = join(t.fork.path, ".patchbook/config.toml");
    const before = read(config);
    sh(["chmod", "a-w", lock], { cwd: t.fork.path });
    try {
      expect(t.pb(["track", "lib", lib.path], { cwd: t.fork.path, code: 1 }).stderr).toBe(refused(lock));
    } finally {
      sh(["chmod", "u+w", lock], { cwd: t.fork.path });
    }
    expect(read(config)).toBe(before);
    t.pb(["track", "lib", lib.path], { cwd: t.fork.path });
    expect(lockPin(read(lock), "lib").commit).toBe(commit);
  }, ForkCase);

  permissionTest("init names the lock when it cannot write it and can be retried", (t) => {
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    const lock = join(repo.path, ".patchbook/upstream.lock");
    mkdirSync(join(repo.path, ".patchbook"));
    writeFileSync(lock, '{\n  "version": 1,\n  "upstreams": []\n}\n');
    sh(["chmod", "a-w", lock], { cwd: repo.path });
    const init = ["init", "--upstream", t.up.path, "--output-from", "", "--output-to", "out"];
    try {
      expect(t.pb(init, { cwd: repo.path, code: 1 }).stderr).toBe(refused(lock));
    } finally {
      sh(["chmod", "u+w", lock], { cwd: repo.path });
    }
    expect(existsSync(join(repo.path, ".patchbook/config.toml"))).toBe(false);
    t.pb(init, { cwd: repo.path });
    expect(lockPin(read(lock), "upstream").commit).toMatch(/^[0-9a-f]{40}$/);
  }, ForkCase);
});

describe("RecordRollbackTest", () => {
  const hookCommit = (t: ForkCase, env: Record<string, string> = {}) => {
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    return sh(["git", "commit", "-qm", "edit"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", ...env }, check: false });
  };

  const patchbookFingerprint = (t: ForkCase): string[] => {
    const root = join(t.fork.path, ".patchbook");
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        const stat = lstatSync(path);
        const mode = (stat.mode & 0o7777).toString(8);
        if (stat.isDirectory()) {
          found.push(`${relative(root, path)}/ ${mode}`);
          walk(path);
        } else found.push(`${relative(root, path)} ${mode} ${new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex")}`);
      }
    };
    walk(root);
    return found;
  };

  const changeFile = (t: ForkCase, name: string): string => join(t.fork.path, ".patchbook/changes", name, "CHANGE.md");

  const shouted = (t: ForkCase): void => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    t.pb(["record", "shout", "--intent", "Shout the second line."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("shout");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("three", "THREE"));
  };

  const READ_ONLY = 0o444;

  const asReadOnly = (before: string[], path: string): string[] =>
    before.map((line) => (line.startsWith(`${path} `) ? line.replace(/^(\S+) \d+ /, `$1 ${READ_ONLY.toString(8)} `) : line));

  const readOnly = (path: string, body: () => void): void => {
    const mode = statSync(path).mode & 0o7777;
    chmodSync(path, READ_ONLY);
    try {
      body();
    } finally {
      chmodSync(path, mode);
    }
  };

  forkTest("record retried after a failed change write keeps the new intent", (t) => {
    if (process.getuid?.() === 0) return;
    shouted(t);
    readOnly(changeFile(t, "shout"), () => {
      t.pb(["record", "shout", "--intent", "New intent."], { cwd: t.fork.path, code: 1 });
    });
    const retry = t.pb(["record", "shout", "--intent", "New intent."], { cwd: t.fork.path });
    expect(retry.stdout).toBe("file     app.txt\n");
    expect(read(changeFile(t, "shout"))).toContain("intent: New intent.");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("record leaves the patchbook as it was when a change write fails", (t) => {
    if (process.getuid?.() === 0) return;
    shouted(t);
    const before = patchbookFingerprint(t);
    readOnly(changeFile(t, "shout"), () => {
      t.pb(["record", "shout", "--intent", "New intent."], { cwd: t.fork.path, code: 1 });
      expect(patchbookFingerprint(t)).toEqual(asReadOnly(before, "changes/shout/CHANGE.md"));
    });
  });

  forkTest("hook leaves the patchbook as it was when a change write fails and records on the retry", (t) => {
    if (process.getuid?.() === 0) return;
    shouted(t);
    const before = patchbookFingerprint(t);
    readOnly(changeFile(t, "shout"), () => {
      const failed = hookCommit(t);
      expect(failed.code).not.toBe(0);
      expect(failed.stderr).not.toContain("file     app.txt");
      expect(patchbookFingerprint(t)).toEqual(asReadOnly(before, "changes/shout/CHANGE.md"));
    });
    const retried = hookCommit(t);
    expect(retried.code).toBe(0);
    expect(retried.stderr).toContain("file     app.txt");
    expect(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: t.fork.path }).stdout).toContain(".patchbook/changes/shout/ours/app.txt.pb");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("record leaves the patchbook as it was when the series cannot be written", (t) => {
    if (process.getuid?.() === 0) return;
    t.fork.write("extra.txt", "ours\n");
    const series = join(t.fork.path, ".patchbook/series");
    const before = patchbookFingerprint(t);
    readOnly(series, () => {
      t.pb(["record", "extra", "--intent", "Add extra."], { cwd: t.fork.path, code: 1 });
      expect(patchbookFingerprint(t)).toEqual(asReadOnly(before, "series"));
    });
    const retry = t.pb(["record", "extra", "--intent", "Add extra."], { cwd: t.fork.path });
    expect(retry.stdout).toBe("add      extra.txt\n");
    expect(read(series)).toBe("extra\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("record leaves the patchbook as it was when the build.lock cannot be written", (t) => {
    if (process.getuid?.() === 0) return;
    shouted(t);
    const before = patchbookFingerprint(t);
    const lock = join(t.fork.path, ".patchbook/build.lock");
    readOnly(lock, () => {
      t.pb(["record", "shout", "--intent", "New intent."], { cwd: t.fork.path, code: 1 });
      expect(patchbookFingerprint(t)).toEqual(asReadOnly(before, "build.lock"));
    });
    t.pb(["record", "shout", "--intent", "New intent."], { cwd: t.fork.path });
    expect(read(changeFile(t, "shout"))).toContain("intent: New intent.");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("record that fails prints no note of what it saved", (t) => {
    if (process.getuid?.() === 0) return;
    shouted(t);
    t.fork.write("extra.txt", "ours\n");
    readOnly(changeFile(t, "shout"), () => {
      const failed = t.pb(["record", "shout", "--intent", "New intent."], { cwd: t.fork.path, code: 1 });
      expect(failed.stdout).toBe("");
    });
    readOnly(join(t.fork.path, ".patchbook/build.lock"), () => {
      const failed = t.pb(["record", "shout", "--intent", "New intent."], { cwd: t.fork.path, code: 1 });
      expect(failed.stdout).toBe("");
    });
  });

  forkTest("record names the files it cannot put back and then the original error", (t) => {
    if (process.getuid?.() === 0) return;
    t.fork.write("extra.txt", "ours\n");
    const book = join(t.fork.path, ".patchbook");
    mkdirSync(join(book, "changes"), { recursive: true });
    chmodSync(join(book, "build.lock"), READ_ONLY);
    chmodSync(book, 0o555);
    try {
      const failed = t.pb(["record", "extra", "--intent", "Add extra."], { cwd: t.fork.path, code: 1 });
      expect(failed.stdout).toBe("");
      expect(failed.stderr).toMatch(/couldn't put these back as they were:\n {2}\S+\/\.patchbook\/series\n/);
      expect(failed.stderr.indexOf("permission denied")).toBeGreaterThan(failed.stderr.indexOf("couldn't put these back"));
    } finally {
      chmodSync(book, 0o755);
    }
  });

  forkTest("hook names the files it cannot put back once", (t) => {
    if (process.getuid?.() === 0) return;
    t.fork.write("extra.txt", "ours\n");
    const book = join(t.fork.path, ".patchbook");
    mkdirSync(join(book, "changes"), { recursive: true });
    chmodSync(join(book, "build.lock"), READ_ONLY);
    chmodSync(book, 0o555);
    try {
      const failed = hookCommit(t, { PATCHBOOK_INTENT: "Add extra." });
      expect(failed.code).not.toBe(0);
      expect(failed.stderr.match(/couldn't put these back as they were:\n {2}\S+\/\.patchbook\/series\n/g)).toHaveLength(1);
      expect(failed.stderr).toContain("permission denied");
    } finally {
      chmodSync(book, 0o755);
    }
  });

  forkTest("record puts back a copy it deleted when the build.lock cannot be written", (t) => {
    if (process.getuid?.() === 0) return;
    t.fork.write("extra.txt", "ours\n");
    t.pb(["record", "extra", "--intent", "Add extra."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("extra");
    t.fork.rm("extra.txt");
    const before = patchbookFingerprint(t);
    expect(before.some((line) => line.startsWith("changes/extra/ours/extra.txt.pb "))).toBe(true);
    readOnly(join(t.fork.path, ".patchbook/build.lock"), () => {
      t.pb(["record", "extra"], { cwd: t.fork.path, code: 1 });
      expect(patchbookFingerprint(t)).toEqual(asReadOnly(before, "build.lock"));
    });
    t.pb(["record", "extra"], { cwd: t.fork.path });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });
});
