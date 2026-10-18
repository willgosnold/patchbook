// End-to-end tests: each one builds a throwaway upstream repo and drives the CLI against it.

import { describe, expect, test } from "bun:test";
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Case, Repo, dedent, lstrip, mkdirNew, partitionHead, replace, sh, words } from "./helpers";

const TIMEOUT = 120_000;

const read = (p: string): string => readFileSync(p, "utf8");
const isSymlink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Every file and link under root except `.git`, by path, so a test can see that nothing changed. */
const tree = (root: string): Record<string, string> => {
  const found: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (path === join(root, ".git")) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) found[relative(root, path)] = `-> ${readlinkSync(path)}`;
      else if (stat.isDirectory()) walk(path);
      else found[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return found;
};

const storeOf = (t: Case): string => join(t.tmp, "store/upstreams", readdirSync(join(t.tmp, "store/upstreams"))[0]!);
const pinOf = (t: { repo: Repo }): string => JSON.parse(read(join(t.repo.path, ".patchbook/upstream.lock"))).plugin.commit;
const gc = (store: string): void => void sh(["git", "gc", "-q", "--prune=now"], { cwd: store });
const inStore = (store: string, commit: string): boolean => sh(["git", "cat-file", "-e", `${commit}^{commit}`], { cwd: store, check: false }).code === 0;
const dropRefs = (store: string): void => {
  for (const ref of sh(["git", "for-each-ref", "--format=%(refname)"], { cwd: store }).stdout.split("\n").filter(Boolean)) {
    sh(["git", "update-ref", "-d", ref], { cwd: store });
  }
};

const markerScript = (t: Case, name: string): string => {
  const marker = join(t.tmp, `${name}-ran`);
  writeFileSync(join(t.tmp, "bin", name), `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });
  return marker;
};
const setRemote = (config: string, remote: string): void => writeFileSync(config, read(config).replace(/^remote = .*$/m, `remote = "${remote}"`));
const cloneFollowing = (t: ForkCase, remote: string): string => {
  const origin = join(t.tmp, "origin.git");
  sh(["git", "init", "-q", "--bare", origin], { cwd: t.tmp });
  t.up.write("app.txt", replace(t.up.read("app.txt"), "six", "SIX"));
  t.up.commit("upstream edit");
  t.pb(["sync"], { cwd: t.fork.path });
  setRemote(join(t.fork.path, ".patchbook/config.toml"), remote);
  t.fork.commit("Sync upstream");
  sh(["git", "push", "-q", origin, "HEAD:main"], { cwd: t.fork.path });
  sh(["git", "clone", "-q", "-b", "main", origin, "fresh"], { cwd: t.tmp });
  return join(t.tmp, "fresh");
};

const snapshot = (dir: string): Record<string, string> =>
  Object.fromEntries(
    (readdirSync(dir, { recursive: true }) as string[]).filter((p) => statSync(join(dir, p)).isFile()).sort().map((p) => [p, read(join(dir, p))]),
  );

const forkOf = (t: Case, up: Repo): Repo => {
  sh(["git", "clone", "-q", up.path, "fork"], { cwd: t.tmp });
  const fork = new Repo(join(t.tmp, "fork"));
  fork.write("mine.txt", "mine\n");
  fork.commit("mine");
  return fork;
};

class ForkCase extends Case {
  readonly up: Repo;
  readonly fork: Repo;

  constructor() {
    super();
    this.up = new Repo(join(this.tmp, "upstream"));
    this.up.write("app.txt", `
      one
      two
      three
      four
      five
      six
      seven
    `);
    this.up.write("docs/guide.md", "a guide\n");
    this.up.write("bin/run.sh", "#!/bin/sh\necho run\n", 0o755);
    this.up.commit("start");
    this.pb(["clone", this.up.path, "fork"], { cwd: this.tmp });
    this.fork = new Repo(join(this.tmp, "fork"));
  }

  recordFeature(): void {
    this.fork.write("app.txt", replace(this.fork.read("app.txt"), "two", "TWO"));
    this.fork.write("extra.txt", "ours\n");
    this.fork.rm("docs/guide.md");
    this.pb(["record", "feature", "--intent", "Shout the second line, add extra.txt, drop the guide."], { cwd: this.fork.path });
    this.pb(["build"], { cwd: this.fork.path });
    this.fork.commit("record");
  }

  config(args: string[], env: Record<string, string> = {}): string {
    Object.assign(this.env, env);
    const out = this.pb(["config", ...args], { cwd: this.fork.path }).stdout;
    for (const k of Object.keys(env)) delete this.env[k];
    return out;
  }
}

class VendorCase extends Case {
  readonly up: Repo;
  readonly repo: Repo;

  constructor() {
    super();
    this.up = new Repo(join(this.tmp, "upstream"));
    this.up.write("plugin/skills/hello/SKILL.md", `
      ---
      name: Hello
      ---

      # Hello

      Open Cursor and say hello.

      Then wave.
    `);
    this.up.write("plugin/agents/helper.md", "A helper.\n");
    this.up.write("plugin/README.md", "For Cursor users.\n");
    this.up.write("other/ignored.md", "Not followed.\n");
    this.up.commit("start");
    this.repo = new Repo(join(this.tmp, "adapted"));
    this.repo.write("README.md", "mine\n");
    this.repo.commit("start");
    this.pb(["init", "--upstream", this.up.path, "--path", "plugin", "--output-from", "skills", "--output-to", "skills"], { cwd: this.repo.path });
    const config = join(this.repo.path, ".patchbook/config.toml");
    writeFileSync(config, read(config) + dedent(`
      [placeholders.snippet]
      file = ".patchbook/snippets.md"
      format = "sections"

      [[check]]
      name = "cursor"
      files = ["**/*.md"]
      pattern = '\\bCursor\\b'
    `));
    this.repo.write(".patchbook/snippets.md", "## greet\n\nSay hello in T3.\n");
  }

  recordEdit(old: string, repl: string, ...args: string[]): string {
    const skill = "skills/hello/SKILL.md";
    this.repo.write(skill, replace(this.repo.read(skill), old, repl));
    const out = this.pb(["record", ...args], { cwd: this.repo.path }).stdout;
    const edited = this.repo.read(skill);
    this.pb(["build"], { cwd: this.repo.path }); // no --force: the edit is recorded
    expect(this.repo.read(skill)).toBe(edited);
    expect(replace(this.pb(["status"], { cwd: this.repo.path }).stdout, "no problems", "")).not.toContain("problem");
    return out;
  }

  missingScaffoldPatchBuild(): string {
    const status = this.pb(["status"], { cwd: this.repo.path, code: 1 }).stdout;
    expect(status).toContain("missing   skills/hello/SKILL.md");
    expect(status).not.toContain("README"); // only what ships is checked
    this.pb(["scaffold"], { cwd: this.repo.path });
    const entries = join(this.repo.path, ".patchbook/blocks/skills/hello/SKILL.md.entries");
    const text = replace(read(entries), "rules: \nintent: \n", "rules: t3\nintent: Speak T3.\n");
    const head = partitionHead(text, "--- patched\n");
    writeFileSync(entries, head + "--- patched\n{{snippet:greet}}\n");
    this.pb(["build"], { cwd: this.repo.path });
    const out = this.repo.read("skills/hello/SKILL.md");
    expect(out).toContain("Say hello in T3.");
    expect(out).not.toContain("Cursor");
    expect(existsSync(join(this.repo.path, "skills/README.md"))).toBe(false);
    return entries;
  }
}

function forkTest(name: string, body: (t: ForkCase) => void): void {
  test(name, () => {
    const t = new ForkCase();
    try {
      body(t);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

const caseSensitiveFs = (() => {
  const dir = mkdtempSync(join(tmpdir(), "case"));
  try {
    writeFileSync(join(dir, "a"), "");
    return !existsSync(join(dir, "A"));
  } finally {
    rmSync(dir, { recursive: true });
  }
})();
const forkTestOnCaseSensitiveFs = caseSensitiveFs ? forkTest : (name: string, _body: (t: ForkCase) => void) => test.skip(name, () => {});

function vendorTest(name: string, body: (t: VendorCase) => void): void {
  test(name, () => {
    const t = new VendorCase();
    try {
      body(t);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("test_version", () => {
  const t = new Case();
  try {
    const out = t.pb(["--version"], { cwd: t.tmp }).stdout;
    expect(out).toBe(`patchbook ${JSON.parse(read(join(import.meta.dir, "../package.json"))).version}\n`);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_clone_keeps_the_destination_it_was_given", () => {
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

test("test_clone_finishes_when_the_skill_cannot_be_installed", () => {
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

const SKILL_FILE = ".agents/skills/patchbook-update/SKILL.md";
const SKILL_LINK = ".claude/skills/patchbook-update";
const SKILL_COPY = read(join(import.meta.dir, "../skills/patchbook-update/SKILL.md"));
const STALE_SKILL = "---\nname: patchbook-update\n---\n\nAn older skill.\n";

function skillFork(t: Case): Repo {
  const up = new Repo(join(t.tmp, "upstream"));
  up.write("app.txt", "one\ntwo\n");
  up.commit("start");
  t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
  return new Repo(join(t.tmp, "fork"));
}

test("test_skill_install_adds_the_skill_to_a_fork_without_one_and_records_it", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    expect(existsSync(join(fork.path, SKILL_FILE))).toBe(false);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(out).toContain(`wrote ${SKILL_FILE}`);
    expect(out).toContain(`wrote ${SKILL_LINK}`);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(readlinkSync(join(fork.path, SKILL_LINK))).toBe("../../.agents/skills/patchbook-update");
    expect(fork.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    expect(t.pb(["show", "patchbook-update-skill"], { cwd: fork.path }).stdout).toContain("Install the patchbook-update skill");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
    fork.commit("skill");
    t.pb(["build"], { cwd: fork.path });
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_replaces_a_stale_skill_in_a_fork_and_a_second_run_changes_nothing", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record"], { cwd: fork.path });
    unlinkSync(join(fork.path, SKILL_LINK));
    t.pb(["record"], { cwd: fork.path });
    fork.commit("an older skill, and no link");

    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(out).toContain(`wrote ${SKILL_FILE}`);
    expect(out).toContain(`wrote ${SKILL_LINK}`);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(readlinkSync(join(fork.path, SKILL_LINK))).toBe("../../.agents/skills/patchbook-update");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
    expect(fork.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    fork.commit("refresh the skill");
    t.pb(["build"], { cwd: fork.path });
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");

    const before = tree(fork.path);
    const again = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(again).toBe("the update skill is already current\n");
    expect(tree(fork.path)).toEqual(before);
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_keeps_the_intent_of_the_change_it_updates", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record", "patchbook-update-skill", "--intent", "Let agents pull upstream."], { cwd: fork.path });
    fork.commit("an older skill");
    t.pb(["skill", "install"], { cwd: fork.path });
    expect(read(join(fork.path, ".patchbook/changes/patchbook-update-skill/CHANGE.md"))).toContain("Let agents pull upstream.");
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_in_a_fork_refuses_when_other_edits_are_waiting_to_be_recorded", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record"], { cwd: fork.path });
    fork.commit("an older skill");
    fork.write(SKILL_FILE, STALE_SKILL + "My own line.\n");
    fork.write("app.txt", "one\nTWO\n");
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stderr).toContain("app.txt");
    expect(out.stderr).toContain("Commit them");
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_in_the_folder_layout_overwrites_the_file_and_records_no_change", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.md", "a\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.write(SKILL_FILE, STALE_SKILL + "Edited by hand.\n");
    repo.commit("start");
    t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: repo.path });
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });

    const out = t.pb(["skill", "install"], { cwd: repo.path }).stdout;
    expect(out).toContain(`wrote ${SKILL_FILE}`);
    expect(repo.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(isSymlink(join(repo.path, SKILL_LINK))).toBe(true);
    expect(existsSync(join(repo.path, ".patchbook/changes"))).toBe(false);
    expect(repo.read(".patchbook/series")).toBe("");

    const before = tree(repo.path);
    expect(t.pb(["skill", "install"], { cwd: repo.path }).stdout).toBe("the update skill is already current\n");
    expect(tree(repo.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_follows_start_agents_and_start_install_skill", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    const off = t.pb(["skill", "install"], { cwd: fork.path });
    expect(off.stdout).toContain("start.install_skill is off (env)");
    expect(existsSync(join(fork.path, ".agents"))).toBe(false);

    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    t.pb(["config", "start.agents", "codex", "--project"], { cwd: fork.path });
    fork.commit("settings");
    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(out).toContain(`wrote ${SKILL_FILE}`);
    expect(out).not.toContain(SKILL_LINK);
    expect(existsSync(join(fork.path, ".claude"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_fails_when_no_agent_can_be_installed_for", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    t.pb(["config", "start.agents", "cursor", "--project"], { cwd: fork.path });
    fork.commit("settings");
    const none = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(none.stderr).toContain("can't install the skill for cursor");
    expect(none.stderr).toContain("the update skill was not installed");
    expect(existsSync(join(fork.path, ".agents"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_clone_of_a_patchbook_repo_starts_a_patchbook_of_its_own", () => {
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
    expect(Object.keys(JSON.parse(mine.read(".patchbook/upstream.lock")))).toEqual(["theirs"]);
    expect(mine.read("app.txt")).toBe("one\nMINE\n");
    expect(t.pb(["status"], { cwd: mine.path }).stdout).toContain("1 edits apply");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_build_leaves_a_vendored_copy_alone_when_upstream_ships_the_folder", () => {
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

test("test_clone_does_not_run_the_hooks_of_a_repo_it_forks", () => {
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

test("test_clone_drops_an_inherited_patchbook_that_is_a_dangling_link", () => {
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

const AWKWARD = (word: string): string => `${word}"q\\b😀`;

const upstreamsOf = (config: string): Record<string, unknown>[] => (Bun.TOML.parse(config) as { upstream: Record<string, unknown>[] }).upstream;

test("test_a_folder_init_writes_awkward_values_so_they_read_back_as_given", () => {
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

test("test_a_fork_init_writes_awkward_values_so_they_read_back_as_given", () => {
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

test("test_init_into_patchbook_names_output_to_not_mount", () => {
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

test("test_init_rejects_a_vendor_folder_inside_the_output_before_it_writes_anything", () => {
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

test("test_an_output_folder_with_glob_characters_builds_twice_beside_a_folder_it_would_match", () => {
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

test("test_the_commit_hook_stages_only_the_output_file_it_names_when_the_folder_has_glob_characters", () => {
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

test("test_a_vendored_folder_with_glob_characters_builds_only_its_own_files", () => {
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

test("test_a_missing_vendor_folder_is_named_by_its_plain_path_in_the_error", () => {
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
    expect(built.stderr).toContain("git add -- nope failed");
    expect(built.stderr).toContain("pathspec 'nope' did not match any files");
    expect(built.stderr).not.toContain(":(literal)");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_an_init_whose_sync_fails_leaves_no_patchbook_and_can_be_retried", () => {
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
    expect(JSON.parse(repo.read(".patchbook/upstream.lock")).upstream.commit).toBe(commit);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const bad of ["no-such-repo", "unrelated"]) {
  test(`test_a_fork_init_against_${bad.replaceAll("-", "_")}_leaves_no_patchbook_and_can_be_retried`, () => {
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

for (const [how, leave] of [
  ["left_by_a_failed_init", (t: Case, fork: Repo, up: Repo) => {
    mkdirSync(join(fork.path, ".patchbook"));
    symlinkSync(join(t.tmp, "missing/config.toml"), join(fork.path, ".patchbook/config.toml"));
    t.pb(["init", "--upstream", up.path], { cwd: fork.path, code: 1 });
    rmSync(join(fork.path, ".patchbook/config.toml"));
  }],
  ["added_by_the_user", (_: Case, fork: Repo, up: Repo) => void sh(["git", "remote", "add", "upstream", up.path], { cwd: fork.path })],
  ["listing_the_given_url_second", (t: Case, fork: Repo, up: Repo) => {
    sh(["git", "remote", "add", "upstream", up.path], { cwd: fork.path });
    sh(["git", "config", "--add", "remote.upstream.url", join(t.tmp, "moved")], { cwd: fork.path });
  }],
] as const) {
  test(`test_a_fork_init_refuses_an_upstream_remote_that_fetches_another_url_${how}`, () => {
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
      expect(JSON.parse(t.pb(["check"], { cwd: fork.path, code: 10 }).stdout).upstreams.moved.head).toBe(head);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

for (const [how, remote, given] of [
  ["an_insteadof_alias", () => "alias:upstream", (up: string) => up],
  ["a_trailing_slash_on_the_remote", (up: string) => up + "/", (up: string) => up],
  ["a_trailing_slash_on_the_given_url", (up: string) => up, (up: string) => up + "/"],
  ["a_file_url", (up: string) => `file://${up}`, (up: string) => up],
  ["a_relative_remote", () => "../upstream", (up: string) => up],
  ["a_relative_given_url", (up: string) => up, () => "../upstream"],
] as const) {
  test(`test_a_fork_init_accepts_an_upstream_remote_spelled_with_${how}`, () => {
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

for (const name of ["my up", "up (copy)", "it's up"]) {
  test(`test_the_command_a_refused_fork_init_prints_works_for_${name.replace(/\W+/g, "_")}`, () => {
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

test("test_a_fork_init_names_a_fix_for_an_upstream_remote_with_no_url", () => {
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
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

// Stands in for ssh by running the remote command here, so scp and ssh:// URLs reach a local repo.
const fakeSsh = (t: Case): string => {
  const script = join(t.tmp, "bin/fake-ssh");
  writeFileSync(script, "#!/bin/sh\nfor a; do cmd=$a; done\nexec sh -c \"$(printf '%s' \"$cmd\" | sed 's/^git-upload-pack/git upload-pack/')\"\n", { mode: 0o755 });
  t.env["GIT_SSH_COMMAND"] = script;
  process.env["GIT_SSH_COMMAND"] = script;
  return script;
};

for (const [how, repoName, remote, given] of [
  ["a_dot_git_suffix", "upstream", (up: string) => `ssh://git@fake${up}.git`, (up: string) => `ssh://git@fake${up}`],
  ["a_percent_encoded_file_url", "my up", (up: string) => `file://${up.replace(" ", "%20")}`, (up: string) => up],
  ["scp_against_ssh", "upstream", (up: string) => `git@fake:${up}`, (up: string) => `ssh://git@fake${up}`],
  ["ssh_against_scp", "upstream", (up: string) => `ssh://git@fake${up}`, (up: string) => `git@fake:${up}`],
] as const) {
  test(`test_a_fork_init_accepts_an_upstream_remote_that_serves_the_same_repo_as_${how}`, () => {
    const t = new Case();
    try {
      fakeSsh(t);
      const up = new Repo(join(t.tmp, repoName));
      up.write("app.txt", "one\n");
      const base = up.commit("start");
      if (how === "a_dot_git_suffix") symlinkSync(up.path, up.path + ".git");
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

test("test_a_fork_init_refuses_an_upstream_remote_that_serves_a_different_tip_than_the_given_url", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    const base = up.commit("start");
    const fork = forkOf(t, up);
    sh(["git", "remote", "add", "upstream", up.path], { cwd: fork.path });
    sh(["git", "clone", "-q", up.path, "moved"], { cwd: t.tmp });
    const moved = new Repo(join(t.tmp, "moved"));
    moved.write("app.txt", "two\n");
    const head = moved.commit("two");
    const refused = t.pb(["init", "--upstream", moved.path], { cwd: fork.path, code: 1 });
    expect(refused.stderr).toContain("the upstream remote and --upstream serve different commits for main");
    expect(refused.stderr).toContain(`main is ${base.slice(0, 7)} on the remote and ${head.slice(0, 7)} on --upstream`);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const [which, how] of [["remote", "the_upstream_remote"], ["given", "the_given_url"]] as const) {
  test(`test_a_fork_init_names_${how}_when_git_cannot_read_it`, () => {
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

test("test_a_fork_init_from_a_subfolder_takes_a_relative_upstream_from_where_it_ran", () => {
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

test("test_a_fork_init_from_a_subfolder_prints_a_fix_that_names_the_folder_meant", () => {
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
    expect(JSON.parse(t.pb(["check"], { cwd: fork.path, code: 10 }).stdout).upstreams.moved.head).toBe(head);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const [layout, hasRemote] of [["fork", true], ["folder", false]] as const) {
  test(`test_a_${layout}_init_rejects_an_upstream_that_starts_with_a_dash${hasRemote ? "_with_a_remote" : ""}`, () => {
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

test("test_a_refused_fork_init_does_not_print_the_password_in_a_remote", () => {
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
    const refused = t.pb(["init", "--upstream", `ssh://user:s3cretpw@fake${moved.path}`], { cwd: fork.path, code: 1 });
    expect(refused.stderr).toContain("the upstream remote and --upstream serve different commits for main");
    expect(refused.stderr).toContain(`The remote fetches ssh://user@fake${up.path}, --upstream is ssh://user@fake${moved.path}`);
    expect(refused.stderr).not.toContain("s3cretpw");
  } finally {
    delete process.env["GIT_SSH_COMMAND"];
    t.cleanup();
  }
}, TIMEOUT);

for (const [how, hasRemote] of [["unreachable_remote", true], ["unreachable_given_url", false]] as const) {
  test(`test_a_fork_init_with_an_${how}_does_not_print_the_password`, () => {
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

for (const hasRemote of [true, false]) {
  test(`test_a_fork_init_names_the_repo_it_follows_without_the_password${hasRemote ? "_of_its_upstream_remote" : ""}`, () => {
    const t = new Case();
    try {
      fakeSsh(t);
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      const fork = forkOf(t, up);
      const secret = `ssh://user:s3cretpw@fake${up.path}`;
      if (hasRemote) sh(["git", "remote", "add", "upstream", secret], { cwd: fork.path });
      const init = t.pb(["init", "--upstream", hasRemote ? `ssh://user@fake${up.path}` : secret], { cwd: fork.path });
      expect(init.stdout).toContain(`branched from ssh://user@fake${up.path}.`);
      expect(init.stdout).not.toContain("s3cretpw");
      expect(fork.read(".patchbook/config.toml")).toContain(`remote = "ssh://user@fake${up.path}"`);
    } finally {
      delete process.env["GIT_SSH_COMMAND"];
      t.cleanup();
    }
  }, TIMEOUT);
}

for (const [how, branch] of [["a_stale_mirror", "main"], ["a_branch_only_the_given_url_has", "feature"]] as const) {
  test(`test_a_fork_init_says_the_remote_serves_different_commits_for_${how}`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      const fork = forkOf(t, up);
      sh(["git", "clone", "-q", up.path, "mirror"], { cwd: t.tmp });
      sh(["git", "remote", "add", "upstream", join(t.tmp, "mirror")], { cwd: fork.path });
      up.write("app.txt", "two\n");
      up.commit("two");
      sh(["git", "branch", "feature"], { cwd: up.path });
      const refused = t.pb(["init", "--upstream", up.path, "--branch", branch], { cwd: fork.path, code: 1 });
      expect(refused.stderr).toContain(`the upstream remote and --upstream serve different commits for ${branch}`);
      expect(refused.stderr).not.toContain("different repos");
      expect(refused.stderr).toContain(`git config --replace-all remote.upstream.url ${up.path}`);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("test_clone_does_not_print_or_commit_the_password_in_the_url", () => {
  const t = new Case();
  try {
    fakeSsh(t);
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    const clone = t.pb(["clone", `ssh://user:s3cretpw@fake${up.path}`, "fork"], { cwd: t.tmp });
    expect(clone.stdout).toContain(`cloned ssh://user@fake${up.path} into`);
    expect(clone.stdout).not.toContain("s3cretpw");
    expect(read(join(t.tmp, "fork/.patchbook/config.toml"))).toContain(`remote = "ssh://user@fake${up.path}"`);
  } finally {
    delete process.env["GIT_SSH_COMMAND"];
    t.cleanup();
  }
}, TIMEOUT);

test("test_clone_and_init_do_not_name_the_upstream_after_the_password_of_a_url_with_no_path", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    const secret = "https://user:s3cretpw@host.invalid/";
    Object.assign(t.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${up.path}.insteadOf`, GIT_CONFIG_VALUE_0: secret });
    const clone = t.pb(["clone", secret], { cwd: t.tmp });
    const fork = forkOf(t, up);
    const init = t.pb(["init", "--upstream", secret], { cwd: fork.path });
    for (const [out, dir] of [[clone.stdout, join(t.tmp, "host.invalid")], [init.stdout, fork.path]] as const) {
      expect(out).not.toContain("s3cretpw");
      expect(read(join(dir, ".patchbook/config.toml"))).toContain('name = "host.invalid"');
      expect(read(join(dir, ".patchbook/upstream.lock"))).not.toContain("s3cretpw");
      expect(t.pb(["status"], { cwd: dir }).stdout).toContain("at host.invalid ");
    }
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const [how, hasRemote] of [["remote", true], ["given_url", false]] as const) {
  test(`test_a_fork_init_does_not_print_a_password_with_an_at_sign_hash_or_question_mark_in_the_${how}`, () => {
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

test("test_a_refused_fork_init_says_to_add_back_the_password_it_does_not_print", () => {
  const t = new Case();
  try {
    fakeSsh(t);
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    const fork = forkOf(t, up);
    sh(["git", "remote", "add", "upstream", up.path], { cwd: fork.path });
    sh(["git", "clone", "-q", up.path, "moved"], { cwd: t.tmp });
    const moved = new Repo(join(t.tmp, "moved"));
    moved.write("app.txt", "two\n");
    moved.commit("two");
    const given = `ssh://user:s3cretpw@fake${moved.path}`;
    const refused = t.pb(["init", "--upstream", given], { cwd: fork.path, code: 1 });
    expect(refused.stderr).toContain("add the credentials from --upstream to the URL in this command");
    const fix = /^.*To follow .*?: (git config --replace-all remote\.upstream\.url .*)$/m.exec(refused.stderr)?.[1];
    expect(fix).toBe(`git config --replace-all remote.upstream.url ssh://user@fake${moved.path}`);
    sh(["sh", "-c", fix!.replace("ssh://user@", "ssh://user:s3cretpw@")], { cwd: fork.path });
    t.pb(["init", "--upstream", given], { cwd: fork.path });
    expect(existsSync(join(fork.path, ".patchbook/config.toml"))).toBe(true);
  } finally {
    delete process.env["GIT_SSH_COMMAND"];
    t.cleanup();
  }
}, TIMEOUT);

for (const [how, dir, given] of [
  ["dot_dot_from_a_subfolder", "sub", () => ".."],
  ["dot_at_the_root", "", () => "."],
  ["a_file_url_of_the_root", "", (fork: string) => `file://${fork}`],
  ["a_file_url_with_a_host", "", (fork: string) => `file://example.invalid${fork}`],
  ["a_file_url_with_an_encoded_slash_after_the_host", "", (fork: string) => `file://example.invalid%2F${fork.slice(1)}`],
  ["a_file_url_whose_host_is_not_utf_8", "", (fork: string) => `file://%ff${fork}`],
  ["a_path_that_git_reads_from_its_closing_bracket", "", () => "x@[y]"],
  ["a_path_that_git_finds_with_dot_git_added", "", (fork: string) => `${fork}-self`],
  ["a_linked_worktree", "", () => "../worktree"],
  ["an_insteadof_alias", "", () => "self:"],
] as const) {
  test(`test_a_fork_init_refuses_an_upstream_that_is_the_repo_itself_given_as_${how}`, () => {
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
  ["an_alias_that_another_insteadof_would_rewrite", () => "self:"],
  ["a_file_url_with_a_host", (fork: string) => `file://example.invalid${fork}`],
  ["a_file_url_with_an_encoded_slash_after_the_host", (fork: string) => `file://example.invalid%2F${fork.slice(1)}`],
  ["a_file_url_whose_host_is_not_utf_8", (fork: string) => `file://%ff${fork}`],
] as const) {
  test(`test_a_fork_init_refuses_an_upstream_remote_that_fetches_the_repo_itself_as_${how}`, () => {
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

test("test_a_fork_init_records_a_remote_url_that_ends_in_a_space_as_it_is", () => {
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

for (const [how, stale] of [["a_url_before_it", true], ["nothing_before_it", false]] as const) {
  test(`test_a_fork_init_records_the_remote_url_after_an_empty_one_with_${how}`, () => {
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

test("test_a_fork_init_refuses_an_upstream_remote_whose_url_is_the_name_of_another_remote", () => {
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

test("test_init_reports_a_failed_fetch_for_a_file_url_with_an_encoded_nul", () => {
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

test("test_init_checks_the_hooks_before_it_writes_anything", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    const fork = forkOf(t, up);
    fork.write(".patchbook/hooks.py", "def placeholder(kind, key):\n    return None\n");
    const init = t.pb(["init", "--upstream", up.path], { cwd: fork.path, code: 1 });
    expect(init.stderr).toContain(".patchbook/hooks.py is Python");
    expect(readdirSync(join(fork.path, ".patchbook"))).toEqual(["hooks.py"]);
    fork.rm(".patchbook/hooks.py");
    t.pb(["init", "--upstream", up.path], { cwd: fork.path });
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const layout of ["fork", "folder"]) {
  test(`test_a_${layout}_init_that_cannot_write_its_series_leaves_commits_working_and_can_be_retried`, () => {
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
      expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("test_a_fork_init_that_cannot_write_its_pin_leaves_no_config_and_can_be_retried", () => {
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

test("test_a_folder_init_that_stops_before_its_config_can_be_retried_from_another_url", () => {
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
    expect(Object.keys(JSON.parse(repo.read(".patchbook/upstream.lock")))).toEqual(["lib"]);
    rmSync(join(repo.path, ".patchbook/config.toml"));
    t.pb(["init", "--upstream", second.path, ...output], { cwd: repo.path });
    expect(JSON.parse(repo.read(".patchbook/upstream.lock")).lib.commit).toBe(commit);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const layout of ["fork", "folder"]) {
  test(`test_a_${layout}_init_that_cannot_install_the_hook_still_starts_the_patchbook`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      const fork = forkOf(t, up);
      const hooks = join(fork.path, ".git/hooks");
      mkdirSync(hooks, { recursive: true });
      const output = layout === "folder" ? ["--output-from", "", "--output-to", "out"] : [];
      sh(["chmod", "a-w", hooks], { cwd: fork.path });
      try {
        const init = t.pb(["init", "--upstream", up.path, ...output], { cwd: fork.path });
        expect(init.stderr).toContain("couldn't install the pre-commit hook");
      } finally {
        sh(["chmod", "u+w", hooks], { cwd: fork.path });
      }
      const status = t.pb(["status"], { cwd: fork.path });
      expect(status.stderr).toContain("installed a pre-commit hook");
      expect(status.stdout).toContain("no problems");
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("test_a_command_warns_and_runs_while_the_pre_commit_hook_cannot_be_installed", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\n");
    up.commit("start");
    const fork = forkOf(t, up);
    t.pb(["init", "--upstream", up.path], { cwd: fork.path });
    const hooks = join(fork.path, ".git/hooks");
    rmSync(join(hooks, "pre-commit"));
    sh(["chmod", "a-w", hooks], { cwd: fork.path });
    try {
      const status = t.pb(["status"], { cwd: fork.path });
      expect(status.stderr).toContain("couldn't install the pre-commit hook");
      expect(status.stderr).toContain("hand edits");
      expect(status.stdout).toContain("no problems");
    } finally {
      sh(["chmod", "u+w", hooks], { cwd: fork.path });
    }
    expect(t.pb(["status"], { cwd: fork.path }).stderr).toContain("installed a pre-commit hook");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

describe("ForkTest", () => {
  // Each layout puts a vendored copy where its own upstream's build writes, so a build would land in it.
  for (const [where, mount, vendor] of [
    ["on", "lib", "lib"],
    ["around", "vendor/lib", "vendor"],
    ["inside", "lib", "lib/vendored"],
  ] as const) {
    forkTest(`test_a_vendor_folder_${where}_its_own_mount_is_rejected`, (t) => {
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

  forkTest("test_a_vendor_folder_on_the_root_upstream_is_rejected", (t) => {
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, replace(read(config), 'mount = ""', 'mount = ""\nvendor = "vendor"'));
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 });
    expect(status.stderr).toContain("the vendored copy of upstream (vendor) overlaps the folder upstream builds into (the repo root)");
    expect(status.stderr).toContain("Change vendor for upstream.");
  });

  forkTest("test_a_vendor_folder_over_another_upstreams_mount_is_rejected", (t) => {
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

  forkTest("test_a_track_whose_fetch_fails_leaves_the_book_as_it_was", (t) => {
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
    expect(JSON.parse(read(join(book, "upstream.lock"))).lib.commit).toBe(commit);
  });

  forkTest("test_a_track_that_fails_writing_config_leaves_a_pin_nothing_reads", (t) => {
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
    expect(Object.keys(JSON.parse(t.pb(["status", "--json"], { cwd: t.fork.path }).stdout).upstreams)).toEqual(["upstream"]);
    expect(t.pb(["build"], { cwd: t.fork.path }).stdout).not.toContain("lib");
    t.pb(["track", "lib", other.path], { cwd: t.fork.path });
    expect(JSON.parse(read(join(t.fork.path, ".patchbook/upstream.lock"))).lib.commit).toBe(commit);
  });

  for (const [order, first, second] of [
    ["holding", "vendor/inner", "vendor"],
    ["inside", "vendor", "vendor/inner"],
    ["equal_to", "vendor", "vendor"],
  ] as const) {
    forkTest(`test_a_vendor_folder_${order}_another_upstreams_vendor_folder_is_rejected`, (t) => {
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

  forkTest("test_check_and_sync_count_only_what_the_new_pin_leaves_out", (t) => {
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

  for (const folder of [".patchbook/pbx", ".git/x", ".patchbook", ".git"]) {
    forkTest(`test_a_mount_at_${folder.replace(/\W/g, "_")}_is_rejected`, (t) => {
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

  for (const mount of ["./.patchbook/pbx", "./.git/pbx", "x/../.patchbook", "./.patchbook", "a/../.git/x"]) {
    forkTest(`test_a_mount_spelled_${mount.replace(/\W/g, "_")}_is_rejected`, (t) => {
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

  for (const mount of ["../outside", "x/../../outside", "/abs/outside", ".."]) {
    forkTest(`test_a_mount_${mount.replace(/\W/g, "_")}_outside_the_repo_is_rejected`, (t) => {
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

  forkTest("test_a_vendor_folder_inside_a_dot_slash_mount_is_rejected", (t) => {
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

  forkTest("test_a_dot_slash_mount_without_overlap_builds_where_the_plain_one_does", (t) => {
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

  forkTest("test_two_upstreams_mounted_at_lib_and_dot_slash_lib_x_are_rejected", (t) => {
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

  forkTest("test_a_vendor_folder_inside_another_upstreams_mount_leaves_that_upstreams_files_out", (t) => {
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

  forkTest("test_a_failed_command_still_says_which_files_it_left_out", (t) => {
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
    mkdirNew(join(change, "ours/lib/vendored"));
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
    ["move", "move docs/guide.md -> vendor/extra/guide.md"],
  ] as const;
  for (const [kind, edit] of intoVendor) {
    forkTest(`test_${kind}_edit_into_a_vendored_copy_is_refused`, (t) => {
      const extra = new Repo(join(t.tmp, "extra"));
      extra.write("a.md", "extra\n");
      extra.commit("extra");
      t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.fork.path });
      t.pb(["build"], { cwd: t.fork.path });
      t.fork.commit("track");
      const change = join(t.fork.path, ".patchbook/changes/into-vendor");
      mkdirNew(join(change, "ours/vendor/extra"));
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
    ["copy_into_the_patchbook_config", "copy app.txt -> .patchbook/config.toml", ".patchbook/config.toml", ".patchbook"],
    ["copy_into_the_patchbook", "copy app.txt -> .patchbook/notes.txt", ".patchbook/notes.txt", ".patchbook"],
    ["add_into_the_patchbook", "add .patchbook/new.md", ".patchbook/new.md", ".patchbook"],
    ["move_into_the_patchbook", "move docs/guide.md -> .patchbook/guide.md", ".patchbook/guide.md", ".patchbook"],
    ["copy_into_dot_PATCHBOOK_config", "copy app.txt -> .PATCHBOOK/config.toml", ".PATCHBOOK/config.toml", ".patchbook"],
    ["add_into_dot_PatchBook", "add .PatchBook/new.md", ".PatchBook/new.md", ".patchbook"],
    ["copy_into_git", "copy app.txt -> .git/x", ".git/x", ".git"],
    ["add_into_git", "add .git/new.md", ".git/new.md", ".git"],
    ["move_into_git", "move docs/guide.md -> .git/guide.md", ".git/guide.md", ".git"],
    ["copy_into_dot_GIT", "copy app.txt -> .GIT/x", ".GIT/x", ".git"],
    ["copy_into_dot_git_dot", "copy app.txt -> .git./x", ".git./x", ".git"],
    ["copy_into_a_nested_git", "copy app.txt -> a/.git/x", "a/.git/x", ".git"],
  ] as const;
  for (const [name, edit, dest, place] of intoKept) {
    forkTest(`test_${name}_is_invalid_and_nothing_is_written`, (t) => {
      const change = join(t.fork.path, ".patchbook/changes/into-kept");
      mkdirNew(change);
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

  const hookCommit = (t: ForkCase, ...args: string[]) =>
    sh(["git", "commit", "-qm", "into kept", ...args], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Shout two." }, check: false });
  const gitState = (t: ForkCase): string =>
    ["rev-parse HEAD", "ls-files -s", "diff --cached", "diff"].map((a) => sh(["git", ...a.split(" ")], { cwd: t.fork.path }).stdout).join("\n--\n");
  const fixHint = "Edit or remove that line in the change's CHANGE.md, or skip the hook once with PATCHBOOK_HOOK=0.";

  const hookRefuses = [
    ["copy_into_the_patchbook", "copy app.txt -> .patchbook/config.toml", ".patchbook/config.toml", ".patchbook"],
    ["add_into_the_patchbook", "add .patchbook/new.md", ".patchbook/new.md", ".patchbook"],
    ["move_into_dot_PATCHBOOK", "move docs/guide.md -> .PATCHBOOK/guide.md", ".PATCHBOOK/guide.md", ".patchbook"],
    ["copy_into_git", "copy app.txt -> .git/x", ".git/x", ".git"],
    ["copy_into_dot_GIT", "copy app.txt -> .GIT/x", ".GIT/x", ".git"],
  ] as const;
  for (const [name, edit, dest, place] of hookRefuses) {
    for (const pending of [false, true]) {
      forkTest(`test_hook_refuses_a_${name}${pending ? "_with_a_hand_edit_pending" : ""}_and_leaves_everything_as_it_was`, (t) => {
        const change = join(t.fork.path, ".patchbook/changes/into-kept");
        mkdirNew(change);
        if (edit.startsWith("add ")) {
          mkdirSync(join(change, "ours", dirname(dest)), { recursive: true });
          writeFileSync(join(change, "ours", `${dest}.pb`), "ours\n");
        }
        writeFileSync(join(change, "CHANGE.md"), `# into-kept\n\nintent: Write into a place a build keeps.\n\nedits:\n- ${edit}\n`);
        writeFileSync(join(t.fork.path, ".patchbook/series"), "into-kept\n");
        if (pending) t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
        sh(["git", "add", "-A"], { cwd: t.fork.path });
        const files = tree(t.fork.path);
        const state = gitState(t);
        const refused = hookCommit(t);
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

  const handAdded = [
    ["a_staged_file_under_dot_PATCHBOOK", ".PATCHBOOK/x.md", true, ".patchbook"],
    ["an_untracked_file_under_dot_GIT", "a/.GIT/y", false, ".git"],
  ] as const;
  for (const [name, path, staged, place] of handAdded) {
    forkTestOnCaseSensitiveFs(`test_hook_refuses_${name}_before_recording_it`, (t) => {
      t.fork.write(path, "ours\n");
      if (staged) sh(["git", "add", "--", path], { cwd: t.fork.path });
      const files = tree(t.fork.path);
      const state = gitState(t);
      const refused = hookCommit(t, "--allow-empty");
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(`patchbook: refusing this commit: ${path} is new, but a change can't write into ${place}.`);
      expect(refused.stderr).toContain(`Move ${path} out of there, or skip the hook once with PATCHBOOK_HOOK=0.`);
      expect(tree(t.fork.path)).toEqual(files);
      expect(gitState(t)).toBe(state);
      expect(existsSync(join(t.fork.path, ".patchbook/changes"))).toBe(false);
    });
  }

  const hookRefusesUnsafe = [
    ["add_climbing_out", "add ../outside.txt"],
    ["add_dot_slash", "add ./new.md"],
    ["add_absolute", "add /outside.txt"],
    ["delete_double_slash", "delete docs//guide.md"],
    ["copy_dest_climbing_out", "copy app.txt -> ../copied.txt"],
    ["copy_dest_dot_slash_patchbook_config", "copy app.txt -> ./.patchbook/config.toml"],
    ["copy_dest_double_slash_patchbook_config", "copy app.txt -> .//.patchbook/config.toml"],
    ["file_climbing_out", "file ../app.txt"],
  ] as const;
  for (const [name, edit] of hookRefusesUnsafe) {
    for (const pending of [false, true]) {
      forkTest(`test_hook_refuses_an_unsafe_${name}_edit${pending ? "_with_a_hand_edit_pending" : ""}_and_leaves_everything_as_it_was`, (t) => {
        const change = join(t.fork.path, ".patchbook/changes/unsafe");
        mkdirNew(change);
        writeFileSync(join(change, "CHANGE.md"), `# unsafe\n\nintent: Name a path outside the tree.\n\nedits:\n- ${edit}\n`);
        writeFileSync(join(t.fork.path, ".patchbook/series"), "unsafe\n");
        if (pending) t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
        sh(["git", "add", "-A"], { cwd: t.fork.path });
        const files = tree(t.fork.path);
        const state = gitState(t);
        const beside = readdirSync(t.tmp).sort();
        const refused = hookCommit(t);
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

  forkTest("test_hook_still_warns_and_commits_for_another_problem", (t) => {
    const change = join(t.fork.path, ".patchbook/changes/gone");
    mkdirNew(change);
    writeFileSync(join(change, "CHANGE.md"), "# gone\n\nintent: Delete a file upstream lacks.\n\nedits:\n- delete missing.txt\n");
    writeFileSync(join(t.fork.path, ".patchbook/series"), "gone\n");
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    const before = sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout;
    const committed = hookCommit(t);
    expect(committed.code).toBe(0);
    expect(committed.stderr).toContain("1 problems, so the output wasn't rebuilt.");
    expect(sh(["git", "rev-parse", "HEAD"], { cwd: t.fork.path }).stdout).not.toBe(before);
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain("gone      changes/gone delete missing.txt");
  });

  const escaping = [
    ["add_climbing_out", "add ../outside.txt"],
    ["add_climbing_out_in_the_middle", "add docs/../../outside.txt"],
    ["add_absolute", "add /outside.txt"],
    ["replace_climbing_out", "replace ../app.txt"],
    ["delete_climbing_out", "delete ../app.txt"],
    ["file_climbing_out", "file ../app.txt"],
    ["file_absolute", "file /app.txt"],
    ["copy_dest_climbing_out", "copy app.txt -> ../copied.txt"],
    ["copy_dest_absolute", "copy app.txt -> /copied.txt"],
    ["copy_source_climbing_out", "copy ../app.txt -> copied.txt"],
    ["move_dest_climbing_out", "move docs/guide.md -> ../guide.md"],
    ["move_source_absolute", "move /docs/guide.md -> guide.md"],
    ["copy_dest_dot_slash_patchbook_config", "copy app.txt -> ./.patchbook/config.toml"],
    ["copy_dest_double_slash_patchbook_config", "copy app.txt -> .//.patchbook/config.toml"],
    ["add_dot_slash_patchbook", "add ./.patchbook/new.md"],
    ["add_dot_slash", "add ./new.md"],
    ["add_inner_dot", "add docs/./new.md"],
    ["delete_double_slash", "delete docs//guide.md"],
    ["delete_dot", "delete ."],
    ["move_source_dot_slash", "move ./docs/guide.md -> guide.md"],
  ] as const;
  for (const [name, edit] of escaping) {
    forkTest(`test_${name}_is_invalid_and_nothing_is_read_or_written_outside`, (t) => {
      const change = join(t.fork.path, ".patchbook/changes/esc");
      mkdirNew(join(change, "ours"));
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
    ["climbing_out", "../x"], ["nested", "a/b"], ["absolute", "/abs"], ["capitalised", "Shout"],
    ["leading_dot", ".x"], ["with_a_space", "a b"], ["with_an_underscore", "a_b"],
  ] as const) {
    forkTest(`test_record_refuses_a_${label}_change_name_and_writes_nothing`, (t) => {
      t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
      const before = tree(t.fork.path);
      const beside = readdirSync(t.tmp).sort();
      const refused = t.pb(["record", name, "--intent", "Shout the second line."], { cwd: t.fork.path, code: 1 });
      expect(refused.stderr).toContain(`"${name}" isn't a valid change name`);
      expect(tree(t.fork.path)).toEqual(before);
      expect(readdirSync(t.tmp).sort()).toEqual(beside);
    });
  }

  forkTest("test_a_series_line_that_is_not_a_change_name_is_invalid_and_its_folder_is_not_read", (t) => {
    mkdirNew(join(t.fork.path, ".patchbook/elsewhere"));
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

  forkTest("test_a_change_folder_that_is_not_a_change_name_is_invalid_and_a_strict_one_is_just_unlisted", (t) => {
    for (const name of ["we\\ird", "Loose_Name", "loose-name"]) {
      mkdirNew(join(t.fork.path, ".patchbook/changes", name));
      writeFileSync(join(t.fork.path, ".patchbook/changes", name, "CHANGE.md"), `# ${name}\n\nintent: Loose.\n\nedits:\n- delete app.txt\n`);
    }
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 });
    expect(status.stdout).toContain(`"we\\\\ird" isn't a valid change name`);
    expect(status.stdout).toContain(`"Loose_Name" isn't a valid change name`);
    expect(status.stdout).toContain("change loose-name is not in the series");
    expect(status.stdout).toContain("3 invalid");
  });

  const badNames = [
    ["a_series_line", "My_Fix", true],
    ["a_folder_that_is_not_in_the_series", "My_Fix", false],
    ["a_folder_with_a_backslash_that_is_not_in_the_series", "we\\ird", false],
  ] as const;
  const badName = (t: ForkCase, name: string, listed: boolean): void => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    t.pb(["record", "tmp-fix", "--intent", "Shout the second line."], { cwd: t.fork.path });
    const changes = join(t.fork.path, ".patchbook/changes");
    renameSync(join(changes, "tmp-fix"), join(changes, name));
    writeFileSync(join(changes, name, "CHANGE.md"), read(join(changes, name, "CHANGE.md")).replace("# tmp-fix", `# ${name}`));
    writeFileSync(join(t.fork.path, ".patchbook/series"), listed ? `${name}\n` : "");
    t.fork.commit("bad name");
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "three", "THREE"));
  };

  for (const [what, name, listed] of badNames) {
    forkTest(`test_status_reports_${what}_that_is_not_a_change_name_as_invalid_and_show_has_no_such_change`, (t) => {
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

    forkTest(`test_hook_refuses_${what}_that_is_not_a_change_name_and_loses_no_edit`, (t) => {
      badName(t, name, listed);
      sh(["git", "add", "-A"], { cwd: t.fork.path });
      const files = tree(t.fork.path);
      const state = gitState(t);
      const refused = hookCommit(t);
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

    forkTest(`test_record_refuses_${what}_that_is_not_a_change_name_and_writes_nothing`, (t) => {
      badName(t, name, listed);
      const files = tree(t.fork.path);
      for (const args of [["--intent", "Shout more."], ["my-fix", "--intent", "Shout more."]]) {
        const refused = t.pb(["record", ...args], { cwd: t.fork.path, code: 1 });
        expect(refused.stderr).toContain(`${JSON.stringify(name)} isn't a valid change name`);
        expect(tree(t.fork.path)).toEqual(files);
      }
    });
  }

  forkTest("test_record_still_takes_a_strict_name_and_makes_one_from_the_intent", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    t.pb(["record", "my-fix", "--intent", "Shout the second line."], { cwd: t.fork.path });
    t.fork.write("extra.txt", "ours\n");
    t.pb(["record", "--intent", "Add an extra file."], { cwd: t.fork.path });
    expect(readdirSync(join(t.fork.path, ".patchbook/changes")).sort()).toEqual(["add-an-extra-file", "my-fix"]);
    expect(read(join(t.fork.path, ".patchbook/series"))).toBe("my-fix\nadd-an-extra-file\n");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    expect(t.pb(["show", "my-fix"], { cwd: t.fork.path }).stdout).toContain("+TWO");
  });

  forkTest("test_record_with_an_empty_name_names_the_change_from_the_intent", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
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
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    t.pb(["record", "fix", "--intent", "Shout the second line."], { cwd: t.fork.path });
    t.pb(["build", "--force"], { cwd: t.fork.path });
    t.fork.commit("fix");
  };

  keepsRejected(
    "test_record_keeps_an_edit_line_it_rejected_when_it_updates_the_change_that_owns_the_file",
    fix,
    (t) => t.fork.write("app.txt", replace(t.fork.read("app.txt"), "three", "THREE")),
    (t) => void t.pb(["record", "--intent", "Shout more."], { cwd: t.fork.path }),
  );
  keepsRejected(
    "test_record_keeps_an_edit_line_it_rejected_when_it_adds_an_edit_to_that_change",
    fix,
    (t) => t.fork.write("extra.txt", "ours\n"),
    (t) => void t.pb(["record", "fix", "--intent", "Shout, and add extra."], { cwd: t.fork.path }),
  );
  keepsRejected(
    "test_record_keeps_an_edit_line_it_rejected_when_it_unadds_a_file_of_that_change",
    (t) => {
      t.fork.write("extra.txt", "ours\n");
      t.pb(["record", "fix", "--intent", "Shout the second line."], { cwd: t.fork.path });
      t.pb(["build", "--force"], { cwd: t.fork.path });
      t.fork.commit("fix");
    },
    (t) => t.fork.rm("extra.txt"),
    (t) => void t.pb(["record", "--intent", "Drop extra."], { cwd: t.fork.path }),
  );

  forkTest("test_check_and_sync_leave_out_what_the_build_ignores", (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "extra\n");
    extra.commit("extra");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.fork.path });
    t.fork.commit("track");
    t.up.write(".patchbook/notes.md", "upstream's notes\n");
    t.up.write("vendor/extra/new.md", "new\n");
    t.up.write("app.txt", replace(t.up.read("app.txt"), "six", "SIX"));
    t.up.commit("upstream edit");
    const notice = "patchbook: left 1 upstream files out of the build because they would land in a vendored copy: vendor/extra (1).\n";
    const checked = t.pb(["check"], { cwd: t.fork.path, code: 10 });
    expect(JSON.parse(checked.stdout).upstreams.upstream.files).toEqual(["changed app.txt"]);
    expect(checked.stderr).toBe(notice);
    const synced = t.pb(["sync", "upstream"], { cwd: t.fork.path });
    expect(synced.stderr).toBe(notice);
    const report = JSON.parse(read(join(t.fork.path, ".patchbook/last-sync.json"))).upstreams.upstream;
    expect(report.upstream).toEqual(["changed app.txt"]);
  });

  for (const kind of ["annotated", "lightweight"]) {
    forkTest(`test_sync_does_not_import_the_${kind}_tags_of_an_in_repo_upstream`, (t) => {
      t.up.write("app.txt", replace(t.up.read("app.txt"), "six", "SIX"));
      t.up.commit("upstream edit");
      sh(["git", "tag", ...(kind === "annotated" ? ["-a", "-m", "release"] : []), "v6"], { cwd: t.up.path });
      t.pb(["sync", "upstream"], { cwd: t.fork.path });
      expect(sh(["git", "for-each-ref", "refs/tags"], { cwd: t.fork.path }).stdout).toBe("");
    });
  }

  forkTest("test_clone_keeps_history_and_pins", (t) => {
    const log = sh(["git", "log", "--oneline"], { cwd: t.fork.path }).stdout;
    expect(log).toContain("start");
    expect(sh(["git", "remote"], { cwd: t.fork.path }).stdout).toContain("upstream");
    expect(t.pb(["check"], { cwd: t.fork.path }).code).toBe(0);
  });

  forkTest("test_record_then_build_is_stable", (t) => {
    t.recordFeature();
    const change = read(join(t.fork.path, ".patchbook/changes/feature/CHANGE.md"));
    expect(change).toContain("- file app.txt");
    expect(change).toContain("- add extra.txt");
    expect(change).toContain("- delete docs/guide.md");
    t.pb(["build"], { cwd: t.fork.path });
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout).toBe("");
    expect(t.pb(["show", "feature"], { cwd: t.fork.path }).stdout).toContain("TWO");
  });

  forkTest("test_sync_merges_clean_upstream_change", (t) => {
    t.recordFeature();
    t.up.write("app.txt", replace(t.up.read("app.txt"), "six", "SIX"));
    const head = t.up.commit("upstream edit");
    const check = t.pb(["check"], { cwd: t.fork.path, code: 10 });
    expect(check.stdout).toContain("changed app.txt");
    t.pb(["sync"], { cwd: t.fork.path });
    const report = JSON.parse(read(join(t.fork.path, ".patchbook/last-sync.json"))).upstreams.upstream;
    expect(report.merged.map((m: { path: string }) => m.path)).toEqual(["app.txt"]);
    t.pb(["build", "--commit"], { cwd: t.fork.path });
    const text = t.fork.read("app.txt");
    expect(text).toContain("TWO");
    expect(text).toContain("SIX");
    const parents = words(sh(["git", "rev-list", "--parents", "-n1", "HEAD"], { cwd: t.fork.path }).stdout);
    expect(parents[2]).toBe(head); // the build merges upstream, so its history stays reachable
  });

  forkTest("test_a_fresh_clone_of_the_fork_reads_the_pin_after_a_sync", (t) => {
    const origin = join(t.tmp, "origin.git");
    const hooked = { ...t.env, PATCHBOOK_HOOK: "1" };
    sh(["git", "init", "-q", "--bare", origin], { cwd: t.tmp });
    sh(["git", "remote", "add", "origin", origin], { cwd: t.fork.path });
    t.up.write("app.txt", replace(t.up.read("app.txt"), "six", "SIX"));
    const head = t.up.commit("upstream edit");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "commit", "-qam", "Sync upstream"], { cwd: t.fork.path, env: hooked });
    sh(["git", "push", "-q", "origin", "HEAD:main"], { cwd: t.fork.path });
    sh(["git", "clone", "-q", "-b", "main", origin, "fresh"], { cwd: t.tmp });
    const fresh = new Repo(join(t.tmp, "fresh"));
    expect(t.pb(["status"], { cwd: fresh.path }).stdout).toBe(`0 edits apply at upstream ${head.slice(0, 7)}; no problems\n`);
    expect(t.pb(["build"], { cwd: fresh.path }).stdout).toContain(`from upstream ${head.slice(0, 7)}`);
    fresh.write("app.txt", replace(fresh.read("app.txt"), "two", "TWO"));
    sh(["git", "commit", "-qam", "shout"], { cwd: fresh.path, env: hooked });
    expect(words(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: fresh.path }).stdout)).toContain(".patchbook/changes/shout/CHANGE.md");
    t.pb(["build", "--commit"], { cwd: fresh.path });
    expect(words(sh(["git", "rev-list", "--parents", "-n1", "HEAD"], { cwd: fresh.path }).stdout)[2]).toBe(head);
  });

  forkTest("test_a_fork_and_its_clone_keep_the_pin_through_gc_when_upstream_is_gone", (t) => {
    const origin = join(t.tmp, "origin.git");
    sh(["git", "init", "-q", "--bare", origin], { cwd: t.tmp });
    t.up.write("app.txt", replace(t.up.read("app.txt"), "six", "SIX"));
    const head = t.up.commit("upstream edit");
    t.pb(["sync"], { cwd: t.fork.path });
    t.fork.commit("Sync upstream");
    sh(["git", "push", "-q", origin, "HEAD:main"], { cwd: t.fork.path });
    sh(["git", "clone", "-q", "-b", "main", origin, "fresh"], { cwd: t.tmp });
    const fresh = new Repo(join(t.tmp, "fresh"));
    t.pb(["hook", "install"], { cwd: fresh.path });
    fresh.write("app.txt", replace(fresh.read("app.txt"), "two", "TWO"));
    sh(["git", "commit", "-qam", "shout"], { cwd: fresh.path, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(words(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: fresh.path }).stdout)).toContain(".patchbook/changes/shout/CHANGE.md");
    rmSync(t.up.path, { recursive: true });
    for (const repo of [t.fork.path, fresh.path]) {
      gc(repo);
      expect(t.pb(["status"], { cwd: repo }).stdout).toContain(`apply at upstream ${head.slice(0, 7)}; no problems`);
    }
  });

  forkTest("test_clone_init_and_track_write_a_relative_upstream_path_as_an_absolute_one", (t) => {
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

  forkTest("test_a_relative_remote_in_config_fails_sync_status_and_check_and_pins_nothing", (t) => {
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replace(`remote = "${t.up.path}"`, 'remote = "../fork"'));
    t.up.write("app.txt", replace(t.up.read("app.txt"), "six", "SIX"));
    t.up.commit("upstream edit");
    const lock = t.fork.read(".patchbook/upstream.lock");
    for (const command of ["sync", "status", "check"]) {
      const out = t.pb([command], { cwd: t.fork.path, code: 1 });
      expect(out.stderr).toContain('upstream upstream\'s remote "../fork" is a relative path');
      expect(out.stderr).toContain("Set remote in .patchbook/config.toml to an absolute path or a URL.");
    }
    expect(t.fork.read(".patchbook/upstream.lock")).toBe(lock);
  });

  forkTest("test_status_reads_a_url_remote_and_refuses_a_relative_path_or_an_empty_remote", (t) => {
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

  forkTest("test_an_empty_upstream_argument_is_refused_and_pins_nothing", (t) => {
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

  forkTest("test_a_remote_that_starts_with_a_dash_fails_sync_status_and_check_and_pins_nothing", (t) => {
    const config = join(t.fork.path, ".patchbook/config.toml");
    const original = read(config);
    t.up.write("app.txt", replace(t.up.read("app.txt"), "six", "SIX"));
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

  forkTest("test_init_and_track_refuse_a_remote_that_starts_with_a_dash_and_change_nothing", (t) => {
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

  forkTest("test_a_remote_helper_in_a_cloned_forks_config_runs_only_if_the_users_git_config_allows_it_and_ext_never_runs", (t) => {
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
    forkTest(`test_a_cloned_forks_config_naming_the_${name}_helper_runs_no_git_remote_${name}`, (t) => {
      const helperRan = markerScript(t, `git-remote-${name}`);
      const fresh = cloneFollowing(t, `${name}::x`);
      for (const command of ["check", "status"]) t.pb([command], { cwd: fresh, code: 1 });
      expect(existsSync(helperRan)).toBe(false);
    });
  }

  forkTest("test_a_users_git_config_that_refuses_the_file_transport_refuses_a_local_path_remote", (t) => {
    const gitconfig = join(t.tmp, "gitconfig");
    writeFileSync(gitconfig, '[protocol]\n\tallow = never\n[protocol "https"]\n\tallow = always\n');
    t.env["GIT_CONFIG_GLOBAL"] = gitconfig;
    expect(t.pb(["check"], { cwd: t.fork.path, code: 1 }).stderr).toContain("transport 'file' not allowed");
  });

  forkTest("test_a_refused_remote_helper_names_the_git_command_without_patchbooks_own_flags", (t) => {
    const fresh = cloneFollowing(t, "pbtest::x");
    const check = t.pb(["check"], { cwd: fresh, code: 1 }).stderr;
    expect(check).toContain("git ls-remote \"pbtest::x\" refs/heads/main failed:\nfatal: transport 'pbtest' not allowed");
    for (const stderr of [check, t.pb(["status"], { cwd: fresh, code: 1 }).stderr]) {
      expect(stderr).not.toContain("protocol.");
      expect(stderr).not.toContain("--end-of-options");
    }
  });

  forkTest("test_a_committed_remote_with_control_characters_reaches_the_terminal_escaped", (t) => {
    const fresh = cloneFollowing(t, "https://example.invalid/\\u001b[31mRED\\u001b]0;TITLE\\u0007x\\u007f[31mDEL\\u009b31mC1\\u0085NEL");
    for (const command of ["check", "status"]) {
      const stderr = t.pb([command], { cwd: fresh, code: 1 }).stderr;
      expect(stderr).toContain(" failed:");
      const ours = stderr.split(" failed:")[0]!;
      expect(ours.replace(/\n/g, "")).not.toMatch(/\p{Cc}/u);
      for (const shown of ["example.invalid/", "RED", "DEL", "NEL"]) expect(ours).toContain(shown);
    }
  });

  forkTest("test_init_and_clone_give_git_an_option_like_branch_or_url_as_a_value_and_pin_nothing", (t) => {
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

  forkTest("test_init_refuses_an_upstream_remote_that_points_elsewhere_and_pins_nothing", (t) => {
    t.up.write("app.txt", replace(t.up.read("app.txt"), "one", "ONE"));
    t.up.commit("b1");
    const mine = join(t.tmp, "mine");
    sh(["git", "clone", "-q", t.up.path, mine], { cwd: t.tmp });
    t.up.write("app.txt", replace(t.up.read("app.txt"), "two", "TWO"));
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

  forkTest("test_a_shallow_clone_of_the_fork_fetches_only_the_pin", (t) => {
    const origin = join(t.tmp, "origin.git");
    sh(["git", "init", "-q", "--bare", origin], { cwd: t.tmp });
    let head = "";
    for (const word of ["four", "five", "six"]) {
      t.up.write("app.txt", replace(t.up.read("app.txt"), word, word.toUpperCase()));
      head = t.up.commit(`shout ${word}`);
    }
    t.pb(["sync"], { cwd: t.fork.path });
    t.fork.commit("Sync upstream");
    sh(["git", "push", "-q", origin, "HEAD:main"], { cwd: t.fork.path });
    sh(["git", "clone", "-q", "--depth", "1", "-b", "main", `file://${origin}`, "shallow"], { cwd: t.tmp });
    const shallow = join(t.tmp, "shallow");
    const commits = (): string => sh(["git", "rev-list", "--count", "--all"], { cwd: shallow }).stdout.trim();
    expect(commits()).toBe("1");
    expect(t.pb(["status"], { cwd: shallow }).stdout).toBe(`0 edits apply at upstream ${head.slice(0, 7)}; no problems\n`);
    expect(t.pb(["build"], { cwd: shallow }).stdout).toContain(`from upstream ${head.slice(0, 7)}`);
    expect(commits()).toBe("2");
  });

  forkTest("test_a_full_fork_stays_full_after_a_sync_fetches_a_new_pin", (t) => {
    const shallow = (): string => sh(["git", "rev-parse", "--is-shallow-repository"], { cwd: t.fork.path }).stdout.trim();
    expect(shallow()).toBe("false");
    t.up.write("app.txt", replace(t.up.read("app.txt"), "six", "SIX"));
    const head = t.up.commit("upstream edit");
    t.pb(["sync"], { cwd: t.fork.path });
    expect(JSON.parse(t.fork.read(".patchbook/upstream.lock")).upstream.commit).toBe(head);
    expect(sh(["git", "cat-file", "-e", `${head}^{commit}`], { cwd: t.fork.path, check: false }).code).toBe(0);
    expect(shallow()).toBe("false");
  });

  forkTest("test_conflict_and_gone", (t) => {
    t.recordFeature();
    t.up.write("app.txt", replace(t.up.read("app.txt"), "two", "deux"));
    t.up.commit("conflicting edit");
    t.pb(["sync"], { cwd: t.fork.path });
    const status = t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout;
    expect(status).toContain("conflict");
    t.pb(["build"], { cwd: t.fork.path, code: 1 });
  });

  forkTest("test_upstream_deletes_an_edited_file", (t) => {
    t.recordFeature();
    t.up.rm("app.txt");
    t.up.write("src/app.txt", "moved\n");
    t.up.commit("move");
    t.pb(["sync"], { cwd: t.fork.path });
    const report = JSON.parse(read(join(t.fork.path, ".patchbook/last-sync.json"))).upstreams.upstream;
    expect(report.gone[0].maybe[0]).toBe("src/app.txt");
    expect(t.pb(["status"], { cwd: t.fork.path, code: 1 }).stdout).toContain("gone");
  });

  forkTest("test_record_writes_the_name_and_intent", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    const out = t.pb(["record"], { cwd: t.fork.path });
    expect(out.stdout).toContain("shout: Shout the second line.");
    const change = read(join(t.fork.path, ".patchbook/changes/shout/CHANGE.md"));
    expect(change).toContain("intent: Shout the second line.");
    expect(change).toContain("- file app.txt");
    expect(read(join(t.tmp, "prompt.txt"))).toContain("+TWO");
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "three", "THREE"));
    t.pb(["record"], { cwd: t.fork.path }); // the model picks shout again, so its intent stays
    expect(read(join(t.fork.path, ".patchbook/changes/shout/CHANGE.md")).split("intent:").length - 1).toBe(1);
    expect(t.pb(["show", "shout"], { cwd: t.fork.path }).stdout).toContain("THREE");
    unlinkSync(join(t.tmp, "prompt.txt"));
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "one", "ONE"));
    expect(t.pb(["record"], { cwd: t.fork.path }).stdout).toContain("(in shout)"); // no model needed
    expect(existsSync(join(t.tmp, "prompt.txt"))).toBe(false);
  });

  forkTest("test_record_keeps_a_given_intent_when_no_name_is_given", (t) => {
    const prompt = join(t.tmp, "prompt.txt");
    const intent = "Make the second line loud so it stands out.";
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
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

  forkTest("test_commit_with_an_intent_does_not_need_the_model", (t) => {
    writeFileSync(join(t.tmp, "bin/claude"), "#!/bin/sh\nexit 1\n");
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    const intent = "Make the second line loud.";
    sh(["git", "commit", "-qam", "shout"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: intent } });
    expect(read(join(t.fork.path, ".patchbook/changes/make-the-second-line/CHANGE.md"))).toContain(`intent: ${intent}`);
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout).toBe("");
  });

  const changeNames = (t: ForkCase): string[] => readdirSync(join(t.fork.path, ".patchbook/changes"));

  forkTest("test_record_names_a_change_from_an_intent_with_one_very_long_word", (t) => {
    const intent = "a".repeat(300);
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    t.pb(["record", "--intent", intent], { cwd: t.fork.path });
    const names = changeNames(t);
    expect(names).toHaveLength(1);
    expect(Buffer.byteLength(names[0]!)).toBeLessThan(256);
    expect(read(join(t.fork.path, ".patchbook/changes", names[0]!, "CHANGE.md"))).toContain(`intent: ${intent}`);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("test_record_names_a_change_from_an_intent_with_several_long_words", (t) => {
    const intent = ["a", "b", "c", "d"].map((c) => c.repeat(64)).join(" ");
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    t.pb(["record", "--intent", intent], { cwd: t.fork.path });
    const names = changeNames(t);
    expect(names).toHaveLength(1);
    expect(Buffer.byteLength(names[0]!)).toBeLessThan(256);
    expect(read(join(t.fork.path, ".patchbook/changes", names[0]!, "CHANGE.md"))).toContain(`intent: ${intent}`);
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
  });

  forkTest("test_record_names_a_change_from_the_first_four_words_of_an_intent", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    t.pb(["record", "--intent", "One two three four five six."], { cwd: t.fork.path });
    expect(changeNames(t)).toEqual(["one-two-three-four"]);
  });

  forkTest("test_commit_with_a_blank_intent_asks_the_model", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    sh(["git", "commit", "-qam", "shout"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "  \n\t " } });
    expect(read(join(t.fork.path, ".patchbook/changes/shout/CHANGE.md"))).toContain("intent: Shout the second line.");
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "three", "THREE"));
    const commit = sh(["git", "commit", "-qam", "again"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(commit.stderr).not.toContain("wasn't rebuilt");
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout).toBe("");
  });

  forkTest("test_record_keeps_a_multi_line_intent_as_one_line", (t) => {
    const intent = "Shout the second line.\nedits:\n- add ghost.txt";
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    t.pb(["record", "--intent", intent], { cwd: t.fork.path });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    t.fork.write("extra.txt", "ours\n");
    t.pb(["record", "extra", "--intent", intent], { cwd: t.fork.path });
    expect(t.pb(["status"], { cwd: t.fork.path }).stdout).toContain("no problems");
    expect(read(join(t.fork.path, ".patchbook/changes/extra/CHANGE.md")).match(/^edits:$/gm)).toHaveLength(1);
  });

  forkTest("test_record_with_an_intent_and_no_name_keeps_the_intent_of_a_change_named_unnamed", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "one", "ONE"));
    t.pb(["record", "unnamed", "--intent", "Shout the first line."], { cwd: t.fork.path });
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    t.pb(["record", "--intent", "Shout the second line too."], { cwd: t.fork.path });
    expect(read(join(t.fork.path, ".patchbook/changes/unnamed/CHANGE.md"))).toContain("intent: Shout the first line.");
    expect(read(join(t.fork.path, ".patchbook/changes/unnamed/CHANGE.md"))).not.toContain("second line too");
  });

  forkTest("test_commit_records_and_builds", (t) => {
    expect(read(join(t.fork.path, ".git/hooks/pre-commit"))).toContain("Installed by patchbook");
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    sh(["git", "commit", "-qam", "shout"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout).toBe("");
    const files = words(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: t.fork.path }).stdout);
    expect(files).toContain("app.txt");
    expect(files).toContain(".patchbook/changes/shout/CHANGE.md");
    expect(files).toContain(".patchbook/build.lock");
    // A patchbook edit is built on commit too.
    const ours = join(t.fork.path, ".patchbook/changes/shout/ours/app.txt.pb");
    writeFileSync(ours, replace(read(ours), "TWO", "Two"));
    sh(["git", "commit", "-qam", "soften"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(t.fork.read("app.txt")).toContain("Two");
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout).toBe("");
  });

  // What the Python version wrote, with the paths of the interpreter and script that installed it.
  const pythonHook = (extra = "") => `#!/bin/sh
# Installed by patchbook. On each commit, it records hand edits to the build output in the
# patchbook, rebuilds, and stages both. Skip it once with: PATCHBOOK_HOOK=0 git commit
[ "$PATCHBOOK_HOOK" = 0 ] && exit 0
${extra}if [ -f '/opt/my tools/patchbook.py' ]; then exec /usr/bin/python3 '/opt/my tools/patchbook.py' hook run; fi
if command -v patchbook >/dev/null; then exec patchbook hook run; fi
echo "patchbook isn't installed, so this commit doesn't record hand edits." >&2
`;

  forkTest("test_hook_from_the_python_version_is_rewritten", (t) => {
    const hook = join(t.fork.path, ".git/hooks/pre-commit");
    writeFileSync(hook, pythonHook());
    expect(t.pb(["status", "--json"], { cwd: t.fork.path }).stderr).toContain("to run patchbook from PATH");
    expect(read(hook)).not.toContain("/opt/my tools");
    expect(read(hook)).toContain("command -v patchbook");
  });

  forkTest("test_hook_someone_added_lines_to_is_left_alone", (t) => {
    const hook = join(t.fork.path, ".git/hooks/pre-commit");
    const edited = pythonHook("other-tool --check || exit $?\n");
    writeFileSync(hook, edited);
    expect(t.pb(["status", "--json"], { cwd: t.fork.path }).stderr).not.toContain("patchbook:");
    expect(read(hook)).toBe(edited);
    expect(t.pb(["hook", "install"], { cwd: t.fork.path }).stderr).toContain("is another tool's hook; add `patchbook hook run`");
    expect(read(hook)).toBe(edited);
  });

  forkTest("test_settings_layer", (t) => {
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

  forkTest("test_settings_with_awkward_text_read_back_as_given", (t) => {
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

  forkTest("test_config_changes_a_dotted_key_or_inline_table_in_place", (t) => {
    const project = join(t.fork.path, ".patchbook/config.toml");
    const original = read(project);
    for (const on of ["hook.enabled = true", "hook = { enabled = true }"]) {
      const before = replace(original, 'layout = "fork"\n', `layout = "fork"\n${on}\n`);
      writeFileSync(project, before);
      t.config(["--project", "hook.enabled", "false"]);
      expect(t.config(["hook.enabled"], { PATCHBOOK_HOOK: "" })).toMatch(/false .*project/);
      expect(read(project)).toBe(replace(before, on, replace(on, "true", "false")));
    }
  });

  forkTest("test_config_refuses_to_edit_a_setting_whose_section_is_not_a_table", (t) => {
    const project = join(t.fork.path, ".patchbook/config.toml");
    const before = replace(read(project), 'layout = "fork"\n', 'layout = "fork"\nhook = true\n');
    writeFileSync(project, before);
    expect(t.pb(["config", "--project", "hook.enabled", "false"], { cwd: t.fork.path, code: 1 }).stderr)
      .toContain("hook in the config must be a table, as in [hook]");
    expect(read(project)).toBe(before);
  });

  forkTest("test_config_set_and_unset_keep_the_rest_of_a_commented_file", (t) => {
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
    expect(read(user)).toBe(replace(before, 'agents = ["claude-code"] # for now', 'agents = ["codex"] # for now'));
    t.config(["--unset", "start.agents"]);
    expect(t.config(["start.agents"])).toMatch(/\["claude-code", "codex"\] .*default/);
    expect(read(user)).toBe(replace(before, 'agents = ["claude-code"] # for now\n', ""));
  });

  forkTest("test_config_replaces_a_value_that_spans_lines", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    writeFileSync(user, '[start]\nagents = [\n  "claude-code",\n  "codex",\n]\n');
    t.config(["start.agents", "codex"]);
    expect(t.config(["start.agents"])).toMatch(/\["codex"\] .*user/);
    expect(Bun.TOML.parse(read(user))).toEqual({ start: { agents: ["codex"] } });
  });

  forkTest("test_config_refuses_an_edit_it_cannot_make_safely", (t) => {
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

  forkTest("test_config_unset_keeps_the_comments_above_the_key", (t) => {
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

  forkTest("test_config_unset_leaves_no_fragment_of_a_multi_line_value", (t) => {
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

  forkTest("test_config_unset_keeps_the_comment_above_a_key_whatever_the_library_would_have_changed", (t) => {
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

  forkTest("test_config_unset_refuses_rather_than_drop_a_comment", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    const before = "[hook]\n# about enabled\nenabled.x = 1\n";
    writeFileSync(user, before);
    const out = t.pb(["config", "--unset", "hook.enabled"], { cwd: t.fork.path, code: 1 });
    expect(out.stderr).toContain(`can't change hook.enabled in ${user} safely: the TOML library would drop the comment "# about enabled"`);
    expect(read(user)).toBe(before);
  });

  forkTest("test_config_keeps_the_endings_and_the_end_of_a_file_with_no_final_newline", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    writeFileSync(user, '[intent]\n# c\r\nmodel = "old"\n[hook]\r\nenabled = true');
    t.config(["intent.model", "new"]);
    expect(read(user)).toBe('[intent]\n# c\r\nmodel = "new"\n[hook]\r\nenabled = true');
    writeFileSync(user, '[intent]\r\nprovider = "claude"');
    t.config(["intent.model", "new"]);
    expect(read(user)).toBe('[intent]\r\nprovider = "claude"\r\nmodel = "new"');
    writeFileSync(user, '[intent]\nmodel = "old"\n\n\n');
    t.config(["intent.model", "new"]);
    expect(read(user)).toBe('[intent]\nmodel = "new"\n\n\n');
    writeFileSync(user, '[intent]\r# c\rmodel = "old"\r');
    t.config(["intent.model", "new"]);
    expect(read(user)).toBe('[intent]\r# c\rmodel = "new"\r');
  });

  forkTest("test_config_unset_keeps_a_byte_order_mark_and_ignores_a_hash_line_in_the_deleted_string", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    writeFileSync(user, '\uFEFFstart.agents = ["a"]\n[intent]\nmodel = "x"\n');
    t.config(["--unset", "start.agents"]);
    expect(read(user)).toBe('\uFEFF[intent]\nmodel = "x"\n');
    writeFileSync(user, '[hook]\nenabled.t = """\n# inside\n"""\n');
    t.config(["--unset", "hook.enabled"]);
    expect(read(user)).toBe("[hook]\n");
  });

  forkTest("test_config_set_keeps_whitespace_only_lines_at_the_end_of_a_file", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    writeFileSync(user, '[intent]\nmodel = "old"\n  \n\n');
    t.config(["intent.model", "new"]);
    expect(read(user)).toBe('[intent]\nmodel = "new"\n  \n\n');
    writeFileSync(user, '[intent]\nmodel = "old"\n   ');
    t.config(["intent.model", "new"]);
    expect(read(user)).toBe('[intent]\nmodel = "new"\n   ');
  });

  forkTest("test_config_unset_on_a_byte_order_mark_line_keeps_the_endings_of_the_lines_after_it", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    writeFileSync(user, "﻿hook.enabled = true\nstart.agents = []\r\nintent.model = \"x\"\r\n");
    t.config(["--unset", "hook.enabled"]);
    expect(read(user)).toBe("﻿start.agents = []\r\nintent.model = \"x\"\r\n");
    writeFileSync(user, "﻿");
    t.config(["intent.model", "new"]);
    expect(read(user)).toBe('﻿[intent]\nmodel = "new"\n');
  });

  forkTest("test_config_set_after_a_last_line_comment_puts_the_file_tail_once_after_the_new_line", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    writeFileSync(user, "[intent]\n# none yet  \n\n  ");
    t.config(["intent.model", "new"]);
    expect(read(user)).toBe('[intent]\n# none yet\n\nmodel = "new"  \n\n  ');
  });

  forkTest("test_config_set_after_a_last_comment_that_ends_in_a_space_toml_does_not_count_as_blank", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    for (const mark of [" ", " ", "　", "﻿"]) {
      writeFileSync(user, `[intent]\n# c${mark}`);
      t.config(["intent.model", "new"]);
      expect(read(user)).toBe(`[intent]\n# c${mark}\n\nmodel = "new"`);
    }
  });

  forkTest("test_config_set_above_a_last_comment_that_ends_in_a_space_toml_does_not_count_as_blank_keeps_it", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    for (const mark of ["\u00A0", "\u2028", "\u3000", "\uFEFF"]) {
      writeFileSync(user, `[intent]\nmodel = "old"\n# c${mark}\n`);
      t.config(["intent.model", "new"]);
      expect(read(user)).toBe(`[intent]\nmodel = "new"\n# c${mark}\n`);
    }
  });

  forkTest("test_config_set_on_a_file_with_a_long_run_of_spaces_before_the_end_is_fast", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    writeFileSync(user, `[intent]\nmodel = "old"${" ".repeat(50000)}\n# end\n`);
    const start = Date.now();
    t.config(["intent.model", "new"]);
    expect(Date.now() - start).toBeLessThan(4000);
    expect(read(user)).toBe('[intent]\nmodel = "new"\n# end\n');
  });

  forkTest("test_config_keeps_each_lines_own_ending_in_a_file_with_mixed_endings", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    const before = '# my settings\r\n[start]\nagents = ["claude-code"]\r\nnote = """\na\nb"""\r\n[intent]\nmodel = "x"\n';
    writeFileSync(user, before);
    t.config(["start.agents", "codex"]);
    expect(read(user)).toBe(replace(before, '["claude-code"]', '["codex"]'));
    t.config(["--unset", "intent.model"]);
    expect(read(user)).toBe('# my settings\r\n[start]\nagents = ["codex"]\r\nnote = """\na\nb"""\r\n[intent]\n');
  });

  forkTest("test_config_keeps_the_line_endings_of_a_crlf_file", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    mkdirSync(join(t.tmp, "config/patchbook"), { recursive: true });
    const before = '# my settings\r\n[start]\r\n# agents\r\nagents = ["claude-code"]\r\nby_host = []\r\n';
    writeFileSync(user, before);
    t.config(["start.agents", "codex"]);
    expect(read(user)).toBe(replace(before, '["claude-code"]', '["codex"]'));
    t.config(["--unset", "start.agents"]);
    expect(read(user)).toBe("# my settings\r\n[start]\r\n# agents\r\nby_host = []\r\n");
    t.config(["intent.model", "x"]);
    expect(read(user)).not.toMatch(/[^\r]\n/);
  });

  forkTest("test_a_config_with_an_integer_too_big_for_bun_says_so_in_either_scope", (t) => {
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

  forkTest("test_config_starts_a_user_config_that_does_not_exist", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    t.config(["--unset", "start.agents"]);
    expect(existsSync(user)).toBe(false);
    t.config(["start.agents", "codex"]);
    expect(read(user)).toBe('[start]\nagents = ["codex"]\n');
    expect(t.config(["start.agents"])).toMatch(/\["codex"\] .*user/);
  });

  forkTest("test_track_writes_awkward_values_so_they_read_back_as_given", (t) => {
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

  forkTest("test_a_project_config_that_is_not_toml_is_named_in_the_error", (t) => {
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, 'layout = "fork"\n[[upstream]\nname = "x"\n');
    for (const args of [["status"], ["build"], ["config"]]) {
      const out = t.pb(args, { cwd: t.fork.path, code: 1 });
      expect(out.stderr).toContain(`${config} isn't valid TOML`);
      expect(out.stderr).not.toContain("SyntaxError");
      expect(out.stderr).not.toContain("    at ");
    }
  });

  forkTest("test_config_writes_the_user_config_inside_a_book_that_fails_to_load", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, replace(read(config), 'layout = "fork"', 'layout = "bogus"'));
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

  forkTest("test_config_writes_the_user_config_inside_a_book_whose_hooks_throw", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    writeFileSync(join(t.fork.path, ".patchbook/hooks.ts"), 'throw new Error("hooks blew up");\n');
    t.pb(["config", "intent.model", "fake-x"], { cwd: t.fork.path });
    expect((Bun.TOML.parse(read(user)) as { intent: { model: string } }).intent.model).toBe("fake-x");
    t.pb(["config", "--unset", "intent.model"], { cwd: t.fork.path });
    expect(read(user)).not.toContain("fake-x");
  });

  forkTest("test_config_writes_the_user_config_and_installs_a_missing_hook_in_a_clone", (t) => {
    sh(["git", "clone", "-q", t.fork.path, "teammate"], { cwd: t.tmp });
    const teammate = new Repo(join(t.tmp, "teammate"));
    const hook = join(teammate.path, ".git/hooks/pre-commit");
    expect(existsSync(hook)).toBe(false);
    const out = t.pb(["config", "intent.model", "fake-x"], { cwd: teammate.path });
    expect(out.stdout).toContain("intent.model");
    expect(out.stderr).toContain("installed a pre-commit hook");
    expect(read(hook)).toContain("Installed by patchbook");
    teammate.write("app.txt", replace(teammate.read("app.txt"), "two", "TWO"));
    sh(["git", "commit", "-qam", "shout"], { cwd: teammate.path, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(existsSync(join(teammate.path, ".patchbook/changes/shout/CHANGE.md"))).toBe(true);
  });

  forkTest("test_config_writes_the_user_config_in_a_book_outside_a_git_repo", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    const loose = join(t.tmp, "loose");
    mkdirSync(join(loose, ".patchbook"), { recursive: true });
    writeFileSync(join(loose, ".patchbook/config.toml"), read(join(t.fork.path, ".patchbook/config.toml")));
    const out = t.pb(["config", "intent.model", "fake-x"], { cwd: loose });
    expect(out.stderr).toContain("couldn't install the pre-commit hook");
    expect((Bun.TOML.parse(read(user)) as { intent: { model: string } }).intent.model).toBe("fake-x");
  });

  forkTest("test_a_user_config_that_is_not_toml_is_named_in_the_error", (t) => {
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

  forkTest("test_hook_off_in_the_project", (t) => {
    t.config(["--project", "hook.enabled", "false"]);
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    sh(["git", "commit", "-qam", "shout"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "" } });
    expect(existsSync(join(t.fork.path, ".patchbook/changes/shout"))).toBe(false);
  });

  forkTest("test_build_refuses_to_overwrite_hand_edits", (t) => {
    t.recordFeature();
    t.fork.write("app.txt", "hand edit\n");
    t.pb(["build"], { cwd: t.fork.path, code: 1 });
    t.pb(["build", "--force"], { cwd: t.fork.path });
    expect(t.fork.read("app.txt")).toContain("TWO");
  });

  forkTest("test_added_symlink_stays_a_symlink", (t) => {
    symlinkSync("app.txt", join(t.fork.path, "link"));
    t.pb(["record", "link", "--intent", "Link to the app."], { cwd: t.fork.path });
    unlinkSync(join(t.fork.path, "link"));
    t.pb(["build", "--force"], { cwd: t.fork.path });
    expect(isSymlink(join(t.fork.path, "link"))).toBe(true);
    expect(readlinkSync(join(t.fork.path, "link"))).toBe("app.txt");
  });

  forkTest("test_exec_bit_survives", (t) => {
    t.recordFeature();
    expect(isExecutable(join(t.fork.path, "bin/run.sh"))).toBe(true);
  });

  forkTest("test_fork_tracks_a_second_upstream", (t) => {
    const lib = new Repo(join(t.tmp, "lib"));
    lib.write("src/lib.txt", "v1\n");
    lib.commit("lib");
    t.pb(["track", "lib", lib.path, "--path", "src"], { cwd: t.fork.path });
    t.pb(["build", "--commit"], { cwd: t.fork.path });
    expect(t.fork.read("lib/lib.txt")).toBe("v1\n");
    lib.write("src/lib.txt", "v2\n");
    lib.commit("lib v2");
    const check = JSON.parse(t.pb(["check"], { cwd: t.fork.path, code: 10 }).stdout);
    expect(check.upstreams.lib.moved).toBeTruthy();
    expect(check.upstreams.upstream.moved).toBeFalsy();
    t.pb(["sync", "lib"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    expect(t.fork.read("lib/lib.txt")).toBe("v2\n");
    expect(words(t.fork.read("app.txt"))[1]).toBe("two");
  });

  forkTest("test_sync_changes_nothing_when_the_pin_ref_cannot_be_written", (t) => {
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
});

describe("VendorTest", () => {
  vendorTest("test_missing_scaffold_patch_build", (t) => {
    t.missingScaffoldPatchBuild();
  });

  vendorTest("test_structural_edits", (t) => {
    t.missingScaffoldPatchBuild();
    const change = join(t.repo.path, ".patchbook/changes/support");
    mkdirNew(join(change, "ours/skills/support"));
    writeFileSync(join(change, "ours/skills/support/SKILL.md.pb"), "---\nname: support\n---\n");
    writeFileSync(join(change, "CHANGE.md"), lstrip(dedent(`
      # support

      intent: Ship the agent briefs inside a support skill.

      edits:
      - add skills/support/SKILL.md
      - move agents -> skills/support/agents
    `)));
    writeFileSync(join(t.repo.path, ".patchbook/series"), "support\n");
    t.pb(["build"], { cwd: t.repo.path });
    expect(t.repo.read("skills/support/agents/helper.md")).toBe("A helper.\n");
    expect(existsSync(join(t.repo.path, "skills/support/SKILL.md"))).toBe(true);
  });

  vendorTest("test_record_in_vendor_output", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.write("skills/hello/notes.txt", "added by hand\n");
    t.pb(["record", "notes", "--intent", "Add notes."], { cwd: t.repo.path });
    expect(read(join(t.repo.path, ".patchbook/changes/notes/CHANGE.md"))).toContain("- add skills/hello/notes.txt");
    t.pb(["build"], { cwd: t.repo.path });
    expect(t.repo.read("skills/hello/notes.txt")).toBe("added by hand\n");
  });

  vendorTest("test_record_paragraph_edits", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    // A patched paragraph keeps its placeholder and its intent, with no model call.
    let out = t.recordEdit("Say hello in T3.", "Say hello in T3. Smile.");
    expect(out).toContain("updated");
    expect(read(entries)).toContain("--- patched\n{{snippet:greet}} Smile.");
    expect(existsSync(join(t.tmp, "prompt.txt"))).toBe(false);
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

  vendorTest("test_record_paragraph_edit_with_an_intent_keeps_the_intent_of_a_change_named_unnamed", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    t.repo.write("skills/hello/notes.txt", "added by hand\n");
    t.pb(["record", "unnamed", "--intent", "Add notes."], { cwd: t.repo.path });
    t.recordEdit("Then wave.", "Then wave twice.", "--intent", "Wave twice.");
    expect(read(entries)).toContain("--- patched\nThen wave twice.");
    expect(read(join(t.repo.path, ".patchbook/changes/unnamed/CHANGE.md"))).toContain("intent: Add notes.");
    expect(read(join(t.repo.path, ".patchbook/changes/unnamed/CHANGE.md"))).not.toContain("Wave twice.");
  });

  vendorTest("test_record_with_no_name_or_intent_adds_to_the_change_named_unnamed", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.write("skills/hello/notes.txt", "added by hand\n");
    t.pb(["record", "unnamed", "--intent", "Add notes."], { cwd: t.repo.path });
    unlinkSync(join(t.repo.path, "skills/hello/SKILL.md"));
    t.pb(["record"], { cwd: t.repo.path });
    const kept = read(join(t.repo.path, ".patchbook/changes/unnamed/CHANGE.md"));
    expect(kept).toContain("intent: Add notes.");
    expect(kept).toContain("- add skills/hello/notes.txt");
    expect(kept).toContain("- delete skills/hello/SKILL.md");
    expect(readdirSync(join(t.repo.path, ".patchbook/changes"))).toEqual(["unnamed"]);
  });

  vendorTest("test_record_deleting_a_file_with_block_entries_keeps_the_change_named_unnamed", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.write("skills/hello/notes.txt", "added by hand\n");
    t.pb(["record", "unnamed", "--intent", "Add notes."], { cwd: t.repo.path });
    unlinkSync(join(t.repo.path, "skills/hello/SKILL.md"));
    t.pb(["record", "--intent", "Drop the skill."], { cwd: t.repo.path });
    const kept = read(join(t.repo.path, ".patchbook/changes/unnamed/CHANGE.md"));
    expect(kept).toContain("intent: Add notes.");
    expect(kept).toContain("- add skills/hello/notes.txt");
    expect(read(join(t.repo.path, ".patchbook/changes/unnamed-2/CHANGE.md"))).toContain("- delete skills/hello/SKILL.md");
  });

  vendorTest("test_record_ignores_output_the_patchbook_changed", (t) => {
    const entries = t.missingScaffoldPatchBuild();
    writeFileSync(entries, replace(read(entries), "{{snippet:greet}}", "Say hi in T3."));
    expect(t.pb(["record"], { cwd: t.repo.path }).stdout).toContain("nothing to record");
    expect(read(entries)).toContain("Say hi in T3.");
  });

  vendorTest("test_upstream_rewords_a_patched_block", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.commit("built");
    const skill = "plugin/skills/hello/SKILL.md";
    t.up.write(skill, replace(t.up.read(skill), "say hello", "say hi"));
    t.up.commit("reword");
    t.pb(["check"], { cwd: t.repo.path, code: 10 });
    t.pb(["sync"], { cwd: t.repo.path });
    const status = t.pb(["status"], { cwd: t.repo.path, code: 1 }).stdout;
    expect(status).toContain("orphan");
    expect(status).toContain("missing");
    expect(status).toMatch(/nearest new blocks: line 7 \[[0-9a-f]{12}\] 0\.9/);
  });

  vendorTest("test_no_copy_of_upstream_in_the_repo", (t) => {
    expect(existsSync(join(t.repo.path, "vendor"))).toBe(false);
    expect(read(join(t.repo.path, ".patchbook/config.toml"))).toContain('layout = "folder"');
    expect(readdirSync(join(t.tmp, "store/upstreams")).length).toBe(1);
  });

  vendorTest("test_reading_upstream", (t) => {
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

  vendorTest("test_sync_pins_the_head_when_another_fetch_lands_in_the_store", (t) => {
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

  vendorTest("test_a_failed_fetch_names_the_upstream_and_the_ref_it_was_asked_for", (t) => {
    const err = t.pb(["sync", "plugin", "no-such-ref"], { cwd: t.repo.path, code: 1 }).stderr;
    expect(err).toContain(`git fetch ${JSON.stringify(t.up.path)} no-such-ref failed:`);
    expect(err).toContain("fatal:");
    expect(err).not.toContain("refs/patchbook");
  });

  vendorTest("test_store_keeps_pinned_commits_through_gc", (t) => {
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

  vendorTest("test_store_keeps_a_pin_it_held_without_a_ref", (t) => {
    const store = join(t.tmp, "store/upstreams", readdirSync(join(t.tmp, "store/upstreams"))[0]!);
    for (const ref of sh(["git", "for-each-ref", "--format=%(refname)"], { cwd: store }).stdout.split("\n").filter(Boolean)) {
      sh(["git", "update-ref", "-d", ref], { cwd: store });
    }
    expect(words(t.pb(["upstream", "plugin"], { cwd: t.repo.path }).stdout)).toEqual(["README.md", "agents/helper.md", "skills/hello/SKILL.md"]);
    sh(["git", "gc", "-q", "--prune=now"], { cwd: store });
    rmSync(t.up.path, { recursive: true });
    expect(words(t.pb(["upstream", "plugin"], { cwd: t.repo.path }).stdout)).toEqual(["README.md", "agents/helper.md", "skills/hello/SKILL.md"]);
  });

  vendorTest("test_check_leaves_the_heads_it_fetches_to_gc", (t) => {
    const store = join(t.tmp, "store/upstreams", readdirSync(join(t.tmp, "store/upstreams"))[0]!);
    const pin = JSON.parse(read(join(t.repo.path, ".patchbook/upstream.lock"))).plugin.commit;
    t.up.write("plugin/README.md", "For everyone.\n");
    const head = t.up.commit("readme");
    t.pb(["check"], { cwd: t.repo.path, code: 10 });
    sh(["git", "gc", "-q", "--prune=now"], { cwd: store });
    expect(sh(["git", "cat-file", "-e", `${pin}^{commit}`], { cwd: store, check: false }).code).toBe(0);
    expect(sh(["git", "cat-file", "-e", `${head}^{commit}`], { cwd: store, check: false }).code).not.toBe(0);
    rmSync(t.up.path, { recursive: true });
    expect(words(t.pb(["upstream", "plugin"], { cwd: t.repo.path }).stdout)).toEqual(["README.md", "agents/helper.md", "skills/hello/SKILL.md"]);
  });

  vendorTest("test_check_keeps_the_pin_when_the_head_moved_but_not_the_tree", (t) => {
    const store = storeOf(t);
    const pin = pinOf(t);
    dropRefs(store);
    t.up.write("other/ignored.md", "Still not followed.\n");
    t.up.commit("outside the path");
    t.pb(["check"], { cwd: t.repo.path });
    gc(store);
    expect(inStore(store, pin)).toBe(true);
  });

  vendorTest("test_check_keeps_the_pin_it_compares_with", (t) => {
    const store = storeOf(t);
    const pin = pinOf(t);
    dropRefs(store);
    t.up.write("plugin/README.md", "For everyone.\n");
    t.up.commit("readme");
    t.pb(["check"], { cwd: t.repo.path, code: 10 });
    gc(store);
    expect(inStore(store, pin)).toBe(true);
  });

  vendorTest("test_check_warns_once_when_the_pin_ref_cannot_be_written", (t) => {
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

  vendorTest("test_check_keeps_the_pin_when_the_head_has_not_moved", (t) => {
    const store = storeOf(t);
    const pin = pinOf(t);
    dropRefs(store);
    t.pb(["check"], { cwd: t.repo.path });
    gc(store);
    expect(inStore(store, pin)).toBe(true);
    rmSync(t.up.path, { recursive: true });
    expect(words(t.pb(["upstream", "plugin"], { cwd: t.repo.path }).stdout)).toEqual(["README.md", "agents/helper.md", "skills/hello/SKILL.md"]);
  });

  vendorTest("test_check_passes_when_the_pin_is_gone_from_the_store_and_from_upstream", (t) => {
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
    expect(out.upstreams.plugin.moved).toBe(false);
    expect(inStore(store, pin)).toBe(false);
  });

  vendorTest("test_sync_keeps_no_ref_for_a_commit_whose_vendored_copy_does_not_match", (t) => {
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

  vendorTest("test_sync_leaves_a_vendored_upstream_as_it_was_when_the_ref_cannot_be_written", (t) => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "one\ntwo\nthree\nfour\nfive\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    const change = join(t.repo.path, ".patchbook/changes/tweak");
    mkdirNew(change);
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

  vendorTest("test_sync_keeps_a_ref_that_was_there_when_the_vendored_copy_does_not_match", (t) => {
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
      vendorTest(`test_sync_keeps_no_new_ref_when_it_fails_after_the_keep_${layout}${before ? "_unless_it_was_there" : ""}`, (t) => {
        const extra = new Repo(join(t.tmp, "extra"));
        extra.write("a.md", "one\ntwo\nthree\nfour\nfive\n");
        extra.commit("a");
        t.pb(["track", "extra", extra.path, ...(layout === "vendored" ? ["--vendor", "vendor/extra"] : [])], { cwd: t.repo.path });
        const change = join(t.repo.path, ".patchbook/changes/tweak");
        mkdirNew(change);
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
      });
    }
  }

  for (const command of ["status", "build"]) {
    vendorTest(`test_${command}_keeps_a_pin_it_held_without_a_ref`, (t) => {
      const store = storeOf(t);
      const pin = pinOf(t);
      dropRefs(store);
      t.pb([command], { cwd: t.repo.path, code: null });
      gc(store);
      expect(inStore(store, pin)).toBe(true);
    });

    vendorTest(`test_${command}_keeps_the_pin_of_a_vendored_upstream_held_without_a_ref`, (t) => {
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

  vendorTest("test_sync_keeps_the_pin_it_moves_from", (t) => {
    const store = storeOf(t);
    const pin = pinOf(t);
    dropRefs(store);
    t.up.write("plugin/README.md", "For everyone.\n");
    t.up.commit("readme");
    t.pb(["sync"], { cwd: t.repo.path });
    gc(store);
    expect(inStore(store, pin)).toBe(true);
  });

  vendorTest("test_upstream_diff_keeps_the_previous_pin", (t) => {
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

  vendorTest("test_upstream_since_does_not_keep_the_commit_it_is_given", (t) => {
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

  vendorTest("test_reads_need_no_write_to_the_pin_ref", (t) => {
    t.missingScaffoldPatchBuild();
    const store = storeOf(t);
    writeFileSync(join(store, "refs/pins", `${pinOf(t)}.lock`), "");
    const files = t.pb(["upstream", "plugin"], { cwd: t.repo.path });
    expect(words(files.stdout)).toEqual(["README.md", "agents/helper.md", "skills/hello/SKILL.md"]);
    expect(files.stderr).toBe("");
    expect(t.pb(["status"], { cwd: t.repo.path }).stderr).toBe("");
  });

  vendorTest("test_reads_go_on_when_the_pin_ref_cannot_be_written", (t) => {
    const store = storeOf(t);
    const pin = pinOf(t);
    dropRefs(store);
    mkdirSync(join(store, "refs/pins"), { recursive: true });
    writeFileSync(join(store, "refs/pins", `${pin}.lock`), "");
    const files = t.pb(["upstream", "plugin"], { cwd: t.repo.path });
    expect(words(files.stdout)).toEqual(["README.md", "agents/helper.md", "skills/hello/SKILL.md"]);
    expect(files.stderr).toContain(`couldn't keep ${pin.slice(0, 7)} in the store`);
  });

  vendorTest("test_vendor_copy_is_guarded", (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "a\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    t.repo.write("vendor/extra/a.md", "edited\n");
    expect(t.pb(["status"], { cwd: t.repo.path, code: 1 }).stderr).toContain("Never edit the vendored copy");
  });

  vendorTest("test_other_upstream_paths_do_not_move_the_pin", (t) => {
    t.up.write("other/ignored.md", "changed\n");
    t.up.commit("elsewhere");
    const out = JSON.parse(t.pb(["check"], { cwd: t.repo.path }).stdout);
    expect(out.moved).toBeFalsy();
  });

  vendorTest("test_two_upstreams", (t) => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("skills/tool/SKILL.md", "---\nname: tool\n---\n\nUse the tool.\n");
    extra.write("skills/unwanted/SKILL.md", "---\nname: unwanted\n---\n");
    extra.commit("extra");
    t.pb(["track", "extra", extra.path, "--vendor", "vendor/extra"], { cwd: t.repo.path });
    expect(existsSync(join(t.repo.path, "vendor/extra/skills/tool/SKILL.md"))).toBe(true);
    const change = join(t.repo.path, ".patchbook/changes/ship-tool");
    mkdirNew(change);
    writeFileSync(join(change, "CHANGE.md"), "# ship-tool\n\nintent: Ship extra's tool skill.\n\nedits:\n- move extra/skills/tool -> skills/tool\n");
    writeFileSync(join(t.repo.path, ".patchbook/series"), "ship-tool\n");
    t.pb(["build"], { cwd: t.repo.path });
    expect(t.repo.read("skills/tool/SKILL.md")).toContain("Use the tool.");
    expect(existsSync(join(t.repo.path, "skills/unwanted"))).toBe(false);
    const lock = JSON.parse(read(join(t.repo.path, ".patchbook/upstream.lock")));
    expect(Object.keys(lock).sort()).toEqual(["extra", "plugin"]);
    extra.write("skills/tool/SKILL.md", "---\nname: tool\n---\n\nUse the new tool.\n");
    extra.commit("v2");
    const check = JSON.parse(t.pb(["check"], { cwd: t.repo.path, code: 10 }).stdout);
    expect(check.upstreams.extra.files).toEqual(["changed extra/skills/tool/SKILL.md"]);
    t.pb(["sync"], { cwd: t.repo.path });
    t.pb(["build"], { cwd: t.repo.path });
    expect(t.repo.read("skills/tool/SKILL.md")).toContain("Use the new tool.");
  });

  vendorTest("test_block_terms_may_return_a_string", (t) => {
    // Python iterated a string into its characters, and a set of them is what the block needs entries for.
    writeFileSync(join(t.repo.path, ".patchbook/hooks.ts"), dedent(`
      export function blockTerms(path: string, block: string) {
        return block.includes("wave") ? "ba" : [];
      }
    `));
    expect(t.pb(["status"], { cwd: t.repo.path, code: 1 }).stdout).toContain("needs an entry (a, b)");
  });

  vendorTest("test_check_may_return_any_kind_of_problem", (t) => {
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

  vendorTest("test_absolute_output_folder_is_used_as_given", (t) => {
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, replace(read(config), 'to = "skills"', `to = "${join(t.repo.path, "skills")}"`));
    t.missingScaffoldPatchBuild();
    expect(existsSync(join(t.repo.path, t.repo.path))).toBe(false);
  });

  vendorTest("test_absolute_output_folder_reached_through_a_link_above_the_repo_is_used_as_given", (t) => {
    symlinkSync(t.tmp, join(t.tmp, "via"));
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, replace(read(config), 'to = "skills"', `to = "${join(t.tmp, "via/adapted/skills")}"`));
    t.missingScaffoldPatchBuild();
    expect(t.repo.read("skills/hello/SKILL.md")).toContain("Hello");
  });

  const setOutputFolder = (t: VendorCase, to: string): void => {
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replace(/^to = .*$/m, () => `to = ${JSON.stringify(to)}`));
  };

  vendorTest("test_output_folder_cannot_be_the_repo_root", (t) => {
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

  vendorTest("test_output_folder_cannot_be_inside_the_patchbook", (t) => {
    t.missingScaffoldPatchBuild();
    for (const to of [".patchbook", ".patchbook/out", join(t.repo.path, ".patchbook/changes")]) {
      setOutputFolder(t, to);
      const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain("is inside .patchbook");
      expect(existsSync(join(t.repo.path, ".patchbook/config.toml"))).toBe(true);
    }
  });

  vendorTest("test_output_folder_must_be_inside_the_repo", (t) => {
    t.missingScaffoldPatchBuild();
    for (const to of ["..", "../elsewhere", join(t.tmp, "elsewhere")]) {
      setOutputFolder(t, to);
      const out = t.pb(["build"], { cwd: t.repo.path, code: 1 });
      expect(out.stderr).toContain("is outside the repo");
      expect(existsSync(join(t.tmp, "elsewhere"))).toBe(false);
    }
  });

  vendorTest("test_output_folder_cannot_overlap_a_vendored_copy", (t) => {
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

  test("test_init_rejects_an_empty_output_folder", () => {
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

  vendorTest("test_output_folder_cannot_be_a_file", (t) => {
    t.missingScaffoldPatchBuild();
    setOutputFolder(t, "README.md");
    const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("is not a folder");
    expect(t.repo.read("README.md")).toBe("mine\n");
  });

  vendorTest("test_a_copy_into_a_git_name_in_the_output_folder_is_invalid", (t) => {
    const change = join(t.repo.path, ".patchbook/changes/into-git");
    mkdirNew(change);
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
    mkdirNew(change);
    writeFileSync(join(change, "CHANGE.md"), `# ${name}\n\nintent: Write somewhere new.\n\nedits:\n${edits.map((e) => `- ${e}\n`).join("")}`);
    writeFileSync(join(t.repo.path, ".patchbook/series"), `${name}\n`);
  }

  vendorTest("test_a_copy_into_a_git_name_under_the_from_folder_is_invalid_when_to_differs", (t) => {
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

  vendorTest("test_a_copy_into_a_patchbook_name_under_the_from_folder_builds_into_the_output_folder", (t) => {
    t.missingScaffoldPatchBuild();
    setOutputFolder(t, "out");
    writeChange(t, "into-dot-patchbook", ["copy skills/hello/SKILL.md -> skills/.patchbook/x.md"]);
    t.pb(["build", "--force"], { cwd: t.repo.path });
    expect(t.repo.read("out/.patchbook/x.md")).toContain("Say hello in T3.");
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  vendorTest("test_destinations_that_only_look_like_kept_names_build", (t) => {
    t.missingScaffoldPatchBuild();
    const dests = [".patchbookx/a", "docs/.patchbook-notes", ".github/x", ".gitignore"];
    writeChange(t, "look-alikes", dests.map((d) => `copy skills/hello/SKILL.md -> skills/${d}`));
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: t.repo.path });
    for (const d of dests) expect(t.repo.read(`skills/${d}`)).toContain("Say hello in T3.");
  });

  vendorTest("test_a_copy_into_a_vendored_copy_names_the_copy", (t) => {
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

  vendorTest("test_hook_still_warns_and_commits_for_a_copy_into_a_vendored_copy", (t) => {
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

  vendorTest("test_output_folder_cannot_be_inside_the_git_dir", (t) => {
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

  vendorTest("test_output_folder_cannot_be_a_dangling_link", (t) => {
    t.missingScaffoldPatchBuild();
    symlinkSync(".patchbook/nope", join(t.repo.path, "dangle"));
    setOutputFolder(t, "dangle");
    const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("is a link to nothing");
    expect(existsSync(join(t.repo.path, ".patchbook/nope"))).toBe(false);
  });

  vendorTest("test_output_folder_overlaps_a_vendored_copy_at_the_repo_root", (t) => {
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, replace(read(config), 'name = "plugin"\n', 'name = "plugin"\nvendor = "."\n'));
    const out = t.pb(["status"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("overlaps the vendored copy, which is the repo root");
  });

  vendorTest("test_a_vendored_copy_inside_another_upstreams_output_folder_builds_and_checks_clean", (t) => {
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

  for (const [where, to, link] of [["itself", "out", "out"], ["an ancestor", "lnk/out", "lnk"]] as const) {
    vendorTest(`test_output_folder_cannot_be_${where === "itself" ? "a_link" : "under_a_link"}`, (t) => {
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

  vendorTest("test_build_after_a_link_in_the_output_became_a_folder", (t) => {
    linkBecomesFolder(t);
    const out = t.pb(["build"], { cwd: t.repo.path });
    expect(out.stdout).toContain("built");
    expect(out.stderr).not.toContain("EISDIR");
    expect(t.repo.read("skills/d/f.md")).toBe("in a folder\n");
  });

  vendorTest("test_commit_after_a_link_in_the_output_became_a_folder", (t) => {
    linkBecomesFolder(t);
    t.repo.write("NOTES.md", "notes\n");
    sh(["git", "add", "NOTES.md"], { cwd: t.repo.path });
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
    vendorTest(`test_build_force_over_an_empty_folder_that_replaced_a_${kind}`, (t) => {
      const at = builtThenReplaced(t, kind, () => {});
      expect(t.pb(["build"], { cwd: t.repo.path, code: 1 }).stderr).toContain("  x\n");
      restored(t, kind, at);
    });

    vendorTest(`test_build_force_over_a_folder_of_empty_folders_that_replaced_a_${kind}`, (t) => {
      const at = builtThenReplaced(t, kind, (folder) => mkdirSync(join(folder, "y/z"), { recursive: true }));
      restored(t, kind, at);
    });

    vendorTest(`test_build_force_refuses_a_folder_of_ignored_files_that_replaced_a_${kind}`, (t) => {
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

  for (const [what, below, named] of [["a_subfolder", "locked", "x/locked"], ["a_folder", "", "x"]] as const) {
    test.skipIf(process.getuid?.() === 0)(`test_build_force_refuses_a_folder_with_${what}_it_cannot_read`, () => {
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
    }, TIMEOUT);
  }

  for (const to of ["skills/.git", "skills/.git/x", "a/.git", "a/b/.git/c"]) {
    vendorTest(`test_output_folder_${to.replace(/\W/g, "_")}_has_a_git_segment_and_is_rejected`, (t) => {
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

  test("test_track_rejects_a_mount_that_puts_the_output_under_a_git_folder_in_the_folder_layout", () => {
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
    ["_spelled_from_the_physical_repo_path", (t, to) => join(realpathSync(t.repo.path), to)],
    ["_spelled_through_a_link_above_the_repo", (t, to) => join(t.tmp, "via/adapted", to)],
    ["_spelled_through_a_link_to_the_repo", (t, to) => join(t.tmp, "alias", to)],
  ];

  for (const [spelled, spell] of spellings) {
    vendorTest(`test_output_folder_cannot_be_under_a_link_to_the_repo_root${spelled}`, (t) => {
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

  test("test_init_rejects_an_output_folder_under_a_link_to_the_repo_root_spelled_through_a_link_above_the_repo", () => {
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

  vendorTest("test_output_folder_under_a_link_spelled_through_a_link_above_the_repo_names_the_link_in_the_repo", (t) => {
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

  vendorTest("test_output_folder_cannot_be_under_a_link_that_leaves_the_repo_and_comes_back_to_its_root", (t) => {
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

  vendorTest("test_output_folder_cannot_be_under_a_link_to_the_repo_root_reached_through_a_link_into_the_repo", (t) => {
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

  for (const to of [".GIT", ".Git/x", "out/.gIT/y"]) {
    vendorTest(`test_output_folder_${to.replace(/\W/g, "_")}_has_a_git_segment_in_another_case_and_is_rejected`, (t) => {
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

  const gitReadsAsDotGit = [
    ["dot_git_dot", ".git."],
    ["dot_git_space", ".git "],
    ["GIT_tilde_1", "GIT~1"],
    ["git_tilde_1_dot_space", "out/git~1. /y"],
    ["dot_git_colon", "out/.git:x"],
    ["backslash_dot_git", "out/a\\.git"],
    ["dot_g_zero_width_non_joiner_it", ".g\u200cit"],
    ["byte_order_mark_dot_GIT", "out/\ufeff.GIT/y"],
    ["dot_git_noncharacter_fffe", ".git\ufffe"],
    ["dot_GIT_zero_width_non_joiner_noncharacter_ffff", "out/.GIT\u200c\uffffx/y"],
  ] as const;

  for (const [what, to] of gitReadsAsDotGit) {
    vendorTest(`test_output_folder_${what}_is_a_name_git_reads_as_dot_git_and_is_rejected`, (t) => {
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

  vendorTest("test_output_folder_named_like_git_but_not_read_as_dot_git_builds_and_stages", (t) => {
    t.missingScaffoldPatchBuild();
    for (const to of [".gitx", "git~2", ".git.x", "a.git", ".git\u200c.", ".git\ufffd"]) {
      setOutputFolder(t, to);
      t.pb(["build", "--force"], { cwd: t.repo.path });
      expect(t.repo.read(`${to}/hello/SKILL.md`)).toContain("Say hello in T3.");
    }
    sh(["git", "-c", "core.protectHFS=true", "add", "-A"], { cwd: t.repo.path });
  });

  test("test_init_and_track_reject_names_git_reads_as_dot_git_in_both_layouts", () => {
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
      for (const to of [".git.", ".git ", "GIT~1"]) {
        const out = t.pb(["init", "--upstream", up.path, "--output-to", to], { cwd: folder.path, code: 1 });
        expect(out.stderr).toContain("inside .git");
        expect(existsSync(join(folder.path, ".patchbook"))).toBe(false);
      }
      t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: folder.path });
      t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
      for (const cwd of [folder.path, join(t.tmp, "fork")]) {
        const config = join(cwd, ".patchbook/config.toml");
        const before = { config: read(config), tree: tree(cwd) };
        for (const mount of [".git.", "a/.git ", "GIT~1/x", "a/.g\u200cit"]) {
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

  test("test_track_rejects_a_mount_with_a_git_segment_in_another_case_in_both_layouts", () => {
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
      t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: folder.path });
      t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
      for (const cwd of [folder.path, join(t.tmp, "fork")]) {
        const config = join(cwd, ".patchbook/config.toml");
        const before = { config: read(config), tree: tree(cwd) };
        for (const mount of [".GIT/x", "a/.Git", "./.gIt/x"]) {
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

  vendorTest("test_an_absolute_output_folder_reached_through_a_link_above_the_repo_builds_twice", (t) => {
    symlinkSync(t.tmp, join(t.tmp, "via"));
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, replace(read(config), 'to = "skills"', `to = "${join(t.tmp, "via/adapted/skills")}"`));
    t.missingScaffoldPatchBuild();
    t.pb(["build"], { cwd: t.repo.path });
    t.pb(["build", "--force"], { cwd: t.repo.path });
    expect(t.repo.read("skills/hello/SKILL.md")).toContain("Hello");
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  vendorTest("test_an_absolute_output_folder_reached_through_a_link_to_the_repo_itself_builds_twice", (t) => {
    symlinkSync(t.repo.path, join(t.tmp, "alias"));
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, replace(read(config), 'to = "skills"', `to = "${join(t.tmp, "alias/skills")}"`));
    t.missingScaffoldPatchBuild();
    t.pb(["build"], { cwd: t.repo.path });
    t.pb(["build", "--force"], { cwd: t.repo.path });
    expect(t.repo.read("skills/hello/SKILL.md")).toContain("Hello");
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  vendorTest("test_an_absolute_output_folder_reached_through_a_link_above_the_repo_but_outside_it_is_rejected", (t) => {
    symlinkSync(t.tmp, join(t.tmp, "via"));
    t.missingScaffoldPatchBuild();
    setOutputFolder(t, join(t.tmp, "via/elsewhere"));
    const before = tree(t.repo.path);
    const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("is outside the repo");
    expect(tree(t.repo.path)).toEqual(before);
  });

  vendorTest("test_build_never_deletes_through_a_link_into_the_patchbook", (t) => {
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

  vendorTest("test_build_never_deletes_a_patchbook_that_links_into_the_output", (t) => {
    t.missingScaffoldPatchBuild();
    renameSync(join(t.repo.path, ".patchbook"), join(t.repo.path, "skills/.pb"));
    symlinkSync("skills/.pb", join(t.repo.path, ".patchbook"));
    const out = t.pb(["build", "--force"], { cwd: t.repo.path, code: 1 });
    for (const f of ["config.toml", "series", "retired.md"]) {
      expect(existsSync(join(t.repo.path, "skills/.pb", f))).toBe(true);
    }
    expect(out.stderr).toContain("is really inside .patchbook");
  });

  test("test_a_rejected_init_can_be_retried", () => {
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

  test("test_init_rejects_a_vendored_copy_at_the_repo_root", () => {
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

  vendorTest("test_a_rejected_track_leaves_the_config_alone", (t) => {
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

  vendorTest("test_a_remote_helper_in_a_cloned_config_is_refused_for_a_store_upstream", (t) => {
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
    vendorTest(`test_a_cloned_config_naming_the_${name}_helper_runs_no_git_remote_${name}_for_a_store_upstream`, (t) => {
      const helperRan = markerScript(t, `git-remote-${name}`);
      setRemote(join(t.repo.path, ".patchbook/config.toml"), `${name}::x`);
      t.repo.commit("follow a remote helper");
      sh(["git", "clone", "-q", t.repo.path, "fresh"], { cwd: t.tmp });
      for (const command of ["check", "status"]) t.pb([command], { cwd: join(t.tmp, "fresh"), code: 1 });
      expect(existsSync(helperRan)).toBe(false);
    });
  }

  vendorTest("test_build_never_changes_the_git_dir_of_a_linked_worktree", (t) => {
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
      vendorTest(`test_build_never_deletes_through_${how.replace(" ", "_")}_link_to_${where.replaceAll(" ", "_")}`, (t) => {
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

  vendorTest("test_build_refuses_a_dangling_link_in_the_output_before_changing_anything", (t) => {
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

  vendorTest("test_commit_in_a_refused_state_records_nothing", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.write("skills/d/retired.md", "hand\n");
    t.repo.commit("a file under skills/d");
    rmSync(join(t.repo.path, "skills/d"), { recursive: true });
    symlinkSync("../.patchbook", join(t.repo.path, "skills/d"));
    t.repo.write(".gitignore", "/skills/d\n");
    t.repo.write("skills/hello/SKILL.md", replace(t.repo.read("skills/hello/SKILL.md"), "Then wave.", "Then bow."));
    const before = tree(t.repo.path);
    const commit = sh(["git", "commit", "-q", "--allow-empty", "-m", "edit"], { cwd: t.repo.path, check: false, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("is really inside .patchbook");
    expect(commit.stderr).not.toContain("fatal");
    expect(tree(t.repo.path)).toEqual(before);
  });

  vendorTest("test_record_in_a_refused_state_records_nothing", (t) => {
    t.missingScaffoldPatchBuild();
    t.repo.write("skills/d/retired.md", "hand\n");
    t.repo.commit("a file under skills/d");
    rmSync(join(t.repo.path, "skills/d"), { recursive: true });
    symlinkSync("../.patchbook", join(t.repo.path, "skills/d"));
    t.repo.write(".gitignore", "/skills/d\n");
    t.repo.write("skills/hello/SKILL.md", replace(t.repo.read("skills/hello/SKILL.md"), "Then wave.", "Then bow."));
    const before = tree(t.repo.path);
    const out = t.pb(["record"], { cwd: t.repo.path, code: 1 });
    expect(out.stderr).toContain("is really inside .patchbook");
    expect(tree(t.repo.path)).toEqual(before);
  });

  vendorTest("test_output_folder_cannot_be_under_a_file_or_a_dangling_link", (t) => {
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

  test("test_init_rejects_an_output_folder_under_a_file", () => {
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

  vendorTest("test_absolute_placeholder_file_is_used_as_given", (t) => {
    const snippets = join(t.tmp, "snippets.md");
    writeFileSync(snippets, t.repo.read(".patchbook/snippets.md"));
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, replace(read(config), 'file = ".patchbook/snippets.md"', `file = "${snippets}"`));
    t.missingScaffoldPatchBuild();
  });

  vendorTest("test_single_upstream_table_is_rejected", (t) => {
    t.missingScaffoldPatchBuild();
    const config = join(t.repo.path, ".patchbook/config.toml");
    writeFileSync(config, replace(read(config), '[[upstream]]\nname = "plugin"\n', "[upstream]\n"));
    expect(t.pb(["status"], { cwd: t.repo.path, code: 1 }).stderr).toContain("Use [[upstream]] with a name");
  });
});

describe("ReadOnlyLockTest", () => {
  const asRoot = process.getuid?.() === 0;
  const lockTest = (name: string, body: (t: ForkCase, lock: string) => void) =>
    test.skipIf(asRoot)(name, () => {
      const t = new ForkCase();
      try {
        body(t, join(t.fork.path, ".patchbook/upstream.lock"));
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);
  const refused = (lock: string) => `patchbook: couldn't write ${realpathSync(lock)}: permission denied\n`;

  lockTest("test_sync_names_the_lock_when_it_cannot_write_it", (t, lock) => {
    t.up.write("app.txt", replace(t.up.read("app.txt"), "six", "SIX"));
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
    expect(JSON.parse(read(lock)).upstream.commit).toBe(head);
  });

  lockTest("test_track_names_the_lock_when_it_cannot_write_it_and_can_be_retried", (t, lock) => {
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
    expect(JSON.parse(read(lock)).lib.commit).toBe(commit);
  });

  lockTest("test_init_names_the_lock_when_it_cannot_write_it_and_can_be_retried", (t) => {
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    const lock = join(repo.path, ".patchbook/upstream.lock");
    mkdirSync(join(repo.path, ".patchbook"));
    writeFileSync(lock, "{}\n");
    sh(["chmod", "a-w", lock], { cwd: repo.path });
    const init = ["init", "--upstream", t.up.path, "--output-from", "", "--output-to", "out"];
    try {
      expect(t.pb(init, { cwd: repo.path, code: 1 }).stderr).toBe(refused(lock));
    } finally {
      sh(["chmod", "u+w", lock], { cwd: repo.path });
    }
    expect(existsSync(join(repo.path, ".patchbook/config.toml"))).toBe(false);
    t.pb(init, { cwd: repo.path });
    expect(JSON.parse(read(lock)).upstream.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});
