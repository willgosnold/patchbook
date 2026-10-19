// End-to-end tests: each one builds a throwaway upstream repo and drives the CLI against it.

import { describe, expect, test } from "bun:test";
import { accessSync, appendFileSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { CMD, Case, Repo, TOOL, type Run, dedent, lstrip, mkdirNew, partitionHead, replace, sh, shlexSplit, words } from "./helpers";

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

/** What Vite+'s `vp config` and husky's `husky` leave in a repo: core.hooksPath at `<dir>/_`, whose pre-commit runs `<dir>/pre-commit`. */
function installManager(repo: Repo, dir: string): void {
  repo.write(`${dir}/_/.gitignore`, "*\n");
  repo.write(`${dir}/_/pre-commit`, `#!/bin/sh\nsh -e "$(dirname "$(dirname "$0")")/pre-commit"\n`, 0o755);
  sh(["git", "config", "core.hooksPath", `${dir}/_`], { cwd: repo.path });
}

const NOTE_STAGED = `git diff --cached --name-only > "$(git rev-parse --git-dir)/staged-when-checked"\n`;

function forkWith(t: Case, files: Record<string, string>): Repo {
  const up = new Repo(join(t.tmp, "upstream"));
  up.write("app.txt", "one\ntwo\n");
  for (const [path, text] of Object.entries(files)) up.write(path, text);
  up.commit("start");
  t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
  return new Repo(join(t.tmp, "fork"));
}

const withHook = (t: Case) => ({ ...t.env, PATCHBOOK_HOOK: "1" });
const committedFiles = (repo: Repo): string[] => words(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: repo.path }).stdout);

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

test("test_skill_install_in_a_fork_refuses_to_replace_an_uncommitted_edit_to_the_skill", () => {
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
    expect(out.stderr).not.toContain("app.txt");
    expect(out.stderr).toContain("Commit them first");
    expect(out.stderr).not.toContain("patchbook record");
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_records_the_skill_on_its_own_while_other_edits_wait", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    fork.write("app.txt", "one\nTWO\n");
    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(out).toContain(`wrote ${SKILL_FILE}`);
    expect(fork.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    const shown = t.pb(["show", "patchbook-update-skill"], { cwd: fork.path }).stdout;
    expect(shown).toContain(SKILL_INTENT);
    expect(shown).not.toContain("app.txt");
    expect(modelWasAsked(t)).toBe(false);
    expect(fork.read("app.txt")).toBe("one\nTWO\n");

    t.pb(["record", "shout-two", "--intent", "Shout the second line."], { cwd: fork.path });
    expect(fork.read(".patchbook/series")).toBe("patchbook-update-skill\nshout-two\n");
    expect(t.pb(["show", "shout-two"], { cwd: fork.path }).stdout).toContain("app.txt");
    expect(t.pb(["show", "shout-two"], { cwd: fork.path }).stdout).not.toContain("SKILL.md");
    expect(t.pb(["show", "patchbook-update-skill"], { cwd: fork.path }).stdout).not.toContain("app.txt");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_refreshes_a_recorded_skill_while_other_edits_wait", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record", "patchbook-update-skill", "--intent", "Let agents pull upstream."], { cwd: fork.path });
    fork.commit("an older skill");
    fork.write("app.txt", "one\nTWO\n");
    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(out).toContain(`wrote ${SKILL_FILE}`);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(read(join(fork.path, ".patchbook/changes/patchbook-update-skill/CHANGE.md"))).toContain("Let agents pull upstream.");
    expect(fork.read("app.txt")).toBe("one\nTWO\n");
    expect(fork.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    expect(read(join(fork.path, ".patchbook/changes/patchbook-update-skill/CHANGE.md"))).not.toContain("app.txt");
    expect(t.pb(["skill", "install"], { cwd: fork.path }).stdout).toBe("the update skill is already current\n");
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
    expect(out).toBe(`wrote ${SKILL_FILE}\nwrote ${SKILL_LINK}\nreplaced ${SKILL_FILE}; your copy is in HEAD\n`);
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

const SKILL_INTENT = "Install the patchbook-update skill, so an agent can pull upstream and carry these changes forward.";

function initFork(t: Case, edit = false): Repo {
  const up = new Repo(join(t.tmp, "upstream"));
  up.write("app.txt", "one\ntwo\n");
  up.commit("start");
  sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
  const mine = new Repo(join(t.tmp, "mine"));
  if (edit) {
    mine.write("app.txt", "one\nTWO\n");
    mine.commit("mine");
  }
  t.pb(["init", "--upstream", up.path], { cwd: mine.path });
  return mine;
}

const modelWasAsked = (t: Case): boolean => existsSync(join(t.tmp, "prompt.txt"));

test("test_init_in_a_fork_records_the_skill_so_install_finds_it_current", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const mine = initFork(t);
    expect(mine.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    expect(t.pb(["show", "patchbook-update-skill"], { cwd: mine.path }).stdout).toContain(SKILL_INTENT);
    expect(t.pb(["status"], { cwd: mine.path }).stdout).toContain("no problems");
    expect(t.pb(["skill", "install"], { cwd: mine.path }).stdout).toBe("the update skill is already current\n");
    expect(modelWasAsked(t)).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_init_in_a_fork_with_edits_of_its_own_records_the_skill_apart_from_them", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const mine = initFork(t, true);
    expect(mine.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    const shown = t.pb(["show", "patchbook-update-skill"], { cwd: mine.path }).stdout;
    expect(shown).toContain(SKILL_INTENT);
    expect(shown).not.toContain("app.txt");
    expect(modelWasAsked(t)).toBe(false);
    expect(t.pb(["skill", "install"], { cwd: mine.path }).stdout).toBe("the update skill is already current\n");

    t.pb(["record", "shout-two", "--intent", "Shout the second line."], { cwd: mine.path });
    expect(mine.read(".patchbook/series")).toBe("patchbook-update-skill\nshout-two\n");
    expect(t.pb(["show", "shout-two"], { cwd: mine.path }).stdout).toContain("app.txt");
    expect(t.pb(["show", "shout-two"], { cwd: mine.path }).stdout).not.toContain("SKILL.md");
    expect(modelWasAsked(t)).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

const SKILL_REFUSED = "Commit them, or move them away, then run `patchbook skill install`";

test("test_init_in_a_fork_keeps_an_uncommitted_edit_to_the_skill_and_records_nothing", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const mine = new Repo(join(t.tmp, "mine"));
    mine.write(SKILL_FILE, STALE_SKILL + "My own line.\n");
    const out = t.pb(["init", "--upstream", up.path], { cwd: mine.path });
    expect(mine.read(SKILL_FILE)).toBe(STALE_SKILL + "My own line.\n");
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stderr).toContain(SKILL_REFUSED);
    expect(isSymlink(join(mine.path, SKILL_LINK)) || existsSync(join(mine.path, SKILL_LINK))).toBe(false);
    expect(mine.read(".patchbook/series")).toBe("");
    expect(existsSync(join(mine.path, ".patchbook/changes"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_init_in_the_folder_layout_keeps_an_uncommitted_edit_to_the_skill", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.md", "a\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    repo.write(SKILL_FILE, STALE_SKILL + "My own line.\n");
    const out = t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: repo.path });
    expect(repo.read(SKILL_FILE)).toBe(STALE_SKILL + "My own line.\n");
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stderr).toContain(SKILL_REFUSED);
    expect(isSymlink(join(repo.path, SKILL_LINK)) || existsSync(join(repo.path, SKILL_LINK))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_init_keeps_an_uncommitted_file_at_the_skill_link_and_writes_no_skill", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const mine = new Repo(join(t.tmp, "mine"));
    mine.write(SKILL_LINK, "my own notes\n");
    const out = t.pb(["init", "--upstream", up.path], { cwd: mine.path });
    expect(mine.read(SKILL_LINK)).toBe("my own notes\n");
    expect(isSymlink(join(mine.path, SKILL_LINK))).toBe(false);
    expect(out.stderr).toContain(SKILL_LINK);
    expect(out.stderr).toContain(SKILL_REFUSED);
    expect(existsSync(join(mine.path, ".agents"))).toBe(false);
    expect(mine.read(".patchbook/series")).toBe("");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test.skipIf(process.getuid?.() === 0)("test_init_finishes_with_a_note_when_the_skill_file_cannot_be_read", () => {
  for (const folder of [false, true]) {
    const t = new Case();
    let file = "";
    try {
      Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\ntwo\n");
      up.commit("start");
      let repo: Repo;
      if (folder) {
        repo = new Repo(join(t.tmp, "adapted"));
        repo.write("README.md", "mine\n");
        repo.commit("start");
      } else {
        sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
        repo = new Repo(join(t.tmp, "mine"));
      }
      repo.write(SKILL_FILE, STALE_SKILL);
      repo.commit("skill");
      file = join(repo.path, SKILL_FILE);
      const mode = statSync(file).mode & 0o777;
      chmodSync(file, 0o000);
      const out = t.pb(["init", "--upstream", up.path, ...(folder ? ["--output-to", "out"] : [])], { cwd: repo.path });
      expect(out.stderr).toContain("couldn't install the update skill");
      expect(statSync(file).mode & 0o777).toBe(0);
      chmodSync(file, mode);
      expect(repo.read(SKILL_FILE)).toBe(STALE_SKILL);
      expect(statSync(file).mode & 0o777).toBe(mode);
      if (!folder) expect(repo.read(".patchbook/series")).toBe("");
    } finally {
      if (file && existsSync(file)) chmodSync(file, 0o644);
      t.cleanup();
    }
  }
}, TIMEOUT);

test("test_init_in_a_fork_records_nothing_for_a_skill_it_did_not_write", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const mine = new Repo(join(t.tmp, "mine"));
    mine.write(SKILL_FILE, SKILL_COPY);
    mkdirSync(join(mine.path, ".claude/skills"), { recursive: true });
    symlinkSync("../../.agents/skills/patchbook-update", join(mine.path, SKILL_LINK));
    mine.commit("the skill, by hand");
    const out = t.pb(["init", "--upstream", up.path], { cwd: mine.path }).stdout;
    expect(out).not.toContain(SKILL_FILE);
    expect(mine.read(".patchbook/series")).toBe("");
    expect(modelWasAsked(t)).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_init_in_a_fork_takes_the_intent_from_the_series_not_from_a_leftover_folder", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const mine = new Repo(join(t.tmp, "mine"));
    mine.write(".patchbook/changes/patchbook-update-skill/CHANGE.md", "# patchbook-update-skill\n\nintent: A leftover.\n\nedits:\n");
    mine.commit("a leftover change folder");
    t.pb(["init", "--upstream", up.path], { cwd: mine.path });
    expect(mine.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    expect(t.pb(["show", "patchbook-update-skill"], { cwd: mine.path }).stdout).toContain(SKILL_INTENT);
    expect(modelWasAsked(t)).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_records_a_skill_that_an_older_init_left_unrecorded", () => {
  const t = new Case();
  try {
    const mine = initFork(t);
    mine.write(SKILL_FILE, SKILL_COPY);
    mkdirSync(join(mine.path, ".claude/skills"), { recursive: true });
    symlinkSync("../../.agents/skills/patchbook-update", join(mine.path, SKILL_LINK));
    expect(mine.read(".patchbook/series")).toBe("");
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    t.pb(["skill", "install"], { cwd: mine.path });
    expect(mine.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    expect(t.pb(["show", "patchbook-update-skill"], { cwd: mine.path }).stdout).toContain(SKILL_INTENT);
    expect(t.pb(["status"], { cwd: mine.path }).stdout).toContain("no problems");
    expect(modelWasAsked(t)).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_refuses_when_the_change_is_missing_from_the_series", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record"], { cwd: fork.path });
    writeFileSync(join(fork.path, ".patchbook/series"), "");
    fork.commit("an older skill, and an empty series");
    rmSync(join(t.tmp, "prompt.txt"), { force: true });
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain("patchbook-update-skill is not in the series");
    expect(modelWasAsked(t)).toBe(false);
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_in_the_folder_layout_refuses_to_replace_an_uncommitted_edit", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.md", "a\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: repo.path });
    repo.write(SKILL_FILE, "My own guidance.\n");
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const before = tree(repo.path);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(repo.read(SKILL_FILE)).toBe("My own guidance.\n");
    expect(tree(repo.path)).toEqual(before);

    repo.commit("my guidance");
    t.pb(["skill", "install"], { cwd: repo.path });
    expect(repo.read(SKILL_FILE)).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_recreates_a_link_that_was_deleted", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    unlinkSync(join(fork.path, SKILL_LINK));
    const out = t.pb(["skill", "install"], { cwd: fork.path });
    expect(out.stdout).toContain(`wrote ${SKILL_LINK}`);
    expect(readlinkSync(join(fork.path, SKILL_LINK))).toBe("../../.agents/skills/patchbook-update");
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test.skipIf(process.getuid?.() === 0)("test_skill_install_that_cannot_make_the_link_leaves_the_stale_skill_alone", () => {
  const t = new Case();
  const skills = join(t.tmp, "fork/.claude/skills");
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record"], { cwd: fork.path });
    unlinkSync(join(fork.path, SKILL_LINK));
    t.pb(["record"], { cwd: fork.path });
    fork.commit("an older skill, and no link");
    mkdirSync(skills, { recursive: true });
    chmodSync(skills, 0o555);

    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain("couldn't install the update skill");
    expect(out.stderr).toContain("the update skill was not installed");
    expect(fork.read(SKILL_FILE)).toBe(STALE_SKILL);
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");

    chmodSync(skills, 0o755);
    t.pb(["skill", "install"], { cwd: fork.path });
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
  } finally {
    if (existsSync(skills)) chmodSync(skills, 0o755);
    t.cleanup();
  }
}, TIMEOUT);

test.skipIf(process.getuid?.() === 0)("test_skill_install_that_cannot_write_the_skill_takes_back_the_link_it_made", () => {
  const t = new Case();
  const file = join(t.tmp, "fork", SKILL_FILE);
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record"], { cwd: fork.path });
    unlinkSync(join(fork.path, SKILL_LINK));
    t.pb(["record"], { cwd: fork.path });
    fork.commit("an older skill, and no link");
    chmodSync(file, 0o444);

    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain("couldn't install the update skill");
    expect(out.stderr).toContain("the update skill was not installed");
    expect(existsSync(join(fork.path, SKILL_LINK))).toBe(false);
    expect(isSymlink(join(fork.path, SKILL_LINK))).toBe(false);
    expect(fork.read(SKILL_FILE)).toBe(STALE_SKILL);
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");

    chmodSync(file, 0o644);
    t.pb(["skill", "install"], { cwd: fork.path });
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(isSymlink(join(fork.path, SKILL_LINK))).toBe(true);
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
  } finally {
    if (existsSync(file)) chmodSync(file, 0o644);
    t.cleanup();
  }
}, TIMEOUT);

/** A folder-layout repo with the skill installed and committed. */
function skillFolder(t: Case): Repo {
  const up = new Repo(join(t.tmp, "upstream"));
  up.write("a.md", "a\n");
  up.commit("start");
  const repo = new Repo(join(t.tmp, "adapted"));
  repo.write("README.md", "mine\n");
  repo.commit("start");
  t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: repo.path });
  Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
  t.pb(["skill", "install"], { cwd: repo.path });
  repo.commit("the skill");
  return repo;
}

const retarget = (repo: Repo, to: string): void => {
  unlinkSync(join(repo.path, SKILL_LINK));
  symlinkSync(to, join(repo.path, SKILL_LINK));
};

test("test_skill_install_in_a_fork_does_not_lose_a_recorded_customization_that_is_not_committed", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, SKILL_COPY + "My own line.\n");
    const mine = fork.read(SKILL_FILE);
    t.pb(["record"], { cwd: fork.path });
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stderr).toContain("Commit them first");
    expect(out.stderr).toContain("In a fork the hook records the commit");
    expect(fork.read(SKILL_FILE)).toBe(mine);
    expect(tree(fork.path)).toEqual(before);

    fork.commit("my own line");
    expect(t.pb(["skill", "install"], { cwd: fork.path }).stdout).toContain(`wrote ${SKILL_FILE}`);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(sh(["git", "log", "--all", "-p"], { cwd: fork.path }).stdout).toContain("+My own line.");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_in_a_fork_does_not_lose_a_recorded_link_that_is_not_committed", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    retarget(fork, "../../elsewhere");
    t.pb(["record"], { cwd: fork.path });
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(SKILL_LINK);
    expect(readlinkSync(join(fork.path, SKILL_LINK))).toBe("../../elsewhere");
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_in_the_folder_layout_refuses_to_replace_an_uncommitted_link", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    retarget(repo, "../../elsewhere");
    const before = tree(repo.path);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain(SKILL_LINK);
    expect(out.stderr).toContain("Commit them first");
    expect(out.stderr).not.toContain("hook");
    expect(readlinkSync(join(repo.path, SKILL_LINK))).toBe("../../elsewhere");
    expect(tree(repo.path)).toEqual(before);

    repo.commit("my link");
    t.pb(["skill", "install"], { cwd: repo.path });
    expect(readlinkSync(join(repo.path, SKILL_LINK))).toBe("../../.agents/skills/patchbook-update");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_in_the_folder_layout_refuses_to_replace_an_uncommitted_file_at_the_link", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    unlinkSync(join(repo.path, SKILL_LINK));
    repo.write(SKILL_LINK, "My own file, not a link.\n");
    const before = tree(repo.path);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain(SKILL_LINK);
    expect(repo.read(SKILL_LINK)).toBe("My own file, not a link.\n");
    expect(tree(repo.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test.skipIf(process.getuid?.() === 0)("test_skill_install_that_cannot_write_the_skill_puts_back_a_link_it_replaced", () => {
  const t = new Case();
  let file = "";
  try {
    const repo = skillFolder(t);
    file = join(repo.path, SKILL_FILE);
    retarget(repo, "../../elsewhere");
    repo.write(SKILL_FILE, STALE_SKILL);
    repo.commit("a wrong link and an older skill");
    chmodSync(file, 0o444);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain("couldn't install the update skill");
    expect(readlinkSync(join(repo.path, SKILL_LINK))).toBe("../../elsewhere");
    expect(sh(["git", "status", "--porcelain"], { cwd: repo.path }).stdout).toBe("");
  } finally {
    if (file && existsSync(file)) chmodSync(file, 0o644);
    t.cleanup();
  }
}, TIMEOUT);

test.skipIf(process.getuid?.() === 0)("test_skill_install_that_cannot_write_the_skill_puts_back_a_file_it_replaced", () => {
  const t = new Case();
  let file = "";
  try {
    const repo = skillFolder(t);
    file = join(repo.path, SKILL_FILE);
    unlinkSync(join(repo.path, SKILL_LINK));
    repo.write(SKILL_LINK, "My own file, not a link.\n");
    repo.write(SKILL_FILE, STALE_SKILL);
    repo.commit("a file at the link and an older skill");
    chmodSync(file, 0o444);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain("couldn't install the update skill");
    expect(isSymlink(join(repo.path, SKILL_LINK))).toBe(false);
    expect(repo.read(SKILL_LINK)).toBe("My own file, not a link.\n");
    expect(sh(["git", "status", "--porcelain"], { cwd: repo.path }).stdout).toBe("");
  } finally {
    if (file && existsSync(file)) chmodSync(file, 0o644);
    t.cleanup();
  }
}, TIMEOUT);

test.skipIf(process.getuid?.() === 0)("test_skill_install_in_a_fork_puts_back_a_recorded_link_when_the_skill_cannot_be_written", () => {
  const t = new Case();
  let file = "";
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    file = join(fork.path, SKILL_FILE);
    fork.write(SKILL_FILE, STALE_SKILL);
    retarget(fork, "../../elsewhere");
    t.pb(["record"], { cwd: fork.path });
    fork.commit("a wrong link and an older skill");
    chmodSync(file, 0o444);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain("couldn't install the update skill");
    expect(readlinkSync(join(fork.path, SKILL_LINK))).toBe("../../elsewhere");
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");
  } finally {
    if (file && existsSync(file)) chmodSync(file, 0o644);
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_does_not_call_it_current_when_a_folder_is_in_the_way", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.md", "a\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: repo.path });
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    t.pb(["skill", "install"], { cwd: repo.path });
    rmSync(join(repo.path, SKILL_LINK));
    repo.write(`${SKILL_LINK}/SKILL.md`, "Mine.\n");
    repo.commit("a skill folder of my own");

    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stdout).not.toContain("already current");
    expect(out.stderr).toContain(`${SKILL_LINK} is a folder`);
    expect(out.stderr).toContain(`the update skill was not installed at ${SKILL_LINK}`);
    expect(repo.read(`${SKILL_LINK}/SKILL.md`)).toBe("Mine.\n");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_in_a_fork_refuses_to_replace_a_customization_that_git_ignores", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    fork.write(".gitignore", ".agents/\n.claude/\n");
    fork.commit("ignore the agents' folders");
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    t.pb(["skill", "install"], { cwd: fork.path });
    fork.write(SKILL_FILE, SKILL_COPY + "My own line.\n");
    const mine = fork.read(SKILL_FILE);
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stderr).toContain("git ignores");
    expect(out.stderr).not.toContain("Commit them first");
    expect(out.stdout).not.toContain("wrote");
    expect(fork.read(SKILL_FILE)).toBe(mine);
    expect(tree(fork.path)).toEqual(before);

    fork.write(SKILL_FILE, SKILL_COPY);
    expect(t.pb(["skill", "install"], { cwd: fork.path }).stdout).toBe("the update skill is already current\n");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_in_the_folder_layout_refuses_to_replace_a_link_that_git_ignores", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    repo.write(".gitignore", ".claude/\n");
    sh(["git", "rm", "-q", "--cached", SKILL_LINK], { cwd: repo.path });
    repo.commit("ignore .claude");
    retarget(repo, "../../elsewhere");
    const before = tree(repo.path);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain(SKILL_LINK);
    expect(out.stderr).toContain("git ignores");
    expect(readlinkSync(join(repo.path, SKILL_LINK))).toBe("../../elsewhere");
    expect(tree(repo.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
  test(`test_skill_install_in_a_fork_refuses_to_replace_an_edit_that_git_hides_with_${flag.slice(2).replace("-", "_")}`, () => {
    const t = new Case();
    try {
      Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
      const fork = skillFork(t);
      t.pb(["skill", "install"], { cwd: fork.path });
      fork.write(SKILL_FILE, SKILL_COPY + "My own line.\n");
      const mine = fork.read(SKILL_FILE);
      sh(["git", "update-index", flag, SKILL_FILE], { cwd: fork.path });
      expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");
      const before = tree(fork.path);
      const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
      expect(out.stderr).toContain(SKILL_FILE);
      expect(out.stderr).toContain("git update-index --no-skip-worktree");
      expect(out.stdout).not.toContain("your copy is in HEAD");
      expect(out.stdout).not.toContain("wrote");
      expect(fork.read(SKILL_FILE)).toBe(mine);
      expect(tree(fork.path)).toEqual(before);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("test_skill_install_in_the_folder_layout_refuses_to_replace_a_link_that_git_hides", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    retarget(repo, "../../elsewhere");
    sh(["git", "update-index", "--assume-unchanged", SKILL_LINK], { cwd: repo.path });
    expect(sh(["git", "status", "--porcelain"], { cwd: repo.path }).stdout).toBe("");
    const before = tree(repo.path);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain(SKILL_LINK);
    expect(out.stdout).not.toContain("your copy is in HEAD");
    expect(readlinkSync(join(repo.path, SKILL_LINK))).toBe("../../elsewhere");
    expect(tree(repo.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_replaces_a_committed_customization_and_names_the_commit_that_keeps_it", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL + "My own line.\n");
    const mine = fork.read(SKILL_FILE);
    t.pb(["record"], { cwd: fork.path });
    fork.commit("my own line");
    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(out).toContain(`replaced ${SKILL_FILE}; your copy is in HEAD`);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(sh(["git", "show", `HEAD:${SKILL_FILE}`], { cwd: fork.path }).stdout).toBe(mine);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_replaces_a_committed_customization_that_checkout_wrote_with_crlf", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    repo.write(".gitattributes", "*.md eol=crlf\n");
    repo.commit("crlf checkout");
    repo.write(SKILL_FILE, STALE_SKILL + "My own line.\n");
    const mine = repo.read(SKILL_FILE);
    repo.commit("my own line");
    repo.rm(SKILL_FILE);
    sh(["git", "checkout", "--", SKILL_FILE], { cwd: repo.path });
    expect(repo.read(SKILL_FILE)).toBe(mine.replaceAll("\n", "\r\n"));
    expect(sh(["git", "status", "--porcelain"], { cwd: repo.path }).stdout).toBe("");
    const out = t.pb(["skill", "install"], { cwd: repo.path }).stdout;
    expect(out).toContain(`replaced ${SKILL_FILE}; your copy is in HEAD`);
    expect(repo.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(sh(["git", "show", `HEAD:${SKILL_FILE}`], { cwd: repo.path }).stdout).toBe(mine);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_clone_installs_the_skill_over_a_committed_copy_that_checkout_wrote_with_crlf", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write(".gitattributes", "*.md eol=crlf\n");
    up.write(SKILL_FILE, SKILL_COPY);
    up.commit("start");
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    expect(out.stderr).not.toContain("was not installed");
    const fork = new Repo(join(t.tmp, "fork"));
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(existsSync(join(fork.path, SKILL_LINK))).toBe(true);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_replaces_a_committed_link_that_checkout_wrote_as_a_file_without_symlinks", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    retarget(repo, "../../elsewhere");
    repo.commit("a wrong link");
    sh(["git", "config", "core.symlinks", "false"], { cwd: repo.path });
    repo.rm(SKILL_LINK);
    sh(["git", "checkout", "--", SKILL_LINK], { cwd: repo.path });
    expect(lstatSync(join(repo.path, SKILL_LINK)).isSymbolicLink()).toBe(false);
    expect(sh(["git", "status", "--porcelain"], { cwd: repo.path }).stdout).toBe("");
    const out = t.pb(["skill", "install"], { cwd: repo.path }).stdout;
    expect(out).toContain(`replaced ${SKILL_LINK}; your copy is in HEAD`);
    expect(sh(["git", "show", `HEAD:${SKILL_LINK}`], { cwd: repo.path }).stdout).toBe("../../elsewhere");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_refuses_a_plain_file_at_a_committed_link_when_checkout_would_have_written_a_link", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    retarget(repo, "../../elsewhere");
    repo.commit("a wrong link");
    repo.rm(SKILL_LINK);
    repo.write(SKILL_LINK, "../../elsewhere");
    expect(lstatSync(join(repo.path, SKILL_LINK)).isSymbolicLink()).toBe(false);
    const before = tree(repo.path);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain(SKILL_LINK);
    expect(out.stdout).not.toContain("your copy is in HEAD");
    expect(repo.read(SKILL_LINK)).toBe("../../elsewhere");
    expect(tree(repo.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

/** A clean filter that drops every line holding SECRET, applied to markdown. */
const dropSecrets = (repo: Repo): void => {
  repo.write(".gitattributes", "*.md filter=strip\n");
  sh(["git", "config", "filter.strip.clean", "sed /SECRET/d"], { cwd: repo.path });
  sh(["git", "config", "filter.strip.smudge", "cat"], { cwd: repo.path });
};

test("test_skill_install_refuses_to_replace_a_line_that_a_clean_filter_drops_from_what_git_stores", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    dropSecrets(repo);
    repo.write(SKILL_FILE, STALE_SKILL);
    repo.commit("an older skill");
    repo.write(SKILL_FILE, STALE_SKILL + "SECRET=hunter2\n");
    const before = tree(repo.path);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stdout).not.toContain("your copy is in HEAD");
    expect(repo.read(SKILL_FILE)).toBe(STALE_SKILL + "SECRET=hunter2\n");
    expect(tree(repo.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_refuses_a_lone_carriage_return_edit", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    fork.write(SKILL_FILE, STALE_SKILL);
    fork.commit("an older skill");
    fork.write(SKILL_FILE, STALE_SKILL.replace("\n", "\r"));
    const before = fork.read(SKILL_FILE);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stdout).not.toContain("your copy is in HEAD");
    expect(fork.read(SKILL_FILE)).toBe(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_refuses_a_file_whose_non_utf8_bytes_differ_from_head", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    writeBytes(fork, SKILL_FILE, NOT_UTF8);
    fork.commit("a skill that is not text");
    writeBytes(fork, SKILL_FILE, SWAPPED);
    const before = readFileSync(join(fork.path, SKILL_FILE));
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stdout).not.toContain("your copy is in HEAD");
    expect(readFileSync(join(fork.path, SKILL_FILE))).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_keeps_a_committed_crlf_file_whose_disk_copy_has_lf", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    fork.write(SKILL_FILE, STALE_SKILL.replaceAll("\n", "\r\n"));
    fork.commit("an older skill with CRLF");
    fork.write(SKILL_FILE, STALE_SKILL);
    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(out).toContain(`replaced ${SKILL_FILE}; your copy is in HEAD\n`);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_refuses_a_utf16_file_whose_disk_copy_adds_carriage_returns", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    writeBytes(fork, SKILL_FILE, Buffer.from([0x58, 0x00, 0x0a, 0x0a]));
    fork.commit("a skill that is UTF-16");
    writeBytes(fork, SKILL_FILE, Buffer.from([0x58, 0x00, 0x0d, 0x0a, 0x0d, 0x0a]));
    const before = readFileSync(join(fork.path, SKILL_FILE));
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stdout).not.toContain("your copy is in HEAD");
    expect(readFileSync(join(fork.path, SKILL_FILE))).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_init_keeps_a_line_that_a_clean_filter_drops_from_what_git_stores_and_records_nothing", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const mine = new Repo(join(t.tmp, "mine"));
    dropSecrets(mine);
    mine.write(SKILL_FILE, STALE_SKILL);
    mine.commit("an older skill");
    mine.write(SKILL_FILE, STALE_SKILL + "SECRET=hunter2\n");
    const out = t.pb(["init", "--upstream", up.path], { cwd: mine.path });
    expect(mine.read(SKILL_FILE)).toBe(STALE_SKILL + "SECRET=hunter2\n");
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stderr).toContain(SKILL_REFUSED);
    expect(isSymlink(join(mine.path, SKILL_LINK)) || existsSync(join(mine.path, SKILL_LINK))).toBe(false);
    expect(mine.read(".patchbook/series")).toBe("");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_refuses_to_replace_an_edit_when_git_cannot_read_head", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    repo.write(SKILL_FILE, "My own guidance.\n");
    sh(["git", "symbolic-ref", "HEAD", "refs/heads/unborn"], { cwd: repo.path });
    const before = tree(repo.path);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stdout).not.toContain("your copy is in HEAD");
    expect(repo.read(SKILL_FILE)).toBe("My own guidance.\n");
    expect(tree(repo.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_init_in_a_fork_keeps_a_customized_skill_that_git_ignores_and_records_nothing", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const mine = new Repo(join(t.tmp, "mine"));
    mine.write(".gitignore", ".agents/\n");
    mine.commit("ignore the agents' folder");
    mine.write(SKILL_FILE, STALE_SKILL + "My own line.\n");
    const out = t.pb(["init", "--upstream", up.path], { cwd: mine.path });
    expect(mine.read(SKILL_FILE)).toBe(STALE_SKILL + "My own line.\n");
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stderr).toContain(SKILL_REFUSED);
    expect(isSymlink(join(mine.path, SKILL_LINK)) || existsSync(join(mine.path, SKILL_LINK))).toBe(false);
    expect(mine.read(".patchbook/series")).toBe("");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_in_a_fork_writes_and_records_nothing_when_an_untracked_folder_is_at_the_link", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record"], { cwd: fork.path });
    fork.commit("an older skill");
    sh(["git", "rm", "-q", "--cached", SKILL_LINK], { cwd: fork.path });
    sh(["git", "commit", "-q", "-m", "untrack the link"], { cwd: fork.path });
    rmSync(join(fork.path, SKILL_LINK));
    fork.write(`${SKILL_LINK}/notes.txt`, "Mine.\n");
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(`${SKILL_LINK} is a folder`);
    expect(out.stderr).toContain(`the update skill was not installed at ${SKILL_LINK}`);
    expect(out.stdout).toBe("");
    expect(fork.read(SKILL_FILE)).toBe(STALE_SKILL);
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_in_the_folder_layout_writes_nothing_when_an_untracked_folder_is_at_the_link", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    repo.write(SKILL_FILE, STALE_SKILL);
    repo.commit("an older skill");
    rmSync(join(repo.path, SKILL_LINK));
    repo.write(`${SKILL_LINK}/notes.txt`, "Mine.\n");
    const before = tree(repo.path);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain(`${SKILL_LINK} is a folder`);
    expect(out.stderr).toContain(`the update skill was not installed at ${SKILL_LINK}`);
    expect(out.stderr).not.toContain("Commit them first");
    expect(tree(repo.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test.skipIf(process.getuid?.() === 0)("test_skill_install_that_cannot_write_the_skill_puts_back_the_mode_of_a_file_it_replaced", () => {
  const t = new Case();
  const umask = process.umask(0o022);
  let file = "";
  try {
    const repo = skillFolder(t);
    file = join(repo.path, SKILL_FILE);
    unlinkSync(join(repo.path, SKILL_LINK));
    repo.write(SKILL_LINK, "My own file, not a link.\n", 0o664);
    repo.write(SKILL_FILE, STALE_SKILL);
    repo.commit("a file at the link and an older skill");
    chmodSync(file, 0o444);
    t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(repo.read(SKILL_LINK)).toBe("My own file, not a link.\n");
    expect(statSync(join(repo.path, SKILL_LINK)).mode & 0o7777).toBe(0o664);
  } finally {
    process.umask(umask);
    if (file && existsSync(file)) chmodSync(file, 0o644);
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_says_which_committed_skill_paths_it_replaced", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    expect(t.pb(["skill", "install"], { cwd: fork.path }).stdout).not.toContain("replaced");
    fork.write(SKILL_FILE, STALE_SKILL);
    retarget(fork, "../../elsewhere");
    t.pb(["record"], { cwd: fork.path });
    fork.commit("an older skill and a wrong link");
    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(out).toContain(`replaced ${SKILL_FILE}; your copy is in HEAD\n`);
    expect(out).toContain(`replaced ${SKILL_LINK}; your copy is in HEAD\n`);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(t.pb(["skill", "install"], { cwd: fork.path }).stdout).toBe("the update skill is already current\n");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

/** A committed link at `at` in `repo`, pointing at `target`. */
function commitLink(repo: Repo, at: string, target: string): void {
  mkdirSync(dirname(join(repo.path, at)), { recursive: true });
  symlinkSync(target, join(repo.path, at));
  repo.commit(`${at} is a link`);
}

/** A folder outside the repo, holding a customized skill. */
function outsideSkill(t: Case): string {
  const shared = join(t.tmp, "shared");
  mkdirSync(join(shared, "skills/patchbook-update"), { recursive: true });
  writeFileSync(join(shared, "skills/patchbook-update/SKILL.md"), SKILL_COPY + "Kept outside the repo.\n");
  return shared;
}

test("test_skill_install_does_not_write_through_a_symlink_at_the_skill_file", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const notes = join(t.tmp, "notes.md");
    writeFileSync(notes, "Notes kept outside the repo.\n");
    commitLink(fork, SKILL_FILE, notes);
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(`${SKILL_FILE} is a symlink`);
    expect(out.stderr).toContain("install won't write through a link");
    expect(out.stdout).toBe("");
    expect(read(notes)).toBe("Notes kept outside the repo.\n");
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_does_not_ask_for_a_commit_when_the_skill_file_is_an_uncommitted_symlink", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const notes = join(t.tmp, "notes.md");
    writeFileSync(notes, "Notes kept outside the repo.\n");
    mkdirSync(join(fork.path, ".agents/skills/patchbook-update"), { recursive: true });
    symlinkSync(notes, join(fork.path, SKILL_FILE));
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(`${SKILL_FILE} is a symlink`);
    expect(out.stderr).not.toContain("Commit them first");
    expect(read(notes)).toBe("Notes kept outside the repo.\n");
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_does_not_write_through_a_symlink_at_a_folder_above_the_skill", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const shared = outsideSkill(t);
    commitLink(fork, ".agents", shared);
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(".agents is a symlink");
    expect(out.stderr).toContain("install won't write through a link");
    expect(out.stdout).toBe("");
    expect(read(join(shared, "skills/patchbook-update/SKILL.md"))).toBe(SKILL_COPY + "Kept outside the repo.\n");
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_clone_finishes_without_installing_when_a_folder_above_the_skill_is_a_symlink", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.txt", "a\n");
    commitLink(up, ".agents", outsideSkill(t));
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    expect(out.stderr).toContain(".agents is a symlink");
    expect(read(join(t.tmp, "shared/skills/patchbook-update/SKILL.md"))).toBe(SKILL_COPY + "Kept outside the repo.\n");
    const fork = join(t.tmp, "fork");
    expect(sh(["git", "log", "--format=%s"], { cwd: fork }).stdout).toContain("Start a patchbook at upstream");
    expect(isSymlink(join(fork, SKILL_LINK))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_init_finishes_without_installing_when_the_skill_file_is_a_symlink", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const mine = new Repo(join(t.tmp, "mine"));
    const notes = join(t.tmp, "notes.md");
    writeFileSync(notes, "Notes kept outside the repo.\n");
    commitLink(mine, SKILL_FILE, notes);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["init", "--upstream", up.path], { cwd: mine.path });
    expect(out.stderr).toContain(`${SKILL_FILE} is a symlink`);
    expect(read(notes)).toBe("Notes kept outside the repo.\n");
    expect(isSymlink(join(mine.path, SKILL_FILE))).toBe(true);
    expect(isSymlink(join(mine.path, SKILL_LINK))).toBe(false);
    expect(existsSync(join(mine.path, ".patchbook/config.toml"))).toBe(true);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

const KEPT = SKILL_COPY + "Kept outside the repo.\n";

/** A folder outside the repo with a regular file where the skill link would go. */
function outsideClaude(t: Case): string {
  const outside = join(t.tmp, "outside-claude");
  mkdirSync(join(outside, "skills"), { recursive: true });
  writeFileSync(join(outside, "skills/patchbook-update"), "Kept outside the repo.\n");
  return outside;
}

/** Commit a link at `at`, run `skill install`, and expect a refusal that leaves `kept` and the repo as they were. */
function expectNoWriteThrough(at: string, target: (t: Case) => string, kept: string, text: string): void {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const outside = target(t);
    commitLink(fork, at, outside);
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(`${at} is a symlink`);
    expect(out.stderr).toContain("install won't write through a link");
    expect(out.stdout).toBe("");
    expect(read(join(t.tmp, kept))).toBe(text);
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}

test("test_skill_install_does_not_write_through_a_symlink_at_the_agents_skills_folder", () => {
  expectNoWriteThrough(".agents/skills", (t) => join(outsideSkill(t), "skills"),
    "shared/skills/patchbook-update/SKILL.md", KEPT);
}, TIMEOUT);

test("test_skill_install_does_not_write_through_a_symlink_at_the_skill_folder", () => {
  expectNoWriteThrough(".agents/skills/patchbook-update", (t) => join(outsideSkill(t), "skills/patchbook-update"),
    "shared/skills/patchbook-update/SKILL.md", KEPT);
}, TIMEOUT);

test("test_skill_install_does_not_write_through_a_symlink_at_the_claude_folder", () => {
  expectNoWriteThrough(".claude", outsideClaude, "outside-claude/skills/patchbook-update", "Kept outside the repo.\n");
}, TIMEOUT);

test("test_skill_install_does_not_write_through_a_symlink_at_the_claude_skills_folder", () => {
  expectNoWriteThrough(".claude/skills", (t) => join(outsideClaude(t), "skills"),
    "outside-claude/skills/patchbook-update", "Kept outside the repo.\n");
}, TIMEOUT);

test("test_clone_finishes_without_installing_when_the_claude_folder_is_a_symlink", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.txt", "a\n");
    commitLink(up, ".claude", outsideClaude(t));
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    expect(out.stderr).toContain(".claude is a symlink");
    expect(read(join(t.tmp, "outside-claude/skills/patchbook-update"))).toBe("Kept outside the repo.\n");
    expect(isSymlink(join(t.tmp, "fork/.claude"))).toBe(true);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_init_finishes_without_installing_when_the_claude_skills_folder_is_a_symlink", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const mine = new Repo(join(t.tmp, "mine"));
    commitLink(mine, ".claude/skills", join(outsideClaude(t), "skills"));
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["init", "--upstream", up.path], { cwd: mine.path });
    expect(out.stderr).toContain(".claude/skills is a symlink");
    expect(read(join(t.tmp, "outside-claude/skills/patchbook-update"))).toBe("Kept outside the repo.\n");
    expect(existsSync(join(mine.path, ".patchbook/config.toml"))).toBe(true);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

/** The common layout: Claude Code's skills folder is a link to the folder Codex reads. */
function sharedLayout(repo: Repo): void {
  repo.write(".agents/skills/other/SKILL.md", "Another skill.\n");
  commitLink(repo, ".claude/skills", "../.agents/skills");
}

test("test_skill_install_counts_a_claude_skills_link_to_the_agents_skills_folder_as_installed", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    sharedLayout(fork);
    const first = t.pb(["skill", "install"], { cwd: fork.path });
    expect(first.stderr).toBe("");
    expect(first.stdout).toContain(`wrote ${SKILL_FILE}\n`);
    expect(first.stdout).not.toContain(SKILL_LINK);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(isSymlink(join(fork.path, ".claude/skills"))).toBe(true);
    const second = t.pb(["skill", "install"], { cwd: fork.path });
    expect(second.stderr).toBe("");
    expect(second.stdout).toBe("the update skill is already current\n");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_clone_and_init_print_no_folder_note_for_a_claude_skills_link_to_the_agents_skills_folder", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.txt", "a\n");
    sharedLayout(up);
    const cloned = t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    expect(cloned.stderr).not.toContain("is a folder");
    expect(cloned.stderr).not.toContain("is a symlink");
    expect(read(join(t.tmp, "fork", SKILL_FILE))).toBe(SKILL_COPY);

    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const inited = t.pb(["init", "--upstream", up.path], { cwd: join(t.tmp, "mine") });
    expect(inited.stderr).not.toContain("is a folder");
    expect(inited.stderr).not.toContain("is a symlink");
    expect(read(join(t.tmp, "mine", SKILL_FILE))).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_and_clone_install_the_codex_copy_when_the_shared_link_dangles", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    commitLink(fork, ".claude/skills", "../.agents/skills");
    const installed = t.pb(["skill", "install"], { cwd: fork.path });
    expect(installed.stderr).toBe("");
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(isSymlink(join(fork.path, ".claude/skills"))).toBe(true);

    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.txt", "a\n");
    commitLink(up, ".claude/skills", "../.agents/skills");
    const cloned = t.pb(["clone", up.path, "fork2"], { cwd: t.tmp });
    expect(cloned.stderr).not.toContain("is a symlink");
    expect(cloned.stderr).not.toContain("is a folder");
    expect(read(join(t.tmp, "fork2", SKILL_FILE))).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

/** An outside `.claude` whose `skills` is the shared link, so a lexical read of that link would match. */
function outsideSharedClaude(t: Case): string {
  const outside = join(t.tmp, "outside-claude2");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "keep.txt"), "Kept outside the repo.\n");
  symlinkSync("../.agents/skills", join(outside, "skills"));
  return outside;
}

test("test_skill_install_and_clone_refuse_a_claude_symlink_to_an_outside_folder_whose_skills_link_is_shared", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    commitLink(fork, ".claude", outsideSharedClaude(t));
    const installed = t.pb(["skill", "install"], { code: 1, cwd: fork.path });
    expect(installed.stderr).toContain(".claude is a symlink");

    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.txt", "a\n");
    commitLink(up, ".claude", join(t.tmp, "outside-claude2"));
    const cloned = t.pb(["clone", up.path, "fork2"], { cwd: t.tmp });
    expect(cloned.stderr).toContain(".claude is a symlink");

    expect(read(join(t.tmp, "outside-claude2/keep.txt"))).toBe("Kept outside the repo.\n");
    expect(existsSync(join(t.tmp, "outside-claude2/.agents"))).toBe(false);
    expect(existsSync(join(t.tmp, ".agents"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

const NOT_UTF8 = Buffer.from([0x62, 0x61, 0x64, 0x20, 0xff, 0xfe, 0x20, 0x62, 0x79, 0x74, 0x65, 0x73, 0x0a]);
const SWAPPED = Buffer.from([0x62, 0x61, 0x64, 0x20, 0xfe, 0xff, 0x20, 0x62, 0x79, 0x74, 0x65, 0x73, 0x0a]);

function writeBytes(repo: Repo, rel: string, data: Uint8Array): void {
  mkdirSync(dirname(join(repo.path, rel)), { recursive: true });
  writeFileSync(join(repo.path, rel), data);
}

test("test_clone_replaces_a_skill_file_that_is_not_utf8", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.txt", "a\n");
    writeBytes(up, SKILL_FILE, NOT_UTF8);
    up.commit("start");
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    expect(out.stderr).not.toContain("TypeError");
    expect(read(join(t.tmp, "fork", SKILL_FILE))).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_init_replaces_a_skill_file_that_is_not_utf8", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const mine = new Repo(join(t.tmp, "mine"));
    writeBytes(mine, SKILL_FILE, NOT_UTF8);
    mine.commit("a skill that is not text");
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["init", "--upstream", up.path], { cwd: mine.path });
    expect(out.stderr).not.toContain("TypeError");
    expect(mine.read(SKILL_FILE)).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_treats_a_skill_file_that_is_not_utf8_like_any_other_that_differs", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    writeBytes(fork, SKILL_FILE, NOT_UTF8);
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stderr).toContain("Commit them first");
    expect(out.stderr).not.toContain("TypeError");
    expect(tree(fork.path)).toEqual(before);

    fork.commit("a skill that is not utf-8");
    const done = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(done).toContain(`replaced ${SKILL_FILE}; your copy is in HEAD\n`);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_leaves_a_folder_at_the_skill_file_and_exits_1", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    fork.write(`${SKILL_FILE}/notes.txt`, "Mine.\n");
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(`${SKILL_FILE} is a folder, so the skill there was left as it is`);
    expect(out.stderr).toContain(`the update skill was not installed at ${SKILL_FILE}`);
    expect(out.stderr).not.toContain("EISDIR");
    expect(out.stdout).toBe("");
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_clone_finishes_when_a_folder_is_at_the_skill_file", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write(`${SKILL_FILE}/notes.txt`, "Mine.\n");
    up.commit("start");
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    expect(out.stderr).toContain("patchbook: couldn't install the update skill");
    expect(read(join(t.tmp, "fork", SKILL_FILE, "notes.txt"))).toBe("Mine.\n");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_goes_ahead_when_a_sync_left_a_conflict", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    const up = new Repo(join(t.tmp, "upstream"));
    fork.write("app.txt", "ONE\ntwo\n");
    t.pb(["record", "shout-one", "--intent", "Shout the first line."], { cwd: fork.path });
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record", "patchbook-update-skill"], { cwd: fork.path });
    fork.commit("mine");
    up.write("app.txt", "uno\ntwo\n");
    up.commit("upstream changes line one");
    t.pb(["sync"], { cwd: fork.path });
    expect(t.pb(["status"], { cwd: fork.path, code: 1 }).stdout).toContain("conflict");

    t.pb(["skill", "install"], { cwd: fork.path });
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_skill_install_says_why_when_start_agents_is_empty", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    t.pb(["config", "start.agents", "", "--project"], { cwd: fork.path });
    fork.commit("settings");
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain("start.agents is empty");
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

test("test_the_commit_hook_reads_an_output_folder_whose_name_starts_with_a_colon", () => {
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

test("test_a_retried_fork_init_records_the_skill_a_failed_first_run_left_on_disk", () => {
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
    expect(existsSync(join(fork.path, SKILL_FILE))).toBe(true);
    rmSync(join(fork.path, ".patchbook/series"));
    t.pb(["init", "--upstream", up.path], { cwd: fork.path });
    expect(fork.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: fork.path });
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

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
      expect(t.pb(["record", "mine", "--intent", "Keep mine.txt"], { cwd: fork.path }).stderr).toContain("installed a pre-commit hook");
      expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
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
      const record = t.pb(["record", "mine", "--intent", "Keep mine.txt"], { cwd: fork.path });
      expect(record.stderr).toContain("couldn't install the pre-commit hook");
      expect(record.stderr).toContain("hand edits");
      expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
    } finally {
      sh(["chmod", "u+w", hooks], { cwd: fork.path });
    }
    expect(t.pb(["record", "mine", "--intent", "Keep mine.txt"], { cwd: fork.path }).stderr).toContain("installed a pre-commit hook");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_commit_through_vite_plus_records_when_it_is_installed_after_clone", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { ".vite-hooks/pre-commit": NOTE_STAGED });
    installManager(fork, ".vite-hooks");
    fork.write("app.txt", "one\nTWO\n");
    sh(["git", "commit", "-qam", "shout"], { cwd: fork.path, env: withHook(t) });
    expect(committedFiles(fork)).toContain(".patchbook/changes/shout/CHANGE.md");
    expect(read(join(fork.path, ".git/staged-when-checked"))).toContain(".patchbook/changes/shout/CHANGE.md");
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");
    t.pb(["build"], { cwd: fork.path });
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_commit_through_vite_plus_stops_without_patchbook_unless_skipped", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { ".vite-hooks/pre-commit": NOTE_STAGED });
    installManager(fork, ".vite-hooks");
    const path = t.env["PATH"]!.split(":").filter((d) => !existsSync(join(d, "patchbook"))).join(":");
    const teammate = { ...t.env, PATCHBOOK_HOOK: "1", PATH: path };
    fork.write("app.txt", "one\nTWO\n");
    const stopped = sh(["git", "commit", "-qam", "shout"], { cwd: fork.path, check: false, env: teammate });
    expect(stopped.code).not.toBe(0);
    expect(stopped.stderr).toContain("npm install -g patchbook");
    expect(stopped.stderr).toContain("PATCHBOOK_HOOK=0");
    sh(["git", "commit", "-qam", "shout"], { cwd: fork.path, env: { ...teammate, PATCHBOOK_HOOK: "0" } });
    expect(sh(["git", "log", "-1", "--format=%s"], { cwd: fork.path }).stdout).toBe("shout\n");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_status_warns_when_vite_plus_runs_a_hook_without_patchbook", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { ".vite-hooks/pre-commit": NOTE_STAGED });
    installManager(fork, ".vite-hooks");
    fork.write(".vite-hooks/pre-commit", NOTE_STAGED);
    Object.assign(t.env, { PATCHBOOK_HOOK: "1" });
    expect(t.pb(["status"], { cwd: fork.path }).stderr).toContain(".vite-hooks/pre-commit");
    t.pb(["hook", "install"], { cwd: fork.path });
    expect(t.pb(["status"], { cwd: fork.path }).stderr).not.toContain(".vite-hooks/pre-commit");
    expect(fork.read(".vite-hooks/pre-commit")).toEndWith(NOTE_STAGED);
    sh(["git", "add", "-A"], { cwd: fork.path });
    fork.write("app.txt", "one\nTWO\n");
    sh(["git", "commit", "-qam", "shout"], { cwd: fork.path, env: withHook(t) });
    expect(committedFiles(fork)).toContain(".patchbook/changes/shout/CHANGE.md");
    t.pb(["build"], { cwd: fork.path });
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_init_puts_patchbook_first_in_a_husky_hook", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("skills/a/SKILL.md", "Para one.\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write(".husky/pre-commit", NOTE_STAGED);
    repo.commit("start");
    installManager(repo, ".husky");
    t.pb(["init", "--upstream", up.path, "--output-from", "skills", "--output-to", "skills"], { cwd: repo.path });
    expect(repo.read(".husky/pre-commit")).toEndWith(NOTE_STAGED);
    t.pb(["build"], { cwd: repo.path });
    sh(["git", "add", "-A"], { cwd: repo.path });
    sh(["git", "commit", "-qm", "built"], { cwd: repo.path, env: withHook(t) });
    repo.write("skills/a/SKILL.md", "Para uno.\n");
    sh(["git", "commit", "-qam", "spanish"], { cwd: repo.path, env: withHook(t) });
    expect(read(join(repo.path, ".git/staged-when-checked"))).toContain(".patchbook/changes/shout/CHANGE.md");
    expect(sh(["git", "status", "--porcelain"], { cwd: repo.path }).stdout).toBe("");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

const GUARD = [
  'if [ "$PATCHBOOK_HOOK" != 0 ] && [ -f .patchbook/config.toml ]; then',
  "  if ! command -v patchbook >/dev/null; then",
  `    echo "patchbook isn't installed, so this commit can't record hand edits to the build output." >&2`,
  '    echo "Install it with npm install -g patchbook, or skip it once with PATCHBOOK_HOOK=0 git commit" >&2',
  "    exit 1",
  "  fi",
  "  patchbook hook run || exit 1",
  "fi",
].join("\n") + "\n";

const indent = (text: string, spaces: number): string => text.replace(/^(?=.)/gm, " ".repeat(spaces));

const LEFTHOOK_SNIPPET = `pre-commit:\n  commands:\n    patchbook:\n      priority: 1\n      run: |\n${indent(GUARD, 8)}`;

const LEFTHOOK_TOML_SNIPPET = `[pre-commit.commands.patchbook]\npriority = 1\nrun = '''\n${GUARD}'''\n`;

const LEFTHOOK_JSON_SNIPPET = `{\n  "pre-commit": {\n    "commands": {\n      "patchbook": {\n        "priority": 1,\n        "run": ${JSON.stringify(GUARD)}\n      }\n    }\n  }\n}\n`;

const PRE_COMMIT_SNIPPET = `repos:
  - repo: local
    hooks:
      - id: patchbook
        name: patchbook
        entry: |
${indent(`sh -c '${GUARD.trimEnd().replaceAll("'", "'\\''")}'`, 10)}
        language: system
        pass_filenames: false
        always_run: true
`;

const LEFTHOOK_DISPATCHER = `#!/bin/sh\n# lefthook stand-in\nlefthook run pre-commit "$@"\n`;

const LEFTHOOK_BY_EXTENSION = { yml: LEFTHOOK_SNIPPET, yaml: LEFTHOOK_SNIPPET, toml: LEFTHOOK_TOML_SNIPPET, json: LEFTHOOK_JSON_SNIPPET, jsonc: LEFTHOOK_JSON_SNIPPET };

const LEFTHOOK_NAMES = ["lefthook", ".lefthook", ".config/lefthook"].flatMap((name) =>
  Object.entries(LEFTHOOK_BY_EXTENSION).map(([extension, snippet]) => [`${name}.${extension}`, snippet] as const));

const SNIPPETS = {
  ...Object.fromEntries(LEFTHOOK_NAMES.map(([name, snippet]) => [name, { snippet, dispatcher: LEFTHOOK_DISPATCHER }])),
  ".pre-commit-config.yaml": {
    snippet: PRE_COMMIT_SNIPPET,
    dispatcher: `#!/usr/bin/env bash\n# File generated by pre-commit: https://pre-commit.com\nexec pre-commit hook-impl --hook-type=pre-commit -- "$@"\n`,
  },
};

for (const [config, { snippet, dispatcher }] of Object.entries(SNIPPETS)) {
  test(`test_hook_install_prints_what_to_add_to_${config}`, () => {
    const t = new Case();
    try {
      const existing = /json/.test(config) ? "" : "# lint on commit\n";
      const fork = forkWith(t, { [config]: existing });
      writeFileSync(join(fork.path, ".git/hooks/pre-commit"), dispatcher);
      const install = t.pb(["hook", "install"], { cwd: fork.path }).stderr;
      expect(install).toContain(snippet.trim());
      expect(install).toContain(config);
      expect(install).not.toContain(".git/hooks/pre-commit");
      expect(fork.read(config)).toBe(existing);
      expect(read(join(fork.path, ".git/hooks/pre-commit"))).toBe(dispatcher);
      Object.assign(t.env, { PATCHBOOK_HOOK: "1" });
      expect(t.pb(["status"], { cwd: fork.path }).stderr).toContain(config);
      fork.write(config, snippet);
      expect(t.pb(["status"], { cwd: fork.path }).stderr).not.toContain(config);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

const parsed = {
  yaml: (text: string): any => Bun.YAML.parse(text),
  toml: (text: string): any => Bun.TOML.parse(text),
  json: (text: string): any => JSON.parse(text),
};

const COMMANDS: Record<string, (printed: string) => string[]> = {
  "lefthook.yml": (printed) => ["sh", "-c", parsed.yaml(printed)["pre-commit"].commands.patchbook.run],
  "lefthook.toml": (printed) => ["sh", "-c", parsed.toml(printed)["pre-commit"].commands.patchbook.run],
  "lefthook.json": (printed) => ["sh", "-c", parsed.json(printed)["pre-commit"].commands.patchbook.run],
  ".pre-commit-config.yaml": (printed) => shlexSplit(parsed.yaml(printed).repos[0].hooks[0].entry),
};

const printedSnippet = (stderr: string): string => stderr.split("rebuilt output:\n\n")[1]!.split("\nLeave parallel off")[0]!;

for (const config of Object.keys(COMMANDS)) {
  test(`test_the_snippet_for_${config}_guards_the_command_like_the_hook_lines`, () => {
    const t = new Case();
    try {
      const fork = forkWith(t, { [config]: /json/.test(config) ? "" : "# lint on commit\n" });
      const argv = COMMANDS[config]!(printedSnippet(t.pb(["hook", "install"], { cwd: fork.path }).stderr));
      const plain = join(t.tmp, "plain");
      mkdirSync(plain);
      const noPatchbook = { ...withHook(t), PATH: t.env["PATH"]!.split(":").filter((d) => !existsSync(join(d, "patchbook"))).join(":") };
      const blocked = sh(argv, { cwd: fork.path, env: noPatchbook, check: false });
      expect(blocked.code).toBe(1);
      expect(blocked.stderr).toContain("npm install -g patchbook");
      expect(blocked.stderr).toContain("PATCHBOOK_HOOK=0");
      const skipped = sh(argv, { cwd: fork.path, env: { ...noPatchbook, PATCHBOOK_HOOK: "0" }, check: false });
      expect([skipped.code, skipped.stderr]).toEqual([0, ""]);
      const outside = sh(argv, { cwd: plain, env: noPatchbook, check: false });
      expect([outside.code, outside.stderr]).toEqual([0, ""]);
      expect(sh(argv, { cwd: fork.path, env: withHook(t), check: false }).code).toBe(0);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

type Paste = {
  name: string;
  config: string;
  existing: string;
  says: string;
  merge: (existing: string, printed: string) => string;
  parse: (text: string) => any;
  check: (merged: any) => void;
  omits?: RegExp[];
};

const hasPatchbook = (hook: any): void => expect(hook.run).toContain("patchbook hook run");

const PASTES: Paste[] = [
  ...["lefthook.yml", ".config/lefthook.yaml"].flatMap((config): Paste[] => [
    {
      name: "no pre-commit key", config, existing: "skip_output:\n  - meta\n", says: `Add this to ${config},`,
      merge: (existing, printed) => existing + printed, parse: parsed.yaml,
      check: (m) => { expect(m.skip_output).toEqual(["meta"]); hasPatchbook(m["pre-commit"].commands.patchbook); },
    },
    {
      name: "a pre-commit key without commands", config, existing: "pre-commit:\n  parallel: true\n", says: `Add this under the pre-commit key in ${config},`,
      merge: (existing, printed) => existing + printed, parse: parsed.yaml, omits: [/^pre-commit:/m],
      check: (m) => { expect(m["pre-commit"].parallel).toBe(true); hasPatchbook(m["pre-commit"].commands.patchbook); },
    },
    {
      name: "a pre-commit key with commands", config, existing: "pre-commit:\n  commands:\n    lint:\n      run: echo lint\n", says: `Add this under commands, in the pre-commit key of ${config},`,
      merge: (existing, printed) => existing + printed, parse: parsed.yaml, omits: [/^pre-commit:/m, /^\s*commands:/m],
      check: (m) => { expect(m["pre-commit"].commands.lint.run).toBe("echo lint"); hasPatchbook(m["pre-commit"].commands.patchbook); },
    },
  ]),
  ...["lefthook.toml", ".lefthook.toml"].flatMap((config): Paste[] => [
    {
      name: "no pre-commit table", config, existing: 'skip_output = ["meta"]\n', says: `Add this to ${config},`,
      merge: (existing, printed) => existing + printed, parse: parsed.toml,
      check: (m) => { expect(m.skip_output).toEqual(["meta"]); hasPatchbook(m["pre-commit"].commands.patchbook); },
    },
    {
      name: "a pre-commit table", config, existing: "[pre-commit]\nparallel = true\n", says: `Add this to ${config},`,
      merge: (existing, printed) => existing + printed, parse: parsed.toml,
      check: (m) => { expect(m["pre-commit"].parallel).toBe(true); hasPatchbook(m["pre-commit"].commands.patchbook); },
    },
    {
      name: "pre-commit commands", config, existing: '[pre-commit.commands.lint]\nrun = "echo lint"\n', says: `Add this to ${config},`,
      merge: (existing, printed) => existing + printed, parse: parsed.toml,
      check: (m) => { expect(m["pre-commit"].commands.lint.run).toBe("echo lint"); hasPatchbook(m["pre-commit"].commands.patchbook); },
    },
  ]),
  ...["lefthook.json", "lefthook.jsonc"].flatMap((config): Paste[] => [
    {
      name: "an empty file", config, existing: "", says: `Add this to ${config},`,
      merge: (_, printed) => printed, parse: parsed.json,
      check: (m) => hasPatchbook(m["pre-commit"].commands.patchbook),
    },
    {
      name: "no pre-commit key", config, existing: '{ "skip_output": ["meta"] }', says: `Add this inside the top-level braces of ${config}, with a comma after the member before it if there is one,`,
      merge: (existing, printed) => existing.replace(/ \}$/, `, ${printed.trim()} }`), parse: parsed.json, omits: [/^\{/m],
      check: (m) => { expect(m.skip_output).toEqual(["meta"]); hasPatchbook(m["pre-commit"].commands.patchbook); },
    },
    {
      name: "a pre-commit key without commands", config, existing: '{ "pre-commit": { "parallel": true } }', says: `Add this inside "pre-commit" in ${config}, with a comma after the member before it if there is one,`,
      merge: (existing, printed) => existing.replace(/ \} \}$/, `, ${printed.trim()} } }`), parse: parsed.json, omits: [/"pre-commit"/],
      check: (m) => { expect(m["pre-commit"].parallel).toBe(true); hasPatchbook(m["pre-commit"].commands.patchbook); },
    },
    {
      name: "a pre-commit key with commands", config, existing: '{ "pre-commit": { "commands": { "lint": { "run": "echo lint" } } } }',
      says: `Add this inside "commands" in "pre-commit" in ${config}, with a comma after the member before it if there is one,`,
      merge: (existing, printed) => existing.replace(/ \} \} \}$/, `, ${printed.trim()} } } }`), parse: parsed.json, omits: [/"pre-commit"/, /"commands"/],
      check: (m) => { expect(m["pre-commit"].commands.lint.run).toBe("echo lint"); hasPatchbook(m["pre-commit"].commands.patchbook); },
    },
  ]),
  {
    name: "no repos key", config: ".pre-commit-config.yaml", existing: "exclude: ^vendor/\n", says: "Add this to .pre-commit-config.yaml,",
    merge: (existing, printed) => existing + printed, parse: parsed.yaml,
    check: (m) => { expect(m.exclude).toBe("^vendor/"); expect(m.repos[0].hooks[0].id).toBe("patchbook"); },
  },
  {
    name: "repos with entries", config: ".pre-commit-config.yaml",
    existing: "repos:\n  - repo: https://example.com/linters\n    rev: v1\n    hooks:\n      - id: lint\n",
    says: "Add this as the first item under repos in .pre-commit-config.yaml,",
    merge: (existing, printed) => existing.replace("repos:\n", "repos:\n" + printed), parse: parsed.yaml, omits: [/^repos:/m],
    check: (m) => { expect(m.repos[0].hooks[0].id).toBe("patchbook"); expect(m.repos[1].hooks[0].id).toBe("lint"); expect(m.repos).toHaveLength(2); },
  },
  {
    name: "an empty repos list", config: ".pre-commit-config.yaml", existing: "repos: []\n", says: "Add this to .pre-commit-config.yaml in place of repos: [],",
    merge: (_, printed) => printed, parse: parsed.yaml,
    check: (m) => expect(m.repos[0].hooks[0].id).toBe("patchbook"),
  },
];

for (const { name, config, existing, says, merge, parse, check, omits = [] } of PASTES) {
  test(`test_hook_install_prints_what_goes_into_${config}_with_${name.replaceAll(" ", "_")}`, () => {
    const t = new Case();
    try {
      const fork = forkWith(t, { [config]: existing });
      const install = t.pb(["hook", "install"], { cwd: fork.path }).stderr;
      expect(install).toContain(says);
      const printed = printedSnippet(install);
      for (const absent of omits) expect(printed).not.toMatch(absent);
      expect(fork.read(config)).toBe(existing);
      check(parse(merge(existing, printed)));
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("test_hook_install_in_a_repo_nested_in_a_fork_fails_instead_of_installing_nothing", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, {});
    const inner = new Repo(join(fork.path, "vendor/inner"));
    inner.write("a.txt", "a\n");
    inner.commit("inner");
    const outerHook = read(join(fork.path, ".git/hooks/pre-commit"));
    const install = t.pb(["hook", "install"], { cwd: inner.path, code: 1 });
    expect(install.stderr).toContain("another git repo");
    expect(install.stderr).toContain("/fork");
    expect(existsSync(join(inner.path, ".git/hooks/pre-commit"))).toBe(false);
    expect(read(join(fork.path, ".git/hooks/pre-commit"))).toBe(outerHook);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_hook_install_works_from_a_folder_inside_the_repo_that_holds_the_patchbook", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { ".husky/pre-commit": NOTE_STAGED });
    installManager(fork, ".husky");
    mkdirSync(join(fork.path, "sub/dir"), { recursive: true });
    t.pb(["hook", "install"], { cwd: join(fork.path, "sub/dir") });
    expect(fork.read(".husky/pre-commit")).toContain("patchbook hook run || exit 1");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

const LATIN1_HOOK = Buffer.concat([Buffer.from("# caf"), Buffer.from([0xe9]), Buffer.from(` lint\r\n# written on Windows\r\n${NOTE_STAGED}`)]);
const carriageReturns = (bytes: Uint8Array) => bytes.filter((b) => b === 0x0d).length;

test("test_clone_keeps_the_bytes_of_a_hook_that_is_not_utf8", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    mkdirSync(join(up.path, ".vite-hooks"));
    writeFileSync(join(up.path, ".vite-hooks/pre-commit"), LATIN1_HOOK);
    up.commit("start");
    t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    const fork = new Repo(join(t.tmp, "fork"));
    const hook = readFileSync(join(fork.path, ".vite-hooks/pre-commit"));
    expect(hook.subarray(hook.length - LATIN1_HOOK.length).equals(LATIN1_HOOK)).toBe(true);
    expect(carriageReturns(hook)).toBe(carriageReturns(LATIN1_HOOK));
    expect(hook.includes(Buffer.from("\ufffd"))).toBe(false);
    expect(hook.toString("latin1")).toContain("patchbook hook run || exit 1");
    t.pb(["build"], { cwd: fork.path });
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_init_keeps_the_bytes_of_a_husky_hook_that_is_not_utf8", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("skills/a/SKILL.md", "Para one.\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    mkdirSync(join(repo.path, ".husky"));
    writeFileSync(join(repo.path, ".husky/pre-commit"), LATIN1_HOOK);
    repo.commit("start");
    installManager(repo, ".husky");
    t.pb(["init", "--upstream", up.path, "--output-from", "skills", "--output-to", "skills"], { cwd: repo.path });
    const hook = readFileSync(join(repo.path, ".husky/pre-commit"));
    expect(hook.subarray(hook.length - LATIN1_HOOK.length).equals(LATIN1_HOOK)).toBe(true);
    expect(carriageReturns(hook)).toBe(carriageReturns(LATIN1_HOOK));
    expect(hook.includes(Buffer.from("\ufffd"))).toBe(false);
    expect(hook.toString("latin1")).toContain("patchbook hook run || exit 1");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_a_hook_script_in_the_tree_does_not_hide_another_tools_git_hook", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { ".husky/pre-commit": NOTE_STAGED });
    fork.write(".git/hooks/pre-commit", "#!/bin/sh\necho their hook\n", 0o755);
    Object.assign(t.env, { PATCHBOOK_HOOK: "1" });
    expect(t.pb(["status"], { cwd: fork.path }).stderr).toContain(".git/hooks/pre-commit");
    const install = t.pb(["hook", "install"], { cwd: fork.path }).stderr;
    expect(install).toContain(".git/hooks/pre-commit");
    expect(install).toContain("patchbook hook run || exit 1");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_another_hooks_path_wins_over_a_lefthook_config", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { "lefthook.yml": "# lint on commit\n" });
    sh(["git", "config", "core.hooksPath", ".githooks"], { cwd: fork.path });
    Object.assign(t.env, { PATCHBOOK_HOOK: "1" });
    const status = t.pb(["status"], { cwd: fork.path }).stderr;
    expect(status).toContain(".githooks/pre-commit");
    expect(status).not.toContain("lefthook.yml");
    const install = t.pb(["hook", "install"], { cwd: fork.path }).stderr;
    expect(install).toContain(".githooks/pre-commit");
    expect(install).not.toContain("priority: 1");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_clone_does_not_write_through_a_linked_hook_script", () => {
  const t = new Case();
  try {
    const outside = join(t.tmp, "outside.sh");
    writeFileSync(outside, "echo outside\n");
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    mkdirSync(join(up.path, ".husky"));
    symlinkSync(outside, join(up.path, ".husky/pre-commit"));
    up.commit("start");
    const clone = t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    expect(read(outside)).toBe("echo outside\n");
    expect(clone.stderr).toContain("patchbook hook run || exit 1");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_a_commented_patchbook_line_does_not_count_as_running_it", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { ".vite-hooks/pre-commit": "# TODO: patchbook hook run\n" + NOTE_STAGED });
    expect(fork.read(".vite-hooks/pre-commit")).toContain("patchbook hook run || exit 1");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_hook_install_records_a_manager_script_that_runs_patchbook_unrecorded", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, {});
    fork.write(".husky/pre-commit", "#!/bin/sh\npatchbook hook run || exit 1\n", 0o755);
    installManager(fork, ".husky");
    const install = t.pb(["hook", "install"], { cwd: fork.path }).stderr;
    expect(install).toContain("recorded the edit in the patchbook");
    expect(fork.read(".patchbook/series")).toContain("patchbook-hook");
    Object.assign(t.env, { PATCHBOOK_HOOK: "1" });
    sh(["git", "commit", "-qm", "hook"], { cwd: fork.path, env: withHook(t) });
    t.pb(["build"], { cwd: fork.path });
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_init_in_a_fork_stages_the_series_with_the_hook_change", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, "mine"], { cwd: t.tmp });
    const repo = new Repo(join(t.tmp, "mine"));
    repo.write(".husky/pre-commit", NOTE_STAGED);
    repo.commit("husky");
    installManager(repo, ".husky");
    t.pb(["init", "--upstream", up.path], { cwd: repo.path });
    const staged = words(sh(["git", "diff", "--cached", "--name-only"], { cwd: repo.path }).stdout);
    expect(staged).toContain(".husky/pre-commit");
    expect(staged).toContain(".patchbook/series");
    expect(staged.some((p) => p.startsWith(".patchbook/changes/patchbook-hook/"))).toBe(true);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_status_trusts_patchbooks_hook_kept_by_pre_commits_migration_mode", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { ".pre-commit-config.yaml": "repos: []\n" });
    renameSync(join(fork.path, ".git/hooks/pre-commit"), join(fork.path, ".git/hooks/pre-commit.legacy"));
    fork.write(
      ".git/hooks/pre-commit",
      `#!/bin/sh\n# File generated by pre-commit: https://pre-commit.com\n"$(dirname "$0")/pre-commit.legacy" "$@" || exit 1\n`,
      0o755,
    );
    const install = t.pb(["hook", "install"], { cwd: fork.path }).stderr;
    expect(install).toContain("- id: patchbook");
    expect(install).not.toContain("won't run");
    Object.assign(t.env, { PATCHBOOK_HOOK: "1" });
    expect(t.pb(["status"], { cwd: fork.path }).stderr).not.toContain("doesn't run");
    fork.write("app.txt", "one\nTWO\n");
    sh(["git", "add", "-A"], { cwd: fork.path });
    sh(["git", "commit", "-qm", "shout"], { cwd: fork.path, env: withHook(t) });
    expect(committedFiles(fork).some((p) => p.startsWith(".patchbook/changes/"))).toBe(true);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_the_printed_lines_are_safe_in_a_hooks_folder_every_repo_shares", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, {});
    const shared = join(t.tmp, "shared");
    mkdirSync(shared);
    sh(["git", "config", "core.hooksPath", shared], { cwd: fork.path });
    const install = t.pb(["hook", "install"], { cwd: fork.path }).stderr;
    const lines = install.match(/^# patchbook:[\s\S]*?^fi$/m)![0];
    writeFileSync(join(shared, "pre-commit"), "#!/bin/sh\n" + lines + "\n");
    chmodSync(join(shared, "pre-commit"), 0o755);
    const plain = new Repo(join(t.tmp, "plain"));
    sh(["git", "config", "core.hooksPath", shared], { cwd: plain.path });
    plain.write("a.txt", "a\n");
    sh(["git", "add", "-A"], { cwd: plain.path });
    sh(["git", "commit", "-qm", "plain"], { cwd: plain.path, env: withHook(t) });
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_clone_does_not_write_through_a_linked_hook_folder", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.write("tools/husky/pre-commit", "echo lint\n");
    symlinkSync("tools/husky", join(up.path, ".husky"));
    up.commit("start");
    const clone = t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    const fork = new Repo(join(t.tmp, "fork"));
    expect(fork.read("tools/husky/pre-commit")).toBe("echo lint\n");
    expect(clone.stderr).toContain("patchbook hook run || exit 1");
    const recorded = Object.keys(tree(fork.path)).filter((p) => p.startsWith(".patchbook/changes/patchbook-update-skill/"));
    expect(recorded.filter((p) => p.includes("husky"))).toEqual([]);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_a_leftover_legacy_hook_does_not_hide_another_tools_hook", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, {});
    renameSync(join(fork.path, ".git/hooks/pre-commit"), join(fork.path, ".git/hooks/pre-commit.legacy"));
    fork.write(".git/hooks/pre-commit", "#!/bin/sh\necho other tool\n", 0o755);
    Object.assign(t.env, { PATCHBOOK_HOOK: "1" });
    expect(t.pb(["status"], { cwd: fork.path }).stderr).toContain(".git/hooks/pre-commit");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_a_lefthook_config_does_not_hide_a_dispatcher_that_is_not_lefthooks", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { "lefthook.yml": LEFTHOOK_SNIPPET });
    fork.write(".git/hooks/pre-commit", "#!/bin/sh\necho unrelated dispatcher\n", 0o755);
    Object.assign(t.env, { PATCHBOOK_HOOK: "1" });
    expect(t.pb(["status"], { cwd: fork.path }).stderr).toContain(".git/hooks/pre-commit");
    const install = t.pb(["hook", "install"], { cwd: fork.path }).stderr;
    expect(install).toContain(".git/hooks/pre-commit");
    expect(install).toContain("patchbook hook run || exit 1");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_hook_install_puts_patchbook_first_in_a_husky_folder_below_the_root", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { "frontend/.husky/pre-commit": NOTE_STAGED });
    installManager(fork, "frontend/.husky");
    const install = t.pb(["hook", "install"], { cwd: fork.path });
    expect(fork.read("frontend/.husky/pre-commit")).toContain("patchbook hook run || exit 1");
    expect(install.stderr).toContain("recorded the edit in the patchbook");
    fork.write("app.txt", "one\nTWO\n");
    sh(["git", "commit", "-qam", "shout"], { cwd: fork.path, env: withHook(t) });
    expect(committedFiles(fork).some((p) => p.startsWith(".patchbook/changes/"))).toBe(true);
    t.pb(["build"], { cwd: fork.path });
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_hook_install_stages_record_files_git_ignores", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, {});
    appendFileSync(join(fork.path, ".git/info/exclude"), "*.pb\n");
    fork.write(".husky/pre-commit", "#!/bin/sh\necho lint\n", 0o755);
    installManager(fork, ".husky");
    t.pb(["hook", "install"], { cwd: fork.path });
    const staged = words(sh(["git", "diff", "--cached", "--name-only"], { cwd: fork.path }).stdout);
    expect(staged.some((p) => p.startsWith(".patchbook/changes/patchbook-hook/") && p.endsWith(".pb"))).toBe(true);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_status_is_quiet_once_a_linked_husky_folder_runs_patchbook", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.write("tools/husky/pre-commit", "echo lint\n");
    symlinkSync("tools/husky", join(up.path, ".husky"));
    up.commit("start");
    const clone = t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    const fork = new Repo(join(t.tmp, "fork"));
    installManager(fork, ".husky");
    fork.write("tools/husky/pre-commit", clone.stderr.match(/^# patchbook:[\s\S]*?^fi$/m)![0] + "\necho lint\n");
    Object.assign(t.env, { PATCHBOOK_HOOK: "1" });
    expect(t.pb(["status"], { cwd: fork.path }).stderr).not.toContain("doesn't run");
    expect(t.pb(["hook", "install"], { cwd: fork.path }).stderr).not.toContain("_/pre-commit");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_a_pre_commit_dispatcher_that_mentions_lefthook_is_still_pre_commits", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { "lefthook.yml": LEFTHOOK_SNIPPET, ".pre-commit-config.yaml": "repos: []\n" });
    fork.write(
      ".git/hooks/pre-commit",
      `#!/usr/bin/env bash\n# File generated by pre-commit: https://pre-commit.com\nINSTALL_PYTHON=/opt/lefthook/venv/bin/python\nexec "$INSTALL_PYTHON" -mpre_commit hook-impl --hook-type=pre-commit -- "$@"\n`,
      0o755,
    );
    Object.assign(t.env, { PATCHBOOK_HOOK: "1" });
    expect(t.pb(["status"], { cwd: fork.path }).stderr).toContain(".pre-commit-config.yaml");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_migration_mode_advice_follows_pre_commit_not_a_stray_lefthook_config", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { ".pre-commit-config.yaml": "repos: []\n", "lefthook.yml": "# old\n" });
    renameSync(join(fork.path, ".git/hooks/pre-commit"), join(fork.path, ".git/hooks/pre-commit.legacy"));
    fork.write(
      ".git/hooks/pre-commit",
      `#!/bin/sh\n# File generated by pre-commit: https://pre-commit.com\n"$(dirname "$0")/pre-commit.legacy" "$@" || exit 1\n`,
      0o755,
    );
    const install = t.pb(["hook", "install"], { cwd: fork.path }).stderr;
    expect(install).toContain("- id: patchbook");
    expect(install).not.toContain("priority: 1");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

const hookFile = (repo: Repo) => join(repo.path, ".git/hooks/pre-commit");

function forkWithoutAHook(t: Case): Repo {
  const fork = forkWith(t, {});
  rmSync(hookFile(fork));
  return fork;
}

test("test_read_only_commands_do_not_install_the_hook", () => {
  const t = new Case();
  try {
    const fork = forkWithoutAHook(t);
    for (const args of [["status"], ["check"], ["upstream", "upstream"], ["show", "nothing"], ["config"], ["hook", "status"]]) {
      t.pb(args, { cwd: fork.path, code: null });
      expect(existsSync(hookFile(fork))).toBe(false);
    }
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_commands_that_change_things_install_the_hook", () => {
  const t = new Case();
  try {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("lib.txt", "lib\n");
    extra.commit("start");
    const fork = forkWith(t, {});
    for (const args of [["build"], ["sync"], ["record"], ["track", "extra", extra.path]]) {
      rmSync(hookFile(fork), { force: true });
      t.pb(args, { cwd: fork.path, code: null });
      expect(existsSync(hookFile(fork))).toBe(true);
    }
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_no_command_installs_the_hook_while_hook_enabled_is_false", () => {
  const t = new Case();
  try {
    const fork = forkWithoutAHook(t);
    t.pb(["config", "--project", "hook.enabled", "false"], { cwd: fork.path });
    for (const args of [["build"], ["sync"], ["record"], ["hook", "install"]]) {
      t.pb(args, { cwd: fork.path, code: null });
      expect(existsSync(hookFile(fork))).toBe(false);
    }
    t.pb(["config", "--project", "--unset", "hook.enabled"], { cwd: fork.path });
    t.pb(["build"], { cwd: fork.path });
    expect(existsSync(hookFile(fork))).toBe(true);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_hook_status_says_which_hook_git_runs_and_whether_it_calls_patchbook", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, {});
    const ours = t.pb(["hook", "status"], { cwd: fork.path }).stdout;
    expect(ours).toContain("hook.enabled: on");
    expect(ours).toContain("git runs: .git/hooks/pre-commit");
    expect(ours).toContain("calls patchbook: yes");
    fork.write(".git/hooks/pre-commit", "#!/bin/sh\necho their hook\n", 0o755);
    const theirs = t.pb(["hook", "status"], { cwd: fork.path }).stdout;
    expect(theirs).toContain("git runs: .git/hooks/pre-commit");
    expect(theirs).toContain("calls patchbook: no");
    expect(theirs).toContain("patchbook hook install");
    t.pb(["config", "--project", "hook.enabled", "false"], { cwd: fork.path });
    expect(t.pb(["hook", "status"], { cwd: fork.path }).stdout).toContain("hook.enabled: off");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_hook_status_says_when_git_runs_no_hook_and_does_not_write_one", () => {
  const t = new Case();
  try {
    const fork = forkWithoutAHook(t);
    const out = t.pb(["hook", "status"], { cwd: fork.path }).stdout;
    expect(out).toContain("git runs: nothing");
    expect(out).toContain("calls patchbook: no");
    expect(out).toContain("patchbook hook install");
    expect(existsSync(hookFile(fork))).toBe(false);
    expect(t.pb(["status"], { cwd: fork.path }).stderr).toContain("git runs no pre-commit hook");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_hook_status_names_the_file_that_calls_patchbook", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { ".husky/pre-commit": NOTE_STAGED });
    fork.write(".husky/pre-commit", "echo lint\n");
    const out = t.pb(["hook", "status"], { cwd: fork.path }).stdout;
    expect(out).toContain("git runs: .git/hooks/pre-commit");
    expect(out).toContain("calls patchbook: yes");
    expect(out).not.toContain(".husky");
    installManager(fork, ".husky");
    fork.write(".husky/pre-commit", "patchbook hook run || exit 1\n");
    expect(t.pb(["hook", "status"], { cwd: fork.path }).stdout).toContain("calls patchbook: yes, in .husky/pre-commit");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_hook_status_says_when_git_ignores_a_hook_that_is_not_executable", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, {});
    chmodSync(hookFile(fork), 0o644);
    const out = t.pb(["hook", "status"], { cwd: fork.path }).stdout;
    expect(out).toContain("git runs: nothing");
    expect(out).toContain("chmod +x .git/hooks/pre-commit");
    expect(t.pb(["status"], { cwd: fork.path }).stderr).toContain("isn't executable");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_no_command_installs_the_hook_while_PATCHBOOK_HOOK_is_0", () => {
  const t = new Case();
  try {
    const fork = forkWithoutAHook(t);
    const off = { cwd: fork.path, env: { ...t.env, PATCHBOOK_HOOK: "0" } };
    sh([...CMD, "build"], off);
    expect(existsSync(hookFile(fork))).toBe(false);
    expect(sh([...CMD, "hook", "status"], off).stdout).toContain("hook.enabled: off (env)");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

const SWITCHES = ["user config", "PATCHBOOK_HOOK=0"] as const;

function hookOffBy(t: Case, how: (typeof SWITCHES)[number]): (args: string[], cwd: string) => Run {
  if (how === "user config") {
    t.pb(["config", "hook.enabled", "false"], { cwd: t.tmp });
    return (args, cwd) => t.pb(args, { cwd });
  }
  return (args, cwd) => sh([...CMD, ...args], { cwd, env: { ...t.env, PATCHBOOK_HOOK: "0" } });
}

for (const how of SWITCHES) {
  test(`test_clone_does_not_say_the_hook_records_when_${how === "user config" ? "the_user_config" : "PATCHBOOK_HOOK"}_turned_it_off`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\ntwo\n");
      up.commit("start");
      const cloned = hookOffBy(t, how)(["clone", up.path, "fork"], t.tmp).stdout;
      expect(existsSync(join(t.tmp, "fork/.git/hooks/pre-commit"))).toBe(false);
      expect(cloned).not.toContain("the hook records what you staged");
      expect(cloned).toContain("hook.enabled is off");
      expect(cloned).toContain(how === "user config" ? "`patchbook config hook.enabled true`" : "Unset PATCHBOOK_HOOK");
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("test_clone_says_the_hook_records_only_when_it_was_installed", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    expect(t.pb(["clone", up.path, "fork"], { cwd: t.tmp }).stdout).toContain("the hook records what you staged");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_hook_install_names_the_setting_that_turned_the_hook_off", () => {
  const t = new Case();
  try {
    const fork = forkWithoutAHook(t);
    const install = (env: Record<string, string> = {}) => sh([...CMD, "hook", "install"], { cwd: fork.path, env: { ...t.env, PATCHBOOK_HOOK: "", ...env } }).stderr;
    t.pb(["config", "hook.enabled", "false"], { cwd: fork.path });
    const user = install();
    expect(user).toContain("hook.enabled is off");
    expect(user).toContain("`patchbook config hook.enabled true`");
    t.pb(["config", "--project", "hook.enabled", "false"], { cwd: fork.path });
    expect(install()).toContain("`patchbook config --project hook.enabled true`");
    const env = install({ PATCHBOOK_HOOK: "0" });
    expect(env).toContain("Unset PATCHBOOK_HOOK");
    expect(env).not.toContain("patchbook config");
    expect(existsSync(hookFile(fork))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_install_commands_make_patchbooks_own_hook_executable_again", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, {});
    for (const args of [["build"], ["record"], ["hook", "install"]]) {
      chmodSync(hookFile(fork), 0o644);
      const out = t.pb(args, { cwd: fork.path, code: null });
      expect(out.stderr).toContain("executable");
      expect(statSync(hookFile(fork)).mode & 0o777).toBe(0o755);
    }
    expect(t.pb(["hook", "status"], { cwd: fork.path }).stdout).toContain("git runs: .git/hooks/pre-commit");
    fork.write("app.txt", "one\nTWO\n");
    sh(["git", "commit", "-qam", "shout"], { cwd: fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Shout the second line." } });
    expect(committedFiles(fork).some((f) => f.startsWith(".patchbook/changes/"))).toBe(true);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_install_commands_leave_another_tools_hook_alone_and_hook_install_says_git_ignores_it", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, {});
    const theirs = "#!/bin/sh\necho their hook\n";
    fork.write(".git/hooks/pre-commit", theirs, 0o644);
    expect(t.pb(["build"], { cwd: fork.path }).stderr).not.toContain("executable");
    const install = t.pb(["hook", "install"], { cwd: fork.path }).stderr;
    expect(install).toContain("isn't executable");
    expect(install).toContain("chmod +x .git/hooks/pre-commit");
    expect(fork.read(".git/hooks/pre-commit")).toBe(theirs);
    expect(statSync(hookFile(fork)).mode & 0o777).toBe(0o644);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const how of SWITCHES) {
  const huskyFiles = { ".husky/pre-commit": NOTE_STAGED };
  const noInstall = (repo: Repo): void => {
    expect(existsSync(hookFile(repo))).toBe(false);
    expect(repo.read(".husky/pre-commit")).toBe(NOTE_STAGED);
    expect(sh(["git", "diff", "--cached", "--name-only"], { cwd: repo.path }).stdout).toBe("");
    expect(sh(["git", "status", "--porcelain", "--", ".husky"], { cwd: repo.path }).stdout).toBe("");
  };

  test(`test_clone_of_a_husky_repo_installs_nothing_while_hook_enabled_is_off_by_${how.replaceAll(" ", "_")}`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\ntwo\n");
      for (const [path, text] of Object.entries(huskyFiles)) up.write(path, text);
      up.commit("start");
      hookOffBy(t, how)(["clone", up.path, "fork"], t.tmp);
      noInstall(new Repo(join(t.tmp, "fork")));
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  test(`test_init_in_a_husky_repo_installs_nothing_while_hook_enabled_is_off_by_${how.replaceAll(" ", "_")}`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("skills/a/SKILL.md", "Para one.\n");
      up.commit("start");
      const folder = new Repo(join(t.tmp, "adapted"));
      for (const [path, text] of Object.entries(huskyFiles)) folder.write(path, text);
      folder.commit("start");
      hookOffBy(t, how)(["init", "--upstream", up.path, "--output-from", "skills", "--output-to", "skills"], folder.path);
      noInstall(folder);
      sh(["git", "clone", "-q", up.path, "mine"], { cwd: t.tmp });
      const mine = new Repo(join(t.tmp, "mine"));
      for (const [path, text] of Object.entries(huskyFiles)) mine.write(path, text);
      mine.commit("husky");
      hookOffBy(t, how)(["init", "--upstream", up.path], mine.path);
      noInstall(mine);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  test(`test_track_in_a_husky_fork_installs_nothing_while_hook_enabled_is_off_by_${how.replaceAll(" ", "_")}`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\ntwo\n");
      for (const [path, text] of Object.entries(huskyFiles)) up.write(path, text);
      up.commit("start");
      const extra = new Repo(join(t.tmp, "extra"));
      extra.write("lib.txt", "lib\n");
      extra.commit("start");
      const off = hookOffBy(t, how);
      off(["clone", up.path, "fork"], t.tmp);
      const fork = new Repo(join(t.tmp, "fork"));
      off(["track", "extra", extra.path], fork.path);
      noInstall(fork);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("test_hook_run_never_installs_or_writes_a_hook", () => {
  const t = new Case();
  try {
    const fork = forkWithoutAHook(t);
    fork.write("app.txt", "one\nTWO\n");
    sh(["git", "add", "app.txt"], { cwd: fork.path });
    const env = { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Shout the second line." };
    const ran = sh([...CMD, "hook", "run"], { cwd: fork.path, env });
    expect(ran.stdout).toContain("app.txt");
    expect(existsSync(hookFile(fork))).toBe(false);
    sh([...CMD, "hook", "run"], { cwd: fork.path, env });
    expect(existsSync(hookFile(fork))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_commands_that_install_skip_a_patchbook_in_the_repo_around_the_one_you_are_in", () => {
  const t = new Case();
  try {
    const fork = forkWithoutAHook(t);
    const inner = new Repo(join(t.tmp, "fork/vendor/inner"));
    inner.write("a.txt", "a\n");
    inner.commit("inner");
    t.pb(["build"], { cwd: inner.path, code: null });
    expect(existsSync(hookFile(fork))).toBe(false);
    expect(existsSync(join(inner.path, ".git/hooks/pre-commit"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("test_commands_that_install_treat_a_linked_worktree_of_the_book_repo_as_the_same_repo", () => {
  const t = new Case();
  try {
    const fork = forkWithoutAHook(t);
    // The worktree's commit has no .patchbook, so Book.find walks up to the main checkout's book.
    sh(["git", "worktree", "add", "-q", "--detach", ".claude-wt", "HEAD~1"], { cwd: fork.path });
    const wt = join(fork.path, ".claude-wt");
    expect(existsSync(join(wt, ".patchbook"))).toBe(false);
    t.pb(["hook", "install"], { cwd: wt });
    expect(existsSync(hookFile(fork))).toBe(true);
    rmSync(hookFile(fork));
    t.pb(["sync"], { cwd: wt, code: null });
    expect(existsSync(hookFile(fork))).toBe(true);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const [name, dir, install] of [["husky", ".husky", "npx husky"], ["Vite+", ".vite-hooks", "vp config"]] as const) {
  test(`test_status_and_hook_status_say_when_${name === "husky" ? "husky" : "vite_plus"}_has_not_installed_its_hook_in_a_new_worktree`, () => {
    const t = new Case();
    try {
      const fork = forkWith(t, { [`${dir}/pre-commit`]: NOTE_STAGED });
      installManager(fork, dir);
        expect(t.pb(["status"], { cwd: fork.path }).stderr).not.toContain("git runs no pre-commit hook");
      sh(["git", "worktree", "add", "-q", "../wt", "-b", "wt"], { cwd: fork.path });
      const wt = join(t.tmp, "wt");
      expect(existsSync(join(wt, dir, "_"))).toBe(false);
      const status = t.pb(["status"], { cwd: wt }).stderr;
      expect(status).toContain("git runs no pre-commit hook");
      expect(status).toContain(`${name}`);
      expect(status).toContain(install);
      const hook = t.pb(["hook", "status"], { cwd: wt }).stdout;
      expect(hook).toContain("git runs: nothing");
      expect(hook).toContain(install);
      expect(existsSync(join(wt, dir, "_"))).toBe(false);
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

  const intoKeptCommit = (t: ForkCase, ...args: string[]) =>
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

  forkTestOnCaseSensitiveFs("test_hook_refuses_a_staged_file_under_dot_PATCHBOOK_before_recording_it", (t) => {
    const [path, place] = [".PATCHBOOK/x.md", ".patchbook"];
    t.fork.write(path, "ours\n");
    sh(["git", "add", "--", path], { cwd: t.fork.path });
    const files = tree(t.fork.path);
    const state = gitState(t);
    const refused = intoKeptCommit(t, "--allow-empty");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`patchbook: refusing this commit: ${path} is new, but a change can't write into ${place}.`);
    expect(refused.stderr).toContain(`Move ${path} out of there, or skip the hook once with PATCHBOOK_HOOK=0.`);
    expect(tree(t.fork.path)).toEqual(files);
    expect(gitState(t)).toBe(state);
    expect(existsSync(join(t.fork.path, ".patchbook/changes"))).toBe(false);
  });

  forkTestOnCaseSensitiveFs("test_hook_leaves_an_untracked_file_under_dot_GIT_out_of_the_commit", (t) => {
    t.fork.write("a/.GIT/y", "ours\n");
    expect(sh(["git", "add", "--", "a/.GIT/y"], { cwd: t.fork.path, check: false }).code).not.toBe(0);
    const committed = intoKeptCommit(t, "--allow-empty");
    expect(committed.code).toBe(0);
    expect(committed.stderr).not.toContain("refusing this commit");
    expect(t.fork.read("a/.GIT/y")).toBe("ours\n");
    expect(existsSync(join(t.fork.path, ".patchbook/changes"))).toBe(false);
  });

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

  forkTest("test_hook_still_warns_and_commits_for_another_problem", (t) => {
    const change = join(t.fork.path, ".patchbook/changes/gone");
    mkdirNew(change);
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

  const hookCommit = (t: ForkCase, args: string[], check = true) =>
    sh(["git", "commit", "-q", ...args], { cwd: t.fork.path, check, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
  const committed = (t: ForkCase): string[] => words(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: t.fork.path }).stdout);
  const porcelain = (t: ForkCase): string => sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout;

  const mergeUpstream = (t: ForkCase, ...flags: string[]) => {
    t.up.write("app.txt", replace(t.up.read("app.txt"), "seven", "SEVEN"));
    t.up.commit("upstream shouts seven");
    sh(["git", "fetch", "-q", "upstream"], { cwd: t.fork.path });
    sh(["git", "merge", "-q", "--no-edit", ...flags, "upstream/main"], { cwd: t.fork.path });
  };

  forkTest("test_commit_stops_when_upstream_was_merged_in_directly", (t) => {
    mergeUpstream(t);
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
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

  forkTest("test_commit_stops_on_a_merge_of_upstream_that_is_not_committed_yet", (t) => {
    mergeUpstream(t, "--no-commit", "--no-ff");
    const commit = hookCommit(t, ["-m", "merge upstream"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("upstream shouts seven");
    expect(commit.stderr).toContain("patchbook sync");
    expect(existsSync(join(t.tmp, "prompt.txt"))).toBe(false);
  });

  forkTest("test_build_refuses_when_upstream_was_merged_in_directly", (t) => {
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

  forkTest("test_commit_works_again_once_sync_has_moved_the_pin_past_a_merged_upstream", (t) => {
    mergeUpstream(t);
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    expect(hookCommit(t, ["-m", "shout"], false).code).not.toBe(0);
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook/upstream.lock"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout"]);
    expect(committed(t)).toContain(".patchbook/changes/shout/CHANGE.md");
    expect(t.fork.read("app.txt")).toContain("TWO");
    expect(t.fork.read("app.txt")).toContain("SEVEN");
  });

  forkTest("test_build_refuses_without_installing_the_hook", (t) => {
    mergeUpstream(t);
    rmSync(join(t.fork.path, ".git/hooks/pre-commit"));
    t.pb(["build"], { cwd: t.fork.path, code: 1 });
    expect(existsSync(join(t.fork.path, ".git/hooks/pre-commit"))).toBe(false);
  });

  forkTest("test_commit_and_build_still_work_after_sync_pins_an_older_upstream_commit", (t) => {
    const start = sh(["git", "rev-parse", "HEAD"], { cwd: t.up.path }).stdout.trim();
    t.up.write("app.txt", replace(t.up.read("app.txt"), "seven", "SEVEN"));
    t.up.commit("upstream shouts seven");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build", "--force", "--commit"], { cwd: t.fork.path });
    t.pb(["sync", "upstream", start], { cwd: t.fork.path });
    t.pb(["build", "--force"], { cwd: t.fork.path });
    expect(t.fork.read("app.txt")).toContain("seven");
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout"]);
    expect(committed(t)).toContain(".patchbook/changes/shout/CHANGE.md");
  });

  forkTest("test_commit_works_after_a_merged_upstream_commit_that_changes_nothing", (t) => {
    sh(["git", "commit", "-q", "--allow-empty", "-m", "an empty commit upstream"], { cwd: t.up.path });
    sh(["git", "fetch", "-q", "upstream"], { cwd: t.fork.path });
    sh(["git", "merge", "-q", "--no-edit", "upstream/main"], { cwd: t.fork.path });
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout"]);
    expect(committed(t)).toContain(".patchbook/changes/shout/CHANGE.md");
  });

  forkTest("test_commit_leaves_out_an_untracked_file", (t) => {
    t.fork.write("notes.txt", "scratch\n");
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "only app.txt"]);
    const files = committed(t);
    expect(files).toContain("app.txt");
    expect(files).toContain(".patchbook/changes/shout/CHANGE.md");
    expect(files.filter((f) => f.includes("notes.txt"))).toEqual([]);
    expect(read(join(t.fork.path, ".patchbook/changes/shout/CHANGE.md"))).not.toContain("notes.txt");
    expect(porcelain(t)).toBe("?? notes.txt\n");
  });

  forkTest("test_commit_records_only_the_staged_part_of_a_file", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    const staged = t.fork.read("app.txt");
    t.fork.write("app.txt", replace(staged, "three", "THREE"));
    const unstaged = t.fork.read("app.txt");
    hookCommit(t, ["-m", "shout two"]);
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toBe(staged);
    const shown = t.pb(["show", "shout"], { cwd: t.fork.path }).stdout;
    expect(shown).toContain("+TWO");
    expect(shown).not.toContain("THREE");
    expect(t.fork.read("app.txt")).toBe(unstaged);
    expect(porcelain(t)).toBe(" M app.txt\n");
  });

  forkTest("test_partial_commit_records_only_the_paths_it_names", (t) => {
    t.fork.write("staged.txt", "staged\n");
    sh(["git", "add", "staged.txt"], { cwd: t.fork.path });
    t.fork.write("notes.txt", "scratch\n");
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    hookCommit(t, ["-m", "only app.txt", "app.txt"]);
    const files = committed(t);
    expect(files).toContain("app.txt");
    expect(files).toContain(".patchbook/changes/shout/CHANGE.md");
    expect(files.filter((f) => f.includes("staged.txt") || f.includes("notes.txt"))).toEqual([]);
    expect(porcelain(t)).toBe("A  staged.txt\n?? notes.txt\n");
  });

  forkTest("test_commit_refuses_to_build_over_unstaged_edits", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    hookCommit(t, ["-am", "shout"]);
    const ours = join(t.fork.path, ".patchbook/changes/shout/ours/app.txt.pb");
    writeFileSync(ours, replace(read(ours), "TWO", "Two"));
    sh(["git", "add", ours], { cwd: t.fork.path });
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "three", "THREE"));
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

  forkTest("test_commit_after_record_takes_what_was_recorded", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    t.fork.write("new.txt", "hello\n");
    t.pb(["record", "loud", "--intent", "Shout the second line and add new.txt."], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "loud"]);
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("TWO");
    expect(sh(["git", "show", "HEAD:new.txt"], { cwd: t.fork.path }).stdout).toBe("hello\n");
    expect(read(join(t.fork.path, ".patchbook/changes/loud/CHANGE.md"))).toContain("- add new.txt");
    expect(porcelain(t)).toBe("");
  });

  forkTest("test_commit_after_build_takes_the_built_output", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    hookCommit(t, ["-am", "shout"]);
    const ours = join(t.fork.path, ".patchbook/changes/shout/ours/app.txt.pb");
    writeFileSync(ours, replace(read(ours), "TWO", "Two"));
    t.pb(["build"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "soften"]);
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("Two");
    expect(read(ours)).toContain("Two");
    expect(porcelain(t)).toBe("");
  });

  forkTest("test_commit_refuses_patchbook_edits_it_does_not_take", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    hookCommit(t, ["-am", "shout"]);
    const ours = join(t.fork.path, ".patchbook/changes/shout/ours/app.txt.pb");
    writeFileSync(ours, replace(read(ours), "TWO", "Two"));
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

  forkTest("test_commit_builds_over_a_file_git_converts_on_checkout", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    hookCommit(t, ["-am", "shout"]);
    writeFileSync(join(t.fork.path, ".git/info/attributes"), "*.txt text eol=crlf\n");
    t.fork.rm("app.txt");
    sh(["git", "checkout", "--", "app.txt"], { cwd: t.fork.path });
    expect(t.fork.read("app.txt")).toContain("TWO\r\n");
    const ours = join(t.fork.path, ".patchbook/changes/shout/ours/app.txt.pb");
    writeFileSync(ours, replace(read(ours), "TWO", "Two"));
    sh(["git", "add", ours], { cwd: t.fork.path });
    hookCommit(t, ["-m", "soften"]);
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("Two");
  });

  const renameToIgnoredLocalCfg = (t: ForkCase) => {
    t.fork.write("extra.txt", "ours\n");
    sh(["git", "add", "extra.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "extra"]);
    const change = join(t.fork.path, ".patchbook/changes/shout");
    writeFileSync(join(change, "CHANGE.md"), replace(read(join(change, "CHANGE.md")), "- add extra.txt", "- add local.cfg"));
    sh(["git", "mv", join(change, "ours/extra.txt.pb"), join(change, "ours/local.cfg.pb")], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    writeFileSync(join(t.fork.path, ".git/info/exclude"), "local.cfg\n");
  };

  forkTest("test_commit_keeps_an_ignored_file_the_build_would_overwrite", (t) => {
    renameToIgnoredLocalCfg(t);
    t.fork.write("local.cfg", "mine\n");
    expect(hookCommit(t, ["-m", "rename"], false).code).toBe(0);
    expect(committed(t)).toContain("extra.txt");
    expect(t.fork.read("local.cfg")).toBe("mine\n");
    expect(porcelain(t)).toBe("");
  });

  forkTest("test_commit_writes_ignored_output_to_disk_and_leaves_it_out", (t) => {
    renameToIgnoredLocalCfg(t);
    expect(hookCommit(t, ["-m", "rename"]).stderr).not.toContain("local.cfg");
    expect(t.fork.read("local.cfg")).toBe("ours\n");
    expect(sh(["git", "ls-files", "local.cfg"], { cwd: t.fork.path }).stdout).toBe("");
    expect(porcelain(t)).toBe("");
  });

  forkTest("test_commit_leaves_out_an_intent_to_add_file", (t) => {
    t.fork.write("notes.txt", "scratch\n");
    sh(["git", "add", "-N", "notes.txt"], { cwd: t.fork.path });
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "only app.txt"]);
    expect(committed(t).filter((f) => f.includes("notes.txt"))).toEqual([]);
    expect(read(join(t.fork.path, ".patchbook/changes/shout/CHANGE.md"))).not.toContain("notes.txt");
    expect(porcelain(t)).toBe(" A notes.txt\n");
  });

  forkTest("test_commit_stages_a_built_path_literally", (t) => {
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

  forkTest("test_partial_commit_on_its_own_index_says_how_to_keep_the_record", (t) => {
    const index = join(t.tmp, "index");
    writeFileSync(index, readFileSync(join(t.fork.path, ".git/index")));
    const env = { ...t.env, GIT_INDEX_FILE: index };
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
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
    t.up.write("app.txt", replace(t.up.read("app.txt"), "two", "two v1"));
    t.up.commit("v1");
    syncAndBuild(t);
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    t.up.write("app.txt", replace(t.up.read("app.txt"), "two v1", "two v2"));
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

  forkTest("test_commit_stops_on_an_older_build_left_in_the_index_and_takes_the_newer_once_added", (t) => {
    stageAnOlderBuild(t);
    stopsOnAnOlderBuild(t, "app.txt");
    sh("git --literal-pathspecs add -- app.txt".split(" "), { cwd: t.fork.path });
    expect(hookCommit(t, ["-m", "take upstream"]).stderr).not.toContain("app.txt");
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("two v2");
    expect(t.fork.read("app.txt")).toContain("two v2");
    expect(porcelain(t)).toBe("");
  });

  forkTest("test_commit_stops_on_an_older_build_left_in_the_index_and_records_it_once_checked_out", (t) => {
    stageAnOlderBuild(t);
    stopsOnAnOlderBuild(t, "app.txt");
    sh("git --literal-pathspecs checkout -- app.txt".split(" "), { cwd: t.fork.path });
    expect(hookCommit(t, ["-m", "take upstream"]).stderr).toContain("file     app.txt");
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("two v1");
    expect(t.fork.read("app.txt")).toContain("two v1");
    expect(porcelain(t)).toBe("");
  });

  forkTest("test_commit_records_a_staged_edit_the_working_copy_put_back", (t) => {
    const built = t.fork.read("app.txt");
    t.fork.write("app.txt", replace(built, "two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    t.fork.write("app.txt", built);
    expect(hookCommit(t, ["-m", "shout"]).stderr).toContain("file     app.txt");
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("TWO");
    expect(porcelain(t)).toBe("");
  });

  forkTest("test_commit_records_a_staged_edit_after_build_force", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
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

  forkTest("test_commit_stops_on_a_file_an_older_build_left_in_the_index_and_drops_it_once_added", (t) => {
    stageAnOlderBuildsFile(t);
    stopsOnAnOlderBuild(t, "extra.txt");
    sh("git --literal-pathspecs add -- extra.txt".split(" "), { cwd: t.fork.path });
    expect(hookCommit(t, ["-m", "take upstream"]).stderr).not.toContain("extra.txt");
    expect(sh(["git", "ls-files", "extra.txt"], { cwd: t.fork.path }).stdout).toBe("");
    expect(existsSync(join(t.fork.path, "extra.txt"))).toBe(false);
    expect(porcelain(t)).toBe("");
    t.pb(["build"], { cwd: t.fork.path });
  });

  forkTest("test_commit_stops_on_a_file_an_older_build_left_in_the_index_and_records_it_once_checked_out", (t) => {
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
    const text = replace(read(entries), "rules: \nintent: \n", "rules: t3\nintent: Speak T3.\n");
    writeFileSync(entries, partitionHead(text, "--- patched\n") + "--- patched\n{{snippet:greet}}\n");
    t.pb(["build"], { cwd: t.fork.path });
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "greet from strings.md"]);
    expect(t.fork.read("greet.txt")).toBe("hello\n");
    expect(porcelain(t)).toBe("");
  };

  forkTest("test_commit_stops_on_an_unstaged_edit_to_a_placeholder_file_in_the_output", (t) => {
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

  forkTest("test_commit_stops_on_a_staged_placeholder_file_in_the_output_the_working_copy_put_back", (t) => {
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

  forkTest("test_commit_takes_a_placeholder_file_in_the_output_that_the_build_changed", (t) => {
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

  forkTest("test_commit_without_file_modes_builds_a_program_from_upstream_once", (t) => {
    sh(["git", "config", "core.fileMode", "false"], { cwd: t.fork.path });
    t.up.write("new.sh", "echo up\n", 0o755);
    t.up.commit("add new.sh");
    syncAndBuild(t);
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "take upstream"]);
    expect(committed(t)).toContain("new.sh");
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    const later = hookCommit(t, ["-m", "shout"]);
    expect(later.stderr).not.toContain("built from");
    expect(committed(t)).not.toContain("new.sh");
  });

  forkTest("test_commit_without_file_modes_records_an_edit_to_a_program_from_upstream", (t) => {
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

  forkTest("test_commit_after_sync_leaves_the_sync_report_untracked", (t) => {
    t.up.write("app.txt", replace(t.up.read("app.txt"), "one", "ONE"));
    t.up.commit("move");
    t.pb(["sync"], { cwd: t.fork.path });
    hookCommit(t, ["-am", "Sync upstream"]);
    expect(committed(t)).toContain(".patchbook/upstream.lock");
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("ONE");
    expect(porcelain(t)).toBe("?? .patchbook/last-sync.json\n");
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout"]);
    expect(committed(t)).toContain(".patchbook/changes/shout/CHANGE.md");
    expect(porcelain(t)).toBe("?? .patchbook/last-sync.json\n");
  });

  forkTest("test_commit_leaves_out_an_untracked_file_in_the_patchbook_folder", (t) => {
    writeFileSync(join(t.fork.path, ".patchbook/scratch.txt"), "my note\n");
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout"]);
    expect(committed(t)).toContain(".patchbook/changes/shout/CHANGE.md");
    expect(committed(t)).not.toContain(".patchbook/scratch.txt");
    expect(porcelain(t)).toBe("?? .patchbook/scratch.txt\n");
  });

  forkTest("test_build_commit_leaves_out_an_untracked_file_in_the_patchbook_folder", (t) => {
    writeFileSync(join(t.fork.path, ".patchbook/notes.md"), "v1\n");
    t.fork.commit("notes");
    writeFileSync(join(t.fork.path, ".patchbook/notes.md"), "v2\n");
    writeFileSync(join(t.fork.path, ".patchbook/scratch.txt"), "my note\n");
    t.up.write("app.txt", replace(t.up.read("app.txt"), "two", "deux"));
    t.up.commit("move");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build", "--commit"], { cwd: t.fork.path });
    for (const p of [".patchbook/build.lock", ".patchbook/notes.md", ".patchbook/upstream.lock"]) expect(committed(t)).toContain(p);
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("deux");
    expect(committed(t)).not.toContain(".patchbook/scratch.txt");
    expect(porcelain(t)).toBe("?? .patchbook/last-sync.json\n?? .patchbook/scratch.txt\n");
  });

  forkTest("test_partial_commit_says_the_patchbook_changes_are_not_in_it", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    t.pb(["record", "loud", "--intent", "Shout the second line."], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    const commit = hookCommit(t, ["-m", "only app.txt", "app.txt"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("the patchbook has changes that aren't in this commit:\n  .patchbook/build.lock");
    expect(commit.stderr).not.toContain("haven't staged");
  });

  forkTest("test_commit_keeps_a_staged_new_file_deleted_from_the_working_tree", (t) => {
    t.fork.write("new.txt", "new\n");
    sh(["git", "add", "new.txt"], { cwd: t.fork.path });
    t.fork.rm("new.txt");
    hookCommit(t, ["-m", "add new.txt"]);
    expect(committed(t)).toContain("new.txt");
    expect(sh(["git", "show", "HEAD:new.txt"], { cwd: t.fork.path }).stdout).toBe("new\n");
  });

  forkTest("test_commit_over_an_unstaged_edit_advises_a_stash_that_keeps_the_build", (t) => {
    t.up.write("app.txt", replace(t.up.read("app.txt"), "one", "ONE"));
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

  forkTest("test_commit_over_an_unstaged_edit_beside_an_intent_to_add_entry_advises_untracking_it_first", (t) => {
    t.up.write("app.txt", replace(t.up.read("app.txt"), "one", "ONE"));
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

  forkTest("test_commit_refuses_to_build_over_an_unstaged_edit_to_a_name_with_a_leading_space", (t) => {
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

  forkTest("test_commit_stages_records_the_repo_ignores", (t) => {
    writeFileSync(join(t.fork.path, ".git/info/exclude"), "*.pb\n");
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout"]);
    expect(committed(t)).toContain(".patchbook/changes/shout/ours/app.txt.pb");
    expect(committed(t)).toContain(".patchbook/changes/shout/base/app.txt.pb");
  });

  forkTest("test_commit_builds_over_an_unstaged_mode_change", (t) => {
    t.up.write("app.txt", replace(t.up.read("app.txt"), "two", "two v1"));
    t.up.commit("v1");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    chmodSync(join(t.fork.path, "app.txt"), 0o755);
    hookCommit(t, ["-m", "v1"]);
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("two v1");
    expect(headMode(t, "app.txt")).toBe("100644");
  });

  forkTest("test_commit_stops_on_a_file_removed_from_the_index_but_kept_on_disk", (t) => {
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

  forkTest("test_commit_deletes_an_output_file_before_any_build_lock", (t) => {
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

  forkTest("test_commit_unadds_a_file_a_change_added_after_git_rm", (t) => {
    t.fork.write("extra.txt", "extra\n");
    sh(["git", "add", "extra.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "add extra.txt"]);
    sh(["git", "rm", "-q", "extra.txt"], { cwd: t.fork.path });
    expect(hookCommit(t, ["-m", "drop extra.txt"]).stderr).toContain("unadd    extra.txt");
    expect(lastCommit(t)).toBe("drop extra.txt\n");
    expect(inHead(t, "extra.txt")).toBe("");
    expect(porcelain(t)).toBe("");
  });

  forkTest("test_commit_all_unadds_a_recorded_symlink_deleted_from_disk", (t) => {
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

  forkTest("test_commit_records_a_regular_file_over_a_recorded_symlink", (t) => {
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

  forkTest("test_commit_records_a_retargeted_symlink_as_a_symlink", (t) => {
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

  forkTest("test_commit_refuses_an_upstream_link_replaced_by_a_regular_file", (t) => {
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

  forkTest("test_record_refuses_an_upstream_link_replaced_by_a_regular_file", (t) => {
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

  forkTest("test_commit_records_a_retargeted_upstream_link_as_a_link", (t) => {
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
    forkTest(`test_record_with_file_modes_${fileMode}_records_an_executable_file_over_a_recorded_symlink_as_a_regular_file`, (t) => {
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

  forkTest("test_hook_install_without_file_modes_keeps_the_exec_bit_of_a_script_we_added", (t) => {
    sh(["git", "config", "core.fileMode", "false"], { cwd: t.fork.path });
    t.fork.write(".husky/pre-commit", "npm test\n", 0o755);
    sh(["git", "add", ".husky/pre-commit"], { cwd: t.fork.path });
    sh(["git", "update-index", "--chmod=+x", ".husky/pre-commit"], { cwd: t.fork.path });
    sh(["git", "commit", "-q", "-m", "add husky script"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Add the pre-commit script." } });
    expect(modeInHead(t, ".husky/pre-commit")).toBe("100755");
    const pb = join(t.fork.path, ".patchbook/changes/add-the-pre-commit/ours/.husky/pre-commit.pb");
    expect(isExecutable(pb)).toBe(true);
    chmodSync(join(t.fork.path, ".husky/pre-commit"), 0o644);
    writeFileSync(join(t.fork.path, ".husky/pre-commit"), "npm test --run\n");
    installManager(t.fork, ".husky");
    t.pb(["hook", "install"], { cwd: t.fork.path });
    expect(read(pb)).toContain("npm test --run");
    expect(isExecutable(pb)).toBe(true);
    expect(sh(["git", "ls-files", "-s", ".husky/pre-commit"], { cwd: t.fork.path }).stdout.split(" ")[0]).toBe("100755");
  });

  forkTest("test_commit_deletes_an_upstream_file_and_folder_after_git_rm", (t) => {
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
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout"]);
    upstream();
    t.up.commit("move app.txt");
    t.pb(["sync"], { cwd: t.fork.path });
  };

  forkTest("test_commit_drops_the_file_of_a_change_retired_after_upstream_deleted_it", (t) => {
    shoutThenSync(t, () => t.up.rm("app.txt"));
    const pb = join(t.fork.path, ".patchbook");
    writeFileSync(join(pb, "series"), replace(read(join(pb, "series")), "shout\n", ""));
    rmSync(join(pb, "changes/shout"), { recursive: true });
    writeFileSync(join(pb, "retired.md"), read(join(pb, "retired.md")) + "\n- shout: upstream deleted app.txt\n");
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "retire shout"]);
    expect(inHead(t, "app.txt")).toBe("");
    expect(porcelain(t)).toBe("");
    t.pb(["build"], { cwd: t.fork.path });
    expect(porcelain(t)).toBe("");
  });

  forkTest("test_commit_drops_the_old_name_of_a_file_a_change_follows_across_an_upstream_rename", (t) => {
    shoutThenSync(t, () => sh(["git", "mv", "app.txt", "renamed.txt"], { cwd: t.up.path }));
    const change = join(t.fork.path, ".patchbook/changes/shout");
    for (const copy of ["base", "ours"]) renameSync(join(change, copy, "app.txt.pb"), join(change, copy, "renamed.txt.pb"));
    writeFileSync(join(change, "CHANGE.md"), replace(read(join(change, "CHANGE.md")), "app.txt", "renamed.txt"));
    sh(["git", "add", "-A"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "repair shout"]);
    expect(inHead(t, "app.txt")).toBe("");
    expect(sh(["git", "show", "HEAD:renamed.txt"], { cwd: t.fork.path }).stdout).toContain("TWO");
    expect(porcelain(t)).toBe("");
    t.pb(["build"], { cwd: t.fork.path });
    expect(porcelain(t)).toBe("");
  });

  const headMode = (t: ForkCase, path: string): string => sh(["git", "ls-tree", "HEAD", path], { cwd: t.fork.path }).stdout.split(" ")[0]!;

  forkTest("test_commit_takes_a_staged_mode_change_and_later_commits_leave_it", (t) => {
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

  forkTest("test_commit_records_an_edit_staged_with_a_mode_change", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    chmodSync(join(t.fork.path, "app.txt"), 0o755);
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    const commit = hookCommit(t, ["-m", "shout and run"]);
    expect(commit.stderr).toContain("file     app.txt");
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toContain("TWO");
    expect(headMode(t, "app.txt")).toBe("100755");
  });

  forkTest("test_commit_records_an_edit_staged_with_a_mode_change_under_an_unstaged_edit", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"), 0o755);
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

  forkTest("test_commit_takes_a_mode_change_to_a_file_the_fork_added", (t) => {
    t.fork.write("mine.sh", "echo mine\n", 0o755);
    sh(["git", "add", "mine.sh"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "add mine.sh"]);
    chmodSync(join(t.fork.path, "mine.sh"), 0o644);
    sh(["git", "add", "mine.sh"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "mine.sh is not a program"]);
    expect(headMode(t, "mine.sh")).toBe("100644");
  });

  forkTest("test_commit_writes_the_build_over_a_mode_the_index_already_has", (t) => {
    t.fork.write("mine.sh", "echo mine\n", 0o755);
    sh(["git", "add", "mine.sh"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "add mine.sh"]);
    chmodSync(join(t.fork.path, "mine.sh"), 0o644);
    sh(["git", "add", "mine.sh"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "mine.sh is not a program"]);
    chmodSync(join(t.fork.path, ".patchbook/changes/shout/ours/mine.sh.pb"), 0o644);
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "record that mine.sh is not a program"]);
    expect(isExecutable(join(t.fork.path, "mine.sh"))).toBe(false);
    expect(porcelain(t)).toBe("");
  });

  forkTest("test_commit_records_a_staged_file_where_upstream_adds_a_program", (t) => {
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

  forkTest("test_commit_refuses_to_build_over_an_intent_to_add_file", (t) => {
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

  forkTest("test_commit_leaves_out_ignored_output_that_build_commit_left_out", (t) => {
    writeFileSync(join(t.fork.path, ".git/info/exclude"), "*.log\n");
    t.up.write("keep.log", "kept\n");
    t.up.commit("a log");
    t.pb(["sync"], { cwd: t.fork.path });
    t.pb(["build", "--commit"], { cwd: t.fork.path });
    for (const [line, shout] of [["two", "TWO"], ["three", "THREE"]] as const) {
      t.fork.write("app.txt", replace(t.fork.read("app.txt"), line, shout));
      sh(["git", "add", "app.txt"], { cwd: t.fork.path });
      expect(hookCommit(t, ["-m", `shout ${line}`]).stderr).not.toContain("keep.log");
      expect(committed(t)).not.toContain("keep.log");
      expect(t.fork.read("keep.log")).toBe("kept\n");
    }
    expect(sh(["git", "ls-files", "keep.log"], { cwd: t.fork.path }).stdout).toBe("");
    expect(porcelain(t)).toBe("?? .patchbook/last-sync.json\n");
  });

  forkTest("test_commit_takes_a_mode_change_from_upstream", (t) => {
    t.up.write("app.txt", t.up.read("app.txt"), 0o755);
    t.up.commit("make app.txt executable");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "take upstream"]);
    expect(sh(["git", "ls-files", "-s", "app.txt"], { cwd: t.fork.path }).stdout).toStartWith("100755 ");
    expect(porcelain(t)).toBe("");
  });

  // Root ignores file modes, so a read-only build.lock cannot make the hook fail.
  const readOnlyTest = process.getuid?.() === 0 ? (name: string, _: unknown) => test.skip(name, () => {}) : forkTest;
  const lockOf = (t: ForkCase) => join(t.fork.path, ".patchbook/build.lock");

  readOnlyTest("test_failed_commit_leaves_the_patchbook_as_it_found_it", (t) => {
    const series = read(join(t.fork.path, ".patchbook/series"));
    const lock = read(lockOf(t));
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
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
  });

  readOnlyTest("test_commit_retried_after_a_failed_record_holds_the_output_and_its_record", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
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
  });

  readOnlyTest("test_failed_commit_leaves_the_output_as_it_found_it", (t) => {
    t.up.write("app.txt", replace(t.up.read("app.txt"), "five", "FIVE"));
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
  });

  /** Replaces `.patchbook/<name>` with a committed link to a copy outside the repo, and returns what the copy holds. */
  const linkPatchbook = (t: ForkCase, name: string) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "one", "ONE"));
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
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    return hookCommit(t, ["-m", "shout"], false);
  };

  for (const name of ["blocks", "changes", "series", "build.lock"]) {
    forkTest(`test_commit_refuses_a_patchbook_${name}_that_is_a_link`, (t) => {
      const { held, before } = linkPatchbook(t, name);
      const commit = shoutTwo(t);
      expect(commit.code).not.toBe(0);
      expect(commit.stderr).toContain(`.patchbook/${name} is a link`);
      expect(commit.stderr).toContain("PATCHBOOK_HOOK=0");
      expect(held()).toBe(before);
      expect(porcelain(t)).toBe("M  app.txt\n");
    });
  }

  for (const [what, path] of [["change_folder", "changes/shout"], ["CHANGE_md", "changes/shout/CHANGE.md"], ["side_folder", "changes/shout/ours"]] as const) {
    forkTest(`test_commit_refuses_a_${what}_that_is_a_link`, (t) => {
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
    forkTest(`test_commit_goes_through_a_patchbook_${name.replace(".", "_")}_that_is_a_link`, (t) => {
      const { held, before } = linkPatchbook(t, name);
      expect(shoutTwo(t).code).toBe(0);
      expect(committed(t)).toContain("app.txt");
      expect(held()).toBe(before);
      expect(porcelain(t)).toBe("");
    });
  }

  /** Commits the `shout` change, then plants `link` in its `ours` copy, pointing at `outside` (made here, holding `keep.txt`). */
  const plantInShout = (t: ForkCase, link: string, file: boolean) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "one", "ONE"));
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

  forkTest("test_commit_refuses_a_recorded_folder_link_named_like_a_copy", (t) => {
    const outside = plantInShout(t, "d.pb", false);
    t.fork.write("d.pb/x", "payload\n");
    sh(["git", "add", "d.pb/x"], { cwd: t.fork.path });
    const commit = hookCommit(t, ["-m", "add d.pb/x"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain(".patchbook/changes/shout/ours/d.pb is a link");
    expect(readdirSync(outside)).toEqual(["keep.txt"]);
    expect(porcelain(t)).toBe("A  d.pb/x\n");
  });

  forkTest("test_commit_refuses_a_folder_link_above_a_copy", (t) => {
    const outside = plantInShout(t, "sub", false);
    t.fork.write("sub/x", "payload\n");
    sh(["git", "add", "sub/x"], { cwd: t.fork.path });
    const commit = hookCommit(t, ["-m", "add sub/x"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain(".patchbook/changes/shout/ours/sub is a link");
    expect(readdirSync(outside)).toEqual(["keep.txt"]);
  });

  forkTest("test_commit_replaces_a_recorded_symlink_without_changing_its_target", (t) => {
    const outside = plantInShout(t, "note.txt.pb", true);
    t.fork.write("note.txt", "payload\n");
    sh(["git", "add", "note.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "add note.txt"]);
    expect(read(outside)).toBe("keep\n");
    expect(committed(t)).toContain("note.txt");
    expect(porcelain(t)).toBe("");
  });

  forkTest("test_commit_refuses_a_link_inside_blocks", (t) => {
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

  readOnlyTest("test_failed_commit_puts_a_private_copy_back_with_its_own_mode_when_its_bytes_did_not_change", (t) => {
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "one", "ONE"));
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
  });

  for (const [where, target] of [["into the patchbook", ".patchbook"], ["to a folder beside it", "docs.bak"]] as const) {
    forkTest(`test_commit_refuses_an_output_folder_replaced_by_a_link_${where.replaceAll(" ", "_")}`, (t) => {
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

  forkTest("test_commit_all_refuses_an_output_folder_replaced_by_a_link", (t) => {
    renameSync(join(t.fork.path, "docs"), join(t.fork.path, "docs.bak"));
    symlinkSync("docs.bak", join(t.fork.path, "docs"));
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "one", "ONE"));
    const before = tree(t.fork.path);
    const commit = hookCommit(t, ["-am", "link docs"], false);
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("docs is a link");
    expect(commit.stderr).not.toContain("fatal");
    expect(tree(t.fork.path)).toEqual(before);
  });

  forkTest("test_commit_ignores_an_output_folder_replaced_by_a_link_that_is_not_staged", (t) => {
    renameSync(join(t.fork.path, "docs"), join(t.fork.path, "docs.bak"));
    symlinkSync("docs.bak", join(t.fork.path, "docs"));
    hookCommit(t, ["--allow-empty", "-m", "nothing staged"]);
    expect(inHead(t, "docs")).toBe("docs/guide.md\n");
  });

  readOnlyTest("test_failed_commit_reports_nothing_stuck_after_putting_back_nested_new_folders", (t) => {
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
  });

  readOnlyTest("test_commit_goes_through_when_a_folder_in_the_patchbook_cant_be_read", (t) => {
    writeFileSync(join(t.fork.path, ".git/info/exclude"), "*.junk\n");
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    hookCommit(t, ["-m", "shout"]);
    const secret = join(t.fork.path, ".patchbook/changes/shout/secret");
    mkdirSync(secret);
    writeFileSync(join(secret, "s.junk"), "x\n");
    chmodSync(secret, 0o000);
    try {
      t.fork.write("app.txt", replace(t.fork.read("app.txt"), "three", "THREE"));
      sh(["git", "add", "app.txt"], { cwd: t.fork.path });
      hookCommit(t, ["-m", "shout again"]);
      expect(committed(t)).toContain("app.txt");
    } finally {
      chmodSync(secret, 0o755);
    }
  });

  readOnlyTest("test_failed_commit_puts_a_private_file_back_with_its_own_mode", (t) => {
    const series = join(t.fork.path, ".patchbook/series");
    chmodSync(series, 0o600);
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
    sh(["git", "add", "app.txt"], { cwd: t.fork.path });
    chmodSync(lockOf(t), 0o444);
    expect(hookCommit(t, ["-m", "shout"], false).code).not.toBe(0);
    expect(statSync(series).mode & 0o777).toBe(0o600);
  });

  readOnlyTest("test_failed_commit_lists_what_it_could_not_put_back", (t) => {
    const patchbook = join(t.fork.path, ".patchbook");
    t.fork.write("app.txt", replace(t.fork.read("app.txt"), "two", "TWO"));
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
  });

  readOnlyTest("test_failed_commit_puts_a_private_folder_back_with_its_own_mode", (t) => {
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
  });

  readOnlyTest("test_failed_commit_puts_back_the_lock_it_rebuilt_when_nothing_was_recorded", (t) => {
    t.up.write("app.txt", replace(t.up.read("app.txt"), "five", "FIVE"));
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
    expect(t.pb(["status", "--json"], { cwd: t.fork.path }).stderr).not.toContain("to run patchbook from PATH");
    expect(read(hook)).toBe(pythonHook());
    expect(t.pb(["build"], { cwd: t.fork.path }).stderr).toContain("to run patchbook from PATH");
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

  forkTest("test_another_hooks_path_gets_the_lines_to_add", (t) => {
    sh(["git", "config", "core.hooksPath", ".githooks"], { cwd: t.fork.path });
    const install = t.pb(["hook", "install"], { cwd: t.fork.path }).stderr;
    expect(install).toContain(".githooks/pre-commit");
    expect(install).toContain("patchbook hook run");
    expect(existsSync(join(t.fork.path, ".githooks"))).toBe(false);
    Object.assign(t.env, { PATCHBOOK_HOOK: "1" });
    expect(t.pb(["status"], { cwd: t.fork.path }).stderr).toContain(".githooks/pre-commit");
    t.fork.write(".githooks/pre-commit", "patchbook hook run || exit 1\n", 0o755);
    expect(t.pb(["status"], { cwd: t.fork.path }).stderr).not.toContain(".githooks/pre-commit");
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

  forkTest("test_config_writes_the_user_config_and_leaves_a_missing_hook_alone_in_a_clone", (t) => {
    sh(["git", "clone", "-q", t.fork.path, "teammate"], { cwd: t.tmp });
    const teammate = new Repo(join(t.tmp, "teammate"));
    const hook = join(teammate.path, ".git/hooks/pre-commit");
    expect(existsSync(hook)).toBe(false);
    const out = t.pb(["config", "intent.model", "fake-x"], { cwd: teammate.path });
    expect(out.stdout).toContain("intent.model");
    expect(out.stderr).not.toContain("pre-commit hook");
    expect(existsSync(hook)).toBe(false);
  });

  forkTest("test_config_writes_the_user_config_in_a_book_outside_a_git_repo", (t) => {
    const user = join(t.tmp, "config/patchbook/config.toml");
    const loose = join(t.tmp, "loose");
    mkdirSync(join(loose, ".patchbook"), { recursive: true });
    writeFileSync(join(loose, ".patchbook/config.toml"), read(join(t.fork.path, ".patchbook/config.toml")));
    const out = t.pb(["config", "intent.model", "fake-x"], { cwd: loose });
    expect(out.stderr).not.toContain("pre-commit hook");
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

  const twoMovedUpstreams = (t: ForkCase): { lib: Repo; away: string } => {
    const lib = new Repo(join(t.tmp, "lib"));
    lib.write("src/lib.txt", "v1\n");
    lib.commit("lib");
    t.pb(["track", "lib", lib.path, "--path", "src"], { cwd: t.fork.path });
    t.up.write("app.txt", replace(t.up.read("app.txt"), "six", "SIX"));
    t.up.commit("upstream edit");
    lib.write("src/lib.txt", "v2\n");
    lib.commit("lib v2");
    return { lib, away: join(t.tmp, "lib.away") };
  };
  type Report = { from: string; to: string; upstream: string[] };
  const lastSync = (t: ForkCase): { upstream: Report; lib?: Report } =>
    JSON.parse(read(join(t.fork.path, ".patchbook/last-sync.json"))).upstreams;

  const dropLibFromConfig = (t: ForkCase): void => {
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replace(/\n\[\[upstream\]\]\nname = "lib"[\s\S]*$/, "\n"));
  };

  forkTest("test_sync_keeps_the_report_of_an_upstream_when_a_later_one_fails", (t) => {
    const { lib, away } = twoMovedUpstreams(t);
    const before = JSON.parse(t.fork.read(".patchbook/upstream.lock")).upstream.commit;
    renameSync(lib.path, away);
    t.pb(["sync"], { cwd: t.fork.path, code: 1 });
    const pin = JSON.parse(t.fork.read(".patchbook/upstream.lock")).upstream.commit;
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

  forkTest("test_sync_of_one_upstream_keeps_the_report_of_another", (t) => {
    const { lib } = twoMovedUpstreams(t);
    t.pb(["sync", "upstream"], { cwd: t.fork.path });
    const first = lastSync(t).upstream;
    lib.write("src/lib.txt", "v3\n");
    lib.commit("lib v3");
    t.pb(["sync", "lib"], { cwd: t.fork.path });
    expect(Object.keys(lastSync(t))).toEqual(["upstream", "lib"]);
    expect(lastSync(t).upstream).toEqual(first);
  });

  forkTest("test_sync_drops_the_report_of_an_upstream_no_longer_in_the_config", (t) => {
    twoMovedUpstreams(t);
    t.pb(["sync"], { cwd: t.fork.path });
    expect(Object.keys(lastSync(t))).toEqual(["upstream", "lib"]);
    dropLibFromConfig(t);
    t.up.write("app.txt", replace(t.up.read("app.txt"), "five", "FIVE"));
    t.up.commit("another edit");
    t.pb(["sync"], { cwd: t.fork.path });
    expect(Object.keys(lastSync(t))).toEqual(["upstream"]);
  });

  forkTest("test_sync_drops_the_report_of_a_removed_upstream_when_nothing_moved", (t) => {
    twoMovedUpstreams(t);
    t.pb(["sync"], { cwd: t.fork.path });
    expect(Object.keys(lastSync(t))).toEqual(["upstream", "lib"]);
    dropLibFromConfig(t);
    expect(t.pb(["sync"], { cwd: t.fork.path }).stdout).toContain("Nothing to do");
    expect(Object.keys(lastSync(t))).toEqual(["upstream"]);
  });

  if (process.getuid?.() !== 0) {
    forkTest("test_sync_keeps_the_pin_when_the_report_cannot_be_written", (t) => {
      const file = join(t.fork.path, ".patchbook/last-sync.json");
      const lock = (): string => t.fork.read(".patchbook/upstream.lock");
      t.up.write("app.txt", replace(t.up.read("app.txt"), "six", "SIX"));
      t.up.commit("first edit");
      t.pb(["sync"], { cwd: t.fork.path });
      const reported = read(file);
      const pinned = lock();
      t.up.write("app.txt", replace(t.up.read("app.txt"), "five", "FIVE"));
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
    });

    const secondEdits = [
      ["merge", "four", "FOUR", "1 of ours merged cleanly, 0 conflicts", { merged: [{ change: "feature", path: "app.txt" }], conflicts: [] }],
      ["conflict", "two", "TWO_UP", "0 of ours merged cleanly, 1 conflicts", { merged: [], conflicts: [{ change: "feature", path: "app.txt", count: 1 }] }],
    ] as const;
    for (const blocked of ["last-sync.json", "upstream.lock"]) {
      for (const [kind, line, edited, summary, carried] of secondEdits) {
        forkTest(`test_a_sync_that_cannot_write_${blocked}_after_a_${kind}_changes_nothing_and_reports_the_${kind}_when_run_again`, (t) => {
          t.recordFeature();
          t.up.write("app.txt", replace(t.up.read("app.txt"), "six", "SIX"));
          const first = t.up.commit("first edit");
          t.pb(["sync"], { cwd: t.fork.path });
          t.up.write("app.txt", replace(t.up.read("app.txt"), line, edited));
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
        });
      }
    }

    forkTest("test_a_sync_that_cannot_write_upstream.lock_puts_back_a_last_sync_json_that_is_a_link", (t) => {
      t.up.write("app.txt", replace(t.up.read("app.txt"), "six", "SIX"));
      t.up.commit("first edit");
      t.pb(["sync"], { cwd: t.fork.path });
      const report = join(t.fork.path, ".patchbook/last-sync.json");
      const kept = join(t.tmp, "last-sync.json");
      renameSync(report, kept);
      symlinkSync(kept, report);
      const reported = read(kept);
      t.up.write("app.txt", replace(t.up.read("app.txt"), "five", "FIVE"));
      t.up.commit("second edit");
      const lock = join(t.fork.path, ".patchbook/upstream.lock");
      chmodSync(lock, 0o444);
      try {
        t.pb(["sync"], { cwd: t.fork.path, code: 1 });
      } finally {
        chmodSync(lock, 0o644);
      }
      expect(readlinkSync(report)).toBe(kept);
      expect(read(kept)).toBe(reported);
    });
  }

  describe.skipIf(!!process.env["PATCHBOOK_CMD"])("killed by a preload, so only from source", () => {
    const killedBeforeWriting = (t: ForkCase, path: string, args: string[]): void => {
      const env = { ...t.env, CRASH_BEFORE_WRITE: path };
      sh([process.execPath, "--preload", join(import.meta.dir, "crash.ts"), TOOL, ...args], { cwd: t.fork.path, env, check: false });
    };

    forkTest("test_a_sync_of_one_upstream_first_undoes_a_killed_sync_of_another_and_its_report", (t) => {
      const { lib } = twoMovedUpstreams(t);
      t.pb(["sync"], { cwd: t.fork.path });
      const reported = lastSync(t);
      const lock = t.fork.read(".patchbook/upstream.lock");
      t.up.write("app.txt", replace(t.up.read("app.txt"), "five", "FIVE"));
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

    forkTest("test_a_killed_track_cannot_put_back_a_report_that_undoing_another_killed_sync_rolled_back", (t) => {
      twoMovedUpstreams(t);
      t.pb(["sync"], { cwd: t.fork.path });
      const reported = lastSync(t);
      t.up.write("app.txt", replace(t.up.read("app.txt"), "five", "FIVE"));
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

    forkTest("test_undoing_a_killed_first_sync_deletes_the_report_it_wrote", (t) => {
      const report = join(t.fork.path, ".patchbook/last-sync.json");
      const lock = t.fork.read(".patchbook/upstream.lock");
      t.up.write("app.txt", replace(t.up.read("app.txt"), "six", "SIX"));
      t.up.commit("upstream edit");
      expect(existsSync(report)).toBe(false);
      killedBeforeWriting(t, "/.patchbook/sync-upstream/lock", ["sync"]);
      expect(existsSync(report)).toBe(true);
      t.pb(["sync", "upstream", "refs/heads/nope"], { cwd: t.fork.path, code: 1 });
      expect(existsSync(report)).toBe(false);
      expect(t.fork.read(".patchbook/upstream.lock")).toBe(lock);
    });
  });

  forkTest("test_sync_replaces_a_last_sync_file_that_does_not_parse", (t) => {
    writeFileSync(join(t.fork.path, ".patchbook/last-sync.json"), "{ not json");
    t.up.write("app.txt", replace(t.up.read("app.txt"), "six", "SIX"));
    t.up.commit("upstream edit");
    t.pb(["sync"], { cwd: t.fork.path });
    expect(Object.keys(lastSync(t))).toEqual(["upstream"]);
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

  vendorTest("test_build_commit_leaves_out_files_outside_the_build", (t) => {
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

  vendorTest("test_build_commit_takes_the_placeholder_file_so_a_clone_builds", (t) => {
    t.missingScaffoldPatchBuild();
    t.pb(["build", "--commit"], { cwd: t.repo.path });
    const clone = join(t.tmp, "clone");
    sh(["git", "clone", "-q", t.repo.path, clone], { cwd: t.tmp });
    t.pb(["build"], { cwd: clone });
    expect(read(join(clone, "skills/hello/SKILL.md"))).toContain("Say hello in T3.");
    expect(sh(["git", "status", "--porcelain"], { cwd: clone }).stdout).toBe("");
    expect(sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout).toBe("");
  });

  vendorTest("test_build_commit_leaves_out_an_ignored_placeholder_file", (t) => {
    writeFileSync(join(t.repo.path, ".git/info/exclude"), ".patchbook/snippets.md\n");
    t.missingScaffoldPatchBuild();
    t.pb(["build", "--commit"], { cwd: t.repo.path });
    expect(sh(["git", "ls-files", ".patchbook/snippets.md"], { cwd: t.repo.path }).stdout).toBe("");
    expect(sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout).toBe("");
  });

  vendorTest("test_commit_stops_on_a_placeholder_file_left_out_of_it", (t) => {
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

  vendorTest("test_first_commit_after_build_takes_the_output", (t) => {
    t.missingScaffoldPatchBuild();
    sh(["git", "add", ".patchbook"], { cwd: t.repo.path });
    sh(["git", "commit", "-qm", "built"], { cwd: t.repo.path, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(sh(["git", "show", "HEAD:skills/hello/SKILL.md"], { cwd: t.repo.path }).stdout).toContain("Say hello in T3.");
    expect(existsSync(join(t.repo.path, ".patchbook/changes/shout"))).toBe(false);
    expect(sh(["git", "status", "--porcelain"], { cwd: t.repo.path }).stdout).toBe("");
  });

  vendorTest("test_build_commit_with_nothing_in_the_output", (t) => {
    const repo = new Repo(join(t.tmp, "empty"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    t.pb(["init", "--upstream", t.up.path, "--path", "plugin", "--output-from", "nothing", "--output-to", "nothing"], { cwd: repo.path });
    t.pb(["build", "--commit"], { cwd: repo.path });
    expect(words(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: repo.path }).stdout)).toContain(".patchbook/build.lock");
    expect(sh(["git", "status", "--porcelain"], { cwd: repo.path }).stdout).toBe("");
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

  const extraWithAChange = (t: VendorCase, vendored: boolean): Repo => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("a.md", "one\ntwo\nthree\nfour\nfive\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, ...(vendored ? ["--vendor", "vendor/extra"] : [])], { cwd: t.repo.path });
    const change = join(t.repo.path, ".patchbook/changes/tweak");
    mkdirNew(change);
    writeFileSync(join(change, "CHANGE.md"), "# tweak\n\nintent: Shout the first line.\n\nedits:\n- file extra/a.md\n");
    mkdirSync(join(change, "base/extra"), { recursive: true });
    mkdirSync(join(change, "ours/extra"), { recursive: true });
    writeFileSync(join(change, "base/extra/a.md.pb"), "one\ntwo\nthree\nfour\nfive\n");
    writeFileSync(join(change, "ours/extra/a.md.pb"), "ONE\ntwo\nthree\nfour\nfive\n");
    writeFileSync(join(t.repo.path, ".patchbook/series"), "tweak\n");
    t.pb(["build"], { cwd: t.repo.path });
    if (vendored) {
      writeFileSync(join(t.repo.path, ".git/info/exclude"), "scratch\n");
      writeFileSync(join(t.repo.path, "vendor/extra/scratch"), "ignored, and only here\n");
    }
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

  const failedSyncs: [string, (t: VendorCase, extra: Repo) => void][] = [
    ["the_repos_gitignore_hides_an_upstream_file", (t, extra) => {
      t.repo.write(".gitignore", "*.log\n");
      extra.write("c.log", "hidden\n");
      extra.commit("v2");
    }],
    ["upstreams_own_gitignore_hides_one_of_its_files", (_, extra) => {
      extra.write(".gitignore", "*.log\n");
      extra.write("x.log", "kept\n");
      sh(["git", "add", "-f", "x.log"], { cwd: extra.path });
      extra.commit("v2");
    }],
    ["a_file_name_is_too_long_to_write", (_, extra) => {
      const blob = sh(["git", "hash-object", "-w", "a.md"], { cwd: extra.path }).stdout.trim();
      sh(["git", "add", "a.md"], { cwd: extra.path });
      sh(["git", "update-index", "--add", "--cacheinfo", `100644,${blob},z${"x".repeat(300)}`], { cwd: extra.path });
      sh(["git", "commit", "-qm", "v2"], { cwd: extra.path });
    }],
  ];
  for (const [why, move] of failedSyncs) {
    vendorTest(`test_a_failed_sync_leaves_the_vendored_copy_and_the_changes_as_they_were_when_${why}`, (t) => {
      const extra = extraWithAChange(t, true);
      move(t, extra);
      const before = tree(t.repo.path);
      t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
      expect(tree(t.repo.path)).toEqual(before);
      expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
    });
  }

  vendorTest("test_a_failed_sync_to_a_new_upstream_path_at_the_same_commit_leaves_the_vendored_copy_as_it_was", (t) => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("x/a.md", "x\n");
    extra.write("y/a.md", "y\n");
    extra.write("y/c.log", "hidden\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--path", "x", "--vendor", "vendor/extra"], { cwd: t.repo.path });
    writeFileSync(join(t.repo.path, ".git/info/exclude"), "scratch\n");
    t.repo.write("vendor/extra/scratch", "ignored, and only here\n");
    t.repo.write(".patchbook/config.toml", t.repo.read(".patchbook/config.toml").replace('path = "x"', 'path = "y"'));
    t.repo.write(".gitignore", "*.log\n");
    const before = tree(t.repo.path);
    t.pb(["sync", "extra"], { cwd: t.repo.path, code: 1 });
    expect(tree(t.repo.path)).toEqual(before);
  });

  describe.skipIf(process.getuid?.() === 0)("where chmod blocks writes, so not as root", () => {
    for (const [what, blocked] of [["a_change_file", ".patchbook/changes/tweak/base"], ["the_lock", ".patchbook/upstream.lock"]] as const) {
      for (const layout of ["folder", "vendored"]) {
        vendorTest(`test_a_failed_sync_leaves_the_changes_as_they_were_when_${what}_cannot_be_written_${layout}`, (t) => {
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
        });
      }
    }

    vendorTest("test_a_killed_sync_keeps_its_journal_while_a_saved_change_file_cannot_be_read", (t) => {
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
    });

    forkTest("test_a_failed_sync_of_the_forks_own_upstream_drops_its_ref_though_an_upstream_on_that_remote_pins_the_commit", (t) => {
      t.pb(["track", "mirror", t.up.path], { cwd: t.fork.path });
      t.fork.commit("track mirror");
      t.up.write("app.txt", replace(t.up.read("app.txt"), "six", "SIX"));
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
    });
  });

  for (const [when, call] of [["checks_the_new_copy", "write-tree --prefix=vendor/extra/"], ["keeps_the_new_commit", "update-ref refs/pins/"]] as const) {
    vendorTest(`test_a_sync_killed_while_it_${when}_is_put_right_by_the_next_sync`, (t) => {
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
      expect(ignored.split("\n").filter((line) => line.startsWith("!!"))).toEqual([]);
      expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
    });
  }

  const lockChanges: [string, (t: VendorCase) => void, boolean][] = [
    ["the_lock_has_changed_since", (t) => sh(["git", "checkout", "HEAD~1", "--", ".patchbook/upstream.lock"], { cwd: t.repo.path }), false],
    ["the_lock_has_changed_since_the_sync_wrote_it", (t) => {
      t.repo.write(".patchbook/sync-extra/lock", t.repo.read(".patchbook/upstream.lock"));
      sh(["git", "checkout", "HEAD~1", "--", ".patchbook/upstream.lock"], { cwd: t.repo.path });
    }, true],
    ["the_lock_no_longer_parses", (t) => t.repo.write(".patchbook/upstream.lock", "<<<<<<< HEAD\n"), true],
    ["its_record_cannot_be_read", (t) => t.repo.write(".patchbook/sync-extra/pin", ""), true],
  ];
  for (const [how, change, refLeft] of lockChanges) {
    vendorTest(`test_a_killed_sync_is_left_for_the_user_when_${how}`, (t) => {
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
      expect(stderr).toContain(".patchbook/sync-extra holds a sync of extra");
      expect(stderr).toContain("old/ holds the vendored copy as it was");
      expect(stderr).not.toContain("before/");
      expect(tree(t.repo.path)).toEqual(before);
      expect(pinRefs(t, head)).toBe(refLeft ? 1 : 0);
    });
  }

  vendorTest("test_a_killed_sync_left_for_the_user_stops_a_sync_or_track_of_another_upstream", (t) => {
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

  for (const [by, args] of [["the_next_sync", ["sync", "extra"]], ["a_plain_sync_that_reaches_another_upstream_first", ["sync"]]] as const) {
    vendorTest(`test_a_lock_torn_by_a_killed_sync_is_put_back_by_${by}`, (t) => {
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
    ["its_vendor_folders_parent_was_removed", (t) => rmSync(join(t.repo.path, "vendor"), { recursive: true })],
    ["a_change_file_was_replaced_by_a_link", (t) => {
      const ours = ".patchbook/changes/tweak/ours/extra/a.md.pb";
      t.repo.write(".patchbook/sync-extra/before/changes/tweak/ours/extra/a.md.pb", t.repo.read(ours));
      rmSync(join(t.repo.path, ours));
      symlinkSync(join(t.tmp, "victim.txt"), join(t.repo.path, ours));
    }],
  ];
  for (const [what, change] of killedThenChanged) {
    vendorTest(`test_a_killed_sync_is_put_right_by_the_next_sync_when_${what}`, (t) => {
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

  vendorTest("test_a_failed_sync_leaves_the_vendored_copy_as_it_was_when_its_folder_name_has_a_newline", (t) => {
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

  vendorTest("test_a_killed_sync_keeps_the_ref_of_a_commit_another_upstream_has_pinned_since", (t) => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("x/a.md", "x\n");
    extra.write("y/a.md", "y\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--path", "x"], { cwd: t.repo.path });
    t.pb(["track", "other", extra.path, "--path", "y"], { cwd: t.repo.path });
    extra.write("x/a.md", "x2\n");
    extra.write("y/a.md", "y2\n");
    const head = extra.commit("v2");
    killSync(t, "update-ref refs/pins/");
    t.pb(["sync", "other"], { cwd: t.repo.path });
    t.pb(["sync", "extra", "refs/heads/nope"], { cwd: t.repo.path, code: 1 });
    expect(pinRefs(t, head)).toBe(1);
  });

  vendorTest("test_a_killed_sync_drops_its_ref_when_only_an_upstream_on_another_remote_has_pinned_that_commit", (t) => {
    t.missingScaffoldPatchBuild();
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("x/a.md", "x\n");
    extra.write("y/a.md", "y\n");
    extra.commit("a");
    t.pb(["track", "extra", extra.path, "--path", "x"], { cwd: t.repo.path });
    t.pb(["track", "other", `${extra.path}/`, "--path", "y"], { cwd: t.repo.path });
    extra.write("x/a.md", "x2\n");
    extra.write("y/a.md", "y2\n");
    const head = extra.commit("v2");
    killSync(t, "update-ref refs/pins/");
    t.pb(["sync", "other"], { cwd: t.repo.path });
    t.pb(["sync", "extra", "refs/heads/nope"], { cwd: t.repo.path, code: 1 });
    expect(pinRefs(t, head)).toBe(1);
  });

  forkTest("test_a_failed_sync_drops_its_ref_though_the_forks_own_upstream_on_that_remote_pins_the_commit", (t) => {
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

  describe.skipIf(!!process.env["PATCHBOOK_CMD"])("killed by a preload, so only from source", () => {
    for (const file of ["pin", "lock"]) {
      vendorTest(`test_a_sync_killed_before_it_deletes_its_journal_${file}_keeps_its_ref_once_an_older_commit_is_checked_out`, (t) => {
        const extra = extraWithAChange(t, true);
        extra.commit("v2");
        t.repo.commit("follow extra");
        t.pb(["sync", "extra"], { cwd: t.repo.path });
        t.repo.commit("sync extra");
        extra.write("b.md", "b\n");
        const head = extra.commit("v3");
        const env = { ...t.env, CRASH_BEFORE_RM: `/.patchbook/sync-extra/${file}` };
        sh([process.execPath, "--preload", join(import.meta.dir, "crash.ts"), TOOL, "sync", "extra"], { cwd: t.repo.path, env, check: false });
        expect(t.repo.read(".patchbook/upstream.lock")).toContain(head);
        expect(existsSync(join(t.repo.path, ".patchbook/sync-extra", file))).toBe(true);
        t.repo.commit("sync extra to v3");
        sh(["git", "checkout", "-q", "HEAD~2"], { cwd: t.repo.path });
        t.pb(["sync", "extra"], { cwd: t.repo.path, code: null });
        expect(pinRefs(t, head)).toBe(1);
      });
    }
  });

  vendorTest("test_a_plain_sync_puts_back_a_torn_lock_before_it_recovers_an_earlier_upstream", (t) => {
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

  vendorTest("test_a_killed_sync_puts_back_a_deleted_change_file_with_its_mode", (t) => {
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

  vendorTest("test_commit_refuses_an_output_folder_replaced_by_a_link", (t) => {
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

  vendorTest("test_commit_refuses_an_output_folder_replaced_by_a_link_before_any_build", (t) => {
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
