import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Case, Repo, TIMEOUT, type Run, crashCmd, sh } from "../helpers";
import { read, isSymlink, tree, checkedUpstream, lockPin, lockNames, withPin, forkOf, ForkCase, forkTest, forkTestOnCaseSensitiveFs, installManager, NOTE_STAGED, SKILL_FILE, AWKWARD, upstreamsOf, repoState, fakeSsh, startingRepo } from "../e2e-fixtures.ts";

test("clone keeps the destination it was given", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream.git"));
    up.write("a.txt", "a\n");
    up.commit("start");
    t.pb(["clone", up.path, "work.git"], { cwd: t.tmp });
    expect(existsSync(join(t.tmp, "work.git/.patchbook/config.toml"))).toBe(true);
    expect(existsSync(join(t.tmp, "work"))).toBe(false);
    t.pb(["clone", up.path], { cwd: t.tmp }); // the default name drops the .git
    expect(existsSync(join(t.tmp, "upstream/.patchbook/config.toml"))).toBe(true);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("clone finishes when the skill cannot be installed", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write(".agents", "not a folder\n");
    up.commit("start");
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    expect(out.stderr).toContain("patchbook: couldn't install the update skill");
    const fork = join(t.tmp, "fork");
    expect(sh(["git", "log", "--format=%s"], { cwd: fork }).stdout).toContain("Start a patchbook at upstream");
    expect(sh(["git", "status", "--porcelain"], { cwd: fork }).stdout).toBe("");
    expect(read(join(fork, ".agents"))).toBe("not a folder\n");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("init --path . takes the whole upstream, and a path that climbs out is refused cleanly", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.write("sub/lib.txt", "two\n");
    up.commit("start");
    const empty = new Repo(join(t.tmp, "empty"));
    t.pb(["init", "--upstream", up.path, "--path", ".", "--output-to", "out"], { cwd: empty.path });
    const config = read(join(empty.path, ".patchbook/config.toml"));
    expect(config).not.toContain("path =");
    expect(config).toContain(`name = "upstream"`);
    t.pb(["build"], { cwd: empty.path });
    expect(read(join(empty.path, "out/app.txt"))).toBe("one\n");

    const sub = new Repo(join(t.tmp, "sub"));
    t.pb(["init", "--upstream", up.path, "--path", "./sub/", "--output-to", "out"], { cwd: sub.path });
    expect(read(join(sub.path, ".patchbook/config.toml"))).toContain(`path = "sub"`);

    const bad = new Repo(join(t.tmp, "bad"));
    const out = t.pb(["init", "--upstream", up.path, "--path", "../x", "--output-to", "out"], { cwd: bad.path, code: 1 });
    expect(out.stderr).toContain("must name a folder inside the upstream");
    expect(existsSync(join(bad.path, ".patchbook"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("a trailing slash on --path or a config path names the same folder, so ./ is the upstream root", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("README.md", "top\n");
    up.write("sub/a.txt", "two\n");
    up.commit("start");
    for (const spelling of ["./", ".//", "sub/..//"]) {
      const repo = new Repo(join(t.tmp, `root${spelling.length}`));
      t.pb(["init", "--upstream", up.path, "--path", spelling, "--output-to", "out"], { cwd: repo.path });
      const config = read(join(repo.path, ".patchbook/config.toml"));
      expect(config).toContain(`name = "upstream"`);
      expect(config).not.toContain("path =");
      t.pb(["build"], { cwd: repo.path });
      expect(read(join(repo.path, "out/README.md"))).toBe("top\n");
    }

    const sub = new Repo(join(t.tmp, "sub"));
    t.pb(["init", "--upstream", up.path, "--path", ".//sub//", "--output-to", "out"], { cwd: sub.path });
    expect(read(join(sub.path, ".patchbook/config.toml"))).toContain(`path = "sub"`);
    t.pb(["track", "again", up.path, "--path", "./"], { cwd: sub.path });
    const tracked = read(join(sub.path, ".patchbook/config.toml"));
    expect(tracked).toContain(`name = "again"`);
    expect(tracked).not.toMatch(/path = "\.?"/);
    t.pb(["build"], { cwd: sub.path });
    expect(read(join(sub.path, "out/a.txt"))).toBe("two\n");
    expect(read(join(sub.path, "out/again/README.md"))).toBe("top\n");

    const edited = new Repo(join(t.tmp, "edited"));
    t.pb(["init", "--upstream", up.path, "--path", "sub", "--output-to", "out"], { cwd: edited.path });
    const configFile = join(edited.path, ".patchbook/config.toml");
    writeFileSync(configFile, read(configFile).replace(`path = "sub"`, `path = "./"`));
    t.pb(["build"], { cwd: edited.path });
    expect(read(join(edited.path, "out/README.md"))).toBe("top\n");

    const bad = new Repo(join(t.tmp, "bad"));
    const out = t.pb(["init", "--upstream", up.path, "--path", "../", "--output-to", "out"], { cwd: bad.path, code: 1 });
    expect(out.stderr).toContain("must name a folder inside the upstream");
    expect(existsSync(join(bad.path, ".patchbook"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("clone and init point to the scheduled updates section", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    const cloned = t.pb(["clone", up.path, "fork"], { cwd: t.tmp }).stdout;
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const forked = t.pb(["init", "--upstream", up.path], { cwd: join(t.tmp, "mine") }).stdout;
    const adapted = new Repo(join(t.tmp, "adapted"));
    adapted.write("README.md", "mine\n");
    adapted.commit("start");
    const folder = t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: adapted.path }).stdout;
    for (const out of [cloned, forked, folder]) {
      expect(out).toContain("https://github.com/willgosnold/patchbook#scheduled-updates");
      expect(out).toContain('"Use the patchbook-update skill."');
      expect(out).not.toContain("T3 scheduled task");
    }
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("clone of a patchbook repo starts a patchbook of its own", () => {
  const t = new Case();
  try {
    const base = new Repo(join(t.tmp, "base"));
    base.write("app.txt", "one\ntwo\n");
    base.commit("start");
    t.pb(["clone", base.path, "theirs"], { cwd: t.tmp });
    const theirs = new Repo(join(t.tmp, "theirs"));
    theirs.write("app.txt", "one\nTHEIRS\n");
    t.pb(["record", "theirs-change", "--intent", "Theirs."], { cwd: theirs.path });
    t.pb(["build"], { cwd: theirs.path });
    theirs.commit("theirs");

    const cloned = t.pb(["clone", theirs.path, "mine"], { cwd: t.tmp }).stdout;
    const mine = new Repo(join(t.tmp, "mine"));
    expect(t.pb(["status"], { cwd: mine.path }).stdout).toContain("no problems");
    expect(cloned).toContain("Upstream has a .patchbook/ of its own");
    expect(existsSync(join(mine.path, ".patchbook/changes/theirs-change"))).toBe(false);

    mine.write("app.txt", "one\nMINE\n");
    t.pb(["record", "mine", "--intent", "Mine."], { cwd: mine.path });
    const built = t.pb(["build"], { cwd: mine.path }).stdout;
    expect(built).toContain("built 1 files");
    expect(mine.read(".patchbook/series")).toBe("mine\n");
    expect(mine.read(".patchbook/config.toml")).toContain(`remote = "${theirs.path}"`);
    expect(mine.read(".patchbook/config.toml")).not.toContain(base.path);
    expect(lockNames(mine.read(".patchbook/upstream.lock"))).toEqual(["theirs"]);
    expect(mine.read("app.txt")).toBe("one\nMINE\n");
    expect(t.pb(["status"], { cwd: mine.path }).stdout).toContain("1 edits apply");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

const folded = ".PATCHBOOK/config.toml";
const cantFork = "patchbook can't fork an upstream with a folder that is .patchbook on macOS and Windows";

test("clone refuses an upstream with a .PATCHBOOK folder and writes nothing", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.write(folded, "upstream = true\n");
    up.commit("start");
    const refused = t.pb(["clone", up.path, "fork"], { cwd: t.tmp, code: 1 });
    expect(refused.stderr).toContain(folded);
    expect(refused.stderr).toContain(cantFork);
    expect(existsSync(join(t.tmp, "fork"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("init refuses an upstream with a .PATCHBOOK folder and writes nothing", () => {
  const t = new Case();
  try {
    const leaf = folded.replace("config.toml", "notes.md");
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.write(leaf, "upstream = true\n");
    up.commit("start");
    const mine = forkOf(t, up);
    const before = tree(mine.path);
    const refused = t.pb(["init", "--upstream", up.path], { cwd: mine.path, code: 1 });
    expect(refused.stderr).toContain(leaf);
    expect(refused.stderr).toContain(cantFork);
    expect(tree(mine.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

forkTest("sync and check refuse an upstream that gains a .PATCHBOOK folder and write nothing", (t) => {
  t.up.write(folded, "upstream = true\n");
  t.up.commit("upstream gains a folded folder");
  const before = tree(t.fork.path);
  for (const args of [["sync"], ["check"]]) {
    const refused = t.pb(args, { cwd: t.fork.path, code: 1 });
    expect(refused.stderr).toContain(folded);
    expect(refused.stderr).toContain(cantFork);
    expect(tree(t.fork.path)).toEqual(before);
  }
});

describe("a fork that already holds a folder read as .patchbook", () => {
  const refusedEverywhere = (t: ForkCase, hand: () => void) => {
    hand();
    const files = tree(t.fork.path);
    const recorded = t.pb(["record", "--intent", "Edit."], { cwd: t.fork.path, code: 1 });
    expect(recorded.stderr).toContain(folded);
    expect(tree(t.fork.path)).toEqual(files);
    expect(existsSync(join(t.fork.path, ".patchbook/changes"))).toBe(false);
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    const state = ["rev-parse HEAD", "diff --cached"].map((a) => sh(["git", ...a.split(" ")], { cwd: t.fork.path }).stdout).join("\n--\n");
    const committed = sh(["git", "commit", "-qm", "edit"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Edit." }, check: false });
    expect(committed.code).toBe(1);
    expect(committed.stderr).toContain(folded);
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).toBe(state.split("\n--\n")[0]!);
    expect(existsSync(join(t.fork.path, ".patchbook/changes"))).toBe(false);
  };

  forkTestOnCaseSensitiveFs("record and the hook refuse a hand edit to a folded file the pin carries", (t) => {
    t.up.write(folded, "upstream = true\n");
    const commit = t.up.commit("a fork made before folded folders were refused");
    const lock = join(t.fork.path, ".patchbook/upstream.lock");
    writeFileSync(lock, withPin(read(lock), { name: "upstream", commit, tree: sh(["git", "rev-parse", `${commit}^{tree}`], { cwd: t.up.path }).stdout.trim() }));
    t.fork.write(folded, "upstream = true\n");
    t.fork.commit("carry it");
    refusedEverywhere(t, () => t.fork.write(folded, "edited\n"));
  });

  forkTestOnCaseSensitiveFs("record and the hook refuse a hand edit to a tracked folded file", (t) => {
    t.fork.write(folded, "kept by hand\n");
    t.fork.commit("carry it");
    refusedEverywhere(t, () => t.fork.write(folded, "edited\n"));
  });
});

test("build leaves a vendored copy alone when upstream ships the folder", () => {
  const t = new Case();
  try {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "extra\n");
    extra.commit("start");
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.write("vendor/extra/stale.md", "old\n");
    up.commit("start");
    t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    const fork = new Repo(join(t.tmp, "fork"));
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: fork.path, code: 1 });
    rmSync(join(fork.path, "vendor/extra/stale.md"));
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: fork.path });
    fork.commit("track");
    t.pb(["build"], { cwd: fork.path });
    expect(existsSync(join(fork.path, "vendor/extra/stale.md"))).toBe(false);
    expect(fork.read("vendor/extra/a.md")).toBe("extra\n");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("clone does not run the hooks of a repo it forks", () => {
  const t = new Case();
  try {
    const marker = join(t.tmp, "hook-ran");
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.write(".patchbook/hooks.ts", `
      import { appendFileSync } from "node:fs";
      appendFileSync(${JSON.stringify(marker)}, "loaded\\n");
      export const finish = () => {};
    `);
    up.commit("start");
    t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    const fork = new Repo(join(t.tmp, "fork"));
    expect(existsSync(marker)).toBe(false);
    t.pb(["status"], { cwd: fork.path });
    t.pb(["build"], { cwd: fork.path });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(fork.path, ".patchbook/hooks.ts"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("clone drops an inherited patchbook that is a dangling link", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    symlinkSync("nowhere", join(up.path, ".patchbook"));
    up.commit("start");
    const cloned = t.pb(["clone", up.path, "fork"], { cwd: t.tmp }).stdout;
    const fork = new Repo(join(t.tmp, "fork"));
    expect(cloned).toContain("Upstream has a .patchbook/ of its own");
    expect(isSymlink(join(fork.path, ".patchbook"))).toBe(false);
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("a folder init writes awkward values so they read back as given", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, AWKWARD("up")));
    up.write(`${AWKWARD("plug")}/a.txt`, "a\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    const name = AWKWARD("name");
    const output = ["--output-from", AWKWARD("from"), "--output-to", AWKWARD("out") + "\tz"];
    t.pb(["init", "--upstream", up.path, "--name", name, "--path", AWKWARD("plug"), "--vendor", AWKWARD("vend"), ...output], { cwd: repo.path });
    const config = Bun.TOML.parse(repo.read(".patchbook/config.toml")) as { upstream: Record<string, unknown>[]; output: Record<string, unknown> };
    expect(config.upstream[0]).toMatchObject({ name, remote: up.path, path: AWKWARD("plug"), vendor: AWKWARD("vend") });
    expect(config.output).toEqual({ from: AWKWARD("from"), to: AWKWARD("out") + "\tz" });
    expect(t.pb(["status"], { cwd: repo.path }).stdout).toContain(name);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("a fork init writes awkward values so they read back as given", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, AWKWARD("up")));
    up.write("app.txt", "one\n");
    const base = up.commit("start");
    sh(["git", "clone", "-q", up.path, "fork"], { cwd: t.tmp });
    const name = AWKWARD("name");
    const init = t.pb(["init", "--upstream", up.path, "--name", name], { cwd: join(t.tmp, "fork") });
    expect(init.stdout).toContain(`pinned upstream at ${base.slice(0, 7)}`);
    expect(upstreamsOf(read(join(t.tmp, "fork/.patchbook/config.toml")))[0]).toMatchObject({ name, remote: up.path });
    expect(t.pb(["status"], { cwd: join(t.tmp, "fork") }).stdout).toContain("no problems");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("init into patchbook names output to not mount", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.txt", "a\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    const init = t.pb(["init", "--upstream", up.path, "--output-to", ".patchbook/out"], { cwd: repo.path, code: 1 });
    expect(init.stderr).toContain("inside .patchbook");
    expect(init.stderr).toContain("Change [output] to.");
    expect(init.stderr).not.toContain("Change mount");
    expect(existsSync(join(repo.path, ".patchbook"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("init rejects a vendor folder inside the output before it writes anything", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.txt", "a\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    const init = t.pb(["init", "--upstream", up.path, "--output-to", "out", "--vendor", "out/vendored"], { cwd: repo.path, code: 1 });
    expect(init.stderr).toContain("the vendored copy of upstream (out/vendored) overlaps the folder upstream builds into (out)");
    expect(init.stderr).toContain("Change vendor for upstream or [output] to.");
    expect(init.stderr).not.toContain("mount");
    expect(existsSync(join(repo.path, ".patchbook"))).toBe(false);
    expect(existsSync(join(repo.path, "out"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("init rejects a vendor folder inside the output when --output-from is set", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("skills/a.txt", "a\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    const init = t.pb(["init", "--upstream", up.path, "--output-from", "skills", "--output-to", "skills", "--vendor", "skills/vendored"], { cwd: repo.path, code: 1 });
    expect(init.stderr).toContain(
      "the vendored copy of upstream (skills/vendored) overlaps the folder upstream builds into (skills). A build writes there, but a vendored copy must match upstream exactly. Change vendor for upstream or [output] to.",
    );
    expect(existsSync(join(repo.path, ".patchbook"))).toBe(false);
    expect(existsSync(join(repo.path, "skills"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("an output folder with glob characters builds twice beside a folder it would match", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.md", "a\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.write("other/notes.md", "notes\n");
    repo.commit("start");
    t.pb(["init", "--upstream", up.path, "--output-to", "o*"], { cwd: repo.path });
    t.pb(["build"], { cwd: repo.path });
    const second = t.pb(["build"], { cwd: repo.path });
    expect(second.stdout).toContain("built 1 files");
    expect(second.stderr).not.toContain("changed since the last build");
    expect(repo.read("o*/a.md")).toBe("a\n");
    expect(repo.read("other/notes.md")).toBe("notes\n");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("the commit hook stages only the output file it names when the folder has glob characters", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.md", "a\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.write("other/a.md", "theirs\n");
    repo.commit("start");
    t.pb(["init", "--upstream", up.path, "--output-to", "o*"], { cwd: repo.path });
    t.pb(["build"], { cwd: repo.path });
    repo.commit("build");
    repo.write("o*/a.md", "edited\n");
    repo.write("other/a.md", "unrelated work\n");
    sh(["git", "add", "--", ":(literal)o*/a.md"], { cwd: repo.path });
    const env = { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Edit a." };
    sh(["git", "commit", "-qm", "edit a"], { cwd: repo.path, env });
    const committed = sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: repo.path }).stdout;
    expect(committed).toContain("o*/a.md");
    expect(committed).not.toContain("other/a.md");
    expect(sh(["git", "status", "--short"], { cwd: repo.path }).stdout).toContain(" M other/a.md");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("the commit hook reads an output folder whose name starts with a colon", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.md", "a\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    t.pb(["init", "--upstream", up.path, "--output-to", ":x"], { cwd: repo.path });
    t.pb(["build"], { cwd: repo.path });
    repo.commit("build");
    repo.write("README.md", "mine, edited\n");
    sh(["git", "add", "README.md"], { cwd: repo.path });
    const env = { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Edit the readme." };
    sh(["git", "commit", "-qm", "edit the readme"], { cwd: repo.path, env });
    expect(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: repo.path }).stdout.trim()).toBe("README.md");
    expect(sh(["git", "ls-files", "--", ":(literal):x/a.md"], { cwd: repo.path }).stdout.trim()).toBe(":x/a.md");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("a vendored folder with glob characters builds only its own files", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.md", "a\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.write("v*/a.md", "a\n");
    repo.write("vx/n.md", "n\n");
    repo.commit("start");
    t.pb(["init", "--upstream", up.path, "--output-to", "out", "--vendor", "v*"], { cwd: repo.path });
    const built = t.pb(["build"], { cwd: repo.path });
    expect(built.stdout).toContain("built 1 files");
    expect(Object.keys(tree(join(repo.path, "out")))).toEqual(["a.md"]);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("a missing vendor folder is named by its plain path in the error", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.md", "a\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    t.pb(["init", "--upstream", up.path, "--output-to", "out", "--vendor", "nope"], { cwd: repo.path });
    rmSync(join(repo.path, "nope"), { recursive: true, force: true });
    const built = t.pb(["build"], { cwd: repo.path, code: 1 });
    expect(built.stderr).toContain("(nope) is empty or missing");
    expect(built.stderr).not.toContain(":(literal)");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("an init whose sync fails leaves no patchbook and can be retried", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("skills/a.md", "a\n");
    const commit = up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    const output = ["--output-from", "skills", "--output-to", "skills"];
    const init = t.pb(["init", "--upstream", join(t.tmp, "no-such-repo"), ...output], { cwd: repo.path, code: 1 });
    expect(init.stderr).toContain("git fetch");
    expect(existsSync(join(repo.path, ".patchbook"))).toBe(false);
    t.pb(["init", "--upstream", up.path, ...output], { cwd: repo.path });
    expect(lockPin(repo.read(".patchbook/upstream.lock"), "upstream").commit).toBe(commit);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const bad of ["no-such-repo", "unrelated"]) {
  test(`a fork init against ${bad} leaves no patchbook and can be retried`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      const base = up.commit("start");
      sh(["git", "clone", "-q", up.path, "fork"], { cwd: t.tmp });
      const fork = new Repo(join(t.tmp, "fork"));
      fork.write("mine.txt", "mine\n");
      fork.commit("mine");
      up.write("app.txt", "two\n");
      up.commit("later");
      const unrelated = new Repo(join(t.tmp, "unrelated"));
      unrelated.write("other.txt", "other\n");
      unrelated.commit("other");
      t.pb(["init", "--upstream", join(t.tmp, bad)], { cwd: fork.path, code: 1 });
      expect(existsSync(join(fork.path, ".patchbook"))).toBe(false);
      const init = t.pb(["init", "--upstream", up.path], { cwd: fork.path });
      expect(init.stdout).toContain(`pinned upstream at ${base.slice(0, 7)}`);
      expect(sh(["git", "remote", "get-url", "upstream"], { cwd: fork.path }).stdout.trim()).toBe(up.path);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

for (const again of ["the same URL", "another URL"]) {
  test(`a fork init that fails changes nothing so a retry with ${again} runs like a first init`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      const fork = forkOf(t, up);
      sh(["git", "clone", "-q", up.path, "moved"], { cwd: t.tmp });
      const moved = new Repo(join(t.tmp, "moved"));
      moved.write("app.txt", "two\n");
      moved.commit("two");
      mkdirSync(join(fork.path, ".patchbook"));
      symlinkSync(join(t.tmp, "missing/config.toml"), join(fork.path, ".patchbook/config.toml"));
      const before = repoState(fork.path);
      t.pb(["init", "--upstream", up.path], { cwd: fork.path, code: 1 });
      expect(repoState(fork.path)).toEqual(before);
      rmSync(join(fork.path, ".patchbook"), { recursive: true });
      sh(["git", "clone", "-q", up.path, "twin"], { cwd: t.tmp });
      const twin = new Repo(join(t.tmp, "twin"));
      twin.write("mine.txt", "mine\n");
      twin.commit("mine");
      const url = again === "the same URL" ? up.path : moved.path;
      const first = t.pb(["init", "--upstream", url], { cwd: twin.path });
      const retry = t.pb(["init", "--upstream", url], { cwd: fork.path });
      expect([retry.stdout, retry.stderr]).toEqual([first.stdout, first.stderr]);
      expect(tree(join(fork.path, ".patchbook"))).toEqual(tree(join(twin.path, ".patchbook")));
      expect(sh(["git", "remote", "get-url", "upstream"], { cwd: fork.path }).stdout.trim()).toBe(url);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

for (const [how, leave] of [
  ["added by the user",(_: Case, fork: Repo, up: Repo) => void sh(["git", "remote", "add", "upstream", up.path], { cwd: fork.path })],
  ["listing the given url second", (t: Case, fork: Repo, up: Repo) => {
    sh(["git", "remote", "add", "upstream", up.path], { cwd: fork.path });
    sh(["git", "config", "--add", "remote.upstream.url", join(t.tmp, "moved")], { cwd: fork.path });
  }],
] as const) {
  test(`a fork init refuses an upstream remote that fetches another URL ${how}`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      const fork = forkOf(t, up);
      sh(["git", "clone", "-q", up.path, "moved"], { cwd: t.tmp });
      const moved = new Repo(join(t.tmp, "moved"));
      moved.write("app.txt", "two\n");
      const head = moved.commit("two");
      leave(t, fork, up);
      const refused = t.pb(["init", "--upstream", moved.path], { cwd: fork.path, code: 1 });
      expect(refused.stderr).toContain("the upstream remote and --upstream serve different commits for main");
      expect(refused.stderr).toContain(`The remote fetches ${up.path}, --upstream is ${moved.path}`);
      expect(refused.stderr).toContain(`git config --replace-all remote.upstream.url ${moved.path}`);
      expect(existsSync(join(fork.path, ".patchbook/config.toml"))).toBe(false);
      sh(["git", "config", "--replace-all", "remote.upstream.url", moved.path], { cwd: fork.path });
      t.pb(["init", "--upstream", moved.path], { cwd: fork.path });
      expect(checkedUpstream(t.pb(["check"], { cwd: fork.path, code: 10 }).stdout, "moved").head).toBe(head);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

for (const [how, remote, given] of [
  ["an insteadOf alias", () => "alias:upstream", (up: string) => up],
  ["a trailing slash on the remote", (up: string) => up + "/", (up: string) => up],
  ["a trailing slash on the given url", (up: string) => up, (up: string) => up + "/"],
  ["a file url", (up: string) => `file://${up}`, (up: string) => up],
  ["a relative remote", () => "../upstream", (up: string) => up],
  ["a relative given url", (up: string) => up, () => "../upstream"],
] as const) {
  test(`a fork init accepts an upstream remote spelled with ${how}`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      const base = up.commit("start");
      const fork = forkOf(t, up);
      sh(["git", "config", `url.${t.tmp}/.insteadOf`, "alias:"], { cwd: fork.path });
      sh(["git", "remote", "add", "upstream", remote(up.path)], { cwd: fork.path });
      const init = t.pb(["init", "--upstream", given(up.path)], { cwd: fork.path });
      expect(init.stdout).toContain(`pinned upstream at ${base.slice(0, 7)}`);
      expect(fork.read(".patchbook/config.toml")).toContain(`remote = "${resolve(realpathSync(fork.path), given(up.path))}"`);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

for (const name of ["my up", "it's up"]) {
  test(`the command a refused fork init prints works for ${name}`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      const fork = forkOf(t, up);
      sh(["git", "remote", "add", "upstream", up.path], { cwd: fork.path });
      sh(["git", "clone", "-q", up.path, name], { cwd: t.tmp });
      const other = join(t.tmp, name);
      const moved = new Repo(other);
      moved.write("app.txt", "two\n");
      moved.commit("two");
      const refused = t.pb(["init", "--upstream", other], { cwd: fork.path, code: 1 });
      const fix = /^.*To follow .*?: (git config --replace-all remote\.upstream\.url .*)$/m.exec(refused.stderr)?.[1];
      expect(fix).toBeDefined();
      sh(["sh", "-c", fix!], { cwd: fork.path });
      expect(sh(["git", "remote", "get-url", "upstream"], { cwd: fork.path }).stdout.trim()).toBe(other);
      t.pb(["init", "--upstream", other], { cwd: fork.path });
      expect(existsSync(join(fork.path, ".patchbook/config.toml"))).toBe(true);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("a fork init names a fix for an upstream remote with no URL", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    const fork = forkOf(t, up);
    sh(["git", "remote", "add", "upstream", up.path], { cwd: fork.path });
    sh(["git", "config", "--unset", "remote.upstream.url"], { cwd: fork.path });
    sh(["git", "config", "remote.upstream.pushurl", up.path], { cwd: fork.path });
    const refused = t.pb(["init", "--upstream", up.path], { cwd: fork.path, code: 1 });
    expect(refused.stderr).toContain("the upstream remote has no url");
    expect(refused.stderr).toContain(`git config --replace-all remote.upstream.url ${up.path}`);
    expect(existsSync(join(fork.path, ".patchbook"))).toBe(false);
    sh(["git", "config", "--replace-all", "remote.upstream.url", up.path], { cwd: fork.path });
    t.pb(["init", "--upstream", up.path], { cwd: fork.path });
    expect(t.pb(["status"], { cwd: fork.path, code: 1 }).stdout).toContain("unrecorded mine.txt");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const [how, repoName, remote, given] of [
  ["a .git suffix", "upstream", (up: string) => `ssh://git@fake${up}.git`, (up: string) => `ssh://git@fake${up}`],
  ["a percent encoded file url", "my up", (up: string) => `file://${up.replace(" ", "%20")}`, (up: string) => up],
  ["scp against ssh", "upstream", (up: string) => `git@fake:${up}`, (up: string) => `ssh://git@fake${up}`],
  ["ssh against scp", "upstream", (up: string) => `ssh://git@fake${up}`, (up: string) => `git@fake:${up}`],
] as const) {
  test(`a fork init accepts an upstream remote that serves the same repo as ${how}`, () => {
    const t = new Case();
    try {
      fakeSsh(t);
      const up = new Repo(join(t.tmp, repoName));
      up.write("app.txt", "one\n");
      const base = up.commit("start");
      if (how === "a .git suffix") symlinkSync(up.path, up.path + ".git");
      const fork = forkOf(t, up);
      sh(["git", "remote", "add", "upstream", remote(up.path)], { cwd: fork.path });
      const init = t.pb(["init", "--upstream", given(up.path)], { cwd: fork.path });
      expect(init.stdout).toContain(`pinned upstream at ${base.slice(0, 7)}`);
      expect(fork.read(".patchbook/config.toml")).toContain(`remote = "${given(up.path)}"`);
    } finally {
      delete process.env["GIT_SSH_COMMAND"];
      t.cleanup();
    }
  }, TIMEOUT);
}

for (const [which, how] of [["remote", "the upstream remote"], ["given", "the given url"]] as const) {
  test(`a fork init names ${how} when git cannot read it`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      const fork = forkOf(t, up);
      const gone = join(t.tmp, "gone");
      sh(["git", "remote", "add", "upstream", which === "remote" ? gone : up.path], { cwd: fork.path });
      const refused = t.pb(["init", "--upstream", which === "remote" ? up.path : gone], { cwd: fork.path, code: 1 });
      expect(refused.stderr).toContain(`couldn't read ${which === "remote" ? "the upstream remote" : "--upstream"} ${gone}`);
      expect(refused.stderr).toContain("does not appear to be a git repository");
      expect(existsSync(join(fork.path, ".patchbook"))).toBe(false);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("a fork init from a subfolder takes a relative upstream from where it ran", () => {
  for (const hasRemote of [true, false]) {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      const base = up.commit("start");
      const fork = forkOf(t, up);
      if (hasRemote) sh(["git", "remote", "add", "upstream", up.path], { cwd: fork.path });
      mkdirSync(join(fork.path, "sub"));
      const init = t.pb(["init", "--upstream", "../../upstream"], { cwd: join(fork.path, "sub") });
      expect(init.stdout).toContain(`pinned upstream at ${base.slice(0, 7)}`);
      expect(readFileSync(join(fork.path, ".patchbook/config.toml"), "utf8")).toContain(`remote = "${realpathSync(up.path)}"`);
      expect(sh(["git", "remote", "get-url", "upstream"], { cwd: fork.path }).stdout.trim()).toBe(hasRemote ? up.path : realpathSync(up.path));
    } finally {
      t.cleanup();
    }
  }
}, TIMEOUT);

test("a fork init from a subfolder prints a fix that names the folder meant", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    const fork = forkOf(t, up);
    sh(["git", "remote", "add", "upstream", up.path], { cwd: fork.path });
    sh(["git", "clone", "-q", up.path, "moved"], { cwd: t.tmp });
    const moved = new Repo(join(t.tmp, "moved"));
    moved.write("app.txt", "two\n");
    const head = moved.commit("two");
    mkdirSync(join(fork.path, "sub"));
    const sub = join(fork.path, "sub");
    const refused = t.pb(["init", "--upstream", "../../moved"], { cwd: sub, code: 1 });
    const fix = /^.*To follow .*?: (git config --replace-all remote\.upstream\.url .*)$/m.exec(refused.stderr)?.[1];
    expect(fix).toBeDefined();
    sh(["sh", "-c", fix!], { cwd: sub });
    expect(sh(["git", "remote", "get-url", "upstream"], { cwd: fork.path }).stdout.trim()).toBe(realpathSync(moved.path));
    t.pb(["init", "--upstream", "../../moved"], { cwd: sub });
    expect(checkedUpstream(t.pb(["check"], { cwd: fork.path, code: 10 }).stdout, "moved").head).toBe(head);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const [layout, hasRemote] of [["fork", true], ["folder", false]] as const) {
  test(`a ${layout} init rejects an upstream that starts with a dash${hasRemote ? " with a remote" : ""}`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      const fork = forkOf(t, up);
      if (hasRemote) sh(["git", "remote", "add", "upstream", up.path], { cwd: fork.path });
      const out = layout === "fork" ? [] : ["--output-to", "out"];
      const refused = t.pb(["init", "--upstream=-x", ...out], { cwd: fork.path, code: 1 });
      expect(refused.stderr).toContain('remote "-x" starts with "-", so git would read it as an option.');
      expect(refused.stderr).not.toContain("usage");
      expect(existsSync(join(fork.path, ".patchbook"))).toBe(false);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

forkTest("a message escapes the control and format characters in a config value", (t) => {
  const config = join(t.fork.path, ".patchbook/config.toml");
  writeFileSync(config, read(config).replace(/^layout = .*$/m, 'layout = "x\\u009b2Jy\\u202ez\\u007f\\u0085"'));
  const refused = t.pb(["status"], { cwd: t.fork.path, code: 1 });
  expect(refused.stderr).toContain('layout must be folder or fork, not "x\\u009b2Jy\\u202ez\\u007f\\u0085"');
  expect(refused.stderr.replace(/\n$/, "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
});

test("a refused fork init does not print the password in a remote", () => {
  const t = new Case();
  try {
    fakeSsh(t);
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    const fork = forkOf(t, up);
    sh(["git", "remote", "add", "upstream", `ssh://user:s3cretpw@fake${up.path}`], { cwd: fork.path });
    sh(["git", "clone", "-q", up.path, "moved"], { cwd: t.tmp });
    const moved = new Repo(join(t.tmp, "moved"));
    moved.write("app.txt", "two\n");
    moved.commit("two");
    const refused = t.pb(["init", "--upstream", `ssh://user@fake${moved.path}`], { cwd: fork.path, code: 1 });
    expect(refused.stderr).toContain("the upstream remote and --upstream serve different commits for main");
    expect(refused.stderr).toContain(`The remote fetches ssh://user@fake${up.path}, --upstream is ssh://user@fake${moved.path}`);
    expect(refused.stderr).not.toContain("s3cretpw");
  } finally {
    delete process.env["GIT_SSH_COMMAND"];
    t.cleanup();
  }
}, TIMEOUT);

for (const [how, hasRemote] of [["unreachable remote", true], ["unreachable given url", false]] as const) {
  test(`a fork init with an ${how} does not print the password`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      const fork = forkOf(t, up);
      const secret = "https://user:s3cretpw@host.invalid/team/up";
      if (hasRemote) sh(["git", "remote", "add", "upstream", secret], { cwd: fork.path });
      const refused = t.pb(["init", "--upstream", hasRemote ? up.path : secret], { cwd: fork.path, code: 1 });
      expect(refused.stderr).toContain("host.invalid");
      expect(refused.stderr).not.toContain("s3cretpw");
      expect(existsSync(join(fork.path, ".patchbook"))).toBe(false);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("a fork init names the repo it follows without the password of its upstream remote", () => {
  const t = new Case();
  try {
    fakeSsh(t);
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    const fork = forkOf(t, up);
    sh(["git", "remote", "add", "upstream", `ssh://user:s3cretpw@fake${up.path}`], { cwd: fork.path });
    const init = t.pb(["init", "--upstream", `ssh://user@fake${up.path}`], { cwd: fork.path });
    expect(init.stdout).toContain(`branched from ssh://user@fake${up.path}.`);
    expect(init.stdout).not.toContain("s3cretpw");
    expect(fork.read(".patchbook/config.toml")).toContain(`remote = "ssh://user@fake${up.path}"`);
  } finally {
    delete process.env["GIT_SSH_COMMAND"];
    t.cleanup();
  }
}, TIMEOUT);

for (const [how, branch, onRemote] of [["a stale mirror", "main", true], ["a branch only the given url has", "feature", false]] as const) {
  test(`a fork init says the remote serves different commits for ${how} and names the tip on each side`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      const base = up.commit("start");
      const fork = forkOf(t, up);
      sh(["git", "clone", "-q", up.path, "mirror"], { cwd: t.tmp });
      sh(["git", "remote", "add", "upstream", join(t.tmp, "mirror")], { cwd: fork.path });
      up.write("app.txt", "two\n");
      const head = up.commit("two");
      sh(["git", "branch", "feature"], { cwd: up.path });
      const refused = t.pb(["init", "--upstream", up.path, "--branch", branch], { cwd: fork.path, code: 1 });
      expect(refused.stderr).toContain(`the upstream remote and --upstream serve different commits for ${branch}`);
      expect(refused.stderr).toContain(`${branch} is ${onRemote ? base.slice(0, 7) : "missing"} on the remote and ${head.slice(0, 7)} on --upstream`);
      expect(refused.stderr).not.toContain("different repos");
      expect(refused.stderr).toContain(`git config --replace-all remote.upstream.url ${up.path}`);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("clone and init name the upstream after the host of a URL with no path", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    const url = "https://host.invalid/";
    Object.assign(t.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${up.path}.insteadOf`, GIT_CONFIG_VALUE_0: url });
    t.pb(["clone", url], { cwd: t.tmp });
    const fork = forkOf(t, up);
    t.pb(["init", "--upstream", url], { cwd: fork.path });
    for (const dir of [join(t.tmp, "host.invalid"), fork.path]) {
      expect(read(join(dir, ".patchbook/config.toml"))).toContain('name = "host.invalid"');
      expect(t.pb(["status"], { cwd: dir, code: dir === fork.path ? 1 : 0 }).stdout).toContain("at host.invalid ");
    }
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const [how, hasRemote] of [["remote", true], ["given url", false]] as const) {
  test(`a fork init does not print a password with an at sign hash or question mark in the ${how}`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      const fork = forkOf(t, up);
      for (const password of ["p@s3cret", "p#s3cret", "p?s3cret"]) {
        const secret = `https://user:${password}@host.invalid/team/up`;
        if (hasRemote) sh(["git", "remote", "remove", "upstream"], { cwd: fork.path, check: false });
        if (hasRemote) sh(["git", "remote", "add", "upstream", secret], { cwd: fork.path });
        const refused = t.pb(["init", "--upstream", hasRemote ? up.path : secret], { cwd: fork.path, code: 1 });
        expect(refused.stderr).toContain("host.invalid/team/up");
        expect(refused.stderr).not.toContain("s3cret");
      }
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

for (const [how, dir, given] of [
  ["\"..\" from a subfolder", "sub", () => ".."],
  ["\".\" at the root", "", () => "."],
  ["a file url with an encoded slash after the host", "", (fork: string) => `file://example.invalid%2F${fork.slice(1)}`],
  ["a file url whose host is not UTF-8", "", (fork: string) => `file://%ff${fork}`],
  ["a path that git reads from its closing bracket", "", () => "x@[y]"],
  ["a path that git finds with .git added", "", (fork: string) => `${fork}-self`],
  ["a linked worktree", "", () => "../worktree"],
  ["an insteadOf alias", "", () => "self:"],
] as const) {
  test(`a fork init refuses an upstream that is the repo itself given as ${how}`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      const fork = forkOf(t, up);
      mkdirSync(join(fork.path, "sub"));
      sh(["git", "worktree", "add", "-q", "--detach", "../worktree"], { cwd: fork.path });
      sh(["git", "config", `url.${fork.path}.insteadOf`, "self:"], { cwd: fork.path });
      symlinkSync(fork.path, `${fork.path}-self.git`);
      symlinkSync(fork.path, join(fork.path, "]"));
      const refused = t.pb(["init", "--upstream", given(fork.path)], { cwd: join(fork.path, dir), code: 1 });
      expect(refused.stderr).toContain("is this repo");
      expect(existsSync(join(fork.path, ".patchbook"))).toBe(false);
      expect(sh(["git", "remote"], { cwd: fork.path }).stdout.trim()).toBe("origin");
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

for (const [how, remote] of [
  ["dot", () => "."],
  ["an alias that another insteadOf would rewrite", () => "self:"],
  ["a file url with a host", (fork: string) => `file://example.invalid${fork}`],
] as const) {
  test(`a fork init refuses an upstream remote that fetches the repo itself as ${how}`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      const base = up.commit("start");
      sh(["git", "clone", "-q", up.path, "fork"], { cwd: t.tmp });
      const fork = new Repo(join(t.tmp, "fork"));
      const alias = remote(fork.path) === "self:";
      if (alias) sh(["git", "config", `url.${fork.path}.insteadOf`, "self:"], { cwd: fork.path });
      if (alias) sh(["git", "config", `url.${up.path}.insteadOf`, fork.path], { cwd: fork.path });
      sh(["git", "remote", "add", "upstream", remote(fork.path)], { cwd: fork.path });
      const refused = t.pb(["init", "--upstream", up.path], { cwd: fork.path, code: 1 });
      expect(refused.stderr).toContain(`the upstream remote fetches this repo (${alias ? fork.path : remote(fork.path)})`);
      expect(existsSync(join(fork.path, ".patchbook"))).toBe(false);
      const fix = /^.*To follow .*?: (git config --replace-all remote\.upstream\.url .*)$/m.exec(refused.stderr)?.[1];
      sh(["sh", "-c", fix!], { cwd: fork.path });
      expect(t.pb(["init", "--upstream", up.path], { cwd: fork.path }).stdout).toContain(`pinned upstream at ${base.slice(0, 7)}`);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("a fork init records a remote URL that ends in a space as it is", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, "upstream "], { cwd: t.tmp });
    const spaced = join(t.tmp, "upstream ");
    const fork = forkOf(t, up);
    sh(["git", "remote", "add", "upstream", spaced], { cwd: fork.path });
    expect(t.pb(["init", "--upstream", spaced], { cwd: fork.path }).stdout).toContain(`branched from ${spaced}.`);
    expect(fork.read(".patchbook/config.toml")).toContain(`remote = "${spaced}"`);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const [how, stale] of [["a url before it", true], ["nothing before it", false]] as const) {
  test(`a fork init records the remote URL after an empty one with ${how}`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      sh(["git", "clone", "-q", up.path, "other"], { cwd: t.tmp });
      const fork = forkOf(t, up);
      for (const url of [...(stale ? [join(t.tmp, "other")] : []), "", up.path]) {
        sh(["git", "config", "--add", "remote.upstream.url", url], { cwd: fork.path });
      }
      expect(t.pb(["init", "--upstream", up.path], { cwd: fork.path }).stdout).toContain(`branched from ${up.path}.`);
      expect(fork.read(".patchbook/config.toml")).toContain(`remote = "${up.path}"`);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("a fork init refuses an upstream remote whose URL is the name of another remote", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    const fork = forkOf(t, up);
    sh(["git", "remote", "add", "upstream", "origin"], { cwd: fork.path });
    const refused = t.pb(["init", "--upstream", up.path], { cwd: fork.path, code: 1 });
    expect(refused.stderr).toContain(`the upstream remote fetches origin, but its url origin expands to ${up.path}.`);
    expect(existsSync(join(fork.path, ".patchbook"))).toBe(false);
    const fix = /^.*To follow .*?: (git config --replace-all remote\.upstream\.url .*)$/m.exec(refused.stderr)?.[1];
    sh(["sh", "-c", fix!], { cwd: fork.path });
    expect(t.pb(["init", "--upstream", up.path], { cwd: fork.path }).stdout).toContain(`branched from ${up.path}.`);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("init reports a failed fetch for a file URL with an encoded NUL", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    const fork = forkOf(t, up);
    const failed = t.pb(["init", "--upstream", `file://${fork.path}%00x`], { cwd: fork.path, code: 1 });
    expect(failed.stderr).toContain("patchbook: git fetch");
    expect(failed.stderr).not.toContain("TypeError");
    expect(existsSync(join(fork.path, ".patchbook/config.toml"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("init loads hooks.ts before it writes anything", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    const fork = forkOf(t, up);
    fork.write(".patchbook/hooks.ts", "export const stray = 1;\n");
    const init = t.pb(["init", "--upstream", up.path], { cwd: fork.path, code: 1 });
    expect(init.stderr).toContain(".patchbook/hooks.ts: \"stray\" isn't a hook");
    expect(readdirSync(join(fork.path, ".patchbook"))).toEqual(["hooks.ts"]);
    fork.rm(".patchbook/hooks.ts");
    t.pb(["init", "--upstream", up.path], { cwd: fork.path });
    expect(t.pb(["status"], { cwd: fork.path, code: 1 }).stdout).toContain("unrecorded mine.txt");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("a hooks.js beside .patchbook is a file patchbook does not know about", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    const fork = forkOf(t, up);
    const stray = "export const placeholder = () => null;\n";
    fork.write(".patchbook/hooks.js", stray);
    t.pb(["init", "--upstream", up.path], { cwd: fork.path });
    expect(t.pb(["status"], { cwd: fork.path, code: 1 }).stdout).toContain("unrecorded mine.txt");
    expect(fork.read(".patchbook/hooks.js")).toBe(stray);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const layout of ["fork", "folder"]) {
  test(`a ${layout} init that cannot write its series leaves commits working and can be retried`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      const fork = forkOf(t, up);
      const output = layout === "folder" ? ["--output-from", "", "--output-to", "out"] : [];
      mkdirSync(join(fork.path, ".patchbook"));
      symlinkSync(join(t.tmp, "missing/series"), join(fork.path, ".patchbook/series"));
      t.pb(["init", "--upstream", up.path, ...output], { cwd: fork.path, code: 1 });
      expect(existsSync(join(fork.path, ".patchbook/config.toml"))).toBe(false);
      fork.write("more.txt", "more\n");
      sh(["git", "add", "more.txt"], { cwd: fork.path });
      sh(["git", "commit", "-q", "-m", "more"], { cwd: fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
      rmSync(join(fork.path, ".patchbook/series"));
      t.pb(["init", "--upstream", up.path, ...output], { cwd: fork.path });
      expect(t.pb(["status"], { cwd: fork.path, code: layout === "fork" ? 1 : 0 }).stdout).toContain(layout === "fork" ? "unrecorded more.txt" : "no problems");
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("a fork init that fails leaves no skill and a retry records it", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, "fork"], { cwd: t.tmp });
    const fork = new Repo(join(t.tmp, "fork"));
    mkdirSync(join(fork.path, ".patchbook"));
    symlinkSync(join(t.tmp, "missing/series"), join(fork.path, ".patchbook/series"));
    t.pb(["init", "--upstream", up.path], { cwd: fork.path, code: 1 });
    expect(existsSync(join(fork.path, ".patchbook/config.toml"))).toBe(false);
    expect(existsSync(join(fork.path, ".agents"))).toBe(false);
    expect(existsSync(join(fork.path, ".claude"))).toBe(false);
    rmSync(join(fork.path, ".patchbook/series"));
    t.pb(["init", "--upstream", up.path], { cwd: fork.path });
    expect(fork.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: fork.path });
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("a fork init that cannot write its pin leaves no config and can be retried", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    const base = up.commit("start");
    const fork = forkOf(t, up);
    mkdirSync(join(fork.path, ".patchbook"));
    symlinkSync(join(t.tmp, "missing/upstream.lock"), join(fork.path, ".patchbook/upstream.lock"));
    t.pb(["init", "--upstream", up.path], { cwd: fork.path, code: 1 });
    expect(existsSync(join(fork.path, ".patchbook/config.toml"))).toBe(false);
    rmSync(join(fork.path, ".patchbook/upstream.lock"));
    expect(t.pb(["init", "--upstream", up.path], { cwd: fork.path }).stdout).toContain(`pinned upstream at ${base.slice(0, 7)}`);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("init refuses a patchbook that is a link", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    const fork = forkOf(t, up);
    const outside = join(t.tmp, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(fork.path, ".patchbook"));
    const out = t.pb(["init", "--upstream", up.path], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(".patchbook is a link");
    expect(out.stderr).toContain("replace the link with a copy of what it points to");
    expect(readdirSync(outside)).toEqual([]);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("init refuses a series that is a link", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    const fork = forkOf(t, up);
    const outside = join(t.tmp, "series");
    writeFileSync(outside, "mine\n");
    mkdirSync(join(fork.path, ".patchbook"));
    symlinkSync(outside, join(fork.path, ".patchbook/series"));
    const out = t.pb(["init", "--upstream", up.path], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(".patchbook/series already exists");
    expect(read(outside)).toBe("mine\n");
    expect(existsSync(join(fork.path, ".patchbook/upstream.lock"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const layout of ["fork", "folder"] as const) {
  for (const name of ["upstream.lock", "retired.md"]) {
    test(`a ${layout} init refuses a ${name} that is a link`, () => {
      const t = new Case();
      try {
        const up = new Repo(join(t.tmp, "upstream"));
        up.write("app.txt", "one\n");
        up.commit("start");
        const fork = forkOf(t, up);
        const output = layout === "folder" ? ["--output-from", "", "--output-to", "out"] : [];
        const outside = join(t.tmp, name);
        writeFileSync(outside, "mine\n");
        mkdirSync(join(fork.path, ".patchbook"));
        symlinkSync(outside, join(fork.path, ".patchbook", name));
        const out = t.pb(["init", "--upstream", up.path, ...output], { cwd: fork.path, code: 1 });
        const refusal = { "upstream.lock": "is a link", "retired.md": "already exists" }[name];
        expect(out.stderr).toContain(`.patchbook/${name} ${refusal}`);
        expect(read(outside)).toBe("mine\n");
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);
  }
}

test("a folder init that fails leaves no pin and can be retried from another URL", () => {
  const t = new Case();
  try {
    const first = new Repo(join(t.tmp, "first"));
    first.write("a.txt", "first\n");
    first.commit("first");
    const second = new Repo(join(t.tmp, "second"));
    second.write("a.txt", "second\n");
    const commit = second.commit("second");
    const repo = new Repo(join(t.tmp, "repo"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    const output = ["--name", "lib", "--output-from", "", "--output-to", "out"];
    mkdirSync(join(repo.path, ".patchbook"));
    symlinkSync(join(t.tmp, "missing/config.toml"), join(repo.path, ".patchbook/config.toml"));
    t.pb(["init", "--upstream", first.path, ...output], { cwd: repo.path, code: 1 });
    expect(readdirSync(join(repo.path, ".patchbook"))).toEqual(["config.toml"]);
    rmSync(join(repo.path, ".patchbook/config.toml"));
    t.pb(["init", "--upstream", second.path, ...output], { cwd: repo.path });
    expect(lockPin(repo.read(".patchbook/upstream.lock"), "lib").commit).toBe(commit);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const path of [".patchbook", ".patchbook/config.toml", ".patchbook/series", ".patchbook/retired.md", ".patchbook/upstream.lock"]) {
  test(`init refuses a dangling link at ${path} and writes nothing`, () => {
    for (const layout of ["fork", "folder"]) {
      const t = new Case();
      try {
        const { up, repo, output } = startingRepo(t, layout);
        const elsewhere = join(t.tmp, "elsewhere");
        mkdirSync(elsewhere);
        mkdirSync(dirname(join(repo.path, path)), { recursive: true });
        symlinkSync(join(elsewhere, "missing"), join(repo.path, path));
        const before = repoState(repo.path);
        const init = t.pb(["init", "--upstream", up.path, ...output], { cwd: repo.path, code: 1 });
        expect(init.stderr).toContain(`patchbook: ${path} is a symlink to a missing`);
        expect(repoState(repo.path)).toEqual(before);
        expect(readdirSync(elsewhere)).toEqual([]);
      } finally {
        t.cleanup();
      }
    }
  }, TIMEOUT);
}

for (const layout of ["fork", "folder"]) {
  test(`a ${layout} init refuses a patchbook folder without a config that holds series or retired.md`, () => {
    for (const [held, named] of [[["series", "retired.md"], "series"], [["retired.md"], "retired.md"]] as const) {
      const t = new Case();
      try {
        const { up, repo, output } = startingRepo(t, layout);
        const files = { series: "keep-me\n", "retired.md": "my own retired notes\n" };
        for (const file of held) repo.write(`.patchbook/${file}`, files[file as keyof typeof files]);
        const before = repoState(repo.path);
        const init = t.pb(["init", "--upstream", up.path, ...output], { cwd: repo.path, code: 1 });
        expect(init.stderr).toContain(`patchbook: .patchbook/${named} already exists. Move it away, or restore .patchbook/config.toml, then run init again.`);
        for (const file of held) expect(repo.read(`.patchbook/${file}`)).toBe(files[file as keyof typeof files]);
        expect(repoState(repo.path)).toEqual(before);
      } finally {
        t.cleanup();
      }
    }
  }, TIMEOUT);
}

const INIT_STEPS: [string, string[], string, (repo: Repo) => string[]][] = [
  ["its pin", ["fork", "folder"], ".patchbook/upstream.lock: permission denied", (repo) => (repo.write(".patchbook/upstream.lock", '{"version": 1, "upstreams": []}\n', 0o444), [])],
  ["the upstream remote", ["fork"], "could not lock config file", (repo) => (writeFileSync(join(repo.path, ".git/config.lock"), ""), [])],
  ["the vendored copy", ["folder"], "ro/copy: permission denied", (repo) => {
    mkdirSync(join(repo.path, "ro"));
    chmodSync(join(repo.path, "ro"), 0o555);
    return ["--vendor", "ro/copy"];
  }],
];

for (const [step, layouts, failure, block] of INIT_STEPS) {
  for (const layout of layouts) {
    test.skipIf(process.getuid?.() === 0)(`a ${layout} init that cannot write ${step} leaves the repo as it was`, () => {
      const t = new Case();
      try {
        const { up, repo, output } = startingRepo(t, layout);
        const args = block(repo);
        const before = repoState(repo.path);
        const init = t.pb(["init", "--upstream", up.path, ...output, ...args], { cwd: repo.path, code: 1 });
        expect(init.stderr).toContain(failure);
        expect(repoState(repo.path)).toEqual(before);
      } finally {
        sh(["chmod", "-R", "u+w", t.tmp], { cwd: t.tmp, check: false });
        t.cleanup();
      }
    }, TIMEOUT);
  }
}

for (const layout of ["fork", "folder"]) {
  test.skipIf(process.getuid?.() === 0)(`a ${layout} init that cannot write the skill finishes and leaves no part of it`, () => {
    const t = new Case();
    try {
      const { up, repo, output } = startingRepo(t, layout);
      const folder = join(repo.path, ".agents/skills/patchbook-update");
      mkdirSync(folder, { recursive: true });
      chmodSync(folder, 0o555);
      const init = t.pb(["init", "--upstream", up.path, ...output], { cwd: repo.path });
      expect(init.stderr).toContain("couldn't install the update skill");
      expect(readdirSync(folder)).toEqual([]);
      expect(existsSync(join(repo.path, ".claude"))).toBe(false);
      expect(t.pb(["status"], { cwd: repo.path, code: layout === "fork" ? 1 : 0 }).stdout).toContain(layout === "fork" ? "unrecorded mine.txt" : "no problems");
    } finally {
      sh(["chmod", "-R", "u+w", t.tmp], { cwd: t.tmp, check: false });
      t.cleanup();
    }
  }, TIMEOUT);
}

for (const manager of ["git", "husky"]) {
  test.skipIf(process.getuid?.() === 0)(`a fork init that cannot record the skill after installing the ${manager} hook leaves the repo as it was`, () => {
    const t = new Case();
    try {
      const { up, repo } = startingRepo(t, "fork");
      if (manager === "husky") {
        repo.write(".husky/pre-commit", NOTE_STAGED);
        repo.commit("husky");
        installManager(repo, ".husky");
      }
      const leftover = join(repo.path, ".patchbook/changes/patchbook-update-skill");
      mkdirSync(leftover, { recursive: true });
      chmodSync(leftover, 0o555);
      const before = repoState(repo.path);
      const init = t.pb(["init", "--upstream", up.path], { cwd: repo.path, code: 1 });
      expect(init.stderr).toContain("permission denied");
      expect(repoState(repo.path)).toEqual(before);
    } finally {
      sh(["chmod", "-R", "u+w", t.tmp], { cwd: t.tmp, check: false });
      t.cleanup();
    }
  }, TIMEOUT);
}

describe.skipIf(!!process.env["PATCHBOOK_CMD"])("init stopped by a preload, so only from source", () => {
  const preloaded = (t: Case, cwd: string, env: Record<string, string>, args: string[]): Run =>
    sh([...crashCmd(), ...args], { cwd, env: { ...t.env, PATCHBOOK_HOOK: "", ...env }, check: false });

  for (const [step, layouts, file] of [["its series", ["fork", "folder"], "series"], ["retired.md", ["fork", "folder"], "retired.md"], ["its config", ["fork", "folder"], "config.toml"]] as const) {
    for (const layout of layouts) {
      test(`a ${layout} init that cannot write ${step} leaves the repo as it was`, () => {
        const t = new Case();
        try {
          const { up, repo, output } = startingRepo(t, layout);
          const before = repoState(repo.path);
          const init = preloaded(t, repo.path, { FAIL_WRITE: `/.patchbook/${file}` }, ["init", "--upstream", up.path, ...output]);
          expect(init.code).toBe(1);
          expect(init.stderr).toContain(`.patchbook/${file}: i/o error`);
          expect(repoState(repo.path)).toEqual(before);
        } finally {
          t.cleanup();
        }
      }, TIMEOUT);
    }
  }

  test("a retried fork init records the skill a killed first run left on disk", () => {
    const t = new Case();
    try {
      Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      sh(["git", "clone", "-q", up.path, "fork"], { cwd: t.tmp });
      const fork = new Repo(join(t.tmp, "fork"));
      preloaded(t, fork.path, { CRASH_BEFORE_WRITE: "/.patchbook/series" }, ["init", "--upstream", up.path]);
      expect(existsSync(join(fork.path, ".patchbook/config.toml"))).toBe(false);
      expect(existsSync(join(fork.path, SKILL_FILE))).toBe(true);
      t.pb(["init", "--upstream", up.path], { cwd: fork.path });
      expect(fork.read(".patchbook/series")).toBe("patchbook-update-skill\n");
      expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
      t.pb(["build"], { cwd: fork.path });
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  test("a folder init killed before its config can be retried from another URL", () => {
    const t = new Case();
    try {
      const first = new Repo(join(t.tmp, "first"));
      first.write("a.txt", "first\n");
      first.commit("first");
      const second = new Repo(join(t.tmp, "second"));
      second.write("a.txt", "second\n");
      const commit = second.commit("second");
      const repo = new Repo(join(t.tmp, "repo"));
      repo.write("README.md", "mine\n");
      repo.commit("start");
      const output = ["--name", "lib", "--output-from", "", "--output-to", "out"];
      preloaded(t, repo.path, { CRASH_BEFORE_WRITE: "/.patchbook/series" }, ["init", "--upstream", first.path, ...output]);
      expect(existsSync(join(repo.path, ".patchbook/config.toml"))).toBe(false);
      expect(lockNames(repo.read(".patchbook/upstream.lock"))).toEqual(["lib"]);
      t.pb(["init", "--upstream", second.path, ...output], { cwd: repo.path });
      expect(lockPin(repo.read(".patchbook/upstream.lock"), "lib").commit).toBe(commit);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
});
