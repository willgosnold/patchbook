// Paths the other suites leave out: the codex provider, the first installed model CLI, a sync that fails
// partway, `check` before a pin, the hook inside another tool's pre-commit, and paragraph planning.

import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckJson, UpstreamCheck, UpstreamLock } from "../src/api.ts";
import { shellQuote as q } from "../src/lib/proc.ts";
import { Case, Repo, sh, words } from "./helpers";

const TIMEOUT = 120_000;

const read = (p: string): string => readFileSync(p, "utf8");
const checked = (stdout: string, name: string): UpstreamCheck => (JSON.parse(stdout) as CheckJson).upstreams.find((u) => u.name === name)!;
const lines = (text: string): string[] => text.split("\n").filter(Boolean);

/** A stand-in for a model CLI: it keeps its arguments and stdin under `logs`, counts its calls, then answers. */
function fakeCli(dir: string, name: string, logs: string, reply: string, code = 0, stderr = ""): void {
  mkdirSync(dir, { recursive: true });
  const fake = join(dir, name);
  writeFileSync(fake, `#!/bin/sh
printf x >> ${q(join(logs, `${name}.calls`))}
printf '%s\\n' "$@" > ${q(join(logs, `${name}.args`))}
cat > ${q(join(logs, `${name}.prompt`))}
printf '%s\\n' ${q(reply)}
${stderr ? `printf '%s\\n' ${q(stderr)} >&2\n` : ""}exit ${code}
`);
  chmodSync(fake, 0o755);
}

const answer = (change: string, intent: string): string => JSON.stringify({ change, intent });

/** A case with no model settings from the environment, so each test sets the ones it means to use. */
class Sandbox extends Case {
  constructor() {
    super();
    for (const k of ["PATCHBOOK_PROVIDER", "PATCHBOOK_MODEL", "PATCHBOOK_EFFORT", "PATCHBOOK_INTENT"]) delete this.env[k];
  }

  get bin(): string {
    return join(this.tmp, "bin");
  }

  fake(name: string, reply: string, code = 0, stderr = ""): void {
    fakeCli(this.bin, name, this.tmp, reply, code, stderr);
  }

  args(name: string): string[] {
    return lines(read(join(this.tmp, `${name}.args`)));
  }

  called(name: string): boolean {
    return existsSync(join(this.tmp, `${name}.args`));
  }

  calls(name: string): number {
    return this.called(name) ? read(join(this.tmp, `${name}.calls`)).length : 0;
  }

  /** A PATH holding git, cat and these fake model CLIs, and nothing else. */
  pathWith(...names: string[]): string {
    const dir = join(this.tmp, `path-${names.join("-") || "none"}`);
    mkdirSync(dir, { recursive: true });
    for (const tool of ["git", "cat"]) symlinkSync(Bun.which(tool)!, join(dir, tool));
    for (const name of names) fakeCli(dir, name, this.tmp, answer(`from-${name}`, `${name} wrote this.`));
    return dir;
  }
}

/** A fork of an upstream with one file, ready for a hand edit. */
class Fork extends Sandbox {
  readonly up: Repo;
  readonly fork: Repo;

  constructor() {
    super();
    this.up = new Repo(join(this.tmp, "upstream"));
    this.up.write("app.txt", "one\ntwo\nthree\n");
    this.up.commit("start");
    this.pb(["clone", this.up.path, "fork"], { cwd: this.tmp });
    this.fork = new Repo(join(this.tmp, "fork"));
  }

  edit(): void {
    this.fork.write("app.txt", this.fork.read("app.txt").replaceAll("two", "TWO"));
  }

  record(args: string[] = [], code: number | null = 0) {
    return this.pb(["record", ...args], { cwd: this.fork.path, code });
  }

  /** Every change's name and CHANGE.md, to look for anything taken from a model answer. */
  changeText(): string {
    return this.changes().map((c) => `${c}\n${this.fork.read(`.patchbook/changes/${c}/CHANGE.md`)}`).join("\n");
  }

  changes(): string[] {
    const dir = join(this.fork.path, ".patchbook/changes");
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }
}

/** Two upstreams in the folder layout: `alpha` is followed from the start, `beta` is added by `trackBeta` or by hand. */
class Duo extends Sandbox {
  readonly alpha: Repo;
  readonly beta: Repo;
  readonly repo: Repo;

  constructor() {
    super();
    this.alpha = new Repo(join(this.tmp, "alpha-up"));
    this.alpha.write("a.md", "alpha\n");
    this.alpha.write("docs/b.md", "alpha docs\n");
    this.alpha.commit("start");
    this.beta = new Repo(join(this.tmp, "beta-up"));
    this.beta.write("c.md", "beta\n");
    this.beta.commit("start");
    this.repo = new Repo(join(this.tmp, "repo"));
    this.repo.write("README.md", "mine\n");
    this.repo.commit("start");
    this.pb(["init", "--upstream", this.alpha.path, "--name", "alpha", "--output-to", "out"], { cwd: this.repo.path });
  }

  get lockPath(): string {
    return join(this.repo.path, ".patchbook/upstream.lock");
  }

  lock(): Record<string, { commit: string; tree: string }> {
    const lock: UpstreamLock = JSON.parse(read(this.lockPath));
    return Object.fromEntries(lock.upstreams.map(({ name, ...pin }) => [name, pin]));
  }

  trackBeta(): void {
    this.pb(["track", "beta", this.beta.path, "--mount", "beta"], { cwd: this.repo.path });
  }

  /** Follow beta the way a hand edit of the config does, with no sync, so it has no pin. */
  followBetaByHand(): void {
    appendFileSync(join(this.repo.path, ".patchbook/config.toml"), `\n[[upstream]]\nname = "beta"\nremote = "${this.beta.path}"\nmount = "beta"\n`);
  }

  check(code: number) {
    return this.pb(["check"], { cwd: this.repo.path, code });
  }

  /** Both upstreams get a new commit. */
  moveBoth(): { alpha: string; beta: string } {
    this.alpha.write("a.md", "alpha moved\n");
    const alpha = this.alpha.commit("move alpha");
    this.beta.write("c.md", "beta moved\n");
    const beta = this.beta.commit("move beta");
    return { alpha, beta };
  }

  loseBeta(): void {
    renameSync(this.beta.path, `${this.beta.path}.gone`);
  }
}

function sandboxTest<T extends Case>(make: () => T, name: string, body: (t: T) => void): void {
  test(name, () => {
    const t = make();
    try {
      body(t);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

const forkTest = (name: string, body: (t: Fork) => void): void => sandboxTest(() => new Fork(), name, body);
const duoTest = (name: string, body: (t: Duo) => void): void => sandboxTest(() => new Duo(), name, body);
const docTest = (name: string, body: (t: Doc) => void): void => sandboxTest(() => new Doc(), name, body);

describe("the codex provider", () => {
  forkTest("record calls codex as configured and takes its name and intent from the answer", (t) => {
    t.env["PATCHBOOK_PROVIDER"] = "codex";
    t.fake("codex", answer("codex-shout", "Shout the second line."));
    t.edit();
    const out = t.record().stdout;
    const args = t.args("codex");
    expect(args.slice(0, 9)).toEqual(["exec", "-m", "gpt-6-luna", "-c", "model_reasoning_effort=high", "--skip-git-repo-check", "-s", "read-only", "--ephemeral"]);
    expect(args[9]).toBe("-C");
    expect(args).toHaveLength(12);
    expect(args[11]).toBe("-");
    expect(args[10]).not.toBe(t.fork.path);
    expect(existsSync(args[10]!)).toBe(false);
    const prompt = read(join(t.tmp, "codex.prompt"));
    expect(prompt).toContain("disk/app.txt");
    expect(prompt).toContain("-two\n+TWO");
    expect(prompt).toContain('Reply with only a JSON object: {"change": "<name>", "intent": "<intent>"}.');
    expect(out).toContain("codex-shout: Shout the second line.");
    expect(t.changes()).toEqual(["codex-shout"]);
    expect(t.fork.read(".patchbook/changes/codex-shout/CHANGE.md")).toContain("intent: Shout the second line.");
    expect(t.fork.read(".patchbook/series")).toContain("codex-shout");
    expect(t.called("claude")).toBe(false);
  });

  forkTest("the model and effort settings reach codex", (t) => {
    t.env["PATCHBOOK_PROVIDER"] = "codex";
    t.env["PATCHBOOK_MODEL"] = "gpt-6-sol";
    t.env["PATCHBOOK_EFFORT"] = "low";
    t.fake("codex", answer("codex-shout", "Shout the second line."));
    t.edit();
    t.record();
    const args = t.args("codex");
    expect(args.slice(0, 5)).toEqual(["exec", "-m", "gpt-6-sol", "-c", "model_reasoning_effort=low"]);
  });

  forkTest("a name given to record wins over the one codex picks", (t) => {
    t.env["PATCHBOOK_PROVIDER"] = "codex";
    t.fake("codex", JSON.stringify({ change: "codex-pick", intent: "Shout the second line." }));
    t.edit();
    t.record(["mine"]);
    expect(t.changes()).toEqual(["mine"]);
    expect(t.fork.read(".patchbook/changes/mine/CHANGE.md")).toContain("intent: Shout the second line.");
    expect(read(join(t.tmp, "codex.prompt"))).toContain('For these edits: they are a new change called mine. Write its intent in "intent".');
  });

  forkTest("a codex that fails is named in the pending note, and no change takes a name or intent from it", (t) => {
    t.env["PATCHBOOK_PROVIDER"] = "codex";
    t.fake("codex", answer("codex-shout", "Shout."), 3, "codex: not logged in");
    t.edit();
    const out = t.record().stdout;
    expect(out).toContain("pending  no intent yet for pending (codex failed: codex: not logged in). To fill it: patchbook intent pending");
    expect(t.changes()).toEqual(["pending"]);
    expect(t.fork.read(".patchbook/changes/pending/CHANGE.md")).toContain("\nintent:\n");
    expect(t.changeText()).not.toContain("codex-shout");
    expect(t.changeText()).not.toContain("Shout.");
  });

  for (const reply of [
    "I could not decide.",
    "{not json}",
    answer("Not Kebab Case", "Shout."),
    answer("codex-shout", ""),
    '{"change": 5, "intent": "Shout."}',
    '{"intent": "Shout."}',
    '{"change": "codex-shout", "intents": {"codex-shout": "Shout."}}',
    '{"change": null, "intent": "Shout."}',
  ]) {
    forkTest(`an answer codex garbles (${reply}) is named in the pending note, and no change takes a name or intent from it`, (t) => {
      t.env["PATCHBOOK_PROVIDER"] = "codex";
      t.fake("codex", reply);
      t.edit();
      const out = t.record().stdout;
      expect(out).toContain("pending  no intent yet for pending (codex didn't return a usable name and intent: codex's reply");
      expect(out).toContain(". To fill it: patchbook intent pending");
      expect(t.called("codex")).toBe(true);
      expect(t.changes()).toEqual(["pending"]);
      expect(t.fork.read(".patchbook/changes/pending/CHANGE.md")).toContain("\nintent:\n");
      for (const taken of ["Not Kebab Case", "not-kebab-case", "codex-shout", "Shout."]) expect(t.changeText()).not.toContain(taken);
    });
  }
});

describe("an unusable reply", () => {
  forkTest("the pending note says why, so the reply's fault can be told from the model's failure", (t) => {
    t.env["PATCHBOOK_PROVIDER"] = "codex";
    t.fake("codex", JSON.stringify({ change: "codex-shout", intents: { "app.txt": "Shout." } }));
    t.edit();
    const out = t.record().stdout;
    expect(out).toContain("pending  no intent yet for pending (codex didn't return a usable name and intent: codex's reply: intent is missing). To fill it: patchbook intent pending");
  });
});

describe("the model CLI patchbook picks when no provider is set", () => {
  for (const [installed, picked] of [
    [["codex"], "codex"],
    [["claude"], "claude"],
    [["claude", "codex"], "claude"],
  ] as const) {
    forkTest(`with ${installed.join(" and ")} installed, record uses ${picked}`, (t) => {
      t.env["PATH"] = t.pathWith(...installed);
      expect(t.pb(["config", "intent.provider"], { cwd: t.fork.path }).stdout).toMatch(new RegExp(`"${picked}" +default`));
      t.edit();
      t.record();
      expect(t.changes()).toEqual([`from-${picked}`]);
      expect(t.fork.read(`.patchbook/changes/from-${picked}/CHANGE.md`)).toContain(`intent: ${picked} wrote this.`);
      for (const name of installed) expect(t.called(name)).toBe(name === picked);
    });
  }

  forkTest("a provider that is set beats the first installed", (t) => {
    t.env["PATH"] = t.pathWith("claude", "codex");
    t.env["PATCHBOOK_PROVIDER"] = "codex";
    t.edit();
    t.record();
    expect(t.changes()).toEqual(["from-codex"]);
    expect(t.called("claude")).toBe(false);
  });
});

describe("a sync that fails partway", () => {
  duoTest("the upstream that can't be fetched is named, its pin stays, and the one before it is pinned", (t) => {
    t.trackBeta();
    const before = t.lock();
    const moved = t.moveBoth();
    t.loseBeta();
    const failed = t.pb(["sync"], { cwd: t.repo.path, code: 1 });
    expect(failed.stderr).toContain(t.beta.path);
    expect(failed.stdout).toContain("alpha: pinned");
    expect(t.lock()["alpha"]!.commit).toBe(moved.alpha);
    expect(t.lock()["beta"]).toEqual(before["beta"]!);
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  duoTest("a branch that upstream no longer has fails the same way", (t) => {
    t.trackBeta();
    const before = t.lock();
    t.moveBoth();
    sh(["git", "branch", "-m", "trunk"], { cwd: t.beta.path });
    const failed = t.pb(["sync"], { cwd: t.repo.path, code: 1 });
    expect(failed.stderr).toContain(t.beta.path);
    expect(t.lock()["beta"]).toEqual(before["beta"]!);
  });

  duoTest("syncing one upstream by name does not touch the broken one", (t) => {
    t.trackBeta();
    const before = t.lock();
    const moved = t.moveBoth();
    t.loseBeta();
    t.pb(["sync", "alpha"], { cwd: t.repo.path });
    expect(t.lock()["alpha"]!.commit).toBe(moved.alpha);
    expect(t.lock()["beta"]).toEqual(before["beta"]!);
    const failed = t.pb(["sync", "beta"], { cwd: t.repo.path, code: 1 });
    expect(failed.stderr).toContain(t.beta.path);
    expect(t.lock()["beta"]).toEqual(before["beta"]!);
  });
});

describe("check before a pin", () => {
  duoTest("an upstream followed but never synced counts as moved, and everything it ships as added", (t) => {
    t.followBetaByHand();
    const lock = read(t.lockPath);
    const head = sh(["git", "rev-parse", "HEAD"], { cwd: t.beta.path }).stdout.trim();
    const r = t.check(10);
    const report: CheckJson = JSON.parse(r.stdout);
    expect(report.moved).toBe(true);
    expect(checked(r.stdout, "alpha")).toMatchObject({ pinned: t.lock()["alpha"]!.commit, moved: false, files: [] });
    expect(checked(r.stdout, "beta")).toMatchObject({ pinned: null, head, moved: true, files: ["added beta/c.md"] });
    expect(report.upstreams.map((u) => u.name)).toEqual(["alpha", "beta"]);
    expect(read(t.lockPath)).toBe(lock);
    expect(existsSync(join(t.repo.path, ".patchbook/last-sync.json"))).toBe(false);
  });

  duoTest("syncing the upstream that had no pin makes check clean", (t) => {
    t.followBetaByHand();
    t.check(10);
    t.pb(["sync", "beta"], { cwd: t.repo.path });
    const out = t.check(0).stdout;
    expect(JSON.parse(out).moved).toBe(false);
    expect(checked(out, "beta")).toMatchObject({ pinned: t.lock()["beta"]!.commit, moved: false, files: [] });
  });

  duoTest("with no lock at all, every upstream is moved", (t) => {
    t.followBetaByHand();
    rmSync(t.lockPath);
    const out = t.check(10).stdout;
    expect(JSON.parse(out).moved).toBe(true);
    expect(checked(out, "alpha")).toMatchObject({ pinned: null, moved: true, files: ["added a.md", "added docs/b.md"] });
    expect(checked(out, "beta")).toMatchObject({ pinned: null, moved: true, files: ["added beta/c.md"] });
    expect(existsSync(t.lockPath)).toBe(false);
  });

  duoTest("an upstream with no pin that can't be reached fails and is named", (t) => {
    t.followBetaByHand();
    t.loseBeta();
    const failed = t.check(1);
    expect(failed.stderr).toContain(t.beta.path);
    expect(failed.stdout).toBe("");
  });

  duoTest("an upstream with no pin and no such branch fails and names the branch", (t) => {
    t.followBetaByHand();
    sh(["git", "branch", "-m", "trunk"], { cwd: t.beta.path });
    const failed = t.check(1);
    expect(failed.stderr).toContain("upstream beta has no branch main");
    expect(failed.stdout).toBe("");
  });
});

describe("the hook inside another tool's pre-commit", () => {
  const otherHook = (t: Fork): string => `#!/bin/sh
echo "other tool: lint" >> ${q(join(t.tmp, "other-tool.log"))}
patchbook hook run || exit $?
git diff --cached --name-only > ${q(join(t.tmp, "staged.txt"))}
`;

  const install = (t: Fork): { hook: string; script: string } => {
    const hook = join(t.fork.path, ".git/hooks/pre-commit");
    const script = otherHook(t);
    writeFileSync(hook, script);
    chmodSync(hook, 0o755);
    return { hook, script };
  };

  const commit = (t: Fork, hookOn: "0" | "1") =>
    sh(["git", "commit", "-qam", "shout"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: hookOn } });

  forkTest("both run: the other tool's work, then a record and a build that are staged into the commit", (t) => {
    const { hook, script } = install(t);
    t.edit();
    commit(t, "1");
    expect(lines(read(join(t.tmp, "other-tool.log")))).toEqual(["other tool: lint"]);
    expect(lines(read(join(t.tmp, "staged.txt")))).toEqual(expect.arrayContaining(["app.txt", ".patchbook/changes/shout/CHANGE.md", ".patchbook/build.lock"]));
    const files = words(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: t.fork.path }).stdout);
    expect(files).toEqual(expect.arrayContaining(["app.txt", ".patchbook/changes/shout/CHANGE.md", ".patchbook/build.lock"]));
    expect(t.fork.read(".patchbook/changes/shout/CHANGE.md")).toContain("intent: Shout the second line.");
    expect(sh(["git", "status", "--porcelain"], { cwd: t.fork.path }).stdout).toBe("");
    expect(read(hook)).toBe(script);
  });

  forkTest("a pin that moved is built into the commit, with the other tool's work run too", (t) => {
    install(t);
    t.up.write("app.txt", "one\ntwo\nthree\nfour\n");
    t.up.commit("add a line");
    t.pb(["sync"], { cwd: t.fork.path });
    sh(["git", "add", ".patchbook"], { cwd: t.fork.path });
    const made = sh(["git", "commit", "-q", "--allow-empty", "-m", "nothing of mine"], { cwd: t.fork.path, env: { ...t.env, PATCHBOOK_HOOK: "1" } });
    expect(made.stderr).toMatch(/patchbook: built from upstream [0-9a-f]+/);
    expect(sh(["git", "show", "HEAD:app.txt"], { cwd: t.fork.path }).stdout).toBe("one\ntwo\nthree\nfour\n");
    expect(lines(read(join(t.tmp, "other-tool.log")))).toEqual(["other tool: lint"]);
    expect(t.changes()).toEqual([]);
  });

  forkTest("the other tool's hook is left alone by patchbook's own commands", (t) => {
    const { hook, script } = install(t);
    t.pb(["status"], { cwd: t.fork.path });
    t.pb(["build"], { cwd: t.fork.path });
    expect(read(hook)).toBe(script);
  });

  forkTest("PATCHBOOK_HOOK=0 skips patchbook's part and the other tool still runs", (t) => {
    install(t);
    t.edit();
    commit(t, "0");
    expect(lines(read(join(t.tmp, "other-tool.log")))).toEqual(["other tool: lint"]);
    expect(t.changes()).toEqual([]);
    expect(words(sh(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: t.fork.path }).stdout)).toEqual(["app.txt"]);
  });
});

/** A folder-layout repo over an upstream guide with five paragraphs, one of which names Cursor and is patched. */
class Doc extends Sandbox {
  readonly repo: Repo;
  readonly entries: string;

  constructor() {
    super();
    const up = new Repo(join(this.tmp, "upstream"));
    up.write("guide.md", "# Guide\n\nOpen Cursor and say hello.\n\nThen wave.\n\nThen sit.\n\nBye.\n");
    up.commit("start");
    this.repo = new Repo(join(this.tmp, "repo"));
    this.repo.write("README.md", "mine\n");
    this.repo.commit("start");
    this.pb(["init", "--upstream", up.path, "--name", "docs", "--output-to", "out"], { cwd: this.repo.path });
    appendFileSync(join(this.repo.path, ".patchbook/config.toml"), String.raw`
[[check]]
name = "cursor"
files = ["**/*.md"]
pattern = '\bCursor\b'
`);
    this.pb(["scaffold"], { cwd: this.repo.path });
    this.entries = join(this.repo.path, ".patchbook/blocks/guide.md.entries");
    const text = read(this.entries).replaceAll("rules: \nintent: \n", "rules: t3\nintent: Speak T3.\n");
    writeFileSync(this.entries, `${text.split("--- patched\n")[0]!}--- patched\nOpen T3 and say hello.\n`);
    this.pb(["build"], { cwd: this.repo.path });
  }

  get guide(): string {
    return "out/guide.md";
  }

  edit(old: string, repl: string): void {
    this.repo.write(this.guide, this.repo.read(this.guide).replaceAll(old, repl));
  }

  record(args: string[] = []) {
    return this.pb(["record", ...args], { cwd: this.repo.path });
  }

  changes(): string[] {
    const dir = join(this.repo.path, ".patchbook/changes");
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }
}

describe("planning paragraph edits", () => {
  docTest("an edit to a patched paragraph updates its entry, keeps its kind, and has the model write its intent again, in one call", (t) => {
    const label = `guide.md [${/^=== entry (\S+)$/m.exec(read(t.entries))![1]}]`;
    t.fake("claude", JSON.stringify({ change: null, intents: { [label]: "Speak T3, and smile." } }));
    t.edit("Open T3 and say hello.", "Open T3 and say hello. Smile.");
    const out = t.record().stdout;
    expect(out).toContain(`entry    ${label} updated\nintent   ${label}: Speak T3, and smile.\n`);
    expect(read(t.entries)).toContain("kind: translation\nrules: t3\nintent: Speak T3, and smile.\n");
    expect(t.calls("claude")).toBe(1);
    const prompt = read(join(t.tmp, "claude.prompt"));
    expect(prompt).toContain("Speak T3.");
    expect(prompt).toContain("-Open Cursor and say hello.\n+Open T3 and say hello. Smile.\n");
    expect(read(t.entries)).toContain("--- patched\nOpen T3 and say hello. Smile.\n");
    expect(t.changes()).toEqual([]);
    t.pb(["build"], { cwd: t.repo.path });
    expect(t.repo.read(t.guide)).toContain("Open T3 and say hello. Smile.");
  });

  docTest("with no model, an edit to a patched paragraph keeps its entry's intent and says it may be stale", (t) => {
    const label = `guide.md [${/^=== entry (\S+)$/m.exec(read(t.entries))![1]}]`;
    t.fake("claude", JSON.stringify({ change: null, intents: { [label]: "Not this." } }));
    t.env["PATCHBOOK_PROVIDER"] = "none";
    t.edit("Open T3 and say hello.", "Open T3 and say hello. Smile.");
    const out = t.record().stdout;
    expect(out).toBe(`entry    ${label} updated\nintent   may be stale: ${label} (intent.provider is none). Edit them by hand to cover these edits\n`);
    expect(read(t.entries)).toContain("kind: translation\nrules: t3\nintent: Speak T3.\n");
    expect(t.calls("claude")).toBe(0);
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  docTest("an edit across two neighbouring paragraphs goes into the first one's entry and empties the second's", (t) => {
    t.edit("Then wave.\n\nThen sit.", "Then wave and sit.");
    const out = t.record(["--intent", "Merge the last two steps."]).stdout;
    expect(out.match(/entry +guide\.md \[[0-9a-f]{12}\] added/g)).toHaveLength(2);
    const entries = read(t.entries);
    expect(entries).toContain("kind: policy\nrules: \nintent: Merge the last two steps.\n--- upstream\nThen wave.\n--- patched\nThen wave and sit.\n");
    expect(entries.endsWith("kind: policy\nrules: \nintent: Merge the last two steps.\n--- upstream\nThen sit.\n--- patched\n")).toBe(true);
    expect(entries).toContain("--- patched\nOpen T3 and say hello.\n");
    const edited = t.repo.read(t.guide);
    t.pb(["build"], { cwd: t.repo.path });
    expect(t.repo.read(t.guide)).toBe(edited);
    expect(t.pb(["status"], { cwd: t.repo.path }).stdout).toContain("no problems");
  });

  docTest("an entry recorded after one that deletes its paragraph follows it after one blank line", (t) => {
    t.edit("Open T3 and say hello.\n\n", "");
    t.record(["--intent", "Drop the greeting."]);
    expect(read(t.entries)).toContain("--- upstream\nOpen Cursor and say hello.\n--- patched\n");
    t.edit("Then wave.", "Then wave twice.");
    t.record(["--intent", "Wave twice."]);
    const entries = read(t.entries);
    expect(entries).toContain("--- upstream\nOpen Cursor and say hello.\n--- patched\n\n=== entry ");
    expect(entries).toContain("--- patched\nThen wave twice.\n");
    expect(entries).not.toContain("\n\n\n");
  });

  docTest("an edit to a paragraph upstream wrote gets a new entry with the model's intent", (t) => {
    t.edit("Then wave.", "Then wave twice.");
    const out = t.record().stdout;
    expect(out).toContain("intent: Shout the second line.");
    expect(read(t.entries)).toContain("kind: policy\nrules: \nintent: Shout the second line.\n--- upstream\nThen wave.\n--- patched\nThen wave twice.\n");
    expect(read(join(t.tmp, "prompt.txt"))).toContain("upstream/guide.md");
    expect(t.changes()).toEqual([]);
  });

  docTest("with no model, an edit recorded into a change with no intent writes an empty intent, never None, and status reports it missing", (t) => {
    t.env["PATCHBOOK_PROVIDER"] = "none";
    mkdirSync(join(t.repo.path, ".patchbook/changes/mine"), { recursive: true });
    writeFileSync(join(t.repo.path, ".patchbook/changes/mine/CHANGE.md"), "# mine\n\nintent:\n\nedits:\n");
    appendFileSync(join(t.repo.path, ".patchbook/series"), "mine\n");
    t.edit("Then wave.", "Then wave twice.");
    t.record(["mine"]);
    const entries = read(t.entries);
    expect(entries).toContain("kind: policy\nrules: \nintent: \n--- upstream\nThen wave.\n--- patched\nThen wave twice.\n");
    expect(entries).not.toContain("None");
    expect(t.pb(["status"], { cwd: t.repo.path, code: 1 }).stdout).toContain("it has no intent");
  });

  docTest("a paragraph put back as upstream wrote it loses its entry", (t) => {
    t.edit("Open T3 and say hello.", "Open Cursor and say hello.");
    const out = t.record().stdout;
    expect(out).toMatch(/entry +guide\.md \[[0-9a-f]{12}\] removed: the paragraph is upstream's again/);
    expect(existsSync(t.entries)).toBe(false);
  });

  for (const [what, old, repl] of [
    ["an extra blank line added between two paragraphs", "Then wave.\n\nThen sit.", "Then wave.\n\n\nThen sit."],
    ["a dropped final newline", "Bye.\n", "Bye."],
  ] as const) {
    docTest(`${what} doesn't map onto whole paragraphs, so record skips the file and changes no entry`, (t) => {
      const entries = read(t.entries);
      t.edit(old, repl);
      const out = t.record().stdout;
      expect(out).toContain("skipped  guide.md: the edit doesn't map onto whole paragraphs; edit its block entries directly");
      expect(read(t.entries)).toBe(entries);
      expect(t.changes()).toEqual([]);
    });
  }

  docTest("a file that stops being text is skipped, and its entries stay as they were", (t) => {
    const entries = read(t.entries);
    writeFileSync(join(t.repo.path, t.guide), Buffer.from([0x23, 0x00, 0x01, 0x02, 0x0a]));
    const out = t.record().stdout;
    expect(out).toContain("skipped  guide.md: it isn't text");
    expect(read(t.entries)).toBe(entries);
    expect(t.changes()).toEqual([]);
  });
});
