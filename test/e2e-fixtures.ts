import { expect, test } from "bun:test";
import { accessSync, constants, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { CheckJson, UpstreamCheck, UpstreamLock, UpstreamPin } from "../src/api.ts";
import { Case, Repo, TIMEOUT, dedent, sh, words } from "./helpers";

export const read = (p: string): string => readFileSync(p, "utf8");
export const isSymlink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
export const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Every file and link under root except `.git`, by path, so a test can see that nothing changed. */
export const tree = (root: string): Record<string, string> => {
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

export const storeOf = (t: Case): string => join(t.tmp, "store/upstreams", readdirSync(join(t.tmp, "store/upstreams"))[0]!);
export const checkedUpstream = (stdout: string, name: string): UpstreamCheck => (JSON.parse(stdout) as CheckJson).upstreams.find((u) => u.name === name)!;

export const lockPin = (lock: string, name: string): UpstreamPin => (JSON.parse(lock) as UpstreamLock).upstreams.find((p) => p.name === name)!;
export const lockNames = (lock: string): string[] => (JSON.parse(lock) as UpstreamLock).upstreams.map((p) => p.name);
export const withPin = (lock: string, pin: UpstreamPin): string => {
  const doc = JSON.parse(lock) as UpstreamLock;
  return JSON.stringify({ ...doc, upstreams: [...doc.upstreams.filter((p) => p.name !== pin.name), pin] }, null, 2) + "\n";
};

export const gc = (store: string): void => void sh(["git", "gc", "-q", "--prune=now"], { cwd: store });

export const markerScript = (t: Case, name: string): string => {
  const marker = join(t.tmp, `${name}-ran`);
  writeFileSync(join(t.tmp, "bin", name), `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });
  return marker;
};
export const setRemote = (config: string, remote: string): void => writeFileSync(config, read(config).replace(/^remote = .*$/m, `remote = "${remote}"`));

export const snapshot = (dir: string): Record<string, string> =>
  Object.fromEntries(
    (readdirSync(dir, { recursive: true }) as string[]).filter((p) => statSync(join(dir, p)).isFile()).sort().map((p) => [p, read(join(dir, p))]),
  );

export const forkOf = (t: Case, up: Repo): Repo => {
  sh(["git", "clone", "-q", up.path, "fork"], { cwd: t.tmp });
  const fork = new Repo(join(t.tmp, "fork"));
  fork.write("mine.txt", "mine\n");
  fork.commit("mine");
  return fork;
};

export class ForkCase extends Case {
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

export class VendorCase extends Case {
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

export function forkTest(name: string, body: (t: ForkCase) => void): void {
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
export const forkTestOnCaseSensitiveFs = caseSensitiveFs ? forkTest : (name: string, _body: (t: ForkCase) => void) => test.skip(name, () => {});

export function vendorTest(name: string, body: (t: VendorCase) => void): void {
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
export function installManager(repo: Repo, dir: string): void {
  repo.write(`${dir}/_/.gitignore`, "*\n");
  repo.write(`${dir}/_/pre-commit`, `#!/bin/sh\nsh -e "$(dirname "$(dirname "$0")")/pre-commit"\n`, 0o755);
  sh(["git", "config", "core.hooksPath", `${dir}/_`], { cwd: repo.path });
}

export const NOTE_STAGED = `git diff --cached --name-only > "$(git rev-parse --git-dir)/staged-when-checked"\n`;

export function forkWith(t: Case, files: Record<string, string>): Repo {
  const up = new Repo(join(t.tmp, "upstream"));
  up.write("app.txt", "one\ntwo\n");
  for (const [path, text] of Object.entries(files)) up.write(path, text);
  up.commit("start");
  t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
  return new Repo(join(t.tmp, "fork"));
}

export const withHook = (t: Case) => ({ ...t.env, PATCHBOOK_HOOK: "1" });
export const committedFiles = (repo: Repo): string[] => words(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: repo.path }).stdout);

export const SKILL_FILE = ".agents/skills/patchbook-update/SKILL.md";

export function initFork(t: Case, edit = false): Repo {
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

export const AWKWARD = (word: string): string => `${word}"q\\b😀`;

export const upstreamsOf = (config: string): Record<string, unknown>[] => (Bun.TOML.parse(config) as { upstream: Record<string, unknown>[] }).upstream;

/** Every folder, file and link under root except `.git`, with each file's mode, so a test can see that a run left nothing behind. */
const onDisk = (root: string): Record<string, string> =>
  Object.fromEntries((readdirSync(root, { recursive: true }) as string[]).filter((p) => p !== ".git" && !p.startsWith(".git/")).sort().map((p) => {
    const at = join(root, p);
    const stat = lstatSync(at);
    return [p, stat.isSymbolicLink() ? `-> ${readlinkSync(at)}` : stat.isDirectory() ? "folder" : `${(stat.mode & 0o777).toString(8)} ${read(at)}`];
  }));

/** What a failed init must leave as it found it: the remotes and the rest of the git config, the index, the hooks, and the working tree. */
export const repoState = (repo: string) => ({
  remotes: sh(["git", "remote", "-v"], { cwd: repo }).stdout,
  config: read(join(repo, ".git/config")),
  index: sh(["git", "ls-files", "--stage"], { cwd: repo }).stdout,
  hooks: tree(join(repo, ".git/hooks")),
  files: onDisk(repo),
});

// Stands in for ssh by running the remote command here, so scp and ssh:// URLs reach a local repo.
export const fakeSsh = (t: Case): string => {
  const script = join(t.tmp, "bin/fake-ssh");
  writeFileSync(script, "#!/bin/sh\nfor a; do cmd=$a; done\nexec sh -c \"$(printf '%s' \"$cmd\" | sed 's/^git-upload-pack/git upload-pack/')\"\n", { mode: 0o755 });
  t.env["GIT_SSH_COMMAND"] = script;
  process.env["GIT_SSH_COMMAND"] = script;
  return script;
};

/** A repo to start a patchbook in, in either layout, following an upstream with one file, with the update skill on. */
export function startingRepo(t: Case, layout: string): { up: Repo; repo: Repo; output: string[] } {
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
