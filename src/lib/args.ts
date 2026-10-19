/** One positional argument. The kind alone decides the type `run` receives for it. */
export type ArgSpec =
  | { readonly kind: "one"; readonly help: string }
  | { readonly kind: "optional"; readonly help: string }
  | { readonly kind: "rest"; readonly help: string }
  | { readonly kind: "choice"; readonly choices: Readonly<Record<string, string>> };

/** One option. A flag is a boolean; a value option holds the text after it. */
export type OptionSpec =
  | { readonly kind: "flag"; readonly help: string }
  | { readonly kind: "value"; readonly meta: string; readonly help: string; readonly need: Need };

type Need = "optional" | "required" | { readonly default: string };

type ArgValue<S extends ArgSpec> = S extends { kind: "one" } ? string
  : S extends { kind: "optional" } ? string | null
  : S extends { kind: "rest" } ? string[]
  : S extends { kind: "choice"; choices: infer C } ? keyof C & string
  : never;

type OptionValue<S extends OptionSpec> = S extends { kind: "flag" } ? boolean
  : S extends { need: "optional" } ? string | null
  : string;

/** The object a command's `run` receives: one typed field per declared argument and option, named by its key. */
export type Values<A extends Record<string, ArgSpec>, O extends Record<string, OptionSpec>> =
  { readonly [K in keyof A]: ArgValue<A[K]> } & { readonly [K in keyof O]: OptionValue<O[K]> };

/** A required argument. Its placeholder in help is the key: `show: { args: { change: arg(...) } }` prints `<change>`. */
export function arg(help: string): { readonly kind: "one"; readonly help: string } {
  return { kind: "one", help };
}
/** An argument that may be left off; `run` gets null. Optional arguments come after required ones. */
arg.optional = (help: string): { readonly kind: "optional"; readonly help: string } => ({ kind: "optional", help });
/** Every remaining argument, possibly none. Only the last argument can be one. */
arg.rest = (help: string): { readonly kind: "rest"; readonly help: string } => ({ kind: "rest", help });
/** One word out of a fixed set, each with its own help line. `run` gets the word as a string union. */
arg.oneOf = <const C extends Record<string, string>>(choices: C): { readonly kind: "choice"; readonly choices: C } => ({ kind: "choice", choices });

/** `--name`, with no value. The flag is the key in kebab case: `outputTo` is `--output-to`. */
export function flag(help: string): { readonly kind: "flag"; readonly help: string } {
  return { kind: "flag", help };
}

/** `--name <meta>`. Absent, `run` gets null, unless the option is "required" or has a default. */
export function option(meta: string, help: string): { readonly kind: "value"; readonly meta: string; readonly help: string; readonly need: "optional" };
export function option(meta: string, help: string, need: "required" | { readonly default: string }): { readonly kind: "value"; readonly meta: string; readonly help: string; readonly need: "required" | { readonly default: string } };
export function option(meta: string, help: string, need: Need = "optional"): OptionSpec {
  return { kind: "value", meta, help, need };
}

type Run<V> = (values: V) => Promise<number> | number;

type Raw = string | string[] | boolean | null;

/** A command with its types erased, so the table can hold every command. Built only by `command`. */
export interface Command {
  readonly summary: string;
  readonly about: readonly string[];
  /** In declaration order: required, then optional, then at most one rest. */
  readonly args: readonly (ArgSpec & { readonly key: string })[];
  readonly options: readonly (OptionSpec & { readonly key: string; readonly flag: `--${string}` })[];
  readonly run: Run<Readonly<Record<string, Raw>>>;
}

const RANK = { one: 0, choice: 0, optional: 1, rest: 2 } as const;
const KEY = /^[a-z][a-zA-Z0-9]*$/;

/**
 * Declare a command. `run`'s parameter type comes from `args` and `options`.
 * Throws when argument order is wrong, when an argument key and an option key collide, or when a key isn't camelCase.
 */
export function command<const A extends Record<string, ArgSpec> = {}, const O extends Record<string, OptionSpec> = {}>(c: {
  summary: string;
  about?: readonly string[];
  args?: A;
  options?: O;
  run: Run<Values<A, O>>;
}): Command {
  const args = Object.entries(c.args ?? {}).map(([key, spec]) => ({ ...spec, key }));
  const options = Object.entries(c.options ?? {}).map(([key, spec]) => ({
    ...spec,
    key,
    flag: `--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}` as const,
  }));
  const keys = new Set<string>();
  for (const { key } of [...args, ...options]) {
    if (!KEY.test(key)) throw new Error(`${c.summary}: "${key}" isn't a camelCase key`);
    if (keys.has(key)) throw new Error(`${c.summary}: "${key}" names both an argument and an option`);
    keys.add(key);
  }
  args.forEach((a, i) => {
    const before = args[i - 1];
    if (before && RANK[a.kind] < RANK[before.kind]) throw new Error(`${c.summary}: "${a.key}" must come before "${before.key}"`);
    if (before?.kind === "rest") throw new Error(`${c.summary}: "${before.key}" takes the rest, so "${a.key}" can't follow it`);
  });
  return { summary: c.summary, about: c.about ?? [], args, options, run: c.run as Run<Readonly<Record<string, Raw>>> };
}

export interface Program {
  readonly name: string;
  readonly version: string;
  /** Top-level help's description, already broken into lines of at most 80 columns. */
  readonly about: readonly string[];
  /** Key order is the order `--help` lists them in. */
  readonly commands: Readonly<Record<string, Command>>;
}

/** What the command line asked for. */
export type Outcome =
  | { readonly kind: "run"; readonly run: () => Promise<number> | number }
  /** Help or the version: stdout, exit 0. */
  | { readonly kind: "print"; readonly text: string }
  /** A usage error: two lines on stderr, exit 2. */
  | { readonly kind: "refuse"; readonly text: string };

/** Every way a command line can be wrong. */
export type Problem =
  | { readonly kind: "missing"; readonly what: string }
  | { readonly kind: "unknown-command"; readonly word: string }
  | { readonly kind: "unknown-option"; readonly flag: string }
  | { readonly kind: "missing-value"; readonly flag: string; readonly next: string | null }
  | { readonly kind: "value-for-flag"; readonly flag: string; readonly value: string }
  | { readonly kind: "extra-argument"; readonly value: string }
  | { readonly kind: "not-a-choice"; readonly choices: readonly string[]; readonly value: string }
  | { readonly kind: "repeated-option"; readonly flag: string };

/**
 * Read argv (without the runtime and script) into an Outcome. Never throws for user input.
 *
 * Rules, in the order they apply:
 * 1. Help wins. If any argument before the first `--` is exactly `-h` or `--help`, print help and ignore
 *    every other problem. It is the command's help when argv[0] names a command, the top-level help otherwise.
 * 2. argv[0] decides the mode: absent is `missing <command>`; `--version` prints the version and refuses anything
 *    after it as an extra argument; any other `-...` (including `--`) is an unknown option; a word in the table
 *    is that command; any other word, `-` included, is an unknown command.
 * 3. In a command, arguments and options may come in any order until `--`. After `--`, every argument is
 *    positional. Before it, `-` alone is positional and anything else starting with `-` is an option.
 * 4. An option is matched by its whole name. No prefixes, no short forms except `-h`, no `-abc` groups.
 * 5. `--name=value` gives the value, which may be empty or start with `-`. A flag given `=value` is refused.
 *    `--name value` takes the next argument when there is one and it doesn't start with `-` (or is `-`);
 *    otherwise the value is missing, and the message shows the `=` form when the next argument starts with `-`.
 * 6. Giving any option twice is refused, flags included. Nothing silently wins.
 * 7. Positionals fill args in order; a rest arg takes all that remain; one too many is an extra argument;
 *    a choice arg refuses a word outside its set.
 * 8. At the end: the first required arg with no value, then the first required option not given, is `missing`.
 * The first problem found, scanning left to right, is the one reported.
 */
export function parseArgv(program: Program, argv: readonly string[]): Outcome {
  const first = argv[0];
  const named = first !== undefined && Object.hasOwn(program.commands, first) ? first : null;
  const end = argv.indexOf("--");
  if ((end < 0 ? argv : argv.slice(0, end)).some((a) => a === "-h" || a === "--help")) {
    return { kind: "print", text: named === null ? programHelp(program) : commandHelp(program, named, program.commands[named]!) };
  }
  if (first === undefined) return refusal(program, null, { kind: "missing", what: "<command>" });
  if (named !== null) {
    try {
      const values = parseCommand(program.commands[named]!, argv.slice(1));
      return { kind: "run", run: () => program.commands[named]!.run(values) };
    } catch (e) {
      if (e instanceof Refusal) return refusal(program, named, e.problem);
      throw e;
    }
  }
  if (first.startsWith("-") && first !== "-") {
    const [name, value] = splitAt(first);
    if (name === "--version" && value === null) {
      const extra = argv[1];
      return extra === undefined ? { kind: "print", text: `${program.name} ${program.version}\n` } : refusal(program, null, { kind: "extra-argument", value: extra });
    }
    const known = name === "--version" || name === "--help" || name === "-h";
    return refusal(program, null, known && value !== null ? { kind: "value-for-flag", flag: name, value } : { kind: "unknown-option", flag: name });
  }
  return refusal(program, null, { kind: "unknown-command", word: first });
}

class Refusal extends Error {
  constructor(readonly problem: Problem) {
    super(problem.kind);
  }
}

function refuse(problem: Problem): never {
  throw new Refusal(problem);
}

function splitAt(word: string): [string, string | null] {
  const eq = word.indexOf("=");
  return eq < 0 ? [word, null] : [word.slice(0, eq), word.slice(eq + 1)];
}

function parseCommand(c: Command, argv: readonly string[]): Record<string, Raw> {
  const values: Record<string, Raw> = {};
  for (const a of c.args) values[a.key] = a.kind === "rest" ? [] : null;
  for (const o of c.options) values[o.key] = o.kind === "flag" ? false : typeof o.need === "object" ? o.need.default : null;
  const given = new Set<string>();
  let taken = 0;
  let ended = false;
  const positional = (word: string) => {
    const spec = c.args[Math.min(taken, c.args.length - 1)];
    if (spec === undefined || (taken >= c.args.length && spec.kind !== "rest")) refuse({ kind: "extra-argument", value: word });
    if (spec.kind === "choice" && !Object.hasOwn(spec.choices, word)) refuse({ kind: "not-a-choice", choices: Object.keys(spec.choices), value: word });
    const slot = values[spec.key];
    if (Array.isArray(slot)) slot.push(word);
    else values[spec.key] = word;
    taken++;
  };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    if (ended || !word.startsWith("-") || word === "-") {
      positional(word);
    } else if (word === "--") {
      ended = true;
    } else {
      const [name, value] = splitAt(word);
      if (value !== null && (name === "-h" || name === "--help")) refuse({ kind: "value-for-flag", flag: name, value });
      const o = c.options.find((x) => x.flag === name);
      if (o === undefined) refuse({ kind: "unknown-option", flag: name });
      if (given.has(o.key)) refuse({ kind: "repeated-option", flag: o.flag });
      given.add(o.key);
      if (o.kind === "flag") {
        if (value !== null) refuse({ kind: "value-for-flag", flag: o.flag, value });
        values[o.key] = true;
      } else if (value !== null) {
        values[o.key] = value;
      } else {
        const next = argv[i + 1];
        if (next === undefined || next === "--" || (next.startsWith("-") && next !== "-")) refuse({ kind: "missing-value", flag: o.flag, next: next ?? null });
        values[o.key] = next;
        i++;
      }
    }
  }
  const unfilled = c.args.slice(taken).find((a) => a.kind === "one" || a.kind === "choice");
  if (unfilled) refuse({ kind: "missing", what: placeholder(unfilled) });
  const absent = c.options.find((o) => o.kind === "value" && o.need === "required" && !given.has(o.key));
  if (absent) refuse({ kind: "missing", what: optionCell(absent) });
  return values;
}

const list = (words: readonly string[]) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`);

function describe(p: Problem): string {
  switch (p.kind) {
    case "missing":
      return `missing ${p.what}`;
    case "unknown-command":
      return `unknown command ${JSON.stringify(p.word)}`;
    case "unknown-option":
      return `unknown option ${JSON.stringify(p.flag)}`;
    case "missing-value":
      return p.next?.startsWith("-")
        ? `${p.flag} needs a value. To pass ${JSON.stringify(p.next)} as its value, write \`${p.flag}=${p.next}\`.`
        : `${p.flag} needs a value`;
    case "value-for-flag":
      return `${p.flag} takes no value, got ${JSON.stringify(p.value)}`;
    case "extra-argument":
      return `extra argument ${JSON.stringify(p.value)}`;
    case "not-a-choice":
      return `expected ${list(p.choices)}, not ${JSON.stringify(p.value)}`;
    case "repeated-option":
      return `${p.flag} given twice`;
  }
}

function refusal(program: Program, name: string | null, p: Problem): Outcome {
  const who = name === null ? program.name : `${program.name} ${name}`;
  const hint = name === null ? `Run \`${program.name} --help\` to see the commands.` : `Run \`${who} --help\` for its arguments and options.`;
  return { kind: "refuse", text: `${who}: ${describe(p)}\n${hint}\n` };
}

type NamedArg = Command["args"][number];
type NamedOption = Command["options"][number];

const placeholder = (a: NamedArg) => (a.kind === "choice" ? Object.keys(a.choices).join("|") : `<${a.key}>`);
const optionCell = (o: NamedOption) => (o.kind === "flag" ? o.flag : `${o.flag} <${o.meta}>`);

function commandHelp(program: Program, name: string, c: Command): string {
  const usage = [
    `${program.name} ${name}`,
    ...c.args.map((a) => (a.kind === "optional" ? `[<${a.key}>]` : a.kind === "rest" ? `[<${a.key}>...]` : placeholder(a))),
    ...c.options.filter((o) => o.kind === "value" && o.need === "required").map(optionCell),
    "[options]",
  ].join(" ");
  const argRows = c.args.flatMap((a): [string, string][] =>
    a.kind === "choice" ? Object.entries(a.choices) : [[a.kind === "rest" ? `<${a.key}>...` : `<${a.key}>`, a.help]]);
  const optionRows: [string, string][] = [
    ...c.options.map((o): [string, string] => [optionCell(o), o.kind === "value" && typeof o.need === "object" ? `${o.help} (default: ${o.need.default})` : o.help]),
    ["-h, --help", "show this help"],
  ];
  const width = Math.max(...[...argRows, ...optionRows].map(([left]) => left.length)) + 2;
  return [
    [`usage: ${usage}`],
    [c.summary, ...c.about],
    ...(argRows.length ? [["arguments:", ...columns(argRows, width)]] : []),
    ["options:", ...columns(optionRows, width)],
  ].map((block) => block.join("\n") + "\n").join("\n");
}

function programHelp(program: Program): string {
  const commandRows = Object.entries(program.commands).map(([name, c]): [string, string] => [name, c.summary]);
  const optionRows: [string, string][] = [["-h, --help", "show this help"], ["--version", `print ${program.name}'s version`]];
  const width = Math.max(...[...commandRows, ...optionRows].map(([left]) => left.length)) + 2;
  return [
    [`usage: ${program.name} <command> [arguments] [options]`, `       ${program.name} --version`],
    [...program.about],
    ["commands:", ...columns(commandRows, width)],
    ["options:", ...columns(optionRows, width)],
    [`Run \`${program.name} <command> --help\` for a command's arguments and options.`],
  ].map((block) => block.join("\n") + "\n").join("\n");
}

function columns(rows: readonly (readonly [string, string])[], width: number): string[] {
  return rows.map(([left, right]) => `  ${left.padEnd(width)}${right}`);
}
