import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paste } from "../paste.ts";
import { CALLS, CMD, Case, Repo, TIMEOUT, type Run, lefthookCommand, lefthookJob, lefthookJsonCommand, lefthookTomlCommand, permissionTest, PRE_COMMIT_RUNS_ALWAYS, preCommitHook, quoted, sh, splitWords, words } from "../helpers";
import { read, tree, forkOf, installManager, NOTE_STAGED, forkWith, withHook, committedFiles } from "../e2e-fixtures.ts";

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
  expect(read(join(import.meta.dir, "..", "paste.ts"))).not.toMatch(/from\s+["'][^"']*src\//);
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
  ["a local pre-commit hook", ".pre-commit-config.yaml", preCommitHook("record", "patchbook hook run")],
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

const ECHOED = `echo "patchbook hook run"`;
const NOT_RUNNING: [string, string, string][] = [
  ["a lefthook YAML command", "lefthook.yml", lefthookCommand("pre-commit", "diagnostic", quoted(ECHOED))],
  ["a local pre-commit hook", ".pre-commit-config.yaml", preCommitHook("diagnostic", quoted(ECHOED))],
];

for (const [name, config, existing] of NOT_RUNNING) {
  test(`hook install still adds patchbook's hook when ${name} only mentions the call in ${JSON.stringify(ECHOED)}`, () => {
    const t = new Case();
    try {
      const fork = forkWith(t, { [config]: existing });
      const install = t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr;
      expect(install).toContain("Add this");
      expect(fork.read(config)).toBe(existing);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("hook install names the clash when a command called patchbook only echoes the call", () => {
  const t = new Case();
  try {
    const existing = lefthookCommand("pre-commit", "patchbook", quoted(ECHOED));
    const fork = forkWith(t, { "lefthook.yml": existing });
    const install = t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr;
    expect(install).toContain("already has a command named patchbook that doesn't always call `patchbook hook run`");
    expect(fork.read("lefthook.yml")).toBe(existing);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

const GENERATED = lefthookCommand("pre-commit", "patchbook", CALLS["pre-commit"]);
test("hook install doesn't take a skipped lefthook command for patchbook's hook", () => {
  const t = new Case();
  try {
    const existing = GENERATED.replace("      run:", "      skip: true\n      run:");
    const fork = forkWith(t, { "lefthook.yml": existing });
    const install = t.pb(["hook", "install"], { cwd: fork.path, timeout: 30_000 }).stderr;
    expect(install).toContain("that doesn't always call `patchbook hook run`");
    expect(fork.read("lefthook.yml")).toBe(existing);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

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
