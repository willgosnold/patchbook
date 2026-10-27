import { describe, expect } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Case, fakeClaude, sh } from "../helpers";
import { read, tree, ForkCase, VendorCase, forkTest, vendorTest } from "../e2e-fixtures.ts";

describe("IntentWithoutAModelTest", () => {
  type Failure = "missing" | "missing with provider" | "exit" | "unusable" | "timeout";
  const FAILURES: readonly (readonly [Failure, string])[] = [
    ["missing", "no claude or codex CLI found"],
    ["missing with provider", "the claude CLI isn't installed"],
    ["exit", "claude failed: fake claude: offline"],
    ["unusable", "claude didn't return a usable name and intent"],
    ["timeout", "claude took longer than 1s"],
  ];

  const breakModel = (t: Case, kind: Failure): (() => void) => {
    const claude = join(t.tmp, "bin/claude");
    const path = t.env["PATH"];
    delete t.env["PATCHBOOK_PROVIDER"];
    if (kind === "missing" || kind === "missing with provider") {
      rmSync(claude);
      t.env["PATH"] = (path ?? "").split(":").filter((d) => !existsSync(join(d, "claude")) && !existsSync(join(d, "codex"))).join(":");
      if (kind === "missing with provider") t.env["PATCHBOOK_PROVIDER"] = "claude";
    } else {
      const body = {
        exit: "echo 'fake claude: offline' >&2\nexit 1",
        unusable: "echo 'I cannot help with that.'",
        timeout: `sleep 3\necho '{"change": "slow", "intent": "Too late."}'`,
      }[kind];
      writeFileSync(claude, `#!/bin/sh\ncat > /dev/null\n${body}\n`);
      if (kind === "timeout") t.env["PATCHBOOK_INTENT_TIMEOUT"] = "1";
    }
    return () => {
      t.env["PATH"] = path ?? "";
      delete t.env["PATCHBOOK_PROVIDER"];
      delete t.env["PATCHBOOK_INTENT_TIMEOUT"];
      writeFileSync(claude, fakeClaude(t.tmp));
      chmodSync(claude, 0o755);
    };
  };

  const hookCommit = (t: ForkCase) => {
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    return sh(["git", "commit", "-qm", "edit"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "" }, check: false });
  };
  const changeText = (t: ForkCase, name: string): string => read(join(t.fork.path, ".patchbook/changes", name, "CHANGE.md"));
  const changeNames = (t: ForkCase): string[] => readdirSync(join(t.fork.path, ".patchbook/changes")).sort();
  const committed = (t: ForkCase): string => sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: t.fork.path }).stdout;

  const note = (name: string, why: string): string => `intent   by patchbook for ${name} (${why}). To replace it, run \`patchbook intent ${name}\` or edit its line to \`intent: <yours>\`\n`;

  const expectByPatchbook = (t: ForkCase, name: string, intent: string): void => {
    expect(changeText(t, name)).toContain(`\nintent (by patchbook): ${intent}\n`);
    expect(read(join(t.fork.path, ".patchbook/series")).split("\n")).toContain(name);
    expect(changeNames(t).filter((n) => n !== name)).not.toContain("pending");
    const status = t.pb(["status"], { cwd: t.fork.path }).stdout;
    expect(status).toContain(`note      changes/${name}: patchbook wrote its intent from the edits. To replace it, run \`patchbook intent ${name}\` or edit its line to \`intent: <yours>\`\n`);
    expect(status).toContain("no problems");
    expect(t.pb(["build"], { cwd: t.fork.path }).stdout).toContain("built");
  };

  for (const [kind, why] of FAILURES) {
    forkTest(`hook commits with patchbook's intent and rebuilds when the model is ${kind}`, (t) => {
      breakModel(t, kind);
      t.fork.write("extra.txt", "ours\n");
      const run = hookCommit(t);
      expect(run.code).toBe(0);
      expect(run.stderr).toContain(`intent   by patchbook for add-extra-txt (${why}`);
      expect(run.stderr).toContain("To replace it, run `patchbook intent add-extra-txt` or edit its line to `intent: <yours>`\n");
      expect(run.stderr).not.toContain("wasn't rebuilt");
      expect(committed(t)).toContain("extra.txt");
      expect(committed(t)).toContain(".patchbook/changes/add-extra-txt/CHANGE.md");
      expect(changeText(t, "add-extra-txt")).toContain("- add extra.txt");
      expectByPatchbook(t, "add-extra-txt", "Adds extra.txt.");
    });

    forkTest(`record writes patchbook's intent when the model is ${kind}`, (t) => {
      breakModel(t, kind);
      t.fork.write("extra.txt", "ours\n");
      const run = t.pb(["record"], { cwd: t.fork.path });
      expect(run.stdout).toMatch(new RegExp(`^add-extra-txt: Adds extra\\.txt\\.\\nadd      extra\\.txt\\nintent   by patchbook for add-extra-txt \\(${why}[^\\n]*\\)\\. `
        + "To replace it, run `patchbook intent add-extra-txt` or edit its line to `intent: <yours>`\\n$"));
      expect(changeText(t, "add-extra-txt")).toContain("- add extra.txt");
      expectByPatchbook(t, "add-extra-txt", "Adds extra.txt.");
    });
  }

  forkTest("record writes patchbook's intent for a rename and an edit when the model fails", (t) => {
    breakModel(t, "exit");
    sh(["git", "mv", "docs", "guide"], { cwd: t.fork.path });
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    const run = t.pb(["record"], { cwd: t.fork.path });
    expect(run.stdout).toStartWith("edit-app-txt: Edits app.txt. Renames docs to guide.\n");
    expect(changeText(t, "edit-app-txt")).toContain("- file app.txt\n- move docs -> guide\n");
    expectByPatchbook(t, "edit-app-txt", "Edits app.txt. Renames docs to guide.");
  });

  forkTest("record names patchbook's change from its edits, clear of the other names, and never joins an existing change", (t) => {
    t.recordFeature();
    t.fork.write("other.txt", "other\n");
    t.pb(["record", "add-more-txt", "--intent", "Ship other.txt."], { cwd: t.fork.path });
    breakModel(t, "exit");
    const feature = changeText(t, "feature");
    t.fork.write("more.txt", "more\n");
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toStartWith("add-more-txt-2: Adds more.txt.\n");
    expect(changeNames(t)).toEqual(["add-more-txt", "add-more-txt-2", "feature"]);
    expect(changeText(t, "feature")).toBe(feature);
    expect(changeText(t, "add-more-txt")).toContain("intent: Ship other.txt.\n");
    expect(changeText(t, "add-more-txt-2")).toContain("- add more.txt");
  });

  forkTest("record keeps a given name and writes patchbook's intent", (t) => {
    breakModel(t, "exit");
    t.fork.write("extra.txt", "ours\n");
    const run = t.pb(["record", "mine"], { cwd: t.fork.path });
    expect(run.stdout).toBe("mine: Adds extra.txt.\nadd      extra.txt\n" + note("mine", "claude failed: fake claude: offline"));
    expectByPatchbook(t, "mine", "Adds extra.txt.");
  });

  forkTest("record writes patchbook's intent again for a change it adds to while the model still fails", (t) => {
    breakModel(t, "exit");
    t.fork.write("extra.txt", "ours\n");
    t.pb(["record"], { cwd: t.fork.path });
    t.fork.write("more.txt", "more\n");
    const run = t.pb(["record", "add-extra-txt"], { cwd: t.fork.path });
    expect(run.stdout).toBe("add      more.txt\nintent   add-extra-txt: Adds extra.txt and more.txt.\n" + note("add-extra-txt", "claude failed: fake claude: offline"));
    expectByPatchbook(t, "add-extra-txt", "Adds extra.txt and more.txt.");
  });

  forkTest("record does not call the model for an edit that needs neither a name nor an intent", (t) => {
    t.recordFeature();
    const ran = join(t.tmp, "model-ran");
    writeFileSync(join(t.tmp, "bin/claude"), `#!/bin/sh\ntouch ${ran}\ncat > /dev/null\necho 'fake claude: offline' >&2\nexit 1\n`);
    t.fork.rm("extra.txt");
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe("unadd    extra.txt (from feature)\n");
    expect(existsSync(ran)).toBe(false);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("record with a given intent does not call the model", (t) => {
    breakModel(t, "exit");
    t.fork.write("extra.txt", "ours\n");
    t.pb(["record", "--intent", "Ship extra.txt."], { cwd: t.fork.path });
    expect(changeText(t, "ship-extra-txt")).toContain("intent: Ship extra.txt.");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  for (const [what, picked, said, rewrote] of [
    ["a new name", "louder", "louder: Make it louder.\n", ""],
    ["an existing change", "feature", "adding to feature\n", "intent   feature: Make it louder.\n"],
  ] as const) {
    forkTest(`record with a working model prints the line for ${what}`, (t) => {
      t.recordFeature();
      writeFileSync(join(t.tmp, "bin/claude"), `#!/bin/sh\ncat > /dev/null\necho '{"change": "${picked}", "intent": "Make it louder."}'\n`);
      t.fork.write("more.txt", "more\n");
      expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe(said + "add      more.txt\n" + rewrote);
    });

    forkTest(`hook with a working model prints the line for ${what}`, (t) => {
      t.recordFeature();
      writeFileSync(join(t.tmp, "bin/claude"), `#!/bin/sh\ncat > /dev/null\necho '{"change": "${picked}", "intent": "Make it louder."}'\n`);
      t.fork.write("more.txt", "more\n");
      const run = hookCommit(t);
      expect(run.code).toBe(0);
      expect(run.stderr).toContain(said + "add      more.txt\n" + rewrote);
    });
  }

  forkTest("record writes patchbook's intent again for a change it takes an edit out of", (t) => {
    breakModel(t, "exit");
    t.fork.write("extra.txt", "ours\n");
    t.fork.write("more.txt", "more\n");
    t.pb(["record"], { cwd: t.fork.path });
    expect(changeText(t, "add-extra-txt")).toContain("\nintent (by patchbook): Adds extra.txt and more.txt.\n");
    t.fork.rm("more.txt");
    const run = t.pb(["record"], { cwd: t.fork.path });
    expect(run.stdout).toBe("unadd    more.txt (from add-extra-txt)\nintent   add-extra-txt: Adds extra.txt.\nintent   by patchbook for add-extra-txt. "
      + "To replace it, run `patchbook intent add-extra-txt` or edit its line to `intent: <yours>`\n");
    expectByPatchbook(t, "add-extra-txt", "Adds extra.txt.");
  });

  forkTest("a change with no intent, as 0.0.1 left pending, stays a problem until a record adds to it with no model", (t) => {
    breakModel(t, "exit");
    t.fork.write("more.txt", "more\n");
    t.pb(["record", "pending"], { cwd: t.fork.path });
    writeFileSync(join(t.fork.path, ".patchbook/changes/pending/CHANGE.md"), "# pending\n\nintent:\n\nedits:\n- add more.txt\n");
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain("changes/pending: it has no intent; fill it with `patchbook intent pending`");
    t.fork.write("more.txt", "more and more\n");
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toContain("intent   by patchbook for pending (claude failed: fake claude: offline). ");
    expectByPatchbook(t, "pending", "Adds more.txt.");
  });

  forkTest("hook commits with patchbook's intent when the model CLI is found but cannot start", (t) => {
    writeFileSync(join(t.tmp, "bin/claude"), "#!/nonexistent/interp\n");
    t.fork.write("extra.txt", "ours\n");
    const run = hookCommit(t);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("intent   by patchbook for add-extra-txt (the claude CLI can't start: ");
    expect(run.stderr).toContain("To replace it, run `patchbook intent add-extra-txt` or edit its line to `intent: <yours>`\n");
    expectByPatchbook(t, "add-extra-txt", "Adds extra.txt.");
  });

  forkTest("a timed-out model leaves none of its children running", (t) => {
    const pidFile = join(t.tmp, "child.pid");
    writeFileSync(join(t.tmp, "bin/claude"), `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}\nsleep 30\n`);
    t.env["PATCHBOOK_INTENT_TIMEOUT"] = "1";
    t.fork.write("extra.txt", "ours\n");
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toContain("claude took longer than 1s");
    const pid = Number(read(pidFile).trim());
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 20 && alive(); i++) Bun.sleepSync(100);
    expect(alive()).toBe(false);
  });

  forkTest("a model that picks a change with patchbook's intent writes it", (t) => {
    breakModel(t, "exit");
    t.fork.write("more.txt", "more\n");
    t.pb(["record"], { cwd: t.fork.path });
    delete t.env["PATCHBOOK_PROVIDER"];
    writeFileSync(join(t.tmp, "bin/claude"), `#!/bin/sh\ncat > /dev/null\necho '{"change": "add-more-txt", "intent": "Ship more files."}'\n`);
    chmodSync(join(t.tmp, "bin/claude"), 0o755);
    t.fork.write("third.txt", "third\n");
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe("adding to add-more-txt\nadd      third.txt\nintent   add-more-txt: Ship more files.\n");
    expect(changeText(t, "add-more-txt")).toContain("\nintent: Ship more files.\n");
    expect(changeText(t, "add-more-txt")).toContain("- add third.txt");
    const status = t.pb(["status"], { cwd: t.fork.path }).stdout;
    expect(status).toContain("no problems");
    expect(status).not.toContain("note");
  });

  describe("provider none", () => {
    const marker = (t: Case): string => {
      const file = join(t.tmp, "model-ran");
      writeFileSync(join(t.tmp, "bin/claude"), `#!/bin/sh\ntouch ${file}\necho '{"change": "x", "intent": "y"}'\n`);
      return file;
    };

    forkTest("record with provider none writes patchbook's intent without calling the model", (t) => {
      const ran = marker(t);
      t.env["PATCHBOOK_PROVIDER"] = "none";
      t.fork.write("extra.txt", "ours\n");
      const run = t.pb(["record"], { cwd: t.fork.path });
      expect(run.stdout).toBe("add-extra-txt: Adds extra.txt.\nadd      extra.txt\n" + note("add-extra-txt", "intent.provider is none"));
      expect(existsSync(ran)).toBe(false);
      expectByPatchbook(t, "add-extra-txt", "Adds extra.txt.");
    });

    forkTest("hook with provider none in the project config commits with patchbook's intent", (t) => {
      const ran = marker(t);
      t.pb(["config", "--project", "intent.provider", "none"], { cwd: t.fork.path });
      t.fork.write("extra.txt", "ours\n");
      const run = hookCommit(t);
      expect(run.code).toBe(0);
      expect(run.stderr).toContain(note("add-extra-txt", "intent.provider is none"));
      expect(existsSync(ran)).toBe(false);
      expectByPatchbook(t, "add-extra-txt", "Adds extra.txt.");
    });

    forkTest("config accepts none for the provider", (t) => {
      expect(t.pb(["config", "intent.provider", "none"], { cwd: t.fork.path }).stdout).toContain('intent.provider = "none"');
      expect(t.pb(["config", "intent.provider"], { cwd: t.fork.path }).stdout).toMatch(/^intent\.provider\s+"none"\s+user$/m);
      t.pb(["config", "intent.provider", "gemini"], { cwd: t.fork.path, code: 1 });
    });

    forkTest("intent with provider none and no intent given fails and writes nothing", (t) => {
      breakModel(t, "exit");
      t.fork.write("extra.txt", "ours\n");
      t.pb(["record"], { cwd: t.fork.path });
      t.env["PATCHBOOK_PROVIDER"] = "none";
      const before = tree(t.fork.path);
      expect(t.pb(["intent", "add-extra-txt"], { cwd: t.fork.path, code: 1 }).stderr).toContain("intent.provider is none");
      expect(tree(t.fork.path)).toEqual(before);
    });
  });

  describe("intent.timeout", () => {
    forkTest("config shows the default timeout and where a set one comes from", (t) => {
      expect(t.pb(["config", "intent.timeout"], { cwd: t.fork.path }).stdout).toMatch(/^intent\.timeout\s+60\s+default$/m);
      t.env["PATCHBOOK_INTENT_TIMEOUT"] = "5";
      expect(t.pb(["config", "intent.timeout"], { cwd: t.fork.path }).stdout).toMatch(/^intent\.timeout\s+5\s+env$/m);
      delete t.env["PATCHBOOK_INTENT_TIMEOUT"];
      t.pb(["config", "--project", "intent.timeout", "2.5"], { cwd: t.fork.path });
      expect(t.pb(["config", "intent.timeout"], { cwd: t.fork.path }).stdout).toMatch(/^intent\.timeout\s+2\.5\s+project$/m);
    });

    forkTest("a timeout that is not a positive number of seconds is refused", (t) => {
      for (const bad of ["abc", "0", "-3", ""]) {
        if (bad) expect(t.pb(["config", "intent.timeout", "--", bad], { cwd: t.fork.path, code: 1 }).stderr).toContain("intent.timeout is a positive number of seconds");
      }
      t.env["PATCHBOOK_INTENT_TIMEOUT"] = "soon";
      expect(t.pb(["config", "intent.timeout"], { cwd: t.fork.path, code: 1 }).stderr).toContain('intent.timeout is a positive number of seconds, not "soon"');
    });

    forkTest("a timeout that is not a whole number of milliseconds still calls the model", (t) => {
      t.env["PATCHBOOK_INTENT_TIMEOUT"] = "2.01";
      t.fork.write("extra.txt", "ours\n");
      expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe("shout: Shout the second line.\nadd      extra.txt\n");
    });

    forkTest("a model that ignores SIGTERM is still stopped at the timeout", (t) => {
      writeFileSync(join(t.tmp, "bin/claude"), `#!/bin/sh\ntrap '' TERM\nsleep 3\n`);
      t.env["PATCHBOOK_INTENT_TIMEOUT"] = "1";
      t.fork.write("extra.txt", "ours\n");
      const started = Date.now();
      expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toContain("claude took longer than 1s");
      expect(Date.now() - started).toBeLessThan(2500);
    });

    forkTest("a slow model is stopped at the timeout and the edits are recorded", (t) => {
      breakModel(t, "timeout");
      t.fork.write("extra.txt", "ours\n");
      const started = Date.now();
      t.pb(["record"], { cwd: t.fork.path });
      expect(Date.now() - started).toBeLessThan(2500);
      expect(changeNames(t)).toEqual(["add-extra-txt"]);
    });
  });

  describe("patchbook intent", () => {
    const byPatchbook = (t: ForkCase, kind: Failure = "exit", file = "more.txt"): (() => void) => {
      const restore = breakModel(t, kind);
      t.fork.write(file, "more\n");
      t.pb(["record"], { cwd: t.fork.path });
      return restore;
    };
    const clean = (t: ForkCase): void => {
      expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
      expect(t.pb(["build"], { cwd: t.fork.path }).stdout).toContain("built");
    };

    forkTest("intent replaces patchbook's intent with a given one and keeps the name", (t) => {
      byPatchbook(t);
      const run = t.pb(["intent", "add-more-txt", "--intent", "Ship more.txt."], { cwd: t.fork.path });
      expect(run.stdout).toBe("intent   add-more-txt: Ship more.txt.\n");
      expect(changeText(t, "add-more-txt")).toContain("\nintent: Ship more.txt.\n");
      expect(changeNames(t)).toEqual(["add-more-txt"]);
      clean(t);
    });

    forkTest("intent replaces patchbook's intent with the model's over its edits", (t) => {
      byPatchbook(t)();
      const run = t.pb(["intent", "add-more-txt"], { cwd: t.fork.path });
      expect(run.stdout).toBe("intent   add-more-txt: Shout the second line.\n");
      expect(changeText(t, "add-more-txt")).toContain("\nintent: Shout the second line.\n");
      expect(changeNames(t)).toEqual(["add-more-txt"]);
      const prompt = read(join(t.tmp, "prompt.txt"));
      expect(prompt).toContain("more.txt");
      expect(prompt).toContain('For "add-more-txt": write its intent,');
      clean(t);
    });

    forkTest("intent with no name fills every change that patchbook or no one wrote the intent of, and leaves the others", (t) => {
      t.recordFeature();
      const feature = changeText(t, "feature");
      const restore = byPatchbook(t);
      t.fork.write("third.txt", "third\n");
      t.pb(["record"], { cwd: t.fork.path });
      restore();
      mkdirSync(join(t.fork.path, ".patchbook/changes/blank"), { recursive: true });
      writeFileSync(join(t.fork.path, ".patchbook/changes/blank/CHANGE.md"), "# blank\n\nintent:\n\nedits:\n");
      appendFileSync(join(t.fork.path, ".patchbook/series"), "blank\n");
      const run = t.pb(["intent"], { cwd: t.fork.path });
      expect(run.stdout).toBe("intent   add-more-txt: Shout the second line.\nintent   add-third-txt: Shout the second line.\nintent   blank: Shout the second line.\n");
      expect(changeText(t, "feature")).toBe(feature);
      expect(changeNames(t)).toEqual(["add-more-txt", "add-third-txt", "blank", "feature"]);
      clean(t);
    });

    forkTest("intent with a failing model exits 1 and writes nothing", (t) => {
      for (const kind of ["exit", "unusable", "timeout", "missing with provider"] as const) {
        const restore = byPatchbook(t, kind, `${kind}.txt`);
        const before = tree(t.fork.path);
        const run = t.pb(["intent"], { cwd: t.fork.path, code: 1 });
        expect(run.stdout).toBe("");
        expect(run.stderr).toContain("patchbook: ");
        expect(tree(t.fork.path)).toEqual(before);
        expect(t.pb(["intent", `add-${kind.replaceAll(" ", "-")}-txt`], { cwd: t.fork.path, code: 1 }).stderr).toContain("patchbook: ");
        expect(tree(t.fork.path)).toEqual(before);
        restore();
        t.pb(["intent"], { cwd: t.fork.path });
        t.pb(["build"], { cwd: t.fork.path });
        t.fork.commit(`after ${kind}`);
      }
    });

    forkTest("intent with a failing model for the second change writes neither", (t) => {
      const restore = byPatchbook(t);
      t.fork.write("third.txt", "third\n");
      t.pb(["record"], { cwd: t.fork.path });
      restore();
      writeFileSync(join(t.tmp, "bin/claude"), `#!/bin/sh\ncat > /dev/null\nif [ -f ${t.tmp}/called ]; then echo nope >&2; exit 1; fi\ntouch ${t.tmp}/called\necho '{"change": null, "intents": {"add-more-txt": "First.", "add-third-txt": "First."}}'\n`);
      const before = tree(t.fork.path);
      t.pb(["intent"], { cwd: t.fork.path, code: 1 });
      expect(tree(t.fork.path)).toEqual(before);
    });

    forkTest("intent never touches an intent that someone wrote", (t) => {
      t.recordFeature();
      const before = tree(t.fork.path);
      const filled = t.pb(["intent", "feature", "--intent", "Other."], { cwd: t.fork.path, code: 1 });
      expect(filled.stderr).toContain("patchbook: feature already has an intent");
      const none = t.pb(["intent"], { cwd: t.fork.path });
      expect(none.stdout).toBe("no intent is empty or by patchbook; nothing to fill\n");
      expect(existsSync(join(t.tmp, "prompt.txt"))).toBe(false);
      expect(tree(t.fork.path)).toEqual(before);
    });

    forkTest("intent for a change that does not exist fails", (t) => {
      const run = t.pb(["intent", "nosuch", "--intent", "X."], { cwd: t.fork.path, code: 1 });
      expect(run.stderr).toBe("patchbook: no change called nosuch\n");
      expect(t.pb(["intent", "Bad_Name"], { cwd: t.fork.path, code: 1 }).stderr).toContain("isn't a valid change name");
    });

    forkTest("intent help describes the command", (t) => {
      expect(t.pb(["--help"], { cwd: t.fork.path }).stdout).toContain("fill empty intents and replace the ones patchbook wrote");
      const help = t.pb(["intent", "--help"], { cwd: t.fork.path }).stdout;
      expect(help).toContain("usage: patchbook intent [<change>] [options]");
    });
  });

  describe("block entries", () => {
    const edit = (t: VendorCase): string => {
      const entries = t.missingScaffoldPatchBuild();
      t.repo.write("skills/hello/SKILL.md", t.repo.read("skills/hello/SKILL.md").replaceAll("Then wave.", "Then wave twice."));
      return entries;
    };
    const LABEL = "hello\\/SKILL\\.md \\[[0-9a-f]{12}\\]";
    const wrote = (what: string): string => `intent \\(by patchbook\\): ${what}`;
    const REWRITES_WAVE = 'Rewrites the paragraph that starts "Then wave\\." in hello\\/SKILL\\.md\\.';
    const status = (t: VendorCase) => t.pb(["status"], { cwd: t.repo.path }).stdout;
    const NOTE = /note {6}skills\/hello\/SKILL\.md \[[0-9a-f]{12}\]: patchbook wrote its intent from the paragraph edit\. To replace it, run `patchbook intent` or edit its line to `intent: <yours>`\n/;
    const expectBuilds = (t: VendorCase): void => {
      expect(t.pb(["status", "--json"], { cwd: t.repo.path }).stdout).toContain('"problems": []');
      t.pb(["build"], { cwd: t.repo.path });
      expect(t.repo.read("skills/hello/SKILL.md")).toContain("Then wave twice.");
    };

    for (const [kind, why] of FAILURES) {
      vendorTest(`record gives a new paragraph entry an intent patchbook wrote when the model is ${kind}`, (t) => {
        const entries = edit(t);
        breakModel(t, kind);
        const run = t.pb(["record"], { cwd: t.repo.path });
        expect(run.stdout).toMatch(new RegExp(`^entry    ${LABEL} added\\nintent   by patchbook for ${LABEL} \\(${why}[^\\n]*\\)\\. To replace it, run \`patchbook intent\` or edit its line to \`intent: <yours>\`\\n$`));
        expect(existsSync(join(t.repo.path, ".patchbook/changes"))).toBe(false);
        expect(read(entries)).toMatch(new RegExp(`kind: policy\\nrules: \\n${wrote(REWRITES_WAVE)}\\n--- upstream\\nThen wave\\.\\n--- patched\\nThen wave twice\\.\\n`));
        expect(read(entries)).toContain("intent: Speak T3.\n");
        expect(status(t)).toMatch(NOTE);
        expect(status(t)).toEndWith("no problems\n");
        expectBuilds(t);
      });
    }

    vendorTest("hook commits a paragraph entry with an intent patchbook wrote when the model fails", (t) => {
      const entries = edit(t);
      breakModel(t, "exit");
      sh(["git", "add", "-A"], { cwd: t.repo.path });
      const run = sh(["git", "commit", "-qm", "wave"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "" }, check: false });
      expect(run.code).toBe(0);
      expect(run.stderr).toMatch(new RegExp(`intent   by patchbook for ${LABEL} \\(claude failed: fake claude: offline\\)\\. To replace it, run`));
      expect(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: t.repo.path }).stdout).toContain(".patchbook/blocks/skills/hello/SKILL.md.entries");
      expect(read(entries)).toMatch(new RegExp(wrote(REWRITES_WAVE)));
      expectBuilds(t);
    });

    vendorTest("record writes a different intent for each new paragraph entry when the model fails", (t) => {
      const entries = t.missingScaffoldPatchBuild();
      const skill = "skills/hello/SKILL.md";
      t.repo.write(skill, t.repo.read(skill).replace("# Hello\n", "# Hello there\n").replace("Then wave.", "Then wave twice."));
      breakModel(t, "exit");
      const run = t.pb(["record"], { cwd: t.repo.path });
      const text = read(entries);
      expect(text).toContain('intent (by patchbook): Rewrites the paragraph that starts "# Hello" in hello/SKILL.md.\n');
      expect(text).toContain('intent (by patchbook): Rewrites the paragraph that starts "Then wave." in hello/SKILL.md.\n');
      expect(text).toContain("intent: Speak T3.\n");
      expect(run.stdout).toMatch(new RegExp(`intent   by patchbook for ${LABEL}, ${LABEL} \\(claude failed: fake claude: offline\\)\\. To replace them, run \`patchbook intent\` or edit their lines to \`intent: <yours>\`\\n$`));
      expect(status(t).match(/^note {6}/gm)).toHaveLength(2);
      t.pb(["build"], { cwd: t.repo.path });
      expect(t.repo.read(skill)).toContain("# Hello there");
    });

    vendorTest("record keeps the intent of an entry someone wrote when the model fails, and says it may be stale", (t) => {
      const entries = t.missingScaffoldPatchBuild();
      const skill = "skills/hello/SKILL.md";
      t.repo.write(skill, t.repo.read(skill).replace("Say hello in T3.", "Say hi in T3."));
      breakModel(t, "exit");
      const run = t.pb(["record"], { cwd: t.repo.path });
      expect(read(entries)).toContain("rules: t3\nintent: Speak T3.\n");
      expect(read(entries)).not.toContain("(by patchbook)");
      expect(run.stdout).toMatch(new RegExp(`^entry    ${LABEL} updated\\nintent   may be stale: ${LABEL} \\(claude failed: fake claude: offline\\)\\. Edit them by hand to cover these edits\\n$`));
      expect(status(t)).not.toContain("note");
      t.pb(["build"], { cwd: t.repo.path });
    });

    vendorTest("record with an intent and a failing model writes the intent it was given, not patchbook's", (t) => {
      const entries = edit(t);
      breakModel(t, "exit");
      const run = t.pb(["record", "--intent", "Wave twice."], { cwd: t.repo.path });
      expect(run.stdout).not.toContain("by patchbook");
      expect(read(entries)).toContain("intent: Wave twice.\n");
      expect(read(entries)).not.toContain("(by patchbook)");
      expect(status(t)).not.toContain("note");
    });

    const SKILL = "skills/hello/SKILL.md";
    const editAgain = (t: VendorCase): void => t.repo.write(SKILL, t.repo.read(SKILL).replace("Then wave twice.", "Then wave thrice."));
    const expectGiven = (t: VendorCase, entries: string, what: string): void => {
      expect(read(entries)).toContain(`intent: ${what}\n`);
      expect(read(entries)).not.toContain("(by patchbook)");
      expect(status(t)).not.toContain("note");
      t.pb(["build"], { cwd: t.repo.path });
      expect(t.repo.read(SKILL)).toContain("Then wave thrice.");
    };

    vendorTest("record --intent replaces an intent patchbook wrote for an entry when the model failed", (t) => {
      const entries = edit(t);
      breakModel(t, "exit");
      t.pb(["record"], { cwd: t.repo.path });
      editAgain(t);
      const run = t.pb(["record", "--intent", "Mine after."], { cwd: t.repo.path });
      expect(run.stdout).toMatch(new RegExp(`^entry    ${LABEL} updated\\n$`));
      expectGiven(t, entries, "Mine after.");
    });

    vendorTest("the hook with PATCHBOOK_INTENT replaces an intent patchbook wrote for an entry", (t) => {
      const entries = edit(t);
      breakModel(t, "exit");
      t.pb(["record"], { cwd: t.repo.path });
      editAgain(t);
      sh(["git", "add", "-A"], { cwd: t.repo.path });
      const run = sh(["git", "commit", "-qm", "wave"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Mine after." }, check: false });
      expect(run.code).toBe(0);
      expect(run.stderr).not.toContain("not used");
      expect(run.stderr).not.toContain("by patchbook");
      expectGiven(t, entries, "Mine after.");
    });

    vendorTest("record --intent gives a new entry and an updated one patchbook wrote the same intent", (t) => {
      const entries = edit(t);
      breakModel(t, "exit");
      t.pb(["record"], { cwd: t.repo.path });
      editAgain(t);
      t.repo.write(SKILL, t.repo.read(SKILL).replace("# Hello\n", "# Hello there\n"));
      const run = t.pb(["record", "--intent", "Mine after."], { cwd: t.repo.path });
      expect(run.stdout).not.toContain("not used");
      expect(run.stdout).not.toContain("by patchbook");
      expect(read(entries).match(/intent: Mine after\.\n/g)).toHaveLength(2);
      expectGiven(t, entries, "Mine after.");
    });

    vendorTest("record --intent keeps an intent someone wrote for an entry and says it was not used", (t) => {
      const entries = edit(t);
      breakModel(t, "exit");
      t.pb(["record"], { cwd: t.repo.path });
      writeFileSync(entries, read(entries).replace(/intent \(by patchbook\): [^\n]*/, "intent: Mine by hand."));
      editAgain(t);
      const run = t.pb(["record", "--intent", "Other."], { cwd: t.repo.path });
      expect(run.stdout).toContain("intent   not used");
      expect(read(entries)).toContain("intent: Mine by hand.\n");
      expect(read(entries)).not.toContain("Other.");
    });

    vendorTest("a later record with no model writes patchbook's intent for an entry again", (t) => {
      const entries = edit(t);
      breakModel(t, "exit");
      t.pb(["record"], { cwd: t.repo.path });
      t.repo.write("skills/hello/SKILL.md", t.repo.read("skills/hello/SKILL.md").replace("Then wave twice.\n", ""));
      const again = t.pb(["record"], { cwd: t.repo.path });
      expect(again.stdout).toMatch(new RegExp(`^entry    ${LABEL} updated\\nintent   by patchbook for ${LABEL} \\(claude failed: fake claude: offline\\)\\. `));
      expect(read(entries)).toContain('intent (by patchbook): Deletes the paragraph that starts "Then wave." in hello/SKILL.md.\n');
      expect(read(entries)).not.toContain("Rewrites");
      expect(status(t)).toMatch(NOTE);
    });

    vendorTest("a later record with the model replaces the intent patchbook wrote for an entry", (t) => {
      const entries = edit(t);
      const restore = breakModel(t, "exit");
      t.pb(["record"], { cwd: t.repo.path });
      restore();
      t.repo.write("skills/hello/SKILL.md", t.repo.read("skills/hello/SKILL.md").replace("Then wave twice.", "Then wave thrice."));
      const again = t.pb(["record"], { cwd: t.repo.path });
      expect(again.stdout).toMatch(new RegExp(`^entry    ${LABEL} updated\\nintent   ${LABEL}: Shout the second line\\.\\n$`));
      expect(read(entries)).toContain("--- patched\nThen wave thrice.");
      expect(read(entries)).not.toContain("(by patchbook)");
      expect(status(t)).not.toContain("note");
    });

    vendorTest("patchbook intent replaces an intent patchbook wrote for an entry", (t) => {
      const entries = edit(t);
      const restore = breakModel(t, "exit");
      t.pb(["record"], { cwd: t.repo.path });
      restore();
      const fill = t.pb(["intent"], { cwd: t.repo.path });
      expect(fill.stdout).toBe("entries  skills/hello/SKILL.md: Shout the second line.\n");
      expect(read(entries)).toMatch(/kind: policy\nrules: \nintent: Shout the second line\.\n/);
      expect(read(entries)).toContain("intent: Speak T3.");
      expect(read(entries)).not.toContain("(by patchbook)");
      expect(status(t)).not.toContain("note");
      expect(t.pb(["intent"], { cwd: t.repo.path }).stdout).toBe("no intent is empty or by patchbook; nothing to fill\n");
      expectBuilds(t);
    });

    vendorTest("an edit of the label to intent: makes an entry's intent someone's", (t) => {
      const entries = edit(t);
      breakModel(t, "exit");
      t.pb(["record"], { cwd: t.repo.path });
      expect(status(t)).toMatch(NOTE);
      writeFileSync(entries, read(entries).replace(/intent \(by patchbook\): [^\n]*/, "intent: Mine."));
      expect(status(t)).not.toContain("note");
      expect(t.pb(["intent"], { cwd: t.repo.path }).stdout).toBe("no intent is empty or by patchbook; nothing to fill\n");
      expect(read(entries)).toContain("intent: Mine.\n");
      expectBuilds(t);
    });

    vendorTest("intent writes nothing when the model fails, and leaves an entry patchbook wrote as it was", (t) => {
      const entries = edit(t);
      breakModel(t, "exit");
      t.pb(["record"], { cwd: t.repo.path });
      const before = tree(t.repo.path);
      const run = t.pb(["intent"], { cwd: t.repo.path, code: 1 });
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("patchbook: claude failed");
      expect(tree(t.repo.path)).toEqual(before);
      expect(read(entries)).toMatch(new RegExp(wrote(REWRITES_WAVE)));
    });

    vendorTest("intent fills an empty entry and replaces patchbook's intent of a change and an entry together", (t) => {
      const entries = edit(t);
      t.repo.write("skills/hello/notes.txt", "added by hand\n");
      const restore = breakModel(t, "exit");
      const run = t.pb(["record"], { cwd: t.repo.path });
      expect(run.stdout).toStartWith("add-skills-hello-notes-txt: Adds skills/hello/notes.txt.\n");
      expect(run.stdout).toMatch(new RegExp(`entry    ${LABEL} added\\n`));
      expect(run.stdout).toMatch(new RegExp(`intent   by patchbook for ${LABEL}, add-skills-hello-notes-txt \\(claude failed: fake claude: offline\\)\\. To replace them, run `));
      const change = join(t.repo.path, ".patchbook/changes/add-skills-hello-notes-txt/CHANGE.md");
      expect(read(change)).toContain("\nintent (by patchbook): Adds skills/hello/notes.txt.\n");
      expect(read(entries)).toMatch(new RegExp(wrote(REWRITES_WAVE)));
      const notes = status(t);
      expect(notes).toMatch(NOTE);
      expect(notes).toContain("note      changes/add-skills-hello-notes-txt: patchbook wrote its intent from the edits.");
      t.pb(["build"], { cwd: t.repo.path });
      restore();
      const fill = t.pb(["intent"], { cwd: t.repo.path });
      expect(fill.stdout).toBe("intent   add-skills-hello-notes-txt: Shout the second line.\nentries  skills/hello/SKILL.md: Shout the second line.\n");
      expect(read(change)).toContain("\nintent: Shout the second line.\n");
      expect(read(entries)).toMatch(/kind: policy\nrules: \nintent: Shout the second line\.\n/);
      expect(read(entries)).toContain("intent: Speak T3.");
      expect(status(t)).not.toContain("note");
      t.pb(["build"], { cwd: t.repo.path });
    });

    vendorTest("intent with an intent and no change name exits 1 and writes nothing", (t) => {
      edit(t);
      t.repo.write("skills/hello/notes.txt", "added by hand\n");
      breakModel(t, "exit");
      t.pb(["record"], { cwd: t.repo.path });
      const before = tree(t.repo.path);
      const run = t.pb(["intent", "--intent", "Wave twice."], { cwd: t.repo.path, code: 1 });
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe("patchbook: --intent needs a change name: patchbook intent <change> --intent ...\n");
      expect(tree(t.repo.path)).toEqual(before);
    });
  });

  describe("the model call", () => {
    const REPLY = '{"change": "louder", "intent": "Make it louder."}';

    const fakeReplying = (t: Case, provider: string, reply: string): void => {
      const file = join(t.tmp, "bin", provider);
      writeFileSync(file, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${t.tmp}/argv.txt\ncat > /dev/null\ncat <<'REPLY'\n${reply}\nREPLY\n`);
      chmodSync(file, 0o755);
    };
    const argvOf = (t: Case): string[] => read(join(t.tmp, "argv.txt")).slice(0, -1).split("\n");

    forkTest("claude runs as a plain completion with no tools, MCP servers or slash commands", (t) => {
      fakeReplying(t, "claude", REPLY);
      t.fork.write("extra.txt", "ours\n");
      t.pb(["record"], { cwd: t.fork.path });
      expect(argvOf(t)).toEqual([
        "-p", "--model", "claude-haiku-5-5", "--effort", "medium",
        "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
      ]);
    });

    forkTest("claude keeps the user's settings and login", (t) => {
      fakeReplying(t, "claude", REPLY);
      t.fork.write("extra.txt", "ours\n");
      t.pb(["record"], { cwd: t.fork.path });
      const argv = argvOf(t);
      for (const flag of ["--bare", "--setting-sources", "--settings", "--mcp-config"]) expect(argv).not.toContain(flag);
    });

    forkTest("codex runs read-only and ephemeral", (t) => {
      fakeReplying(t, "codex", REPLY);
      t.env["PATCHBOOK_PROVIDER"] = "codex";
      t.fork.write("extra.txt", "ours\n");
      t.pb(["record"], { cwd: t.fork.path });
      const argv = argvOf(t);
      expect(argv.slice(0, 9)).toEqual(["exec", "-m", "gpt-6-luna", "-c", "model_reasoning_effort=high", "--skip-git-repo-check", "-s", "read-only", "--ephemeral"]);
      expect(argv[9]).toBe("-C");
      expect(argv.slice(11)).toEqual(["-"]);
    });

    const USABLE: readonly (readonly [string, string, string])[] = [
      ["a bare object", REPLY, "louder: Make it louder."],
      ["an object with blank lines around it", `\n\n${REPLY}\n\n`, "louder: Make it louder."],
      ["a JSON fence", "```json\n" + REPLY + "\n```", "louder: Make it louder."],
      ["a bare fence", "```\n" + REPLY + "\n```", "louder: Make it louder."],
      ["a fence with blank lines around it", "\n```json\n" + REPLY + "\n```\n\n", "louder: Make it louder."],
      ["an object over several lines", '{\n  "change": "louder",\n  "intent": "Make it louder."\n}', "louder: Make it louder."],
      ["an intent with a closing brace", '{"change": "louder", "intent": "Close the } in the header."}', "louder: Close the } in the header."],
      ["an intent with braces in a fence", '```json\n{"change": "louder", "intent": "Use {braces} and a } here."}\n```', "louder: Use {braces} and a } here."],
    ];
    for (const [what, reply, line] of USABLE) {
      forkTest(`record takes the name and intent from ${what}`, (t) => {
        fakeReplying(t, "claude", reply);
        t.fork.write("extra.txt", "ours\n");
        expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe(`${line}\nadd      extra.txt\n`);
        expect(changeText(t, "louder")).toContain(`intent: ${line.slice("louder: ".length)}`);
      });

      forkTest(`hook takes the name and intent from ${what}`, (t) => {
        fakeReplying(t, "claude", reply);
        t.fork.write("extra.txt", "ours\n");
        const run = hookCommit(t);
        expect(run.code).toBe(0);
        expect(run.stderr).toContain(`${line}\nadd      extra.txt\n`);
        expect(committed(t)).toContain(".patchbook/changes/louder/CHANGE.md");
      });
    }

    const UNUSABLE: readonly (readonly [string, string])[] = [
      ["prose before the object", `Sure. Here it is:\n${REPLY}`],
      ["prose after the object", `${REPLY}\nHope that helps.`],
      ["prose on both sides of the object", `Sure.\n${REPLY}\nHope that helps.`],
      ["prose on the same line as the object", `Sure. ${REPLY}`],
      ["two objects", `${REPLY}\n{"change": "other", "intent": "Something else."}`],
      ["an object followed by a stray brace", `${REPLY}\n}`],
      ["a fence with prose around it", "Here:\n```json\n" + REPLY + "\n```\nDone."],
      ["two fences", "```json\n" + REPLY + "\n```\n```json\n{\"change\": \"other\", \"intent\": \"Something else.\"}\n```"],
      ["a fence of another language", "```js\n" + REPLY + "\n```"],
      ["a fence around text", "```\nnot json\n```"],
      ["an unclosed fence", "```json\n" + REPLY],
      ["an array holding the object", `[${REPLY}]`],
      ["an array nested too deep to decode", "[".repeat(32768) + "0" + "]".repeat(32768)],
      ["an object with no intents", '{"change": "louder"}'],
      ["an object with no intent for the change it picks", '{"change": "louder", "intents": {"other": "Make it louder."}}'],
      ["an object that picks no change", '{"change": null, "intent": "Make it louder."}'],
      ["text that is not JSON", "I cannot help with that."],
      ["an empty reply", ""],
      ["a reply of only whitespace", "   \n\n"],
    ];
    for (const [what, reply] of UNUSABLE) {
      forkTest(`record writes patchbook's intent when the reply is ${what}`, (t) => {
        fakeReplying(t, "claude", reply);
        t.fork.write("extra.txt", "ours\n");
        const run = t.pb(["record"], { cwd: t.fork.path });
        expect(run.stdout).toMatch(/^add-extra-txt: Adds extra\.txt\.\nadd      extra\.txt\nintent   by patchbook for add-extra-txt \(claude didn't return a usable name and intent: claude's reply[^\n]+\)\. To replace it, run `patchbook intent add-extra-txt` or edit its line to `intent: <yours>`\n$/);
        expectByPatchbook(t, "add-extra-txt", "Adds extra.txt.");
      });

      forkTest(`hook commits with patchbook's intent when the reply is ${what}`, (t) => {
        fakeReplying(t, "claude", reply);
        t.fork.write("extra.txt", "ours\n");
        const run = hookCommit(t);
        expect(run.code).toBe(0);
        expect(run.stderr).toContain("intent   by patchbook for add-extra-txt (claude didn't return a usable name and intent: claude's reply");
        expect(committed(t)).toContain("extra.txt");
        expect(committed(t)).toContain(".patchbook/changes/add-extra-txt/CHANGE.md");
        expectByPatchbook(t, "add-extra-txt", "Adds extra.txt.");
      });
    }

    forkTest("intent writes nothing when the reply has prose around the object", (t) => {
      breakModel(t, "exit");
      t.fork.write("extra.txt", "ours\n");
      t.pb(["record"], { cwd: t.fork.path });
      fakeReplying(t, "claude", `Sure.\n{"change": null, "intents": {"add-extra-txt": "Ship extra files."}}`);
      delete t.env["PATCHBOOK_PROVIDER"];
      const before = tree(t.fork.path);
      const run = t.pb(["intent", "add-extra-txt"], { cwd: t.fork.path, code: 1 });
      expect(run.stderr).toContain("claude didn't return a usable name and intent");
      expect(tree(t.fork.path)).toEqual(before);
    });

    forkTest("intent replaces patchbook's intent from a fenced reply", (t) => {
      breakModel(t, "exit");
      t.fork.write("extra.txt", "ours\n");
      t.pb(["record"], { cwd: t.fork.path });
      fakeReplying(t, "claude", '```json\n{"change": null, "intents": {"add-extra-txt": "Ship extra files."}}\n```');
      delete t.env["PATCHBOOK_PROVIDER"];
      expect(t.pb(["intent", "add-extra-txt"], { cwd: t.fork.path }).stdout).toBe("intent   add-extra-txt: Ship extra files.\n");
      expect(changeText(t, "add-extra-txt")).toContain("\nintent: Ship extra files.\n");
    });
  });
});

describe("StaleIntentTest", () => {
  const FEATURE = "Shout the second line, add extra.txt, drop the guide.";
  const changeText = (t: ForkCase, name: string): string => read(join(t.fork.path, ".patchbook/changes", name, "CHANGE.md"));

  /** A fake claude that appends each prompt to a log and gives `reply`, or fails when `reply` is null. Returns the prompts so far. */
  const model = (t: Case, reply: string | null): (() => string[]) => {
    const log = join(t.tmp, "prompts.log");
    writeFileSync(join(t.tmp, "reply.json"), reply ?? "");
    const answer = reply === null ? "echo 'fake claude: offline' >&2\nexit 1" : `cat ${t.tmp}/reply.json`;
    writeFileSync(join(t.tmp, "bin/claude"), `#!/bin/sh\ncat >> ${log}\nprintf '\\0' >> ${log}\n${answer}\n`);
    chmodSync(join(t.tmp, "bin/claude"), 0o755);
    return () => (existsSync(log) ? read(log).split("\0").slice(0, -1) : []);
  };
  const reply = (change: string | null, intents: Record<string, string>, intent?: string): string => JSON.stringify({ change, ...(intent ? { intent } : {}), intents });

  forkTest("an edit to a file a change owns asks the model once, with the change's whole diff, and rewrites its intent", (t) => {
    t.recordFeature();
    const intent = "Shout the second and third lines, add extra.txt, drop the guide.";
    const prompts = model(t, reply(null, { feature: intent }));
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("three", "THREE"));
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe(`file     app.txt (in feature)\nintent   feature: ${intent}\n`);
    expect(changeText(t, "feature")).toContain(`intent: ${intent}\n`);
    expect(prompts()).toHaveLength(1);
    const [prompt] = prompts();
    expect(prompt).toContain(FEATURE);
    for (const edit of ["-two\n-three\n+TWO\n+THREE\n", "+++ ours/extra.txt\n@@ -0,0 +1 @@\n+ours\n", "delete docs/guide.md\n"]) expect(prompt).toContain(edit);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("owned edits to two changes in one record ask the model once and give each its own intent", (t) => {
    t.recordFeature();
    t.fork.write("bin/run.sh", "#!/bin/sh\necho RUN\n", 0o755);
    t.pb(["record", "runner", "--intent", "Shout the run line."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("runner");
    const prompts = model(t, reply(null, { feature: "Shout two lines, add extra.txt, drop the guide.", runner: "Shout the run line twice." }));
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("three", "THREE"));
    t.fork.write("bin/run.sh", "#!/bin/sh\necho RUN\necho RUN\n", 0o755);
    const out = t.pb(["record"], { cwd: t.fork.path }).stdout;
    expect(out).toContain("intent   feature: Shout two lines, add extra.txt, drop the guide.\n");
    expect(out).toContain("intent   runner: Shout the run line twice.\n");
    expect(changeText(t, "feature")).toContain("intent: Shout two lines, add extra.txt, drop the guide.\n");
    expect(changeText(t, "runner")).toContain("intent: Shout the run line twice.\n");
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]).toContain("Shout the run line.");
    expect(prompts()[0]).toContain(FEATURE);
  });

  forkTest("a model that files new edits into an existing change replaces its intent in the same call", (t) => {
    t.recordFeature();
    const intent = "Shout the second line, add extra.txt and more.txt, drop the guide.";
    const prompts = model(t, reply("feature", {}, intent));
    t.fork.write("more.txt", "more\n");
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe(`adding to feature\nadd      more.txt\nintent   feature: ${intent}\n`);
    expect(changeText(t, "feature")).toContain(`intent: ${intent}\n`);
    expect(changeText(t, "feature")).toContain("- add more.txt");
    expect(prompts()).toHaveLength(1);
  });

  forkTest("a change that loses an add and takes an edit in one record is shown to the model without the add", (t) => {
    t.fork.write("a.txt", "a\n");
    t.fork.write("b.txt", "b\n");
    t.pb(["record", "x", "--intent", "Add a.txt and b.txt."], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("x");
    const intent = "Add b.txt.";
    const prompts = model(t, reply(null, { x: intent }));
    t.fork.rm("a.txt");
    t.fork.write("b.txt", "bee\n");
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toBe(`unadd    a.txt (from x)\nupdate   b.txt (in x)\nintent   x: ${intent}\n`);
    expect(prompts()).toHaveLength(1);
    const [prompt] = prompts();
    expect(prompt).toContain("b.txt: added");
    expect(prompt).toContain("+++ ours/b.txt\n@@ -0,0 +1 @@\n+bee\n");
    expect(prompt).not.toContain("a.txt: added");
    expect(prompt).not.toContain("ours/a.txt");
    expect(changeText(t, "x")).toBe(`# x\n\nintent: ${intent}\n\nedits:\n- add b.txt\n`);
  });

  for (const [what, setUp, args, calls, said] of [
    ["provider none", (t: ForkCase) => { t.env["PATCHBOOK_PROVIDER"] = "none"; }, [], 0, "intent.provider is none"],
    ["a failing model", () => {}, [], 1, "claude failed: fake claude: offline"],
    ["a given intent", () => {}, ["--intent", "Make it louder."], 0, "the given intent is for the change being recorded"],
  ] as const) {
    forkTest(`with ${what}, an edit to a file a change owns keeps its intent and says it may be stale`, (t) => {
      t.recordFeature();
      const prompts = model(t, what === "a failing model" ? null : reply(null, { feature: "Not this." }));
      setUp(t);
      t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("three", "THREE"));
      const out = t.pb(["record", ...args], { cwd: t.fork.path }).stdout;
      expect(out).toContain(`intent   may be stale: feature (${said}). Edit them by hand to cover these edits\n`);
      expect(out.split("\n").filter((l) => l.startsWith("intent   may be stale"))).toHaveLength(1);
      expect(out).not.toContain("pending");
      expect(changeText(t, "feature")).toContain(`intent: ${FEATURE}\n`);
      expect(prompts()).toHaveLength(calls);
      delete t.env["PATCHBOOK_PROVIDER"];
      expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    });
  }
});
