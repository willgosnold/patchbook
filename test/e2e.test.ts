// End-to-end tests: each one builds a throwaway upstream repo and drives the CLI against it.

import { describe, expect, test } from "bun:test";
import { accessSync, appendFileSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { CheckJson, LastSync, Nearest, SyncReport, UpstreamCheck, UpstreamLock, UpstreamPin } from "../src/api.ts";
import { carriesCrashInjection } from "./crash-build.ts";
import { paste } from "./paste.ts";
import { CMD, Case, Repo, TIMEOUT, type Run, crashCmd, dedent, fakeClaude, isRoot, permissionTest, sh, splitWords, words } from "./helpers";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
const checkedUpstream = (stdout: string, name: string): UpstreamCheck => (JSON.parse(stdout) as CheckJson).upstreams.find((u) => u.name === name)!;
const syncedAt = (root: string): LastSync => JSON.parse(read(join(root, ".patchbook/last-sync.json")));
const reportOf = (root: string, name = "upstream"): SyncReport => syncedAt(root).upstreams.find((r) => r.name === name)!;
const lockPin = (lock: string, name: string): UpstreamPin => (JSON.parse(lock) as UpstreamLock).upstreams.find((p) => p.name === name)!;
const lockNames = (lock: string): string[] => (JSON.parse(lock) as UpstreamLock).upstreams.map((p) => p.name);
const withPin = (lock: string, pin: UpstreamPin): string => {
  const doc = JSON.parse(lock) as UpstreamLock;
  return JSON.stringify({ ...doc, upstreams: [...doc.upstreams.filter((p) => p.name !== pin.name), pin] }, null, 2) + "\n";
};
const pinOf = (t: { repo: Repo }): string => lockPin(read(join(t.repo.path, ".patchbook/upstream.lock")), "plugin").commit;
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
  t.up.write("app.txt", t.up.read("app.txt").replaceAll("six", "SIX"));
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
    this.fork.write("app.txt", this.fork.read("app.txt").replaceAll("two", "TWO"));
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
    this.repo.write(skill, this.repo.read(skill).replaceAll(old, repl));
    const out = this.pb(["record", ...args], { cwd: this.repo.path }).stdout;
    const edited = this.repo.read(skill);
    this.pb(["build"], { cwd: this.repo.path }); // no --force: the edit is recorded
    expect(this.repo.read(skill)).toBe(edited);
    expect(this.pb(["status"], { cwd: this.repo.path }).stdout.replaceAll("no problems", "")).not.toContain("problem");
    return out;
  }

  missingScaffoldPatchBuild(): string {
    const status = this.pb(["status"], { cwd: this.repo.path, code: 1 }).stdout;
    expect(status).toContain("missing   skills/hello/SKILL.md");
    expect(status).not.toContain("README"); // only what ships is checked
    this.pb(["scaffold"], { cwd: this.repo.path });
    const entries = join(this.repo.path, ".patchbook/blocks/skills/hello/SKILL.md.entries");
    const text = read(entries).replaceAll("rules: \nintent: \n", "rules: t3\nintent: Speak T3.\n");
    const head = text.split("--- patched\n")[0]!;
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

test("--version prints the package version", () => {
  const t = new Case();
  try {
    const out = t.pb(["--version"], { cwd: t.tmp }).stdout;
    expect(out).toBe(`patchbook ${JSON.parse(read(join(import.meta.dir, "../package.json"))).version}\n`);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("help prints to stdout and exits 0", () => {
  const t = new Case();
  try {
    const out = t.pb(["sync", "--help"], { cwd: t.tmp });
    expect(out.stdout).toStartWith("usage: patchbook sync ");
    expect(out.stderr).toBe("");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("a usage error prints two lines to stderr and exits 2", () => {
  const t = new Case();
  try {
    const out = t.pb(["sync", "--forse"], { cwd: t.tmp, code: 2 });
    expect(out.stdout).toBe("");
    expect(out.stderr).toBe('patchbook sync: unknown option "--forse"\nRun `patchbook sync --help` for its arguments and options.\n');
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

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

const SKILL_FILE = ".agents/skills/patchbook-update/SKILL.md";
const SKILL_LINK = ".claude/skills/patchbook-update";
const SKILL_COPY = read(join(import.meta.dir, "../skills/patchbook-update/SKILL.md"));
const folderFail = (...paths: string[]) =>
  `patchbook: the update skill was not installed, since a folder sits where it goes:\n  ${paths.join("\n  ")}\nMove or remove the folder, then run \`patchbook skill install\`.\n`;
const STALE_SKILL = "---\nname: patchbook-update\n---\n\nAn older skill.\n";

function skillFork(t: Case): Repo {
  const up = new Repo(join(t.tmp, "upstream"));
  up.write("app.txt", "one\ntwo\n");
  up.commit("start");
  t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
  return new Repo(join(t.tmp, "fork"));
}

test("skill install adds the skill to a fork without one and records it", () => {
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

test("skill install replaces a stale skill in a fork and a second run changes nothing", () => {
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

test("skill install keeps the intent of the change it updates", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record", "patchbook-update-skill", "--intent", "Let agents pull upstream."], { cwd: fork.path });
    fork.commit("an older skill");
    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(read(join(fork.path, ".patchbook/changes/patchbook-update-skill/CHANGE.md"))).toContain("intent: Let agents pull upstream.\n");
    expect(out).not.toContain("intent ");
    expect(modelWasAsked(t)).toBe(false);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install replaces an intent patchbook wrote with the skill's own", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "0", PATCHBOOK_PROVIDER: "none" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record", "patchbook-update-skill"], { cwd: fork.path });
    expect(read(join(fork.path, ".patchbook/changes/patchbook-update-skill/CHANGE.md"))).toContain("intent (by patchbook): ");
    fork.commit("an older skill");
    t.env["PATCHBOOK_SKILL"] = "1";
    t.pb(["skill", "install"], { cwd: fork.path });
    expect(read(join(fork.path, ".patchbook/changes/patchbook-update-skill/CHANGE.md"))).toContain("intent: Install the patchbook-update skill, so an agent can pull upstream and carry these changes forward.\n");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install in a fork refuses to replace an uncommitted edit to the skill", () => {
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

test("skill install records the skill on its own while other edits wait", () => {
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

test("skill install refreshes a recorded skill while other edits wait", () => {
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

test("skill install in the folder layout overwrites the file and records no change", () => {
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

test("skill install follows start.agents and start.install_skill", () => {
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

test("skill install fails when start.agents names only an agent it cannot install for", () => {
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

test("init in a fork records the skill so install finds it current", () => {
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

test("init in a fork with edits of its own records the skill apart from them", () => {
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

test("init in a fork keeps an uncommitted edit to the skill and records nothing", () => {
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

test("init in the folder layout keeps an uncommitted edit to the skill", () => {
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

test("init keeps an uncommitted file at the skill link and writes no skill", () => {
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

permissionTest("init finishes with a note when the skill file cannot be read", () => {
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
});

test("init in a fork records nothing for a skill it did not write", () => {
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

test("init in a fork takes the intent from the series not from a leftover folder", () => {
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

test("skill install records a skill that an older init left unrecorded", () => {
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

test("skill install refuses when the change is missing from the series", () => {
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

test("skill install in the folder layout refuses to replace an uncommitted edit", () => {
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

test("skill install recreates a link that was deleted", () => {
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

permissionTest("skill install that cannot make the link leaves the stale skill alone", () => {
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
});

permissionTest("skill install that cannot write the skill takes back the link it made", () => {
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
});

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

test("skill install in a fork does not lose a recorded customization that is not committed", () => {
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

test("skill install in a fork does not lose a recorded link that is not committed", () => {
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

test("skill install in the folder layout refuses to replace an uncommitted link", () => {
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

test("skill install in the folder layout refuses to replace an uncommitted file at the link", () => {
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

permissionTest("skill install that cannot write the skill puts back a link it replaced", () => {
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
});

permissionTest("skill install that cannot write the skill puts back a file it replaced", () => {
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
});

test("skill install in a fork refuses to replace a customization that git ignores", () => {
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

test("skill install in the folder layout refuses to replace a link that git ignores", () => {
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
  test(`skill install in a fork refuses to replace an edit that git hides with ${flag}`, () => {
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

test("skill install in the folder layout refuses to replace a link that git hides", () => {
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

test("skill install replaces a committed customization and names the commit that keeps it", () => {
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

test("skill install replaces a committed customization that checkout wrote with CRLF", () => {
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

test("clone installs the skill over a committed copy that checkout wrote with CRLF", () => {
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

test("skill install replaces a committed link that checkout wrote as a file without symlinks", () => {
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

test("skill install refuses a plain file at a committed link when checkout would have written a link", () => {
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

test("skill install refuses to replace a line that a clean filter drops from what git stores", () => {
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

test("skill install refuses a lone carriage return edit", () => {
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

test("skill install refuses a file whose non-UTF-8 bytes differ from head", () => {
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

test("skill install keeps a committed CRLF file whose disk copy has LF", () => {
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

test("skill install refuses a UTF-16 file whose disk copy adds carriage returns", () => {
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

test("init keeps a line that a clean filter drops from what git stores and records nothing", () => {
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

test("skill install refuses to replace an edit when git cannot read head", () => {
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

test("init in a fork keeps a customized skill that git ignores and records nothing", () => {
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

test("skill install in a fork writes and records nothing when an untracked folder is at the link", () => {
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
    expect(out.stderr).toContain(folderFail(SKILL_LINK));
    expect(out.stdout).toBe("");
    expect(fork.read(SKILL_FILE)).toBe(STALE_SKILL);
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

permissionTest("skill install that cannot write the skill puts back the mode of a file it replaced", () => {
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
});

test("skill install says which committed skill paths it replaced", () => {
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

test("skill install does not write through a symlink at the skill file", () => {
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

test("skill install does not ask for a commit when the skill file is an uncommitted symlink", () => {
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

test("skill install does not write through a symlink at a folder above the skill", () => {
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

test("clone finishes without installing when a folder above the skill is a symlink", () => {
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

test("init finishes without installing when the skill file is a symlink", () => {
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

test("skill install does not write through a symlink at .agents/skills", () => {
  expectNoWriteThrough(".agents/skills", (t) => join(outsideSkill(t), "skills"),
    "shared/skills/patchbook-update/SKILL.md", KEPT);
}, TIMEOUT);

test("skill install does not write through a symlink at the skill folder", () => {
  expectNoWriteThrough(".agents/skills/patchbook-update", (t) => join(outsideSkill(t), "skills/patchbook-update"),
    "shared/skills/patchbook-update/SKILL.md", KEPT);
}, TIMEOUT);

test("skill install does not write through a symlink at .claude", () => {
  expectNoWriteThrough(".claude", outsideClaude, "outside-claude/skills/patchbook-update", "Kept outside the repo.\n");
}, TIMEOUT);

test("skill install does not write through a symlink at .claude/skills", () => {
  expectNoWriteThrough(".claude/skills", (t) => join(outsideClaude(t), "skills"),
    "outside-claude/skills/patchbook-update", "Kept outside the repo.\n");
}, TIMEOUT);

test("clone finishes without installing when .claude is a symlink", () => {
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

test("init finishes without installing when .claude/skills is a symlink", () => {
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

test("skill install counts a .claude/skills link to .agents/skills as installed", () => {
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

test("clone and init print no folder note for a .claude/skills link to .agents/skills", () => {
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

test("skill install and clone install the codex copy when the shared link dangles", () => {
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

test("skill install and clone refuse a .claude symlink to an outside folder whose skills link is shared", () => {
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

test("clone replaces a skill file that is not UTF-8", () => {
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

test("skill install treats a skill file that is not UTF-8 like any other that differs", () => {
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

test("skill install leaves a folder at the skill file and exits 1", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    fork.write(`${SKILL_FILE}/notes.txt`, "Mine.\n");
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toBe(folderFail(SKILL_FILE));
    expect(out.stdout).toBe("");
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("clone keeps the patchbook and exits 1 when a folder is at the skill file", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write(`${SKILL_FILE}/notes.txt`, "Mine.\n");
    up.commit("start");
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["clone", up.path, "fork"], { cwd: t.tmp, code: 1 });
    expect(out.stderr).toContain(folderFail(SKILL_FILE));
    expect(out.stderr).not.toContain("EISDIR");
    expect(out.stdout).toContain("cloned ");
    const fork = new Repo(join(t.tmp, "fork"));
    expect(fork.read(`${SKILL_FILE}/notes.txt`)).toBe("Mine.\n");
    expect(existsSync(join(fork.path, ".claude"))).toBe(false);
    expect(sh(["git", "log", "-1", "--format=%s"], { cwd: fork.path }).stdout).toStartWith("Start a patchbook at upstream");
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: fork.path });
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");

    renameSync(join(fork.path, SKILL_FILE), join(t.tmp, "my-skill-folder"));
    const early = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(early.stderr).toContain(`the patchbook still holds a folder where it goes:\n  ${SKILL_FILE}\n`);
    expect(t.pb(["status"], { cwd: fork.path, code: 1 }).stdout).toContain(`unrecorded ${SKILL_FILE}/notes.txt`);
    t.pb(["record", "my-folder", "--intent", "Drop my skill folder."], { cwd: fork.path });
    t.pb(["skill", "install"], { cwd: fork.path });
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(fork.read(".patchbook/series")).toBe("my-folder\npatchbook-update-skill\n");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
    expect(t.pb(["skill", "install"], { cwd: fork.path }).stdout).toBe("the update skill is already current\n");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const layout of ["fork", "folder"]) {
  test(`a ${layout} init keeps the patchbook and exits 1 when a folder is at the skill file`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      let repo: Repo;
      if (layout === "fork") {
        sh(["git", "clone", "-q", up.path, "mine"], { cwd: t.tmp });
        repo = new Repo(join(t.tmp, "mine"));
      } else {
        repo = new Repo(join(t.tmp, "adapted"));
        repo.write("README.md", "mine\n");
        repo.commit("start");
      }
      repo.write(`${SKILL_FILE}/notes.txt`, "Mine.\n");
      repo.commit("a folder of my own");
      Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
      const out = t.pb(["init", "--upstream", up.path, ...(layout === "folder" ? ["--output-to", "out"] : [])], { cwd: repo.path, code: 1 });
      expect(out.stderr).toContain(folderFail(SKILL_FILE));
      expect(out.stderr).not.toContain("EISDIR");
      expect(repo.read(`${SKILL_FILE}/notes.txt`)).toBe("Mine.\n");
      expect(existsSync(join(repo.path, ".claude"))).toBe(false);
      expect(existsSync(join(repo.path, ".patchbook/config.toml"))).toBe(true);
      const first = t.pb(["status"], { cwd: repo.path, code: layout === "fork" ? 1 : 0 }).stdout;
      expect(first).toContain(layout === "fork" ? `unrecorded ${SKILL_FILE}/notes.txt` : "no problems");

      renameSync(join(repo.path, SKILL_FILE), join(t.tmp, "my-skill-folder"));
      t.pb(["skill", "install"], { cwd: repo.path });
      expect(repo.read(SKILL_FILE)).toBe(SKILL_COPY);
      expect(t.pb(["status"], { cwd: repo.path }).stdout).toContain("no problems");
      expect(t.pb(["skill", "install"], { cwd: repo.path }).stdout).toBe("the update skill is already current\n");
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

permissionTest("no skill or hook failure shows a raw errno code", () => {
  const t = new Case();
  const locked: string[] = [];
  const noErrno = (stderr: string) => {
    for (const code of ["EISDIR", "ENOENT", "EACCES", "ENOTDIR", "EPERM", "EEXIST", "EROFS"]) expect(stderr).not.toContain(code);
  };
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const holder = new Repo(join(t.tmp, "holder"));
    holder.write(`${SKILL_FILE}/notes.txt`, "Mine.\n");
    holder.commit("start");
    noErrno(t.pb(["clone", holder.path, "cloned"], { cwd: t.tmp, code: 1 }).stderr);
    sh(["git", "clone", "-q", holder.path, "inited"], { cwd: t.tmp });
    const inited = join(t.tmp, "inited");
    noErrno(t.pb(["init", "--upstream", holder.path], { cwd: inited, code: 1 }).stderr);
    noErrno(t.pb(["skill", "install"], { cwd: inited, code: 1 }).stderr);

    Object.assign(t.env, { PATCHBOOK_SKILL: "0" });
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const skills = join(fork.path, ".claude/skills");
    mkdirSync(skills, { recursive: true });
    chmodSync(skills, 0o555);
    locked.push(skills);
    const link = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(link.stderr).toContain("couldn't install the update skill");
    noErrno(link.stderr);

    const git = join(fork.path, ".git");
    rmSync(join(git, "hooks"), { recursive: true });
    chmodSync(git, 0o555);
    locked.push(git);
    const hook = t.pb(["record"], { cwd: fork.path });
    expect(hook.stderr).toContain("couldn't install the pre-commit hook");
    noErrno(hook.stderr);
  } finally {
    for (const p of locked) if (existsSync(p)) chmodSync(p, 0o755);
    t.cleanup();
  }
});

test("skill install goes ahead when a sync left a conflict", () => {
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

test("skill install says why when start.agents is empty", () => {
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

test("commit records a hand edit in a fork cloned with the skill", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write("app.txt", "one\nTWO\n");
    sh(["git", "add", "app.txt"], { cwd: fork.path });
    const commit = sh(["git", "commit", "-q", "-m", "shout"], { cwd: fork.path, check: false, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Shout two." } });
    expect(commit.stderr).not.toContain("is a link");
    expect(commit.code).toBe(0);
    expect(committedFiles(fork)).toContain("app.txt");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");
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

const foldedUpstream = [
  [".PATCHBOOK", ".PATCHBOOK/config.toml"],
  [".patchbook.", ".patchbook./z.txt"],
  [".patchbook and a space", ".patchbook /w.txt"],
] as const;
const cantFork = "patchbook can't fork an upstream with a folder that is .patchbook on macOS and Windows";

for (const [what, path] of foldedUpstream) {
  test(`clone refuses an upstream with a ${what} folder and writes nothing`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.write(path, "upstream = true\n");
      up.commit("start");
      const refused = t.pb(["clone", up.path, "fork"], { cwd: t.tmp, code: 1 });
      expect(refused.stderr).toContain(path);
      expect(refused.stderr).toContain(cantFork);
      expect(existsSync(join(t.tmp, "fork"))).toBe(false);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  test(`init refuses an upstream with a ${what} folder and writes nothing`, () => {
    const t = new Case();
    try {
      const leaf = path.replace("config.toml", "notes.md");
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

  forkTest(`sync and check refuse an upstream that gains a ${what} folder and write nothing`, (t) => {
    t.up.write(path, "upstream = true\n");
    t.up.commit("upstream gains a folded folder");
    const before = tree(t.fork.path);
    for (const args of [["sync"], ["check"]]) {
      const refused = t.pb(args, { cwd: t.fork.path, code: 1 });
      expect(refused.stderr).toContain(path);
      expect(refused.stderr).toContain(cantFork);
      expect(tree(t.fork.path)).toEqual(before);
    }
  });
}

describe("a fork that already holds a folder read as .patchbook", () => {
  const folded = ".PATCHBOOK/config.toml";

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

const AWKWARD = (word: string): string => `${word}"q\\b😀`;

const upstreamsOf = (config: string): Record<string, unknown>[] => (Bun.TOML.parse(config) as { upstream: Record<string, unknown>[] }).upstream;

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

/** Every folder, file and link under root except `.git`, with each file's mode, so a test can see that a run left nothing behind. */
const onDisk = (root: string): Record<string, string> =>
  Object.fromEntries((readdirSync(root, { recursive: true }) as string[]).filter((p) => p !== ".git" && !p.startsWith(".git/")).sort().map((p) => {
    const at = join(root, p);
    const stat = lstatSync(at);
    return [p, stat.isSymbolicLink() ? `-> ${readlinkSync(at)}` : stat.isDirectory() ? "folder" : `${(stat.mode & 0o777).toString(8)} ${read(at)}`];
  }));

/** What a failed init must leave as it found it: the remotes and the rest of the git config, the index, the hooks, and the working tree. */
const repoState = (repo: string) => ({
  remotes: sh(["git", "remote", "-v"], { cwd: repo }).stdout,
  config: read(join(repo, ".git/config")),
  index: sh(["git", "ls-files", "--stage"], { cwd: repo }).stdout,
  hooks: tree(join(repo, ".git/hooks")),
  files: onDisk(repo),
});

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

// Stands in for ssh by running the remote command here, so scp and ssh:// URLs reach a local repo.
const fakeSsh = (t: Case): string => {
  const script = join(t.tmp, "bin/fake-ssh");
  writeFileSync(script, "#!/bin/sh\nfor a; do cmd=$a; done\nexec sh -c \"$(printf '%s' \"$cmd\" | sed 's/^git-upload-pack/git upload-pack/')\"\n", { mode: 0o755 });
  t.env["GIT_SSH_COMMAND"] = script;
  process.env["GIT_SSH_COMMAND"] = script;
  return script;
};

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
  for (const name of ["config.toml", "upstream.lock", "retired.md"]) {
    test(`a ${layout} init refuses a ${name} that is a link`, () => {
      const t = new Case();
      try {
        const up = new Repo(join(t.tmp, "upstream"));
        up.write("app.txt", "one\n");
        up.commit("start");
        const fork = forkOf(t, up);
        const output = layout === "folder" ? ["--output-from", "", "--output-to", "out"] : [];
        const outside = join(t.tmp, name);
        if (name !== "config.toml") writeFileSync(outside, "mine\n");
        mkdirSync(join(fork.path, ".patchbook"));
        symlinkSync(outside, join(fork.path, ".patchbook", name));
        const out = t.pb(["init", "--upstream", up.path, ...output], { cwd: fork.path, code: 1 });
        const refusal = { "config.toml": "is a symlink to a missing file", "upstream.lock": "is a link", "retired.md": "already exists" }[name];
        expect(out.stderr).toContain(`.patchbook/${name} ${refusal}`);
        expect(existsSync(outside) ? read(outside) : null).toBe(name === "config.toml" ? null : "mine\n");
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

/** A repo to start a patchbook in, in either layout, following an upstream with one file, with the update skill on. */
function startingRepo(t: Case, layout: string): { up: Repo; repo: Repo; output: string[] } {
  Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
  const up = new Repo(join(t.tmp, "upstream"));
  up.write("app.txt", "one\n");
  up.commit("start");
  if (layout === "fork") return { up, repo: forkOf(t, up), output: [] };
  const repo = new Repo(join(t.tmp, "repo"));
  repo.write("README.md", "mine\n");
  repo.commit("start");
  return { up, repo, output: ["--output-from", "", "--output-to", "out"] };
}

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

const CREDENTIAL_URLS: readonly (readonly [string, string, string, string])[] = [
  ["a password", "https://user:s3cretpw@host.invalid/team/up", "https://host.invalid/team/up", "s3cretpw"],
  ["a token as the user name", "https://s3cretpw@host.invalid/team/up", "https://host.invalid/team/up", "s3cretpw"],
  ["an ssh password", "ssh://git:s3cretpw@host.invalid/team/up", "ssh://git@host.invalid/team/up", "s3cretpw"],
  ["a token as the user name of a git+https URL", "git+https://s3cretpw@host.invalid/team/up", "git+https://host.invalid/team/up", "s3cretpw"],
  ["an ssh password with an encoded colon", "ssh://u%3ASEKRIT@127.0.0.1:1/team/up", "ssh://u@127.0.0.1:1/team/up", "SEKRIT"],
  ["an ssh password with a lower case encoded colon", "ssh://u%3aSEKRIT@127.0.0.1:1/team/up", "ssh://u@127.0.0.1:1/team/up", "SEKRIT"],
  ["a git+ssh password with an encoded colon", "git+ssh://u%3ASEKRIT@127.0.0.1:1/team/up", "git+ssh://u@127.0.0.1:1/team/up", "SEKRIT"],
  ["an ssh password with an encoded colon and an encoded at sign in the host", "ssh://u@127.0.0.1%3ASEKRIT%40x/team/up", "ssh://u@127.0.0.1%40x/team/up", "SEKRIT"],
  ...([["a no-break space", "\u00a0"], ["a space", " "], ["a tab", "\t"], ["a newline", "\n"]] as const).map(
    ([name, blank]) => [`a_password_with_${name}`, `https://user:SEKRITa${blank}SEKRITb@host.invalid/team/up`, "https://host.invalid/team/up", "SEKRIT"] as const,
  ),
];

const storeState = (t: Case): Record<string, string> | null => (existsSync(join(t.tmp, "store")) ? tree(join(t.tmp, "store")) : null);

const reachableAs = (t: Case, url: string, repo: Repo): void =>
  void Object.assign(t.env, {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `url.${repo.path}.insteadOf`, GIT_CONFIG_VALUE_0: url,
    GIT_CONFIG_KEY_1: "protocol.file.allow", GIT_CONFIG_VALUE_1: "always",
  });

const expectCredentialRefusal = ({ stdout, stderr }: { stdout: string; stderr: string }, shown: string, secret: string): void => {
  expect(stderr).toContain(`patchbook: ${shown} has credentials that patchbook would not keep.`);
  expect(stderr).toContain("Give git the password through a credential helper instead. See: git help credential");
  expect(stdout).not.toContain(secret);
  expect(stderr).not.toContain(secret);
};

for (const [how, url, shown, secret] of CREDENTIAL_URLS) {
  test(`clone refuses a URL with ${how} and creates nothing`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      reachableAs(t, url, up);
      const before = readdirSync(t.tmp).sort();
      const refused = t.pb(["clone", url, "fork"], { cwd: t.tmp, code: 1 });
      expectCredentialRefusal(refused, shown, secret);
      expect(readdirSync(t.tmp).sort()).toEqual(before);
      expect(storeState(t)).toBeNull();
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  for (const layout of ["fork", "folder"]) {
    test(`a ${layout} init refuses a URL with ${how} and writes nothing`, () => {
      const t = new Case();
      try {
        const { up, repo, output } = startingRepo(t, layout);
        reachableAs(t, url, up);
        const before = repoState(repo.path);
        const refused = t.pb(["init", "--upstream", url, ...output], { cwd: repo.path, code: 1 });
        expectCredentialRefusal(refused, shown, secret);
        expect(repoState(repo.path)).toEqual(before);
        expect(storeState(t)).toBeNull();
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);
  }

  test(`track refuses a URL with ${how} and writes nothing`, () => {
    const t = new Case();
    try {
      const { up, repo } = startingRepo(t, "fork");
      t.pb(["init", "--upstream", up.path], { cwd: repo.path });
      repo.commit("start a patchbook");
      const extra = new Repo(join(t.tmp, "extra"));
      extra.write("lib.txt", "lib\n");
      extra.commit("start");
      reachableAs(t, url, extra);
      const before = repoState(repo.path);
      const store = storeState(t);
      const refused = t.pb(["track", "extra", url], { cwd: repo.path, code: 1 });
      expectCredentialRefusal(refused, shown, secret);
      expect(repoState(repo.path)).toEqual(before);
      expect(storeState(t)).toEqual(store);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("init and track still take an ssh URL with only a user name", () => {
  const t = new Case();
  try {
    fakeSsh(t);
    const { up, repo } = startingRepo(t, "fork");
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("lib.txt", "lib\n");
    extra.commit("start");
    const given = `ssh://git@fake${up.path}`;
    t.pb(["init", "--upstream", given], { cwd: repo.path });
    expect(repo.read(".patchbook/config.toml")).toContain(`remote = "${given}"`);
    expect(sh(["git", "remote", "get-url", "upstream"], { cwd: repo.path }).stdout.trim()).toBe(given);
    repo.commit("start a patchbook");
    t.pb(["track", "extra", `ssh://git@fake${extra.path}`], { cwd: repo.path });
    expect(repo.read(".patchbook/config.toml")).toContain(`remote = "ssh://git@fake${extra.path}"`);
  } finally {
    delete process.env["GIT_SSH_COMMAND"];
    t.cleanup();
  }
}, TIMEOUT);

test("init and track still take an ssh URL whose user name has an encoded character and no colon", () => {
  const t = new Case();
  try {
    fakeSsh(t);
    const { up, repo } = startingRepo(t, "fork");
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("lib.txt", "lib\n");
    extra.commit("start");
    const given = `ssh://g%69t@fake${up.path}`;
    t.pb(["init", "--upstream", given], { cwd: repo.path });
    expect(repo.read(".patchbook/config.toml")).toContain(`remote = "${given}"`);
    repo.commit("start a patchbook");
    t.pb(["track", "extra", `ssh://g%69t@fake${extra.path}`], { cwd: repo.path });
    expect(repo.read(".patchbook/config.toml")).toContain(`remote = "ssh://g%69t@fake${extra.path}"`);
  } finally {
    delete process.env["GIT_SSH_COMMAND"];
    t.cleanup();
  }
}, TIMEOUT);

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

for (const layout of ["fork", "folder"]) {
  permissionTest(`a ${layout} init that cannot install the hook still starts the patchbook`, () => {
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
  });
}

permissionTest("a command warns and runs while the pre-commit hook cannot be installed", () => {
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
});

test("commit through Vite+ records when it is installed after clone", () => {
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

test("commit through Vite+ stops without patchbook unless skipped", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { ".vite-hooks/pre-commit": NOTE_STAGED });
    installManager(fork, ".vite-hooks");
    const path = t.env["PATH"]!.split(":").filter((d) => !existsSync(join(d, "patchbook"))).join(":");
    const teammate = { ...t.env, PATCHBOOK_HOOK: "1", PATH: path };
    fork.write("app.txt", "one\nTWO\n");
    const stopped = sh(["git", "commit", "-qam", "shout"], { cwd: fork.path, check: false, env: teammate });
    expect(stopped.code).not.toBe(0);
    expect(stopped.stderr).toContain("npm install -g @patchbook/cli");
    expect(stopped.stderr).toContain("PATCHBOOK_HOOK=0");
    sh(["git", "commit", "-qam", "shout"], { cwd: fork.path, env: { ...teammate, PATCHBOOK_HOOK: "0" } });
    expect(sh(["git", "log", "-1", "--format=%s"], { cwd: fork.path }).stdout).toBe("shout\n");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("status warns when Vite+ runs a hook without patchbook", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { ".vite-hooks/pre-commit": NOTE_STAGED });
    installManager(fork, ".vite-hooks");
    fork.write(".vite-hooks/pre-commit", NOTE_STAGED);
    Object.assign(t.env, { PATCHBOOK_HOOK: "1" });
    expect(t.pb(["status"], { cwd: fork.path, code: 1 }).stderr).toContain(".vite-hooks/pre-commit");
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

test("init puts patchbook first in a husky hook", () => {
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
  '    echo "Install it with npm install -g @patchbook/cli, or skip it once with PATCHBOOK_HOOK=0 git commit" >&2',
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
        stages: [commit]
`;

const LEFTHOOK_DISPATCHER = `#!/bin/sh\n# lefthook stand-in\nlefthook run pre-commit "$@"\n`;

const LEFTHOOK_NAMES = [
  ["lefthook.yml", LEFTHOOK_SNIPPET],
  ["lefthook.yaml", LEFTHOOK_SNIPPET],
  ["lefthook.toml", LEFTHOOK_TOML_SNIPPET],
  ["lefthook.json", LEFTHOOK_JSON_SNIPPET],
  ["lefthook.jsonc", LEFTHOOK_JSON_SNIPPET],
  [".lefthook.yml", LEFTHOOK_SNIPPET],
  [".config/lefthook.yml", LEFTHOOK_SNIPPET],
] as const;

const SNIPPETS = {
  ...Object.fromEntries(LEFTHOOK_NAMES.map(([name, snippet]) => [name, { snippet, dispatcher: LEFTHOOK_DISPATCHER }])),
  ".pre-commit-config.yaml": {
    snippet: PRE_COMMIT_SNIPPET,
    dispatcher: `#!/usr/bin/env bash\n# File generated by pre-commit: https://pre-commit.com\nexec pre-commit hook-impl --hook-type=pre-commit -- "$@"\n`,
  },
};

for (const [config, { snippet, dispatcher }] of Object.entries(SNIPPETS)) {
  test(`hook install prints what to add to ${config}`, () => {
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
      const added = t.pb(["status"], { cwd: fork.path, code: 1 });
      expect(added.stdout).toContain(`unrecorded ${config}`);
      expect(added.stderr).not.toContain(config);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("hook install still prints the TOML advice for a lone lefthook TOML", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { "lefthook.toml": "# lint on commit\n" });
    const install = t.pb(["hook", "install"], { cwd: fork.path });
    expect(install.stderr).toContain("Add this at the end of lefthook.toml,");
    expect(install.stderr).toContain(LEFTHOOK_TOML_SNIPPET.trim());
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("hook install prints the advice when a second lefthook name is a symlink to the same file", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.write("lefthook.yml", "# lint on commit\n");
    symlinkSync("lefthook.yml", join(up.path, ".lefthook.yml"));
    up.commit("start");
    t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    const install = t.pb(["hook", "install"], { cwd: join(t.tmp, "fork") });
    expect(install.stderr).toContain("Add this at the end of lefthook.yml,");
    expect(install.stderr).not.toContain("more than one config file");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

// lefthook reads one config file: the first that exists, by extension (yml, yaml, json, jsonc, toml), then by folder (., .lefthook, .config/lefthook).
const LEFTHOOK_PAIRS: [string, string, string][] = [
  ["lefthook.toml", "lefthook.json", "lefthook.json"],
  [".lefthook.toml", "lefthook.yml", "lefthook.yml"],
  [".config/lefthook.yml", ".lefthook.yml", ".lefthook.yml"],
];

for (const [first, second, read] of LEFTHOOK_PAIRS) {
  test(`hook install refuses when both ${first} and ${second} exist`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\ntwo\n");
      up.write(first, /json/.test(first) ? "{}\n" : "# lint on commit\n");
      up.write(second, /json/.test(second) ? "{}\n" : "# lint on commit\n");
      up.commit("start");
      const clone = t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
      expect(clone.stderr).toContain(`reads ${read} and ignores the rest`);
      expect(clone.stderr).not.toContain("patchbook hook run");
      const fork = new Repo(join(t.tmp, "fork"));
      const before = fork.read(first) + fork.read(second);
      const install = t.pb(["hook", "install"], { cwd: fork.path, code: 1 });
      expect(install.stdout).toBe("");
      expect(install.stderr).toContain(first);
      expect(install.stderr).toContain(second);
      expect(install.stderr).toContain(`reads ${read} and ignores the rest`);
      expect(install.stderr).not.toContain("patchbook hook run");
      expect(install.stderr).not.toContain("priority");
      expect(fork.read(first) + fork.read(second)).toBe(before);
      expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");
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
  ".pre-commit-config.yaml": (printed) => splitWords(parsed.yaml(printed).repos[0].hooks[0].entry),
};

const printedSnippet = (stderr: string): string => stderr.split("rebuilt output:\n\n")[1]!.split("\nLeave parallel off")[0]!;

for (const config of Object.keys(COMMANDS)) {
  test(`the snippet for ${config} guards the command like the hook lines`, () => {
    const t = new Case();
    try {
      const fork = forkWith(t, { [config]: /json/.test(config) ? "" : "# lint on commit\n" });
      const argv = COMMANDS[config]!(printedSnippet(t.pb(["hook", "install"], { cwd: fork.path }).stderr));
      const plain = join(t.tmp, "plain");
      mkdirSync(plain);
      const noPatchbook = { ...withHook(t), PATH: t.env["PATH"]!.split(":").filter((d) => !existsSync(join(d, "patchbook"))).join(":") };
      const blocked = sh(argv, { cwd: fork.path, env: noPatchbook, check: false });
      expect(blocked.code).toBe(1);
      expect(blocked.stderr).toContain("npm install -g @patchbook/cli");
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
  parse: (text: string) => any;
  check: (merged: any) => void;
};

const hasPatchbook = (hook: any, call = "patchbook hook run"): void => expect(hook.run).toContain(call);

/** lefthook runs the commands that have a priority from the lowest up, then the rest, and equal priorities in no set order, so patchbook is first only when its priority is below every other. */
function runsFirst(hook: any, call?: string): void {
  if (hook.jobs) {
    expect(hook.jobs[0].name).toBe("patchbook");
    hasPatchbook(hook.jobs[0], call);
    return;
  }
  const mine = hook.commands.patchbook.priority;
  hasPatchbook(hook.commands.patchbook, call);
  expect(mine).not.toBe(0);
  for (const [name, command] of Object.entries<any>(hook.commands)) {
    if (name !== "patchbook" && (command.priority ?? 0) !== 0) expect(command.priority).toBeGreaterThan(mine);
  }
}

const PRE_COMMIT_LOCAL = (id: string, indentFirst = ""): string =>
  `${indentFirst}- repo: local\n${indentFirst}  hooks:\n${indentFirst}    - id: ${id}\n${indentFirst}      name: ${id}\n${indentFirst}      entry: echo ${id}\n${indentFirst}      language: system\n${indentFirst}      always_run: true\n`;

const patchbookFirst = (m: any, others: string[]): void => {
  const ids = m.repos.flatMap((r: any) => r.hooks.map((h: any) => h.id));
  expect(ids[0]).toBe("patchbook");
  expect(ids.slice(1)).toEqual(others);
};

const PASTES: Paste[] = [
  {
    name: "no pre-commit key", config: "lefthook.yml", existing: "colors: false\n", parse: parsed.yaml,
    check: (m) => { expect(m.colors).toBe(false); runsFirst(m["pre-commit"]); },
  },
  {
    name: "a pre-commit key without commands", config: "lefthook.yml", existing: "pre-commit:\n  parallel: true\n", parse: parsed.yaml,
    check: (m) => { expect(m["pre-commit"].parallel).toBe(true); runsFirst(m["pre-commit"]); },
  },
  {
    name: "a pre-commit key with commands", config: "lefthook.yml", existing: "pre-commit:\n  commands:\n    lint:\n      run: echo lint\n", parse: parsed.yaml,
    check: (m) => { expect(m["pre-commit"].commands.lint.run).toBe("echo lint"); runsFirst(m["pre-commit"]); },
  },
  {
    name: "four-space indentation", config: "lefthook.yml", existing: "pre-commit:\n    commands:\n        lint:\n            run: echo lint\n", parse: parsed.yaml,
    check: (m) => { expect(m["pre-commit"].commands.lint.run).toBe("echo lint"); runsFirst(m["pre-commit"]); },
  },
  {
    name: "four-space indentation and a pre-commit key without commands", config: "lefthook.yml", parse: parsed.yaml,
    existing: "pre-commit:\n    parallel: false\npre-push:\n    commands:\n        test:\n            run: echo test\n",
    check: (m) => { expect(m["pre-push"].commands.test.run).toBe("echo test"); expect(m["pre-commit"].parallel).toBe(false); runsFirst(m["pre-commit"]); },
  },
  {
    name: "commands that already have priorities", config: "lefthook.yml", parse: parsed.yaml,
    existing: "pre-commit:\n  commands:\n    aaa:\n      priority: 1\n      run: echo a\n    zzz:\n      priority: -3\n      run: echo z\n    plain:\n      run: echo p\n",
    check: (m) => { expect(Object.keys(m["pre-commit"].commands).sort()).toEqual(["aaa", "patchbook", "plain", "zzz"]); runsFirst(m["pre-commit"]); },
  },
  {
    name: "jobs", config: "lefthook.yml", parse: parsed.yaml,
    existing: "pre-commit:\n  jobs:\n    - name: lint\n      run: echo lint\n    - name: check\n      run: echo check\n",
    check: (m) => { expect(m["pre-commit"].jobs.map((j: any) => j.name)).toEqual(["patchbook", "lint", "check"]); runsFirst(m["pre-commit"]); },
  },
  {
    name: "a comment above the commands", config: "lefthook.yml", parse: parsed.yaml,
    existing: "# hooks\npre-commit:\n  # what runs\n  commands:\n    # the linter\n    lint:\n      run: echo lint\n",
    check: (m) => { expect(m["pre-commit"].commands.lint.run).toBe("echo lint"); runsFirst(m["pre-commit"]); },
  },
  {
    name: "a pre-commit table", config: "lefthook.toml", existing: "[pre-commit]\nparallel = true\n", parse: parsed.toml,
    check: (m) => { expect(m["pre-commit"].parallel).toBe(true); runsFirst(m["pre-commit"]); },
  },
  {
    name: "a command with a priority", config: "lefthook.toml", existing: "[pre-commit.commands.lint]\npriority = 1\nrun = \"echo lint\"\n", parse: parsed.toml,
    check: (m) => { expect(m["pre-commit"].commands.lint.run).toBe("echo lint"); runsFirst(m["pre-commit"]); },
  },
  {
    name: "an empty file", config: "lefthook.json", existing: "", parse: parsed.json,
    check: (m) => runsFirst(m["pre-commit"]),
  },
  {
    name: "no pre-commit key", config: "lefthook.json", existing: '{ "colors": false }', parse: parsed.json,
    check: (m) => { expect(m.colors).toBe(false); runsFirst(m["pre-commit"]); },
  },
  {
    name: "a pre-commit key without commands", config: "lefthook.json", existing: '{ "pre-commit": { "parallel": true } }', parse: parsed.json,
    check: (m) => { expect(m["pre-commit"].parallel).toBe(true); runsFirst(m["pre-commit"]); },
  },
  {
    name: "a pre-commit key with commands", config: "lefthook.json", existing: '{ "pre-commit": { "commands": { "lint": { "run": "echo lint" } } } }', parse: parsed.json,
    check: (m) => { expect(m["pre-commit"].commands.lint.run).toBe("echo lint"); runsFirst(m["pre-commit"]); },
  },
  {
    name: "commands only in another hook", config: "lefthook.json", parse: parsed.json,
    existing: '{\n  "pre-commit": {\n    "parallel": false\n  },\n  "pre-push": {\n    "commands": {\n      "test": { "run": "echo test" }\n    }\n  }\n}\n',
    check: (m) => { expect(m["pre-push"].commands.test.run).toBe("echo test"); expect(m["pre-push"].commands.patchbook).toBeUndefined(); expect(m["pre-commit"].parallel).toBe(false); runsFirst(m["pre-commit"]); },
  },
  {
    name: "commands only in another hook, before pre-commit", config: "lefthook.json", parse: parsed.json,
    existing: '{\n  "pre-push": {\n    "commands": {\n      "test": { "run": "echo test" }\n    }\n  },\n  "pre-commit": {}\n}\n',
    check: (m) => { expect(m["pre-push"].commands.patchbook).toBeUndefined(); runsFirst(m["pre-commit"]); },
  },
  {
    name: "jobs", config: "lefthook.json", parse: parsed.json,
    existing: '{ "pre-commit": { "jobs": [ { "name": "lint", "run": "echo lint" } ] } }',
    check: (m) => { expect(m["pre-commit"].jobs.map((j: any) => j.name)).toEqual(["patchbook", "lint"]); runsFirst(m["pre-commit"]); },
  },
  {
    name: "comments and tabs", config: "lefthook.jsonc", parse: (text) => Bun.JSONC.parse(text),
    existing: '// hooks\n{\n\t/* what runs */\n\t"pre-commit": {\n\t\t"commands": {\n\t\t\t"lint": { "run": "echo lint" } // the linter\n\t\t}\n\t}\n}\n',
    check: (m) => { expect(m["pre-commit"].commands.lint.run).toBe("echo lint"); runsFirst(m["pre-commit"]); },
  },
  {
    name: "no repos key", config: ".pre-commit-config.yaml", existing: "exclude: ^vendor/\n", parse: parsed.yaml,
    check: (m) => { expect(m.exclude).toBe("^vendor/"); patchbookFirst(m, []); },
  },
  {
    name: "repos with entries", config: ".pre-commit-config.yaml", existing: `repos:\n${PRE_COMMIT_LOCAL("lint", "  ")}`, parse: parsed.yaml,
    check: (m) => patchbookFirst(m, ["lint"]),
  },
  {
    name: "the layout of pre-commit sample-config", config: ".pre-commit-config.yaml", parse: parsed.yaml,
    existing: "repos:\n-   repo: local\n    hooks:\n    -   id: lint\n        name: lint\n        entry: echo lint\n        language: system\n        always_run: true\n",
    check: (m) => patchbookFirst(m, ["lint"]),
  },
  {
    name: "entries four spaces in, with a comment first", config: ".pre-commit-config.yaml", parse: parsed.yaml,
    existing: `# hooks\nrepos:\n    # lint\n${PRE_COMMIT_LOCAL("lint", "    ")}${PRE_COMMIT_LOCAL("check", "    ")}`,
    check: (m) => patchbookFirst(m, ["lint", "check"]),
  },
  {
    name: "an empty repos list", config: ".pre-commit-config.yaml", existing: "repos: []\n", parse: parsed.yaml,
    check: (m) => patchbookFirst(m, []),
  },
];

test("the paste helper shares no code with src", () => {
  expect(read(join(import.meta.dir, "paste.ts"))).not.toMatch(/from\s+["'][^"']*src\//);
});

for (const { name, config, existing, parse, check } of PASTES) {
  test(`hook install prints what goes into ${config} with ${name}`, () => {
    const t = new Case();
    try {
      const fork = forkWith(t, { [config]: existing });
      const install = t.pb(["hook", "install"], { cwd: fork.path }).stderr;
      expect(fork.read(config)).toBe(existing);
      check(parse(paste(existing, install)));
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

const POST_EVENTS = ["post-merge", "post-checkout", "post-rewrite"];
const PRE_COMMIT_DISPATCHER = `#!/usr/bin/env bash\n# File generated by pre-commit: https://pre-commit.com\nexec pre-commit hook-impl --hook-type=pre-commit -- "$@"\n`;

function installDispatchers(fork: Repo, events: string[], dispatcher: string): void {
  for (const event of events) writeFileSync(join(fork.path, ".git/hooks", event), dispatcher, { mode: 0o755 });
}

function postCalls(t: Case, fork: Repo, script: string, env: Record<string, string>, rebasing = false): string[] {
  const bin = join(t.tmp, "calls-bin");
  const log = join(t.tmp, "calls.log");
  mkdirSync(bin, { recursive: true });
  rmSync(log, { force: true });
  writeFileSync(join(bin, "patchbook"), `#!/bin/sh\necho "$* [$PATCHBOOK_CHECKOUT_BEFORE>$PATCHBOOK_CHECKOUT_AFTER]" >> "${log}"\n`, { mode: 0o755 });
  const rebase = join(fork.path, ".git/rebase-merge");
  if (rebasing) mkdirSync(rebase, { recursive: true });
  try {
    sh(["sh", "-c", script], { cwd: fork.path, env: { ...t.env, PATH: `${bin}:${t.env["PATH"]}`, PATCHBOOK_HOOK: "1", ...env }, check: false });
  } finally {
    rmSync(rebase, { recursive: true, force: true });
  }
  return existsSync(log) ? read(log).trim().split("\n") : [];
}

type PostScripts = { merge: string; checkout: (before: string, after: string, branch: string) => { script: string; env: Record<string, string> }; rewrite: (command: string) => { script: string; env: Record<string, string> } };

function behavesLikeThePostHooks(t: Case, fork: Repo, scripts: PostScripts): void {
  expect(postCalls(t, fork, scripts.merge, {})).toEqual(["hook build [>]"]);
  const branch = scripts.checkout("aaa", "bbb", "1");
  expect(postCalls(t, fork, branch.script, branch.env)).toEqual(["hook build [aaa>bbb]"]);
  const file = scripts.checkout("aaa", "bbb", "0");
  expect(postCalls(t, fork, file.script, file.env)).toEqual([]);
  expect(postCalls(t, fork, branch.script, branch.env, true)).toEqual([]);
  const rebase = scripts.rewrite("rebase");
  expect(postCalls(t, fork, rebase.script, rebase.env)).toEqual(["hook build [>]"]);
  const amend = scripts.rewrite("amend");
  expect(postCalls(t, fork, amend.script, amend.env)).toEqual([]);
}

test("hook install prints the post hooks as lefthook commands when lefthook runs them", () => {
  const t = new Case();
  try {
    const existing = "pre-commit:\n  commands:\n    lint:\n      run: echo lint\npost-merge:\n  commands:\n    hello:\n      run: echo hello\n";
    const fork = forkWith(t, { "lefthook.yml": existing });
    installDispatchers(fork, ["pre-commit", ...POST_EVENTS], LEFTHOOK_DISPATCHER);
    const merged = parsed.yaml(paste(existing, t.pb(["hook", "install"], { cwd: fork.path }).stderr));
    expect(merged["pre-commit"].commands.lint.run).toBe("echo lint");
    expect(merged["post-merge"].commands.hello.run).toBe("echo hello");
    runsFirst(merged["pre-commit"]);
    for (const event of POST_EVENTS) runsFirst(merged[event], "patchbook hook build");
    const run = (event: string) => merged[event].commands.patchbook.run as string;
    const fill = (script: string, args: string[]) => script.replace(/\{([123])\}/g, (_, n) => args[Number(n) - 1] ?? "");
    behavesLikeThePostHooks(t, fork, {
      merge: run("post-merge"),
      checkout: (before, after, branch) => ({ script: fill(run("post-checkout"), [before, after, branch]), env: {} }),
      rewrite: (command) => ({ script: fill(run("post-rewrite"), [command]), env: {} }),
    });
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("hook install prints the post hooks as pre-commit hooks when pre-commit runs them", () => {
  const t = new Case();
  try {
    const existing = `repos:\n${PRE_COMMIT_LOCAL("lint", "  ")}`;
    const fork = forkWith(t, { ".pre-commit-config.yaml": existing });
    installDispatchers(fork, ["pre-commit", ...POST_EVENTS], PRE_COMMIT_DISPATCHER);
    const merged = parsed.yaml(paste(existing, t.pb(["hook", "install"], { cwd: fork.path }).stderr));
    const hooks = merged.repos.flatMap((r: any) => r.hooks);
    expect(hooks.map((h: any) => h.id).sort()).toEqual(["lint", "patchbook", "patchbook-post-checkout", "patchbook-post-merge", "patchbook-post-rewrite"]);
    const script = (event: string) => {
      const hook = hooks.find((h: any) => h.id === `patchbook-${event}`);
      expect(hook.stages).toEqual([event]);
      expect(hook.always_run).toBe(true);
      expect(hook.pass_filenames).toBe(false);
      const [shell, flag, body] = splitWords(hook.entry);
      expect([shell, flag]).toEqual(["sh", "-c"]);
      return body!;
    };
    behavesLikeThePostHooks(t, fork, {
      merge: script("post-merge"),
      checkout: (before, after, branch) => ({ script: script("post-checkout"), env: { PRE_COMMIT_FROM_REF: before, PRE_COMMIT_TO_REF: after, PRE_COMMIT_CHECKOUT_TYPE: branch } }),
      rewrite: (command) => ({ script: script("post-rewrite"), env: { PRE_COMMIT_REWRITE_COMMAND: command } }),
    });
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("hook install names the file each post hook goes into when a hooks folder holds them", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, {});
    sh(["git", "config", "core.hooksPath", ".githooks"], { cwd: fork.path });
    mkdirSync(join(fork.path, ".githooks"));
    writeFileSync(join(fork.path, ".githooks/pre-commit"), "#!/bin/sh\necho theirs\n", { mode: 0o755 });
    writeFileSync(join(fork.path, ".githooks/post-merge"), "#!/bin/sh\necho theirs\n", { mode: 0o755 });
    const install = t.pb(["hook", "install"], { cwd: fork.path }).stderr;
    for (const event of POST_EVENTS) expect(install).toContain(`.githooks/${event}`);
    expect(install).toContain("#!/bin/sh");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("hook install prints the whole block to merge by hand when the config can't take a paste", () => {
  const t = new Case();
  try {
    const existing = "pre-commit: { commands: { lint: { run: echo lint } } }\n";
    const fork = forkWith(t, { "lefthook.yml": existing });
    const install = t.pb(["hook", "install"], { cwd: fork.path }).stderr;
    expect(install).toContain("can't tell where in lefthook.yml to add its lines, because its pre-commit key is written inline");
    expect(install).not.toContain("Add this");
    const whole = install.split("keep patchbook's first:\n\n")[1]!.split("\nLeave parallel off")[0]!;
    expect(parsed.yaml(whole)["pre-commit"].commands.patchbook.priority).toBe(1);
    expect(fork.read("lefthook.yml")).toBe(existing);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const [config, existing] of [
  ["lefthook.yml", "pre-commit:\n  commands:\n    patchbook:\n      run: patchbook hook run || exit 1\n"],
  ["lefthook.json", '{ "pre-commit": { "commands": { "patchbook": { "run": "patchbook hook run || exit 1" } } } }'],
  [".pre-commit-config.yaml", "repos:\n  - repo: local\n    hooks:\n      - id: patchbook\n        name: patchbook\n        entry: patchbook hook run\n        language: system\n        pass_filenames: false\n        always_run: true\n"],
] as const) {
  test(`hook install adds nothing to ${config} once it holds patchbook's hook`, () => {
    const t = new Case();
    try {
      const fork = forkWith(t, { [config]: existing });
      const install = t.pb(["hook", "install"], { cwd: fork.path }).stderr;
      expect(install).not.toContain("Add this");
      expect(install).not.toContain("can't tell where");
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

for (const [config, existing, dispatcher, parse] of [
  ["lefthook.json", "{}", LEFTHOOK_DISPATCHER, parsed.json],
  ["lefthook.yml", "# hooks\n", LEFTHOOK_DISPATCHER, parsed.yaml],
  [".pre-commit-config.yaml", "repos: []\n", PRE_COMMIT_DISPATCHER, parsed.yaml],
] as const) {
  test(`the pre-commit and post hook lines paste one after the other into ${config} that has none of them`, () => {
    const t = new Case();
    try {
      const fork = forkWith(t, { [config]: existing });
      installDispatchers(fork, ["pre-commit", ...POST_EVENTS], dispatcher);
      const merged = parse(paste(existing, t.pb(["hook", "install"], { cwd: fork.path }).stderr));
      if (config === ".pre-commit-config.yaml") {
        expect(merged.repos.flatMap((r: any) => r.hooks.map((h: any) => h.id)).sort()).toEqual(["patchbook", "patchbook-post-checkout", "patchbook-post-merge", "patchbook-post-rewrite"]);
      } else {
        expect(Object.keys(merged).sort()).toEqual(["post-checkout", "post-merge", "post-rewrite", "pre-commit"]);
      }
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

const SOMEONE_ELSES = "echo mine";
const CALLS = { "pre-commit": "patchbook hook run || exit 1", "post-merge": "patchbook hook build" } as const;
const lefthookCommand = (event: string, name: string, run: string) => `${event}:\n  commands:\n    ${name}:\n      run: ${run}\n`;
const lefthookJob = (event: string, name: string, run: string) => `${event}:\n  jobs:\n    - name: ${name}\n      run: ${run}\n`;
const lefthookJsonCommand = (event: string, name: string, run: string) => `{ "${event}": { "commands": { "${name}": { "run": "${run}" } } } }\n`;
const lefthookTomlCommand = (event: string, name: string, run: string) => `[${event}.commands.${name}]\nrun = "${run}"\n`;
const PRE_COMMIT_RUNS_ALWAYS = "        pass_filenames: false\n        always_run: true\n";
const preCommitHook = (id: string, entry: string, extra = PRE_COMMIT_RUNS_ALWAYS, repo = "local") => `repos:\n  - repo: ${repo}\n    hooks:\n      - id: ${id}\n        name: ${id}\n        entry: ${entry}\n        language: system\n${extra}`;

const COLLISIONS: [string, string, string, string][] = [
  ["a lefthook YAML command", "lefthook.yml", lefthookCommand("pre-commit", "patchbook", SOMEONE_ELSES), "command"],
  ["a lefthook YAML job", "lefthook.yml", lefthookJob("pre-commit", "patchbook", SOMEONE_ELSES), "job"],
  ["a lefthook JSON command", "lefthook.json", lefthookJsonCommand("pre-commit", "patchbook", SOMEONE_ELSES), "command"],
  ["a lefthook TOML command", "lefthook.toml", lefthookTomlCommand("pre-commit", "patchbook", SOMEONE_ELSES), "command"],
  ["a local pre-commit hook", ".pre-commit-config.yaml", preCommitHook("patchbook", SOMEONE_ELSES), "hook"],
  ["a hook from a remote pre-commit repo", ".pre-commit-config.yaml", `repos:\n  - repo: https://example.com/other/hooks\n    rev: v1\n    hooks:\n      - id: patchbook\n`, "hook"],
  ["a local pre-commit hook given arguments", ".pre-commit-config.yaml", preCommitHook("patchbook", "patchbook hook run", PRE_COMMIT_RUNS_ALWAYS + "        args: [--verbose]\n"), "hook"],
  ["a local pre-commit hook that default_stages keep from the commit", ".pre-commit-config.yaml", "default_stages: [pre-push]\n" + preCommitHook("patchbook", "patchbook hook run"), "hook"],
];

for (const [name, config, existing, kind] of COLLISIONS) {
  test(`hook install says so when ${name} is called patchbook and doesn't run it`, () => {
    const t = new Case();
    try {
      const fork = forkWith(t, { [config]: existing });
      const install = t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr;
      expect(install).toContain(`can't tell where in ${config} to add its lines, because its`);
      expect(install).toContain(`already has a ${kind}`);
      expect(install).toContain("that doesn't always call `patchbook hook run`");
      expect(install).toContain("Merge this into");
      expect(fork.read(config)).toBe(existing);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("hook install checks a post hook for its own call, not for the pre-commit one", () => {
  const t = new Case();
  try {
    const existing = lefthookCommand("pre-commit", "patchbook", CALLS["pre-commit"]) + lefthookCommand("post-merge", "patchbook", "patchbook hook run");
    const fork = forkWith(t, { "lefthook.yml": existing });
    installDispatchers(fork, ["pre-commit", "post-merge"], LEFTHOOK_DISPATCHER);
    const install = t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr;
    expect(install).toContain("already has a command named patchbook that doesn't always call `patchbook hook build`");
    expect(install).not.toContain("pre-commit already has");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

const OTHER_NAMES: [string, string, string][] = [
  ["a lefthook YAML command", "lefthook.yml", lefthookCommand("pre-commit", "record", CALLS["pre-commit"])],
  ["a lefthook YAML job", "lefthook.yml", lefthookJob("pre-commit", "record", CALLS["pre-commit"])],
  ["a lefthook JSON command", "lefthook.json", lefthookJsonCommand("pre-commit", "record", CALLS["pre-commit"])],
  ["a lefthook TOML command", "lefthook.toml", lefthookTomlCommand("pre-commit", "record", CALLS["pre-commit"])],
  ["a local pre-commit hook", ".pre-commit-config.yaml", preCommitHook("record", "patchbook hook run")],
  ["a local pre-commit hook with no stages under default_stages that hold the commit", ".pre-commit-config.yaml", "default_stages: [pre-commit]\n" + preCommitHook("record", "patchbook hook run")],
  ["a local pre-commit hook with no stages under default_stages that hold the old commit name", ".pre-commit-config.yaml", "default_stages: [commit, push]\n" + preCommitHook("record", "patchbook hook run")],
  ["a local pre-commit hook whose own stages beat default_stages", ".pre-commit-config.yaml", "default_stages: [pre-push]\n" + preCommitHook("record", "patchbook hook run", PRE_COMMIT_RUNS_ALWAYS + "        stages: [pre-commit]\n")],
  ["a local pre-commit hook with empty args", ".pre-commit-config.yaml", preCommitHook("record", "patchbook hook run", PRE_COMMIT_RUNS_ALWAYS + "        args: []\n")],
  ["a local pre-commit hook with empty stages that default_stages fill with the commit", ".pre-commit-config.yaml", "default_stages: [pre-commit]\n" + preCommitHook("record", "patchbook hook run", PRE_COMMIT_RUNS_ALWAYS + "        stages: []\n")],
];

for (const [name, config, existing] of OTHER_NAMES) {
  test(`hook install adds nothing when ${name} with another name already runs patchbook`, () => {
    const t = new Case();
    try {
      const fork = forkWith(t, { [config]: existing });
      const install = t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr;
      expect(install).not.toContain("Add this");
      expect(install).not.toContain("can't tell where");
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

/** Text that names the call without running it, or might not run it. */
const MENTIONS = [
  `echo "patchbook hook run"`,
  `printf '%s\\n' 'patchbook hook run'`,
  `echo mine # patchbook hook run`,
  `echo mine\\n# patchbook hook run`,
  `my-patchbook hook run`,
  `patchbook hook run-all`,
  `if false; then patchbook hook run; fi`,
  `./node_modules/.bin/patchbook hook run`,
];
const quoted = (run: string) => JSON.stringify(run);
const unquoted = (run: string) => JSON.stringify(run).slice(1, -1);
const lefthookJsonJob = (event: string, name: string, run: string) => `{ "${event}": { "jobs": [{ "name": "${name}", "run": "${run}" }] } }\n`;

const NOT_RUNNING: [string, string, (run: string) => string][] = [
  ["a lefthook YAML command", "lefthook.yml", (run) => lefthookCommand("pre-commit", "diagnostic", quoted(run))],
  ["a lefthook YAML job", "lefthook.yml", (run) => lefthookJob("pre-commit", "diagnostic", quoted(run))],
  ["a lefthook JSON command", "lefthook.json", (run) => lefthookJsonCommand("pre-commit", "diagnostic", unquoted(run))],
  ["a lefthook JSON job", "lefthook.json", (run) => lefthookJsonJob("pre-commit", "diagnostic", unquoted(run))],
  ["a lefthook TOML command", "lefthook.toml", (run) => lefthookTomlCommand("pre-commit", "diagnostic", unquoted(run))],
  ["a local pre-commit hook", ".pre-commit-config.yaml", (run) => preCommitHook("diagnostic", quoted(run))],
];

for (const [name, config, build] of NOT_RUNNING) {
  for (const run of MENTIONS) {
    test(`hook install still adds patchbook's hook when ${name} only mentions the call in ${JSON.stringify(run)}`, () => {
      const t = new Case();
      try {
        const existing = build(run);
        const fork = forkWith(t, { [config]: existing });
        const install = t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr;
        expect(install).toContain("Add this");
        expect(fork.read(config)).toBe(existing);
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);
  }
}

test("hook install names the clash when a command called patchbook only echoes the call", () => {
  const t = new Case();
  try {
    const existing = lefthookCommand("pre-commit", "patchbook", quoted(MENTIONS[0]!));
    const fork = forkWith(t, { "lefthook.yml": existing });
    const install = t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr;
    expect(install).toContain("already has a command named patchbook that doesn't always call `patchbook hook run`");
    expect(fork.read("lefthook.yml")).toBe(existing);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

const GENERATED = lefthookCommand("pre-commit", "patchbook", CALLS["pre-commit"]);
const NOT_ALWAYS: [string, string, string][] = [
  ["a skipped lefthook command", "lefthook.yml", GENERATED.replace("      run:", "      skip: true\n      run:")],
  ["a lefthook command limited with only", "lefthook.yml", GENERATED.replace("      run:", "      only: [merge]\n      run:")],
  ["a lefthook command limited with glob", "lefthook.yml", GENERATED.replace("      run:", "      glob: '*.md'\n      run:")],
  ["a lefthook command run from a subfolder", "lefthook.yml", GENERATED.replace("      run:", "      root: sub/\n      run:")],
  ["a skipped lefthook job", "lefthook.yml", lefthookJob("pre-commit", "patchbook", CALLS["pre-commit"]).replace("      run:", "      skip: true\n      run:")],
  ["a skipped lefthook JSON command", "lefthook.json", '{ "pre-commit": { "commands": { "patchbook": { "skip": true, "run": "patchbook hook run || exit 1" } } } }\n'],
  ["a lefthook TOML command limited with glob", "lefthook.toml", `[pre-commit.commands.patchbook]\nglob = "*.md"\nrun = "patchbook hook run"\n`],
];

for (const [name, config, existing] of NOT_ALWAYS) {
  test(`hook install doesn't take ${name} for patchbook's hook`, () => {
    const t = new Case();
    try {
      const fork = forkWith(t, { [config]: existing });
      const install = t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr;
      expect(install).toContain("that doesn't always call `patchbook hook run`");
      expect(fork.read(config)).toBe(existing);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

/** pre-commit splits `entry` into words and runs them without a shell, and appends the file names unless pass_filenames is false. patchbook rejects extra arguments, so these fail every commit or skip it. */
const PRE_COMMIT_NOT_ALWAYS: [string, string][] = [
  ["an entry with a shell operator", preCommitHook("record", "patchbook hook run || exit 1")],
  ["a hook that is given the file names", preCommitHook("record", "patchbook hook run", "        always_run: true\n")],
  ["a hook that skips commits without matching files", preCommitHook("record", "patchbook hook run", "        pass_filenames: false\n")],
  ["a hook limited to some files", preCommitHook("record", "patchbook hook run", PRE_COMMIT_RUNS_ALWAYS + "        files: ^src/\n")],
  ["a hook limited to some types", preCommitHook("record", "patchbook hook run", PRE_COMMIT_RUNS_ALWAYS + "        types: [python]\n")],
  ["a hook at the manual stage", preCommitHook("record", "patchbook hook run", PRE_COMMIT_RUNS_ALWAYS + "        stages: [manual]\n")],
  ["a hook in another language", preCommitHook("record", "patchbook hook run").replace("language: system", "language: script")],
  ["a hook with no stages under default_stages that leave out the commit", "default_stages: [pre-push]\n" + preCommitHook("record", "patchbook hook run")],
  ["a hook with empty stages under default_stages that leave out the commit", "default_stages: [pre-push]\n" + preCommitHook("record", "patchbook hook run", PRE_COMMIT_RUNS_ALWAYS + "        stages: []\n")],
  ["a hook with no stages under an empty default_stages", "default_stages: []\n" + preCommitHook("record", "patchbook hook run")],
  ["a hook given arguments", preCommitHook("record", "patchbook hook run", PRE_COMMIT_RUNS_ALWAYS + "        args: [--verbose]\n")],
];

for (const [name, existing] of PRE_COMMIT_NOT_ALWAYS) {
  test(`hook install doesn't take ${name} for patchbook's hook`, () => {
    const t = new Case();
    try {
      const fork = forkWith(t, { ".pre-commit-config.yaml": existing });
      const install = t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr;
      expect(install).toContain("Add this");
      expect(fork.read(".pre-commit-config.yaml")).toBe(existing);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("hook install checks a post hook's own call, not an echo of it", () => {
  const t = new Case();
  try {
    const existing = GENERATED + lefthookCommand("post-merge", "diagnostic", quoted(`echo "patchbook hook build"`));
    const fork = forkWith(t, { "lefthook.yml": existing });
    installDispatchers(fork, ["pre-commit", "post-merge"], LEFTHOOK_DISPATCHER);
    const install = t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr;
    expect(install).toContain("runs this repo's post-merge hook. Add this");
    expect(install).not.toContain("pre-commit hooks. Add this");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("hook install checks a pre-commit framework post hook's own call, not an echo of it", () => {
  const t = new Case();
  try {
    const existing = preCommitHook("record", "patchbook hook run").replace("hooks:\n", "hooks:\n      - id: diagnostic\n        name: diagnostic\n        entry: echo patchbook hook build\n        language: system\n        stages: [post-merge]\n        pass_filenames: false\n        always_run: true\n");
    const fork = forkWith(t, { ".pre-commit-config.yaml": existing });
    installDispatchers(fork, ["pre-commit", "post-merge"], PRE_COMMIT_DISPATCHER);
    const install = t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr;
    expect(install).toContain("runs this repo's post-merge hook. Add this");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

const POST_MERGE_HOOK = "      - id: merged\n        name: merged\n        entry: patchbook hook build\n        language: system\n        pass_filenames: false\n        always_run: true\n";
const commitHook = preCommitHook("record", "patchbook hook run", PRE_COMMIT_RUNS_ALWAYS + "        stages: [commit]\n");

test("hook install gives a pre-commit post hook with no stages the stages default_stages name", () => {
  const t = new Case();
  try {
    const aimed = (stages: string) => `default_stages: [${stages}]\n${commitHook}${POST_MERGE_HOOK}`;
    const fork = forkWith(t, { ".pre-commit-config.yaml": aimed("pre-commit") });
    installDispatchers(fork, ["pre-commit", "post-merge"], PRE_COMMIT_DISPATCHER);
    expect(t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr).toContain("runs this repo's post-merge hook. Add this");
    writeFileSync(join(fork.path, ".pre-commit-config.yaml"), aimed("post-merge"));
    expect(t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr).not.toContain("Add this");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const [config, existing, rename, dispatcher] of [
  ["lefthook.yml", "pre-commit:\n  commands:\n    lint:\n      run: echo lint\n", (m: string) => m.replace(/^(\s+)patchbook:$/gm, "$1record:"), LEFTHOOK_DISPATCHER],
  ["lefthook.json", '{ "pre-commit": { "commands": { "lint": { "run": "echo lint" } } } }\n', (m: string) => m.replaceAll('"patchbook": {', '"record": {'), LEFTHOOK_DISPATCHER],
  [".pre-commit-config.yaml", "repos: []\n", (m: string) => m.replace(/^(\s+(?:id|name): )patchbook/gm, "$1record"), PRE_COMMIT_DISPATCHER],
] as const) {
  test(`hook install adds nothing to ${config} once the lines it printed are there under another name`, () => {
    const t = new Case();
    try {
      const fork = forkWith(t, { [config]: existing });
      installDispatchers(fork, ["pre-commit", ...POST_EVENTS], dispatcher);
      const merged = rename(paste(existing, t.pb(["hook", "install"], { cwd: fork.path }).stderr));
      writeFileSync(join(fork.path, config), merged);
      const again = t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr;
      expect(again).not.toContain("Add this");
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

const COMMENTED_LITERALS = ["false// no colour", "true// no colour", "null// no colour", "1.5// no colour", "-1e-3/* a comment */", "false /* a comment */// and another"];

for (const literal of COMMENTED_LITERALS) {
  test(`a lefthook JSONC comment right after ${literal.split(/\/[/*]/)[0]} doesn't stop the paste`, () => {
    const t = new Case();
    try {
      const existing = `{\n  "colors": ${literal}\n  ,\n  "pre-commit": {\n    "commands": {\n      "lint": { "run": "echo \\"// not a comment\\"" }\n    }\n  }\n}\n`;
      const fork = forkWith(t, { "lefthook.jsonc": existing });
      const install = t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr;
      const merged = Bun.JSONC.parse(paste(existing, install)) as any;
      runsFirst(merged["pre-commit"]);
      expect(merged["pre-commit"].commands.lint.run).toBe('echo "// not a comment"');
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("clone and init finish when the lefthook JSONC has a comment right after a value", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.write("lefthook.jsonc", '{\n  "colors": false// no colour\n  ,\n  "pre-commit": { "commands": { "lint": { "run": "echo lint" } } }\n}\n');
    up.commit("start");
    const cloned = t.pb(["clone", up.path, "fork"], { cwd: t.tmp, timeout: 30_000 });
    expect(cloned.stderr).toContain("Add this");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const forked = t.pb(["init", "--upstream", up.path], { cwd: join(t.tmp, "mine"), timeout: 30_000 });
    expect(forked.stderr).toContain("Add this");
    expect(existsSync(join(t.tmp, "mine/.patchbook"))).toBe(true);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

const UNSUPPORTED_JSON: [string, string][] = [
  ["single-quoted keys", `{'pre-commit': {'commands': {'lint': {'run': 'echo lint'}}}}\n`],
  ["single-quoted values holding braces", `{"colors": '}{', "pre-commit": {"commands": {"lint": {"run": '{]'}}}}\n`],
  ["a single-quoted value before the commands", `{"pre-commit": {"parallel": 'a"', "commands": {"lint": {"run": "x"}}}}\n`],
];

for (const [name, existing] of UNSUPPORTED_JSON) {
  test(`hook install and clone return for lefthook JSON with ${name}`, () => {
    const t = new Case();
    try {
      const fork = forkWith(t, {});
      writeFileSync(join(fork.path, "lefthook.json"), existing);
      const install = t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr;
      expect(install).toMatch(/Add this|can't tell where in lefthook.json/);
      expect(fork.read("lefthook.json")).toBe(existing);
      const up = new Repo(join(t.tmp, "up2"));
      up.write("app.txt", "one\n");
      writeFileSync(join(up.path, "lefthook.json"), existing);
      up.commit("start");
      const cloned = t.pb(["clone", up.path, "fork2"], { cwd: t.tmp, timeout: 30_000 });
      expect(cloned.stderr).toMatch(/Add this|can't tell where in lefthook.json/);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

for (const [name, existing] of [["a document end marker", "colors: false\n...\n"], ["an empty flow map", "{}\n"]] as const) {
  test(`hook install gives lefthook YAML with ${name} to merge by hand, not an append lefthook skips`, () => {
    const t = new Case();
    try {
      const fork = forkWith(t, { "lefthook.yml": existing });
      installDispatchers(fork, ["pre-commit"], LEFTHOOK_DISPATCHER);
      const install = t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr;
      expect(install).toContain("can't tell where in lefthook.yml to add its lines");
      expect(install).not.toContain("Add this");
      const whole = install.split("keep patchbook's first:\n\n")[1]!.split("\nLeave parallel off")[0]!;
      runsFirst(parsed.yaml(whole)["pre-commit"]);
      expect(fork.read("lefthook.yml")).toBe(existing);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("the pre-commit entry limits itself to the commit stage in the spelling every pre-commit accepts", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { ".pre-commit-config.yaml": "repos: []\n" });
    const install = t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr;
    expect(install).toContain("stages: [commit]");
    expect(install).not.toContain("stages: [pre-commit]");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("hook install in a repo nested in a fork fails instead of installing nothing", () => {
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

test("hook install works from a folder inside the repo that holds the patchbook", () => {
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

test("clone keeps the bytes of a hook that is not UTF-8", () => {
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

test("init leaves the bytes of a husky hook that is not UTF-8 and already runs patchbook", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("skills/a/SKILL.md", "Para one.\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    mkdirSync(join(repo.path, ".husky"));
    const hooked = Buffer.concat([Buffer.from("patchbook hook run || exit 1\r\n"), LATIN1_HOOK]);
    writeFileSync(join(repo.path, ".husky/pre-commit"), hooked);
    repo.commit("start");
    installManager(repo, ".husky");
    const init = t.pb(["init", "--upstream", up.path, "--output-from", "skills", "--output-to", "skills"], { cwd: repo.path });
    expect(init.stderr).not.toContain("pre-commit");
    expect(readFileSync(join(repo.path, ".husky/pre-commit"))).toEqual(hooked);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("a hook script in the tree does not hide another tool's git hook", () => {
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

test("a core.hooksPath elsewhere wins over a lefthook config", () => {
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

test("clone does not write through a linked hook script", () => {
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

test("a commented patchbook line does not count as running it", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { ".vite-hooks/pre-commit": "# TODO: patchbook hook run\n" + NOTE_STAGED });
    expect(fork.read(".vite-hooks/pre-commit")).toContain("patchbook hook run || exit 1");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("hook install records a manager script that runs patchbook unrecorded", () => {
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

test("init in a fork stages the series with the hook change", () => {
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

test("status trusts patchbook's hook kept by pre-commit's migration mode", () => {
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

test("hook kept by pre-commit's migration mode without the patchbook check is rewritten", () => {
  const t = new Case();
  try {
    const fork = forkWith(t, { ".pre-commit-config.yaml": "repos: []\n" });
    const legacy = join(fork.path, ".git/hooks/pre-commit.legacy");
    renameSync(join(fork.path, ".git/hooks/pre-commit"), legacy);
    const guarded = readFileSync(legacy, "utf8");
    writeFileSync(legacy, guarded.replace(/^\[ -f .*\n/m, ""), { mode: 0o755 });
    expect(readFileSync(legacy, "utf8")).not.toContain(".patchbook/config.toml");
    const dispatcher = `#!/bin/sh\n# File generated by pre-commit: https://pre-commit.com\n"$(dirname "$0")/pre-commit.legacy" "$@" || exit 1\n`;
    fork.write(".git/hooks/pre-commit", dispatcher, 0o755);
    const install = t.pb(["hook", "install"], { cwd: fork.path }).stderr;
    expect(install).toContain("updated");
    expect(readFileSync(legacy, "utf8")).toBe(guarded);
    expect(read(join(fork.path, ".git/hooks/pre-commit"))).toBe(dispatcher);
    const wt = join(t.tmp, "scratch-wt");
    sh(["git", "worktree", "add", "-q", "--detach", wt, "HEAD~1"], { cwd: fork.path });
    writeFileSync(join(wt, "scratch.txt"), "scratch\n");
    sh(["git", "add", "scratch.txt"], { cwd: wt });
    const commit = sh(["git", "commit", "-q", "-m", "scratch"], { cwd: wt, check: false, env: withHook(t) });
    expect(commit.stderr).not.toContain("refusing");
    expect(commit.code).toBe(0);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("the printed lines are safe in a hooks folder every repo shares", () => {
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

test("clone does not write through a linked hook folder", () => {
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

test("a leftover legacy hook does not hide another tool's hook", () => {
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

test("a lefthook config does not hide a dispatcher that is not lefthook's", () => {
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

test("hook install puts patchbook first in a husky folder below the root", () => {
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

test("hook install stages record files git ignores", () => {
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

test("status is quiet once a linked husky folder runs patchbook", () => {
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
    expect(t.pb(["status"], { cwd: fork.path, code: 1 }).stderr).not.toContain("doesn't run");
    expect(t.pb(["hook", "install"], { cwd: fork.path }).stderr).not.toContain("_/pre-commit");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("a pre-commit dispatcher that mentions lefthook is still pre-commit's", () => {
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

test("migration mode advice follows pre-commit not a stray lefthook config", () => {
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

test("read-only commands do not install the hook", () => {
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

test("commands that change things install the hook", () => {
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

test("no command installs the hook while hook.enabled is false", () => {
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

test("hook status says which hook git runs and whether it calls patchbook", () => {
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

test("hook status says when git runs no hook and does not write one", () => {
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

test("hook status names the file that calls patchbook", () => {
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

test("hook status says when git ignores a hook that is not executable", () => {
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

test("no command installs the hook while PATCHBOOK_HOOK is 0", () => {
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
  test(`clone does not say the hook records when ${how === "user config" ? "the user config" : "PATCHBOOK_HOOK"} turned it off`, () => {
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

test("clone says the hook records only when it was installed", () => {
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

test("hook install names the setting that turned the hook off", () => {
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

test("install commands make patchbook's own hook executable again", () => {
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

test("install commands leave another tool's hook alone and hook install says git ignores it", () => {
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

for (const how of ["user config"] as const) {
  const huskyFiles = { ".husky/pre-commit": NOTE_STAGED };
  const noInstall = (repo: Repo): void => {
    expect(existsSync(hookFile(repo))).toBe(false);
    expect(repo.read(".husky/pre-commit")).toBe(NOTE_STAGED);
    expect(sh(["git", "diff", "--cached", "--name-only"], { cwd: repo.path }).stdout).toBe("");
    expect(sh(["git", "status", "--porcelain", "--", ".husky"], { cwd: repo.path }).stdout).toBe("");
  };

  test(`clone of a husky repo installs nothing while hook.enabled is off by ${how}`, () => {
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

  test(`init in a husky repo installs nothing while hook.enabled is off by ${how}`, () => {
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

  test(`track in a husky fork installs nothing while hook.enabled is off by ${how}`, () => {
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

test("hook run never installs or writes a hook", () => {
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

test("commands that install skip a patchbook in the repo around the one you are in", () => {
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

test("commands that install treat a linked worktree of the book repo as the same repo", () => {
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
  test(`status and hook status say when ${name === "husky" ? "husky" : "Vite+"} has not installed its hook in a new worktree`, () => {
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

  for (const [what, path, test] of [
    [".PATCHBOOK", ".PATCHBOOK/x.md", forkTestOnCaseSensitiveFs],
    [".patchbook.", ".patchbook./x.md", forkTest],
    [".patchbook and a space", ".patchbook /x.md", forkTest],
  ] as const) {
    test(`hook refuses a staged file under ${what} before recording it`, (t) => {
      const place = ".patchbook";
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
  }

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
    ["add absolute", "add /outside.txt"],
    ["copy dest climbing out", "copy app.txt -> ../copied.txt"],
    ["copy source climbing out", "copy ../app.txt -> copied.txt"],
    ["copy dest ./.patchbook/config.toml", "copy app.txt -> ./.patchbook/config.toml"],
    ["add ./.patchbook/new.md", "add ./.patchbook/new.md"],
    ["delete docs//guide.md", "delete docs//guide.md"],
    ["add climbing out with a backslash", "add ..\\outside.txt"],
    ["add backslash in a name", "add docs\\new.md"],
    ["replace backslash", "replace docs\\guide.md"],
    ["delete backslash", "delete docs\\guide.md"],
    ["file backslash", "file docs\\guide.md"],
    ["copy source backslash", "copy docs\\guide.md -> copied.md"],
    ["copy dest backslash", "copy app.txt -> docs\\copied.md"],
    ["copy dest .patchbook backslash config.toml", "copy app.txt -> .patchbook\\config.toml"],
    ["move dest with a leading backslash", "move docs/guide.md -> \\guide.md"],
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

  for (const to of ["skills/.git", "a/b/.git/c"]) {
    vendorTest(`output folder ${to} has a git segment and is rejected`, (t) => {
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

  for (const to of [".GIT", ".Git/x", "out/.gIT/y"]) {
    vendorTest(`output folder ${to} has a git segment in another case and is rejected`, (t) => {
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
    [".git.", ".git."],
    [".git and a space", ".git "],
    ["GIT~1", "GIT~1"],
    [".git:x", "out/.git:x"],
    ["a backslash before .git", "out/a\\.git"],
    ["a byte order mark before .GIT", "out/\ufeff.GIT/y"],
    [".git then the noncharacter U+FFFE", ".git\ufffe"],
    [".GIT with a zero-width non-joiner and U+FFFF", "out/.GIT\u200c\uffffx/y"],
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

  test("track rejects a mount with a git segment in another case in both layouts", () => {
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
    ["a git file deeper down", "lib", "lib/sub/.git", (repo) => {
      mkdirSync(join(repo.path, "lib/sub"), { recursive: true });
      writeFileSync(join(repo.path, "lib/sub/.git"), gitFile);
      writeFileSync(join(repo.path, "lib/sub/wip.txt"), "uncommitted\n");
    }],
    ["a git dir in capitals", "lib", "lib/.GIT", (repo) => {
      mkdirSync(join(repo.path, "lib/.GIT"), { recursive: true });
      writeFileSync(join(repo.path, "lib/.GIT/HEAD"), "ref: refs/heads/main\n");
    }],
    ["a git dir HFS reads as git", "lib", "lib/.g\u200cit", (repo) => {
      mkdirSync(join(repo.path, "lib/.g\u200cit"), { recursive: true });
      writeFileSync(join(repo.path, "lib/.g\u200cit/HEAD"), "ref: refs/heads/main\n");
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

describe("CrashInjection", () => {
  test("the command under test carries no crash injection", () => {
    const src = join(import.meta.dir, "..", "src");
    const shipped = process.env["PATCHBOOK_CMD"] ? [CMD[0]!] : (readdirSync(src, { recursive: true }) as string[]).filter((p) => p.endsWith(".ts")).map((p) => join(src, p));
    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.filter(carriesCrashInjection)).toEqual([]);
  });

  test("a crash build is found to carry crash injection", () => {
    const dir = mkdtempSync(join(tmpdir(), "crash"));
    try {
      const built = join(dir, "patchbook");
      sh([process.execPath, join(import.meta.dir, "crash-build.ts"), "build", built], { cwd: dir });
      expect(carriesCrashInjection(built)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT);
});

const unreachable = [
  ["a password", "https://user:s3cretpw@127.0.0.1:1/x.git"],
  ["a password with an encoded at sign", "https://user:p%40s3cretpw@127.0.0.1:1/x.git"],
  ["an ssh password with an encoded colon", "ssh://u%3As3cretpw@127.0.0.1:1/x.git"],
] as const;

for (const command of ["check", "status", "sync"]) {
  for (const [what, remote] of unreachable) {
    forkTest(`${command} does not print ${what} of an upstream remote it cannot reach`, (t) => {
      setRemote(join(t.fork.path, ".patchbook/config.toml"), remote);
      const out = t.pb([command], { cwd: t.fork.path, code: null });
      if (command !== "status") expect(out.stderr).toContain("127.0.0.1:1/x.git");
      expect(out.stderr + out.stdout).not.toContain("s3cretpw");
    });
  }
}

for (const command of ["check", "sync"]) {
  forkTest(`${command} does not print the password of a tracked upstream's remote it cannot reach`, (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("lib.txt", "lib\n");
    extra.commit("start");
    t.pb(["track", "extra", extra.path], { cwd: t.fork.path });
    t.fork.commit("track");
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replace(`remote = "${extra.path}"`, 'remote = "https://user:s3cretpw@127.0.0.1:1/x.git"'));
    const out = t.pb([command], { cwd: t.fork.path, code: null });
    expect(out.stderr).toContain("127.0.0.1:1/x.git");
    expect(out.stderr + out.stdout).not.toContain("s3cretpw");
  });
}

forkTest("status names an upstream with no name by its host, not the password in its remote", (t) => {
  const config = join(t.fork.path, ".patchbook/config.toml");
  writeFileSync(config, read(config).replace(/^name = .*\n/m, "").replace(/^remote = .*$/m, 'remote = "https://user:s3cretpw@127.0.0.1:1"'));
  const out = t.pb(["status"], { cwd: t.fork.path, code: 1 });
  expect(out.stderr).toContain("upstream 127.0.0.1:1 has no pin yet");
  expect(out.stderr + out.stdout).not.toContain("s3cretpw");
});
