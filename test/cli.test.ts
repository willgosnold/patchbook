import { describe, expect, test } from "bun:test";
import { arg, command, flag, option, type Problem, type Program, parseArgv } from "../src/lib/args.ts";

type Answer = { kind: "print" | "refuse"; text: string } | { kind: "run"; values: Record<string, unknown> };

const CHILD = `
const { PROGRAM } = await import(process.env.CLI);
const { parseArgv } = await import(process.env.ARGS);
let seen;
const commands = Object.fromEntries(Object.entries(PROGRAM.commands).map(([name, c]) => [name, { ...c, run: (values) => ((seen = values), 0) }]));
const answers = JSON.parse(await Bun.stdin.text()).map((argv) => {
  const outcome = parseArgv({ ...PROGRAM, commands }, argv);
  if (outcome.kind !== "run") return outcome;
  outcome.run();
  return { kind: "run", values: seen };
});
console.log(JSON.stringify({ commands: Object.keys(PROGRAM.commands), version: PROGRAM.version, answers }));
`;

function askPatchbook(argvs: string[][]): { commands: string[]; version: string; answer: (argv: string[]) => Answer } {
  const r = Bun.spawnSync([process.execPath, "-e", CHILD], {
    env: { ...process.env, CLI: new URL("../src/cli.ts", import.meta.url).pathname, ARGS: new URL("../src/lib/args.ts", import.meta.url).pathname },
    stdin: Buffer.from(JSON.stringify(argvs)),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  const read: { commands: string[]; version: string; answers: Answer[] } = JSON.parse(r.stdout.toString());
  const byArgv = new Map(argvs.map((argv, i) => [JSON.stringify(argv), read.answers[i]!]));
  return { commands: read.commands, version: read.version, answer: (argv) => byArgv.get(JSON.stringify(argv))! };
}

const HELP: Record<string, string> = {
  top: `\
usage: patchbook <command> [arguments] [options]
       patchbook --version

Keep your changes to an upstream repo, each with its intent,
and keep pulling from upstream.

commands:
  clone       fork an upstream repo, with its history, and start a patchbook
  init        start a patchbook in this repo
  track       follow another upstream, mounted at its own folder
  upstream    list, print, export or diff an upstream at its pin
  check       has any upstream moved? exits 10 if so
  sync        move the pins to upstream and carry every change forward
  status      list what is broken
  build       apply the patchbook to the pinned upstreams and write the output
  record      move edits to the output in the working tree into a change
  intent      fill the empty intents that record left when the model failed
  hook        install the pre-commit hook, run it, or show which hook git runs
  skill       write this patchbook's update skill into the repo
  config      show settings and where each comes from, or set one
  show        print a change, with its file edits as diffs
  blocks      print an upstream file's blocks with their hashes
  scaffold    append skeleton block entries for missing blocks

options:
  -h, --help  show this help
  --version   print patchbook's version

Run \`patchbook <command> --help\` for a command's arguments and options.
`,
  clone: `\
usage: patchbook clone <url> [<dir>] [options]

fork an upstream repo, with its history, and start a patchbook

arguments:
  <url>              the upstream repo's git URL
  <dir>              the folder to clone into (default: the repo's name)

options:
  --branch <branch>  the branch to check out (default: upstream's default)
  -h, --help         show this help
`,
  init: `\
usage: patchbook init --upstream <url> [options]

start a patchbook in this repo

options:
  --upstream <url>     upstream's git URL
  --name <name>        the upstream's name (default: last part of --path or URL)
  --branch <branch>    the upstream branch to follow (default: main)
  --path <path>        the upstream folder to follow, if not the whole repo
  --output-to <dir>    build into <dir>, not over the repo (the folder layout)
  --output-from <dir>  the staged folder that ships, with --output-to
  --vendor <dir>       also keep a byte-for-byte copy of upstream in <dir>
  -h, --help           show this help
`,
  track: `\
usage: patchbook track <name> <url> [options]

follow another upstream, mounted at its own folder

arguments:
  <name>             what to call the upstream
  <url>              its git URL

options:
  --branch <branch>  the upstream branch to follow (default: main)
  --path <path>      the upstream folder to follow, if not the whole repo
  --mount <dir>      the staged folder its files appear under (default: <name>)
  --vendor <dir>     also keep a byte-for-byte copy in <dir>
  -h, --help         show this help
`,
  upstream: `\
usage: patchbook upstream <name> [<path>] [options]

list, print, export or diff an upstream at its pin
Give at most one of --diff, --since and --export.
A <path> limits a diff; --export takes none.

arguments:
  <name>            the upstream to read
  <path>            a path inside the upstream, as upstream has it

options:
  --diff            what upstream changed in the last sync
  --since <commit>  what upstream changed since <commit>
  --export <dir>    write every file at the pin into <dir>
  -h, --help        show this help
`,
  check: `\
usage: patchbook check [options]

has any upstream moved? exits 10 if so

options:
  -h, --help  show this help
`,
  sync: `\
usage: patchbook sync [<name>] [<ref>] [options]

move the pins to upstream and carry every change forward

arguments:
  <name>      only this upstream
  <ref>       a branch, tag or commit (default: the upstream's branch)

options:
  -h, --help  show this help
`,
  status: `\
usage: patchbook status [options]

list what is broken

options:
  --json      machine-readable, with block text
  -h, --help  show this help
`,
  build: `\
usage: patchbook build [options]

apply the patchbook to the pinned upstreams and write the output

options:
  --force     overwrite output files edited since the last build
  --commit    commit the result; in a fork, as a merge of upstream
  -h, --help  show this help
`,
  record: `\
usage: patchbook record [<change>] [options]

move edits to the output in the working tree into a change
The commit hook records only what is staged. This records the working tree.
If the model can't write an intent, the change keeps an empty one.

arguments:
  <change>         the change to add to (default: the model picks or names one)

options:
  --intent <text>  what the change is for (default: the model writes it)
  -h, --help       show this help
`,
  intent: `\
usage: patchbook intent [<change>] [options]

fill the empty intents that record left when the model failed
With no <change>, it fills every change and block entry with an empty intent.

arguments:
  <change>         only this change

options:
  --intent <text>  the intent for <change> (default: the model writes it)
  -h, --help       show this help
`,
  hook: `\
usage: patchbook hook install|run|status [options]

install the pre-commit hook, run it, or show which hook git runs

arguments:
  install     install patchbook's pre-commit hook in this repo
  run         run the hook, as git does before a commit
  status      show which pre-commit hook git runs

options:
  -h, --help  show this help
`,
  skill: `\
usage: patchbook skill install [options]

write this patchbook's update skill into the repo

arguments:
  install     write or refresh the update skill

options:
  -h, --help  show this help
`,
  config: `\
usage: patchbook config [<name>] [<value>] [options]

show settings and where each comes from, or set one

arguments:
  <name>      a setting, such as intent.provider
  <value>     the value to set it to

options:
  --project   set it in this project's .patchbook/config.toml, not yours
  --unset     remove it, so the next layer's value applies
  -h, --help  show this help
`,
  show: `\
usage: patchbook show <change> [options]

print a change, with its file edits as diffs

arguments:
  <change>    the change to print

options:
  -h, --help  show this help
`,
  blocks: `\
usage: patchbook blocks <file> [options]

print an upstream file's blocks with their hashes

arguments:
  <file>      its staged path, such as skills/arena/SKILL.md

options:
  -h, --help  show this help
`,
  scaffold: `\
usage: patchbook scaffold [<file>...] [options]

append skeleton block entries for missing blocks

arguments:
  <file>...   only these staged files (default: every file)

options:
  -h, --help  show this help
`,
};

const TOP_HINT = "Run `patchbook --help` to see the commands.\n";
const hint = (name: string) => `Run \`patchbook ${name} --help\` for its arguments and options.\n`;

const ERRORS: { [K in Problem["kind"]]: [argv: string[], text: string][] } = {
  missing: [
    [[], `patchbook: missing <command>\n${TOP_HINT}`],
    [["show"], `patchbook show: missing <change>\n${hint("show")}`],
    [["track", "tools"], `patchbook track: missing <url>\n${hint("track")}`],
    [["hook"], `patchbook hook: missing install|run|status\n${hint("hook")}`],
    [["init"], `patchbook init: missing --upstream <url>\n${hint("init")}`],
  ],
  "unknown-command": [
    [["frob"], `patchbook: unknown command "frob"\n${TOP_HINT}`],
    [["-"], `patchbook: unknown command "-"\n${TOP_HINT}`],
    [["__proto__"], `patchbook: unknown command "__proto__"\n${TOP_HINT}`],
    [["toString"], `patchbook: unknown command "toString"\n${TOP_HINT}`],
    [["constructor"], `patchbook: unknown command "constructor"\n${TOP_HINT}`],
    [["Sync"], `patchbook: unknown command "Sync"\n${TOP_HINT}`],
    [["sy nc"], `patchbook: unknown command "sy nc"\n${TOP_HINT}`],
    [['a"b'], `patchbook: unknown command "a\\"b"\n${TOP_HINT}`],
  ],
  "unknown-option": [
    [["sync", "--forse"], `patchbook sync: unknown option "--forse"\n${hint("sync")}`],
    [["init", "--bra=x"], `patchbook init: unknown option "--bra"\n${hint("init")}`],
    [["init", "--bra", "x"], `patchbook init: unknown option "--bra"\n${hint("init")}`],
    [["build", "-f"], `patchbook build: unknown option "-f"\n${hint("build")}`],
    [["-v"], `patchbook: unknown option "-v"\n${TOP_HINT}`],
    [["--"], `patchbook: unknown option "--"\n${TOP_HINT}`],
    [["--forse=x"], `patchbook: unknown option "--forse"\n${TOP_HINT}`],
  ],
  "missing-value": [
    [["init", "--upstream"], `patchbook init: --upstream needs a value\n${hint("init")}`],
    [["init", "--upstream", "-x"], `patchbook init: --upstream needs a value. To pass "-x" as its value, write \`--upstream=-x\`.\n${hint("init")}`],
    [["init", "--upstream", "--"], `patchbook init: --upstream needs a value. To pass "--" as its value, write \`--upstream=--\`.\n${hint("init")}`],
  ],
  "value-for-flag": [
    [["build", "--force=yes"], `patchbook build: --force takes no value, got "yes"\n${hint("build")}`],
    [["init", "--help=x"], `patchbook init: --help takes no value, got "x"\n${hint("init")}`],
    [["--help=x"], `patchbook: --help takes no value, got "x"\n${TOP_HINT}`],
  ],
  "extra-argument": [
    [["check", "now"], `patchbook check: extra argument "now"\n${hint("check")}`],
    [["sync", "a", "b", "c"], `patchbook sync: extra argument "c"\n${hint("sync")}`],
    [["--version", "now"], `patchbook: extra argument "now"\n${TOP_HINT}`],
  ],
  "not-a-choice": [
    [["hook", "inst"], `patchbook hook: expected install, run or status, not "inst"\n${hint("hook")}`],
    [["hook", "__proto__"], `patchbook hook: expected install, run or status, not "__proto__"\n${hint("hook")}`],
    [["skill", "x"], `patchbook skill: expected install, not "x"\n${hint("skill")}`],
  ],
  "repeated-option": [
    [["build", "--force", "--force"], `patchbook build: --force given twice\n${hint("build")}`],
    [["init", "--upstream=a", "--upstream", "b"], `patchbook init: --upstream given twice\n${hint("init")}`],
  ],
  conflict: [
    [["upstream", "up", "--diff", "--export", "out"], `patchbook upstream: --export can't go with --diff\n${hint("upstream")}`],
    [["upstream", "up", "--since=abc", "--diff"], `patchbook upstream: --diff can't go with --since\n${hint("upstream")}`],
    [["upstream", "up", "app.txt", "--export=out"], `patchbook upstream: --export can't go with <path>\n${hint("upstream")}`],
    [["upstream", "up", "--export", "out", "app.txt"], `patchbook upstream: <path> can't go with --export\n${hint("upstream")}`],
  ],
};

const DEFAULTS: [argv: string[], values: Record<string, unknown>][] = [
  [["init", "--upstream", "repo"], { upstream: "repo", name: null, branch: "main", path: null, outputTo: null, outputFrom: null, vendor: null }],
  [["scaffold"], { file: [] }],
  [["sync"], { name: null, ref: null }],
  [["build"], { force: false, commit: false }],
  [["hook", "status"], { action: "status" }],
  [["record"], { change: null, intent: null }],
  [["config"], { name: null, value: null, project: false, unset: false }],
];

const VALUES: [argv: string[], values: Record<string, unknown>][] = [
  [["init", "--upstream=-x"], { upstream: "-x" }],
  [["init", "--upstream=-1"], { upstream: "-1" }],
  [["init", "--upstream=--"], { upstream: "--" }],
  [["init", "--upstream", "-"], { upstream: "-" }],
  [["init", "--upstream="], { upstream: "" }],
  [["init", "--upstream", ""], { upstream: "" }],
  [["init", "--upstream=a=b"], { upstream: "a=b" }],
  [["init", "--branch=dev", "--upstream", "r"], { upstream: "r", branch: "dev" }],
  [["init", "--output-to", "out", "--upstream", "r"], { upstream: "r", outputTo: "out" }],
  [["record", "--intent", "words with spaces"], { change: null, intent: "words with spaces" }],
  [["record", "--intent=--help"], { change: null, intent: "--help" }],
  [["record", "--intent=-h"], { change: null, intent: "-h" }],
  [["clone", "url", "--branch=topic", "dir"], { url: "url", dir: "dir", branch: "topic" }],
  [["clone", "--branch", "topic", "url"], { url: "url", dir: null, branch: "topic" }],
  [["show", "-"], { change: "-" }],
  [["show", "--", "-1"], { change: "-1" }],
  [["show", "--", "--help"], { change: "--help" }],
  [["sync", "--", "--help"], { name: "--help", ref: null }],
  [["scaffold", "--", "--", "--force"], { file: ["--", "--force"] }],
  [["scaffold", "a", "--", "b", "c"], { file: ["a", "b", "c"] }],
  [["build", "--commit", "--force"], { force: true, commit: true }],
  [["config", "--unset", "intent.provider"], { name: "intent.provider", value: null, unset: true, project: false }],
  [["config", "intent.provider", "--project", "codex"], { name: "intent.provider", value: "codex", unset: false, project: true }],
  [["upstream", "up", "app.txt", "--since", "abc"], { name: "up", path: "app.txt", diff: false, since: "abc", export: null }],
  [["upstream", "up", "--diff", "app.txt"], { name: "up", path: "app.txt", diff: true, since: null, export: null }],
  [["upstream", "up", "--export", "out"], { name: "up", path: null, diff: false, since: null, export: "out" }],
];

const REFUSED: [argv: string[], line: string][] = [
  [["record", "--intent", "-words with spaces"], 'patchbook record: --intent needs a value. To pass "-words with spaces" as its value, write `--intent=-words with spaces`.'],
  [["clone", "--branch", "-1", "url"], 'patchbook clone: --branch needs a value. To pass "-1" as its value, write `--branch=-1`.'],
  [["init", "--upstream", "--unknown"], 'patchbook init: --upstream needs a value. To pass "--unknown" as its value, write `--upstream=--unknown`.'],
  [["init", "--upstream", "--branch"], 'patchbook init: --upstream needs a value. To pass "--branch" as its value, write `--upstream=--branch`.'],
  [["clone", "url", "--bra=main"], 'patchbook clone: unknown option "--bra"'],
  [["show", "-1"], 'patchbook show: unknown option "-1"'],
  [["--", "show", "--help"], 'patchbook: unknown option "--"'],
  [["--", "-h"], 'patchbook: unknown option "--"'],
  [["build", "--force", "--force=x"], "patchbook build: --force given twice"],
  [["build", "--force", "false"], 'patchbook build: extra argument "false"'],
  [["build", "--force="], 'patchbook build: --force takes no value, got ""'],
  [["init", "--upstream=a", "--upstream"], "patchbook init: --upstream given twice"],
  [["init", "--help="], 'patchbook init: --help takes no value, got ""'],
  [["init", "-h=x"], 'patchbook init: -h takes no value, got "x"'],
  [["init", "-hfoo"], 'patchbook init: unknown option "-hfoo"'],
  [["init", "-hv"], 'patchbook init: unknown option "-hv"'],
  [["init", "--he"], 'patchbook init: unknown option "--he"'],
  [["status", "--version"], 'patchbook status: unknown option "--version"'],
  [["--version=x"], 'patchbook: --version takes no value, got "x"'],
  [["-h=x"], 'patchbook: -h takes no value, got "x"'],
  [["-hfoo"], 'patchbook: unknown option "-hfoo"'],
  [["--version", "--version"], 'patchbook: extra argument "--version"'],
  [["--version", "--"], 'patchbook: extra argument "--"'],
  [["--version", "--help=x"], 'patchbook: extra argument "--help=x"'],
  [["show", "a", "b"], 'patchbook show: extra argument "b"'],
  [["hook", "run", "extra"], 'patchbook hook: extra argument "extra"'],
  [["scaffold", "--bad"], 'patchbook scaffold: unknown option "--bad"'],
  [["init", "--bad", "--upstream"], 'patchbook init: unknown option "--bad"'],
  [["track", "--bad"], 'patchbook track: unknown option "--bad"'],
  [["track", "--mount", "m"], "patchbook track: missing <name>"],
  [["hook", "inst", "extra"], 'patchbook hook: expected install, run or status, not "inst"'],
];

const HELPS: [argv: string[], page: string][] = [
  [["init", "--help"], "init"],
  [["init", "-h"], "init"],
  [["init", "--upstream", "--help"], "init"],
  [["init", "--bad", "--help"], "init"],
  [["hook", "wrong", "--help"], "hook"],
  [["build", "--force", "--force", "-h"], "build"],
  [["init", "--help", "--help"], "init"],
  [["sync", "--forse", "-h"], "sync"],
  [["status", "--version", "--help"], "status"],
  [["show", "-h"], "show"],
  [["unknown", "--help"], "top"],
  [["syn", "--help"], "top"],
  [["--bad", "init", "--help"], "top"],
  [["--help", "unknown"], "top"],
  [["--help", "init"], "top"],
  [["--version", "--help"], "top"],
  [["--help", "--version"], "top"],
  [["-h"], "top"],
  [["--help"], "top"],
];

const patchbook = askPatchbook([
  ["--version"],
  ...Object.keys(HELP).map((name) => (name === "top" ? ["--help"] : [name, "--help"])),
  ...Object.values(ERRORS).flatMap((rows) => rows.map(([argv]) => argv)),
  ...[...DEFAULTS, ...VALUES, ...REFUSED, ...HELPS].map(([argv]) => argv),
]);

const refusal = (text: string) => ({ kind: "refuse", text: expect.stringMatching(new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n`)) });

describe("help", () => {
  test("has a page for every command and the top level, and no page for anything else", () => {
    expect([...patchbook.commands].sort()).toEqual(Object.keys(HELP).filter((k) => k !== "top").sort());
  });

  test.each(Object.keys(HELP))("%s", (name) => {
    expect(patchbook.answer(name === "top" ? ["--help"] : [name, "--help"])).toEqual({ kind: "print", text: HELP[name]! });
  });

  test("keeps every line within 80 columns", () => {
    for (const name of Object.keys(HELP)) {
      for (const line of HELP[name]!.split("\n")) expect({ name, line, long: line.length > 80 }).toEqual({ name, line, long: false });
    }
  });

  test("prints the version", () => {
    expect(patchbook.answer(["--version"])).toEqual({ kind: "print", text: `patchbook ${patchbook.version}\n` });
  });

  test.each(HELPS)("%j prints the %s help and ignores every other problem", (argv, page) => {
    expect(patchbook.answer(argv)).toEqual({ kind: "print", text: HELP[page]! });
  });
});

describe("usage errors", () => {
  test.each(Object.values(ERRORS).flat())("%j", (argv, text) => {
    expect(patchbook.answer(argv)).toEqual({ kind: "refuse", text });
  });
});

describe("how the command line is read", () => {
  test.each(DEFAULTS)("%j gives every field its value", (argv, values) => {
    expect(patchbook.answer(argv)).toEqual({ kind: "run", values });
  });

  test.each(VALUES)("%j gives %j", (argv, values) => {
    expect(patchbook.answer(argv)).toMatchObject({ kind: "run", values });
  });

  test.each(REFUSED)("%j is refused with %j", (argv, line) => {
    expect(patchbook.answer(argv)).toMatchObject(refusal(line));
  });
});

describe("declaring a command", () => {
  test("refuses an optional argument before a required one", () => {
    expect(() => command({ summary: "x", args: { a: arg.optional("a"), b: arg("b") }, run: () => 0 })).toThrow('"b" must come before "a"');
  });

  test("refuses an argument after a rest argument", () => {
    expect(() => command({ summary: "x", args: { a: arg.rest("a"), b: arg.optional("b") }, run: () => 0 })).toThrow('"b" must come before "a"');
    expect(() => command({ summary: "x", args: { a: arg.rest("a"), b: arg.rest("b") }, run: () => 0 })).toThrow('"a" takes the rest, so "b" can\'t follow it');
  });

  test("refuses one key for an argument and an option", () => {
    expect(() => command({ summary: "x", args: { a: arg("a") }, options: { a: flag("a") }, run: () => 0 })).toThrow('"a" names both an argument and an option');
  });

  test("refuses a key that isn't camelCase", () => {
    expect(() => command({ summary: "x", options: { output_to: flag("a") }, run: () => 0 })).toThrow('"output_to" isn\'t a camelCase key');
  });

  test("refuses an exclusive group of fewer than two keys", () => {
    expect(() => command({ summary: "x", options: { a: flag("a") }, exclusive: [["a"]], run: () => 0 })).toThrow('an exclusive group needs two keys, not ["a"]');
  });

  test("turns a camelCase key into a kebab-case flag", () => {
    const c = command({ summary: "x", options: { outputTo: option("dir", "o"), dryRunNow: flag("d") }, run: () => 0 });
    expect(c.options.map((o) => o.flag)).toEqual(["--output-to", "--dry-run-now"]);
  });

  test("lists a required option in the usage line, shows a default in help, and lets a rest argument be empty", () => {
    const seen: unknown[] = [];
    const program: Program = {
      name: "x",
      version: "1",
      about: ["about"],
      commands: {
        go: command({
          summary: "go",
          args: { rest: arg.rest("all the rest") },
          options: { level: option("n", "how much", { default: "3" }), mode: option("m", "which", "required") },
          run: (a) => {
            seen.push(a);
            return 0;
          },
        }),
      },
    };
    const ran = parseArgv(program, ["go", "--mode", "fast"]);
    if (ran.kind === "run") ran.run();
    expect(seen).toEqual([{ rest: [], level: "3", mode: "fast" }]);
    expect(parseArgv(program, ["go"])).toEqual({ kind: "refuse", text: "x go: missing --mode <m>\nRun `x go --help` for its arguments and options.\n" });
    expect(parseArgv(program, ["go", "-h"])).toEqual({
      kind: "print",
      text: `\
usage: x go [<rest>...] --mode <m> [options]

go

arguments:
  <rest>...    all the rest

options:
  --level <n>  how much (default: 3)
  --mode <m>   which
  -h, --help   show this help
`,
    });
  });
});

const showChange = async (_args: { change: string }) => 0;

export const checkedByTypecheck = [
  command({
    summary: "x",
    args: { change: arg("c") },
    options: { intent: option("text", "i"), force: flag("f") },
    run: (a) => {
      const change: string = a.change;
      const intent: string | null = a.intent;
      const force: boolean = a.force;
      // @ts-expect-error a field nobody declared
      void a.output_to;
      // @ts-expect-error an optional option may be null
      const sure: string = a.intent;
      return change.length + (intent?.length ?? 0) + Number(force) + sure.length;
    },
  }),
  command({
    summary: "x",
    args: { action: arg.oneOf({ install: "i", run: "r" }) },
    run: (a) => {
      // @ts-expect-error not one of the declared choices
      const bad: typeof a.action = "status";
      return bad.length;
    },
  }),
  // @ts-expect-error an exclusive group names a key nobody declared
  command({ summary: "x", options: { a: flag("a"), b: flag("b") }, exclusive: [["a", "c"]], run: () => 0 }),
  // @ts-expect-error showChange needs `change`, and this command doesn't declare it
  command({ summary: "x", args: { file: arg("f") }, run: showChange }),
  command({
    summary: "x",
    args: { rest: arg.rest("r") },
    options: { level: option("n", "l", { default: "3" }), name: option("n", "n", "required") },
    run: (a) => {
      const rest: string[] = a.rest;
      const level: string = a.level;
      const name: string = a.name;
      return rest.length + level.length + name.length;
    },
  }),
];
