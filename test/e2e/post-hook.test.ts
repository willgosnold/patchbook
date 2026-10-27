import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Case, Repo, TIMEOUT, sh } from "../helpers";
import { read, isExecutable, ForkCase, forkTest, vendorTest, installManager, NOTE_STAGED, forkWith } from "../e2e-fixtures.ts";

describe("PostHookTest", () => {
  const POST = ["post-merge", "post-checkout", "post-rewrite"];
  const CHECKOUT_CONTEXT = 'PATCHBOOK_CHECKOUT_BEFORE="$1" PATCHBOOK_CHECKOUT_AFTER="$2" ';
  const OURS = ".patchbook/changes/feature/ours/extra.txt.pb";
  const hooked = (t: Case, env: Record<string, string> = {}): Record<string, string> => ({ ...t.env, PATCHBOOK_HOOK: "1", ...env });
  const git = (t: ForkCase, args: string[], env?: Record<string, string>, check = true) => sh(["git", ...args], { cwd: t.fork.path, check, env: env ?? t.env });

  /** Branch `data` holds a change to a change's file that nobody built, as a commit that skipped the hook leaves it. */
  const staleBranch = (t: ForkCase): void => {
    t.recordFeature();
    git(t, ["switch", "-qc", "data"]);
    t.fork.write(OURS, "changed\n");
    t.fork.commit("data, without a build");
    git(t, ["switch", "-q", "main"]);
  };

  forkTest("clone installs post-merge, post-checkout and post-rewrite hooks next to pre-commit", (t) => {
    for (const name of ["pre-commit", ...POST]) {
      const path = join(t.fork.path, ".git/hooks", name);
      expect(existsSync(path)).toBe(true);
      expect(isExecutable(path)).toBe(true);
    }
    for (const name of POST) expect(read(join(t.fork.path, ".git/hooks", name))).toContain('[ "$PATCHBOOK_HOOK" = 0 ] && exit 0');
    expect(read(join(t.fork.path, ".git/hooks/post-checkout"))).toContain('[ "$3" = 1 ] && ');
    expect(read(join(t.fork.path, ".git/hooks/post-rewrite"))).toContain('[ "$1" = rebase ] || exit 0');
  });

  forkTest("build installs the post hooks in a fork that has only the pre-commit hook, and keeps a post hook that isn't patchbook's", (t) => {
    for (const name of POST) rmSync(join(t.fork.path, ".git/hooks", name));
    writeFileSync(join(t.fork.path, ".git/hooks/post-merge"), "#!/bin/sh\necho mine\n", { mode: 0o755 });
    const built = t.pb(["build"], { cwd: t.fork.path });
    expect(built.stderr).toContain("installed post-checkout and post-rewrite hooks");
    expect(read(join(t.fork.path, ".git/hooks/post-merge"))).toBe("#!/bin/sh\necho mine\n");
    expect(isExecutable(join(t.fork.path, ".git/hooks/post-checkout"))).toBe(true);
    expect(t.pb(["build"], { cwd: t.fork.path }).stderr).not.toContain("installed");
  });

  forkTest("git merge rebuilds the output from the patchbook", (t) => {
    staleBranch(t);
    const merged = git(t, ["merge", "-q", "data"], hooked(t));
    expect(merged.stderr).toContain("patchbook: rebuilt 1 file from");
    expect(t.fork.read("extra.txt")).toBe("changed\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).not.toContain("behind");
  });

  forkTest("git checkout of a branch rebuilds the output, and a file checkout does not", (t) => {
    staleBranch(t);
    git(t, ["checkout", "-q", "data", "--", OURS], hooked(t));
    expect(t.fork.read("extra.txt")).toBe("ours\n");
    git(t, ["reset", "-q", "--hard"]);
    const switched = git(t, ["checkout", "-q", "data"], hooked(t));
    expect(switched.stderr).toContain("patchbook: rebuilt 1 file from");
    expect(t.fork.read("extra.txt")).toBe("changed\n");
    git(t, ["switch", "-q", "main"], hooked(t));
    expect(t.fork.read("extra.txt")).toBe("ours\n");
  });

  forkTest("a branch checkout with unchanged build inputs does not run a build", (t) => {
    t.fork.write(".patchbook/series", "bogus\n");
    t.fork.commit("invalid data on both branches");
    git(t, ["switch", "-qc", "same-inputs"]);
    t.fork.write("app.txt", "only the output changed\n");
    t.fork.commit("output only");
    const switched = git(t, ["checkout", "-q", "main"], hooked(t));
    expect(switched.stderr).toBe("");
    expect(t.fork.read("app.txt")).toContain("two");
    expect(git(t, ["status", "--porcelain"]).stdout).toBe("");
  });

  forkTest("build upgrades the previous standalone checkout hook", (t) => {
    const path = join(t.fork.path, ".git/hooks/post-checkout");
    writeFileSync(path, read(path).replace(CHECKOUT_CONTEXT, ""));
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.write(".patchbook/series", "bogus\n");
    t.fork.commit("invalid unchanged inputs");
    const switched = git(t, ["checkout", "-qb", "same-inputs"], hooked(t));
    expect(switched.stderr).toBe("");
    expect(t.pb(["build"], { cwd: t.fork.path, code: 1 }).stderr).toContain("no change called bogus");
  });

  forkTest("an unrelated submodule does not prevent an unchanged-input checkout from skipping the build", (t) => {
    const dep = new Repo(join(t.tmp, "dep"));
    dep.write("README.md", "unrelated\n");
    dep.commit("start");
    git(t, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dep.path, "deps"]);
    t.fork.write(".patchbook/series", "bogus\n");
    t.fork.commit("unchanged invalid data and unrelated submodule");
    const switched = git(t, ["checkout", "-qb", "same-inputs"], hooked(t));
    expect(switched.stderr).toBe("");
    expect(git(t, ["status", "--porcelain"]).stdout).toBe("");
  });

  for (const submodule of ["deps", "sources/deps[1]"]) forkTest(`checkout skips an unchanged placeholder under gitlink ${submodule}`, (t) => {
    const dep = new Repo(join(t.tmp, "dep"));
    dep.write("strings.json", '{"greet":"same"}\n');
    dep.commit("start");
    git(t, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dep.path, submodule]);
    appendFileSync(join(t.fork.path, ".patchbook/config.toml"), `\n[placeholders.str]\nfile = "${submodule}/strings.json"\nformat = "json"\n`);
    t.fork.write(".patchbook/series", "bogus\n");
    t.fork.commit("unchanged inputs including gitlink");
    git(t, ["switch", "-qc", "readme"]);
    t.fork.write("README.md", "unrelated\n");
    t.fork.commit("readme only");
    const switched = git(t, ["checkout", "-q", "--recurse-submodules", "main"], hooked(t));
    expect(switched.stderr).toBe("");
    expect(t.fork.read(`${submodule}/strings.json`)).toContain("same");
    expect(git(t, ["status", "--porcelain"]).stdout).toBe("");
  });

  forkTest("checkout rebuilds when the placeholder's gitlink is removed", (t) => {
    const dep = new Repo(join(t.tmp, "dep"));
    dep.write("strings.json", '{"greet":"before"}\n');
    dep.commit("start");
    git(t, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dep.path, "deps"]);
    appendFileSync(join(t.fork.path, ".patchbook/config.toml"), '\n[placeholders.str]\nfile = "deps/strings.json"\nformat = "json"\n');
    t.fork.write(".patchbook/series", "bogus\n");
    t.fork.commit("gitlink input and invalid series");
    git(t, ["switch", "-qc", "removed"]);
    git(t, ["rm", "-qf", "deps"]);
    t.fork.write("deps/notes.txt", "ordinary replacement without placeholder\n");
    t.fork.commit("removed gitlink");
    git(t, ["checkout", "-q", "--recurse-submodules", "main"]);
    const switched = git(t, ["checkout", "-q", "--recurse-submodules", "removed"], hooked(t));
    expect(switched.stderr).toContain("couldn't rebuild the output after this git command");
    expect(switched.stderr).toContain("no change called bogus");
    expect(t.fork.read("deps/notes.txt")).toContain("ordinary replacement");
  });

  forkTest("checkout skips an ordinary sibling edit beside a placeholder input", (t) => {
    t.fork.write("sources/strings.json", '{"greet":"same"}\n');
    t.fork.write("sources/notes.txt", "before\n");
    appendFileSync(join(t.fork.path, ".patchbook/config.toml"), '\n[placeholders.str]\nfile = "sources/strings.json"\nformat = "json"\n');
    t.fork.write(".patchbook/series", "bogus\n");
    t.fork.commit("unchanged placeholder input");
    git(t, ["switch", "-qc", "sibling"]);
    t.fork.write("sources/notes.txt", "after\n");
    t.fork.commit("sibling only");
    const switched = git(t, ["checkout", "-q", "main"], hooked(t));
    expect(switched.stderr).toBe("");
    expect(t.fork.read("sources/strings.json")).toContain("same");
    expect(git(t, ["status", "--porcelain"]).stdout).toBe("");
  });

  for (const [name, old, next] of [
    ["zero old revision", "0".repeat(40), "HEAD"],
    ["missing old revision", "missing", "HEAD"],
    ["missing new revision", "HEAD", "missing"],
    ["empty old revision", "", "HEAD"],
  ] as const) {
    forkTest(`post-checkout rebuilds when it cannot compare a ${name}`, (t) => {
      staleBranch(t);
      git(t, ["switch", "-q", "data"]);
      const head = git(t, ["rev-parse", "HEAD"]).stdout.trim();
      const built = sh(["sh", join(t.fork.path, ".git/hooks/post-checkout"), old === "HEAD" ? head : old, next === "HEAD" ? head : next, "1"], { cwd: t.fork.path, env: hooked(t) });
      expect(built.stderr).toContain("patchbook: rebuilt 1 file from");
      expect(built.stderr).not.toContain("fatal:");
      expect(t.fork.read("extra.txt")).toBe("changed\n");
    });
  }

  test("checkout rebuilds when custom hooks read a changed file outside .patchbook", () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "up"));
      up.write("app.txt", "upstream\n");
      up.commit("start");
      const repo = new Repo(join(t.tmp, "repo"));
      repo.write("input.txt", "before\n");
      repo.commit("start");
      t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: repo.path });
      repo.write(".patchbook/hooks.ts", `
        import { readFileSync } from "node:fs";
        export const finish = (out) => {
          out.set("generated.txt", { data: readFileSync("input.txt"), mode: 0o644 });
        };
      `);
      t.pb(["build"], { cwd: repo.path });
      repo.commit("build before");
      sh(["git", "switch", "-qc", "data"], { cwd: repo.path, env: t.env });
      repo.write("input.txt", "after\n");
      repo.commit("input only");
      sh(["git", "switch", "-q", "main"], { cwd: repo.path, env: t.env });
      const switched = sh(["git", "checkout", "-q", "data"], { cwd: repo.path, env: hooked(t) });
      expect(switched.stderr).toContain("patchbook: rebuilt 1 file from");
      expect(repo.read("out/generated.txt")).toBe("after\n");
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  for (const linked of [false, true]) vendorTest(`checkout rebuilds when a ${linked ? "linked " : ""}placeholder source outside .patchbook changes`, (t) => {
    t.repo.write("sources/snippets[1].md", t.repo.read(".patchbook/snippets.md"));
    if (linked) symlinkSync("sources", join(t.repo.path, "linked"), "dir");
    const source = `${linked ? "linked" : "sources"}/snippets[1].md`;
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replace('file = ".patchbook/snippets.md"', `file = "${source}"`));
    t.missingScaffoldPatchBuild();
    t.repo.commit("build before");
    sh(["git", "switch", "-qc", "data"], { cwd: t.repo.path, env: t.env });
    t.repo.write("sources/snippets[1].md", "## greet\n\nSay goodbye in T3.\n");
    t.repo.commit("placeholder only");
    sh(["git", "switch", "-q", "main"], { cwd: t.repo.path, env: t.env });
    const switched = sh(["git", "checkout", "-q", "data"], { cwd: t.repo.path, env: hooked(t) });
    expect(switched.stderr).toContain("patchbook: rebuilt 1 file from");
    expect(t.repo.read("skills/hello/SKILL.md")).toContain("Say goodbye in T3.");
  });

  for (const submodule of ["deps", "sources/deps[1]"]) vendorTest(`recursive checkout rebuilds a placeholder inside submodule ${submodule}`, (t) => {
    const strings = new Repo(join(t.tmp, "strings"));
    strings.write("strings.json", '{"greet":"Say hello in T3."}\n');
    strings.commit("before");
    sh(["git", "-c", "protocol.file.allow=always", "submodule", "add", "-q", strings.path, submodule], { cwd: t.repo.path, env: t.env });
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replace('file = ".patchbook/snippets.md"', `file = "${submodule}/strings.json"`).replace('format = "sections"', 'format = "json"'));
    t.missingScaffoldPatchBuild();
    t.repo.commit("build before");
    sh(["git", "switch", "-qc", "data"], { cwd: t.repo.path, env: t.env });
    const dep = new Repo(join(t.repo.path, submodule));
    dep.write("strings.json", '{"greet":"Say goodbye in T3."}\n');
    dep.commit("after");
    t.repo.commit("gitlink only");
    sh(["git", "checkout", "-q", "--recurse-submodules", "main"], { cwd: t.repo.path, env: t.env });
    expect(t.repo.read("skills/hello/SKILL.md")).toContain("Say hello in T3.");
    const switched = sh(["git", "checkout", "-q", "--recurse-submodules", "data"], { cwd: t.repo.path, env: hooked(t) });
    expect(dep.read("strings.json")).toContain("Say goodbye in T3.");
    expect(t.repo.read("skills/hello/SKILL.md")).toContain("Say goodbye in T3.");
    expect(switched.stderr).toContain("patchbook: rebuilt 1 file from");
  });

  forkTest("checkout treats a placeholder file inside the output as a build input", (t) => {
    t.up.write("strings.json", '{"greet":"before"}\n');
    t.up.commit("placeholder source");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    appendFileSync(join(t.fork.path, ".patchbook/config.toml"), '\n[placeholders.str]\nfile = "strings.json"\nformat = "json"\n');
    t.fork.write(".patchbook/series", "bogus\n");
    t.fork.commit("invalid data on both branches");
    git(t, ["switch", "-qc", "data"]);
    t.fork.write("strings.json", '{"greet":"after"}\n');
    t.fork.commit("placeholder only");
    git(t, ["switch", "-q", "main"]);
    const switched = git(t, ["checkout", "-q", "data"], hooked(t));
    expect(switched.stderr).toContain("no change called bogus");
    expect(t.fork.read("strings.json")).toBe('{"greet":"after"}\n');
  });

  forkTest("checkout retains the build validation for changed vendored inputs", (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("extra.txt", "pinned\n");
    extra.commit("start");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    t.fork.commit("vendor");
    git(t, ["switch", "-qc", "data"]);
    t.fork.write("vendor/extra/extra.txt", "changed\n");
    t.fork.commit("vendor only");
    git(t, ["switch", "-q", "main"]);
    const switched = git(t, ["checkout", "-q", "data"], hooked(t));
    expect(switched.stderr).toContain("differs from the pin");
    expect(t.fork.read("vendor/extra/extra.txt")).toBe("changed\n");
  });

  for (const dir of [".husky", ".vite-hooks"]) for (const [ending, newline] of [["LF", "\n"], ["CRLF", "\r\n"]] as const) {
    test(`hook install upgrades a ${ending} checkout snippet in ${dir} without changing surrounding bytes`, () => {
      const t = new Case();
      try {
        const up = new Repo(join(t.tmp, "up"));
        up.write("app.txt", "upstream\n");
        up.commit("start");
        const repo = new Repo(join(t.tmp, "repo"));
        repo.write("README.md", "project\n");
        repo.commit("start");
        t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: repo.path });
        t.pb(["build"], { cwd: repo.path });
        installManager(repo, dir);
        t.pb(["hook", "install"], { cwd: repo.path });
        const path = join(repo.path, dir, "post-checkout");
        const current = read(path).replaceAll("\n", newline);
        const previous = current.replace(CHECKOUT_CONTEXT, "");
        const prefix = Buffer.from([35, 33, 47, 98, 105, 110, 47, 115, 104, 13, 10, 35, 255, 10]);
        const suffix = Buffer.concat([Buffer.from('\necho manager-ran\r\n'), Buffer.from([35, 255, 10])]);
        writeFileSync(path, Buffer.concat([prefix, Buffer.from(previous), suffix]));
        t.pb(["hook", "install"], { cwd: repo.path });
        const expected = Buffer.concat([prefix, Buffer.from(current), suffix]);
        expect(readFileSync(path)).toEqual(expected);
        t.pb(["hook", "install"], { cwd: repo.path });
        expect(readFileSync(path)).toEqual(expected);
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);
  }

  test("hook install upgrades a managed checkout hook and keeps its following commands", () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "up"));
      up.write("app.txt", "upstream\n");
      up.commit("start");
      const repo = new Repo(join(t.tmp, "repo"));
      repo.write("README.md", "project\n");
      repo.commit("start");
      t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: repo.path });
      t.pb(["build"], { cwd: repo.path });
      installManager(repo, ".husky");
      repo.write(".husky/_/post-checkout", '#!/bin/sh\nsh -e "$(dirname "$(dirname "$0")")/post-checkout" "$@"\n', 0o755);
      repo.write(".husky/post-checkout", 'echo manager-ran >> "$(git rev-parse --git-path manager-checkouts)"\n');
      t.pb(["hook", "install"], { cwd: repo.path });
      const path = join(repo.path, ".husky/post-checkout");
      writeFileSync(path, read(path).replace(CHECKOUT_CONTEXT, ""));
      appendFileSync(path, new Uint8Array([35, 255, 10]));
      t.pb(["hook", "install"], { cwd: repo.path });
      const upgraded = readFileSync(path);
      expect([...upgraded.subarray(-3)]).toEqual([35, 255, 10]);
      t.pb(["hook", "install"], { cwd: repo.path });
      expect(readFileSync(path)).toEqual(upgraded);
      repo.write(".patchbook/series", "bogus\n");
      repo.commit("invalid unchanged inputs");
      const switched = sh(["git", "checkout", "-qb", "same-inputs"], { cwd: repo.path, env: hooked(t) });
      expect(switched.stderr).toBe("");
      expect(repo.read(".git/manager-checkouts")).toBe("manager-ran\n");
      repo.write(".patchbook/series", "other\n");
      repo.commit("changed inputs");
      const built = sh(["git", "checkout", "-q", "main"], { cwd: repo.path, env: hooked(t) });
      expect(built.stderr).toContain("no change called bogus");
      expect(repo.read(".git/manager-checkouts")).toBe("manager-ran\nmanager-ran\n");
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  forkTest("the post-rewrite hook rebuilds after a rebase, not after an amend", (t) => {
    staleBranch(t);
    git(t, ["switch", "-q", "data"]);
    const hook = join(t.fork.path, ".git/hooks/post-rewrite");
    sh(["sh", hook, "amend"], { cwd: t.fork.path, env: hooked(t) });
    expect(t.fork.read("extra.txt")).toBe("ours\n");
    sh(["sh", hook, "rebase"], { cwd: t.fork.path, env: hooked(t) });
    expect(t.fork.read("extra.txt")).toBe("changed\n");
  });

  forkTest("git rebase rebuilds the output", (t) => {
    staleBranch(t);
    git(t, ["commit", "-q", "--allow-empty", "-m", "main moves on"]);
    git(t, ["switch", "-q", "data"]);
    git(t, ["rebase", "-q", "main"], hooked(t));
    expect(git(t, ["log", "--format=%s", "-2"]).stdout).toBe("data, without a build\nmain moves on\n");
    expect(t.fork.read("extra.txt")).toBe("changed\n");
  });

  forkTest("a git rebase onto a commit whose outputs were never built completes, and ends with rebuilt outputs", (t) => {
    staleBranch(t);
    git(t, ["switch", "-qc", "topic"]);
    git(t, ["commit", "-qm", "topic", "--allow-empty"]);
    git(t, ["rebase", "-q", "data"], hooked(t));
    expect(git(t, ["log", "--format=%s", "-2"]).stdout).toBe("topic\ndata, without a build\n");
    expect(t.fork.read("extra.txt")).toBe("changed\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).not.toContain("behind");
  });

  forkTest("a git pull --rebase onto a commit whose outputs were never built completes, and ends with rebuilt outputs", (t) => {
    const origin = join(t.tmp, "origin.git");
    sh(["git", "init", "-q", "--bare", "-b", "main", origin], { cwd: t.tmp });
    t.recordFeature();
    git(t, ["remote", "add", "origin", origin]);
    git(t, ["push", "-q", "origin", "main"]);
    sh(["git", "clone", "-q", origin, "second"], { cwd: t.tmp });
    const second = new Repo(join(t.tmp, "second"));
    second.write(OURS, "pulled\n");
    second.commit("data, without a build");
    sh(["git", "push", "-q", "origin", "main"], { cwd: second.path });
    git(t, ["commit", "-qm", "local", "--allow-empty"]);
    git(t, ["pull", "-q", "--rebase", "origin", "main"], hooked(t));
    expect(t.fork.read("extra.txt")).toBe("pulled\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).not.toContain("behind");
  });

  forkTest("a git pull from a clone that recorded a change rebuilds the output", (t) => {
    const origin = join(t.tmp, "origin.git");
    sh(["git", "init", "-q", "--bare", "-b", "main", origin], { cwd: t.tmp });
    t.recordFeature();
    git(t, ["remote", "add", "origin", origin]);
    git(t, ["push", "-q", "origin", "main"]);
    sh(["git", "clone", "-q", origin, "second"], { cwd: t.tmp });
    const second = new Repo(join(t.tmp, "second"));
    second.write(OURS, "pulled\n");
    second.commit("data, without a build");
    sh(["git", "push", "-q", "origin", "main"], { cwd: second.path });
    git(t, ["pull", "-q", "origin", "main"], hooked(t));
    expect(t.fork.read("extra.txt")).toBe("pulled\n");
  });

  forkTest("the branches of the #334 repro merge and rebuild with no manual build", (t) => {
    git(t, ["switch", "-qc", "b1"]);
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    sh(["git", "commit", "-qam", "b1"], { cwd: t.fork.path, env: hooked(t, { PATCHBOOK_INTENT: "Shout the second line." }) });
    git(t, ["switch", "-q", "main"]);
    git(t, ["switch", "-qc", "b2"]);
    t.fork.write("app2.txt", "second\n");
    git(t, ["add", "-A"]);
    sh(["git", "commit", "-qm", "b2"], { cwd: t.fork.path, env: hooked(t, { PATCHBOOK_INTENT: "Add app2.txt." }) });
    git(t, ["switch", "-q", "main"]);
    git(t, ["merge", "-q", "b1"], hooked(t));
    git(t, ["merge", "-q", "b2", "-m", "merge b2"], hooked(t));
    const paths = read(join(t.fork.path, ".patchbook/build.lock")).split("\n").filter(Boolean).map((l) => l.replace(/^\d{6} [0-9a-f]{40} /, ""));
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain("app2.txt");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("a build that fails after a merge says why and leaves the merge done", (t) => {
    staleBranch(t);
    git(t, ["switch", "-q", "data"]);
    writeFileSync(join(t.fork.path, ".patchbook/series"), read(join(t.fork.path, ".patchbook/series")) + "bogus\n");
    t.fork.commit("a series naming no change");
    git(t, ["switch", "-q", "main"]);
    const merged = git(t, ["merge", "-q", "data"], hooked(t), false);
    expect(merged.code).toBe(0);
    expect(merged.stderr).toContain("no change called bogus");
    expect(merged.stderr).toContain("patchbook: couldn't rebuild the output after this git command");
    expect(git(t, ["rev-parse", "HEAD"]).stdout).toBe(git(t, ["rev-parse", "data"]).stdout);
  });

  forkTest("a merge over a hand edit says the build was refused, and keeps the edit", (t) => {
    staleBranch(t);
    t.fork.write("docs/new.txt", "hand edit\n");
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("three", "THREE"));
    const merged = git(t, ["merge", "-q", "data"], hooked(t), false);
    expect(merged.code).toBe(0);
    expect(merged.stderr).toContain("these output files changed since the last build");
    expect(t.fork.read("app.txt")).toContain("THREE");
  });

  forkTest("PATCHBOOK_HOOK=0 and hook.enabled turn the post hooks off", (t) => {
    staleBranch(t);
    git(t, ["merge", "-q", "data"], hooked(t, { PATCHBOOK_HOOK: "0" }));
    expect(t.fork.read("extra.txt")).toBe("ours\n");
    git(t, ["reset", "-q", "--hard", "ORIG_HEAD"]);
    t.pb(["config", "hook.enabled", "false"], { cwd: t.fork.path });
    const env = { ...t.env };
    delete env["PATCHBOOK_HOOK"];
    git(t, ["checkout", "-q", "data"], env);
    expect(t.fork.read("extra.txt")).toBe("ours\n");
  });

  forkTest("status notes the output is behind the patchbook, and not after a build", (t) => {
    staleBranch(t);
    git(t, ["switch", "-q", "data"]);
    const behind = t.pb(["status"], { cwd: t.fork.path });
    expect(behind.stdout).toContain("note      the output is behind the patchbook: extra.txt differs from a build. Run `patchbook build`.\n");
    expect(behind.stdout).toContain("no problems");
    expect(behind.code).toBe(0);
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).not.toContain("behind");
  });

  forkTest("status does not call a hand edit behind the patchbook", (t) => {
    t.fork.write("app.txt", t.fork.read("app.txt").replaceAll("two", "TWO"));
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).not.toContain("behind");
  });

  test("hook install puts the post hooks first in the scripts a hook manager runs", () => {
    const t = new Case();
    try {
      const fork = forkWith(t, { ".husky/pre-commit": NOTE_STAGED });
      installManager(fork, ".husky");
      const install = t.pb(["hook", "install"], { cwd: fork.path }).stderr;
      expect(install).toContain("recorded the edit in the patchbook");
      for (const name of POST) {
        expect(fork.read(`.husky/${name}`)).toContain("patchbook hook build");
        expect(isExecutable(join(fork.path, ".husky", name))).toBe(true);
      }
      expect(fork.read(".husky/post-checkout")).toContain('[ "$3" = 1 ]');
      expect(t.pb(["hook", "install"], { cwd: fork.path }).stderr).not.toContain("put `patchbook hook build`");
      t.pb(["build"], { cwd: fork.path });
      expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  test("hook install prints what to add when another tool's post hook is in the way", () => {
    const t = new Case();
    try {
      const fork = forkWith(t, {});
      for (const name of POST) rmSync(join(fork.path, ".git/hooks", name));
      writeFileSync(join(fork.path, ".git/hooks/post-merge"), "#!/bin/sh\necho theirs\n", { mode: 0o755 });
      const install = t.pb(["hook", "install"], { cwd: fork.path }).stderr;
      expect(install).toContain("post-merge");
      expect(install).toContain("patchbook hook build");
      expect(fork.read(".git/hooks/post-merge")).toBe("#!/bin/sh\necho theirs\n");
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
});
