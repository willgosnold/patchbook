// End-to-end tests: each one builds a throwaway upstream repo and drives the CLI against it.

import { describe, expect, test } from "bun:test";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

const storeOf = (t: Case): string => join(t.tmp, "store/upstreams", readdirSync(join(t.tmp, "store/upstreams"))[0]!);
const pinOf = (t: { repo: Repo }): string => JSON.parse(read(join(t.repo.path, ".patchbook/upstream.lock"))).plugin.commit;
const gc = (store: string): void => void sh(["git", "gc", "-q", "--prune=now"], { cwd: store });
const inStore = (store: string, commit: string): boolean => sh(["git", "cat-file", "-e", `${commit}^{commit}`], { cwd: store, check: false }).code === 0;
const dropRefs = (store: string): void => {
  for (const ref of sh(["git", "for-each-ref", "--format=%(refname)"], { cwd: store }).stdout.split("\n").filter(Boolean)) {
    sh(["git", "update-ref", "-d", ref], { cwd: store });
  }
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

describe("ForkTest", () => {
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
    t.pb(["record", "--intent", "Shout the first line."], { cwd: t.fork.path });
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

  for (const command of ["status", "build"]) {
    vendorTest(`test_${command}_keeps_a_pin_it_held_without_a_ref`, (t) => {
      const store = storeOf(t);
      const pin = pinOf(t);
      dropRefs(store);
      t.pb([command], { cwd: t.repo.path, code: null });
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
