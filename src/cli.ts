#!/usr/bin/env bun
// The command line: a table of subcommands, parsed and reported the way Python's argparse does.
// Also the commands that start a patchbook or follow another upstream, which use every other part.
import { mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { cmdBuild, cmdScaffold, cmdStatus, writeBuildLock } from "./assemble.ts";
import { cmdBlocks } from "./blocks.ts";
import { Book, noticeLeftOut, PB, refuseNestedGit } from "./book.ts";
import { cmdShow } from "./changes.ts";
import { cmdHook, commitAdvice, installHook, installHookOrWarn, keepGitHook } from "./githook.ts";
import { Fail } from "./lib/fail.ts";
import { exists, isSymlink, lexists, readText, resolve, writeText } from "./lib/fs.ts";
import { git, refuseCredentials } from "./lib/proc.ts";
import { rstrip, split, strRepr } from "./lib/py.ts";
import { quoteToml } from "./lib/toml.ts";
import { cmdIntent, cmdRecord } from "./record.ts";
import { checkUpstreamRemote, notThisRepo } from "./remote.ts";
import { cmdConfig } from "./settings.ts";
import { cmdSkill, installSkill, recordSkill, SCHEDULE, leftBehindSkill } from "./skill.ts";
import { absoluteRemote, defaultName, cmdUpstream } from "./store.ts";
import { cmdCheck, cmdSync, syncUpstream } from "./sync.ts";
import { Undo } from "./undo.ts";

// The release build replaces process.env.PATCHBOOK_VERSION at compile time with --define.
const VERSION = process.env.PATCHBOOK_VERSION ?? pkg.version;

// Starting a patchbook, and following another upstream

function upstreamToml(name: string, remote: string, path: string, branch: string, mount: string, vendor: string | null = null): string {
  const lines = ["[[upstream]]", `name = ${quoteToml(name)}`, `remote = ${quoteToml(remote)}`];
  if (path) lines.push(`path = ${quoteToml(path)}`);
  lines.push(`branch = ${quoteToml(branch)}`, `mount = ${quoteToml(mount)}`);
  if (vendor) lines.push(`vendor = ${quoteToml(vendor)}`);
  return lines.join("\n") + "\n";
}

function configText(layout: "fork" | "folder", upstream: string, output?: [string, string]): string {
  let text = `layout = "${layout}"\n\n` + upstream;
  if (output) text += `\n[output]\nfrom = ${quoteToml(output[0])}\nto = ${quoteToml(output[1])}\n`;
  return text;
}

function writeConfig(root: string, text: string): void {
  const d = join(root, PB);
  mkdirSync(d, { recursive: true });
  writeText(join(d, "series"), "");
  writeText(join(d, "retired.md"), "# Retired changes\n\nChanges dropped because upstream made them unnecessary or impossible, and why.\n");
  writeText(join(d, "config.toml"), text);
}

const noHook = () => ({ ...process.env, PATCHBOOK_HOOK: "0" });

async function cmdClone(args: { url: string; dir: string | null; branch: string | null }) {
  refuseCredentials(args.url);
  const dest = resolve(args.dir || basename(rstrip(args.url, "/")).replace(/\.git$/, ""));
  if (exists(dest)) throw new Fail(`${dest} already exists`);
  const clone = ["clone", "--quiet", "--origin", "upstream", ...(args.branch ? ["--branch", args.branch] : [])];
  git([...clone, "--end-of-options", args.url, dest], { cwd: dirname(dest) });
  const branch = git(["branch", "--show-current"], { cwd: dest });
  const commit = git(["rev-parse", "HEAD"], { cwd: dest });
  const inherited = lexists(join(dest, PB));
  if (inherited) rmSync(join(dest, PB), { recursive: true, force: true });
  const name = defaultName(args.url, "");
  const text = configText("fork", upstreamToml(name, args.url, "", branch, ""));
  await Book.fromText(dest, text);
  writeConfig(dest, text);
  const book = await Book.open(dest);
  book.writeLock(name, commit, git(["rev-parse", "HEAD^{tree}"], { cwd: dest }));
  writeBuildLock(book, book.currentOutput());
  process.chdir(dest);
  keepGitHook(book);
  await installHook(book);
  if (installSkill(book)) await recordSkill(book);
  git(["add", "-A"], { cwd: dest });
  git(["commit", "--quiet", "-m", `Start a patchbook at upstream ${commit.slice(0, 7)}`], { cwd: dest, env: noHook() });
  process.stdout.write(`cloned ${args.url} into ${dest}, pinned at ${commit.slice(0, 7)}.\n`
    + (inherited ? `Upstream has a ${PB}/ of its own. It is not part of this fork, so patchbook removed it and builds leave it out.\n` : "")
    + `${commitAdvice(book)}\n`
    + `${SCHEDULE}\n`
    + `To publish it: gh repo create <name> --private --source ${dest} --push\n`);
  return 0;
}

function refuseDanglingLinks(root: string): void {
  for (const p of [PB, ...["config.toml", "series", "retired.md", "upstream.lock"].map((f) => `${PB}/${f}`)]) {
    if (isSymlink(join(root, p)) && !exists(join(root, p))) {
      throw new Fail(`${p} is a symlink to a missing ${p === PB ? "folder" : "file"}. Remove the link, or put back what it points to.`);
    }
  }
}

async function allOrNothing(book: Book, write: (undo: Undo) => Promise<void>): Promise<void> {
  const undo = new Undo();
  const gitFiles = git(["rev-parse", "--path-format=absolute", "--git-path", "config", "--git-path", "index"], { cwd: book.root }).split("\n");
  for (const p of [resolve(book.dir), ...gitFiles, ...book.upstreams.flatMap((u) => (u.vendor ? [u.vendor] : []))]) undo.hold(p);
  try {
    await write(undo);
  } catch (e) {
    const stuck = undo.restore();
    if (stuck.length) {
      process.stderr.write("patchbook: init couldn't put these back as they were:\n  " + stuck.join("\n  ")
        + "\nCheck that you can write to them, and put them back yourself before you run init again.\n");
    }
    throw e;
  }
}

async function cmdInit(args: {
  upstream: string; name: string | null; branch: string; path: string; outputTo: string | null; outputFrom: string; vendor: string | null;
}) {
  refuseCredentials(args.upstream);
  const root = git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  refuseDanglingLinks(root);
  if (lexists(join(root, PB, "config.toml"))) throw new Fail(`${root} already has a patchbook. To follow another upstream: patchbook track`);
  for (const file of ["series", "retired.md"]) {
    if (lexists(join(root, PB, file))) throw new Fail(`${PB}/${file} already exists. Move it away, or restore ${PB}/config.toml, then run init again.`);
  }
  const name = args.name || defaultName(args.upstream, args.path);
  if (args.outputTo !== null) {
    const text = configText("folder", upstreamToml(name, args.upstream, args.path, args.branch, "", args.vendor), [args.outputFrom, args.outputTo]);
    const book = await Book.fromText(root, text);
    for (const u of book.upstreams) if (u.vendor) refuseNestedGit(root, u.name, u.vendor);
    book.refuseLinks();
    book.refuseLinkedTop();
    notThisRepo(root, args.upstream);
    await allOrNothing(book, async (undo) => {
      book.dropPin(name);
      syncUpstream(book, book.upstreams[0]!, args.branch, []);
      installSkill(book, undo);
      writeConfig(root, text);
      installHookOrWarn(book, undo);
      await installHook(book, undo);
    });
    process.stdout.write(`Next: patchbook build, then stage and commit.\n${SCHEDULE}\n`);
    return 0;
  }
  if (args.vendor !== null) {
    throw new Fail("--vendor needs --output-to: the root upstream of a fork builds into the whole repo, so no folder can hold a vendored copy of it. To vendor another upstream, use patchbook track --vendor.");
  }
  const text = configText("fork", upstreamToml(name, args.upstream, args.path, args.branch, ""));
  const book = await Book.fromText(root, text);
  book.refuseLinks();
  book.refuseLinkedTop();
  notThisRepo(root, args.upstream);
  const hasRemote = split(git(["remote"], { cwd: root })).includes("upstream");
  if (hasRemote) checkUpstreamRemote(root, args.upstream, args.branch);
  git(["fetch", "--quiet", "--end-of-options", args.upstream, args.branch], { cwd: root });
  const base = git(["merge-base", "HEAD", "FETCH_HEAD"], { cwd: root });
  book.upstreams[0]!.files(base);
  await allOrNothing(book, async (undo) => {
    book.writeLock(name, base, book.upstreams[0]!.treeOf(base));
    if (!hasRemote) git(["remote", "add", "--end-of-options", "upstream", args.upstream], { cwd: root });
    const installed = installSkill(book, undo);
    writeConfig(root, text);
    installHookOrWarn(book, undo);
    await installHook(book, undo);
    if (installed && (installed.changed.length || leftBehindSkill(book).length)) await recordSkill(book);
  });
  process.stdout.write(`pinned upstream at ${base.slice(0, 7)}, where this repo branched from ${args.upstream}.\n`
    + "Capture your existing changes with `patchbook record`, then `patchbook build`, stage, and commit.\n" + SCHEDULE + "\n");
  return 0;
}

/** Follow one more upstream, mounted at its own folder of the staged tree. */
async function cmdTrack(args: { name: string; url: string; branch: string; path: string; mount: string | null; vendor: string | null }) {
  refuseCredentials(args.url);
  const book = await Book.find();
  book.refuseLinkedTop();
  installHookOrWarn(book);
  if (book.upstreams.some((u) => u.name === args.name)) throw new Fail(`already following an upstream called ${args.name}`);
  const config = join(book.dir, "config.toml");
  const mount = args.mount ?? args.name;
  const text = rstrip(readText(config), "\n") + "\n\n" + upstreamToml(args.name, args.url, args.path, args.branch, mount, args.vendor);
  const candidate = await Book.fromText(book.root, text);
  for (const u of candidate.upstreams) if (u.vendor) refuseNestedGit(book.root, u.name, u.vendor);
  candidate.dropPin(args.name);
  syncUpstream(candidate, candidate.upstream(args.name), args.branch, []);
  writeText(config, text);
  const where = mount ? `${mount}/` : "the root";
  process.stdout.write(`Its files appear at ${where} of the staged tree. Ship what you need with edits (move, copy), then build.\n`);
  return 0;
}

// The table of subcommands

type Positional = { dest: string; nargs?: "?" | "*"; choices?: readonly string[]; help?: string };
type Option = { flag: `--${string}`; takes?: "value"; metavar?: string; default?: string; required?: true; help?: string };
type Parsed = Map<string, string | string[] | boolean | null>;
type Command = { help: string; positionals?: Positional[]; options?: Option[]; run(a: Args): Promise<number> | number };

/** The parsed arguments, read by the type each one was declared with. */
class Args {
  constructor(private readonly values: Parsed) {}

  private get(dest: string) {
    if (!this.values.has(dest)) throw new Error(`no argument ${dest}`);
    return this.values.get(dest);
  }

  text(dest: string): string {
    const v = this.get(dest);
    if (typeof v !== "string") throw new Error(`${dest} isn't a string`);
    return v;
  }

  maybe(dest: string): string | null {
    const v = this.get(dest);
    if (v !== null && typeof v !== "string") throw new Error(`${dest} isn't a string or null`);
    return v ?? null;
  }

  flag(dest: string): boolean {
    const v = this.get(dest);
    if (typeof v !== "boolean") throw new Error(`${dest} isn't a flag`);
    return v;
  }

  list(dest: string): string[] {
    const v = this.get(dest);
    if (!Array.isArray(v)) throw new Error(`${dest} isn't a list`);
    return v;
  }
}

const UPSTREAM_PATH = "the upstream folder to follow, if not the whole repo";

const COMMANDS = new Map<string, Command>([
  ["clone", {
    help: "fork an upstream repo, with its history, and start a patchbook",
    positionals: [{ dest: "url" }, { dest: "dir", nargs: "?" }],
    options: [{ flag: "--branch", takes: "value" }],
    run: (a) => cmdClone({ url: absoluteRemote(a.text("url")), dir: a.maybe("dir"), branch: a.maybe("branch") }),
  }],
  ["init", {
    help: "start a patchbook in this repo",
    options: [
      { flag: "--upstream", takes: "value", required: true, help: "upstream's git URL" },
      { flag: "--name", takes: "value", help: "what to call it (default: the last part of --path or the URL)" },
      { flag: "--branch", takes: "value", default: "main" },
      { flag: "--path", takes: "value", default: "", help: UPSTREAM_PATH },
      { flag: "--output-to", takes: "value", help: "build into this folder instead of over the repo (the folder layout)" },
      { flag: "--output-from", takes: "value", default: "", help: "folder layout: the staged folder that ships" },
      { flag: "--vendor", takes: "value", help: "also keep a byte-for-byte copy of upstream in this folder" },
    ],
    run: (a) => cmdInit({
      upstream: absoluteRemote(a.text("upstream")), name: a.maybe("name"), branch: a.text("branch"), path: a.text("path"),
      outputTo: a.maybe("output_to"), outputFrom: a.text("output_from"), vendor: a.maybe("vendor"),
    }),
  }],
  ["track", {
    help: "follow another upstream, mounted at its own folder",
    positionals: [{ dest: "name" }, { dest: "url" }],
    options: [
      { flag: "--branch", takes: "value", default: "main" },
      { flag: "--path", takes: "value", default: "", help: UPSTREAM_PATH },
      { flag: "--mount", takes: "value", help: "the staged folder its files appear under (default: its name)" },
      { flag: "--vendor", takes: "value", help: "also keep a byte-for-byte copy in this folder" },
    ],
    run: (a) => cmdTrack({
      name: a.text("name"), url: absoluteRemote(a.text("url")), branch: a.text("branch"), path: a.text("path"), mount: a.maybe("mount"),
      vendor: a.maybe("vendor"),
    }),
  }],
  ["upstream", {
    help: "read an upstream at its pin: list, print, export, or diff the last sync",
    positionals: [{ dest: "name" }, { dest: "path", nargs: "?", help: "a path inside the upstream, as upstream has it" }],
    options: [
      { flag: "--diff", help: "what upstream changed in the last sync" },
      { flag: "--since", takes: "value", help: "what upstream changed since this commit" },
      { flag: "--export", takes: "value", metavar: "DIR", help: "write every file at the pin into DIR" },
    ],
    run: (a) => cmdUpstream({ name: a.text("name"), path: a.maybe("path"), diff: a.flag("diff"), since: a.maybe("since"), export: a.maybe("export") }),
  }],
  ["check", { help: "has any upstream moved? exits 10 if so", run: () => cmdCheck() }],
  ["sync", {
    help: "move the pins to upstream and carry every change forward",
    positionals: [
      { dest: "name", nargs: "?", help: "only this upstream" },
      { dest: "ref", nargs: "?", help: "a branch, tag or commit (default: the upstream's branch)" },
    ],
    run: (a) => cmdSync({ name: a.maybe("name"), ref: a.maybe("ref") }),
  }],
  ["status", {
    help: "list what is broken",
    options: [{ flag: "--json", help: "machine-readable, with block text" }],
    run: (a) => cmdStatus({ json: a.flag("json") }),
  }],
  ["build", {
    help: "apply the patchbook to the pinned upstreams and write the output",
    options: [
      { flag: "--force", help: "overwrite output files edited since the last build" },
      { flag: "--commit", help: "commit the result; in a fork, as a merge of upstream" },
    ],
    run: (a) => cmdBuild({ force: a.flag("force"), commit: a.flag("commit") }),
  }],
  ["record", {
    help: "move edits made to the output in the working tree into a change (the commit hook records only what's staged)",
    positionals: [{ dest: "change", nargs: "?", help: "the change to add them to (default: the model picks or names one)" }],
    options: [{ flag: "--intent", takes: "value", help: "what the change is for (default: the model writes it; if it can't, the intent is left empty)" }],
    run: (a) => cmdRecord({ change: a.maybe("change"), intent: a.maybe("intent") }),
  }],
  ["intent", {
    help: "fill the empty intents that record left when the model failed",
    positionals: [{ dest: "change", nargs: "?", help: "only this change (default: every change and block entry with an empty intent)" }],
    options: [{ flag: "--intent", takes: "value", help: "the intent to write, for the change you name (default: the model writes it)" }],
    run: (a) => cmdIntent({ change: a.maybe("change"), intent: a.maybe("intent") }),
  }],
  ["hook", {
    help: "install the pre-commit hook, run it, or show which hook git runs",
    positionals: [{ dest: "action", choices: ["install", "run", "status"] }],
    run: (a) => cmdHook({ action: a.text("action") === "install" ? "install" : a.text("action") === "status" ? "status" : "run" }),
  }],
  ["skill", {
    help: "write this patchbook's update skill into the repo",
    positionals: [{ dest: "action", choices: ["install"] }],
    run: () => cmdSkill(),
  }],
  ["config", {
    help: "show settings and where each comes from, or set one",
    positionals: [{ dest: "name", nargs: "?", help: "a setting, such as intent.provider" }, { dest: "value", nargs: "?" }],
    options: [
      { flag: "--project", help: "set it in this project's .patchbook/config.toml, not yours" },
      { flag: "--unset", help: "remove it, so the next layer's value applies" },
    ],
    run: (a) => cmdConfig({ name: a.maybe("name"), value: a.maybe("value"), project: a.flag("project"), unset: a.flag("unset") }),
  }],
  ["show", {
    help: "print a change, with its file edits as diffs",
    positionals: [{ dest: "change" }],
    run: (a) => cmdShow({ change: a.text("change") }),
  }],
  ["blocks", {
    help: "print an upstream file's blocks with their hashes",
    positionals: [{ dest: "file", help: "its staged path, such as skills/arena/SKILL.md" }],
    run: (a) => cmdBlocks({ file: a.text("file") }),
  }],
  ["scaffold", {
    help: "append skeleton block entries for missing blocks",
    positionals: [{ dest: "file", nargs: "*" }],
    run: (a) => cmdScaffold({ file: a.list("file") }),
  }],
]);

const DESCRIPTION = "Keep your changes to an upstream repo, each with its intent, and keep pulling from upstream.";
const HELP = "show this help message and exit";

// Parsing, the way argparse does it

/** Leaving the program: help or a usage error. */
class Exit extends Error {
  constructor(readonly code: number, readonly text: string) {
    super(text);
  }
}

const dest = (o: Option) => o.flag.slice(2).replaceAll("-", "_");
const metavar = (o: Option) => o.metavar ?? dest(o).toUpperCase();
const posMetavar = (p: Positional) => (p.choices ? `{${p.choices.join(",")}}` : p.dest);
const NEGATIVE = /^-\d+$|^-\d*\.\d+$/;

type Parser = { prog: string; positionals: Positional[]; options: Option[]; description?: string; subcommands?: Map<string, Command> };

function parserFor(name: string, c: Command): Parser {
  return { prog: `patchbook ${name}`, positionals: c.positionals ?? [], options: c.options ?? [] };
}

const TOP: Parser = {
  prog: "patchbook",
  positionals: [{ dest: "cmd", choices: Array.from(COMMANDS.keys()) }],
  options: [{ flag: "--version", help: "show the version and exit" }],
  description: DESCRIPTION,
  subcommands: COMMANDS,
};

function width(): number {
  const env = Number(process.env["COLUMNS"]);
  return (Number.isInteger(env) && env > 0 ? env : process.stdout.columns || 80) - 2;
}

function usageParts(p: Parser): { opt: string[]; pos: string[] } {
  const opt = ["[-h]", ...p.options.map((o) => {
    const part = o.takes ? `${o.flag} ${metavar(o)}` : o.flag;
    return o.required ? part : `[${part}]`;
  })];
  const pos = p.positionals.map((x) => {
    if (p.subcommands) return `${posMetavar(x)} ...`;
    if (x.nargs === "?") return `[${posMetavar(x)}]`;
    if (x.nargs === "*") return `[${posMetavar(x)} ...]`;
    return posMetavar(x);
  });
  return { opt, pos };
}

function usage(p: Parser): string {
  const prefix = "usage: ";
  const w = width();
  const { opt, pos } = usageParts(p);
  const flat = [p.prog, ...opt, ...pos].join(" ");
  if (prefix.length + flat.length <= w) return prefix + flat;
  const lines = (parts: string[], indent: string, first = false): string[] => {
    const out: string[] = [];
    let line: string[] = [];
    let used = (first ? prefix.length : indent.length) - 1;
    for (const part of parts) {
      if (used + 1 + part.length > w && line.length) {
        out.push(indent + line.join(" "));
        line = [];
        used = indent.length - 1;
      }
      line.push(part);
      used += part.length + 1;
    }
    if (line.length) out.push(indent + line.join(" "));
    if (first && out[0] !== undefined) out[0] = out[0].slice(indent.length);
    return out;
  };
  let wrapped: string[];
  if (prefix.length + p.prog.length <= 0.75 * w) {
    const indent = " ".repeat(prefix.length + p.prog.length + 1);
    wrapped = opt.length ? [...lines([p.prog, ...opt], indent, true), ...lines(pos, indent)] : lines([p.prog, ...pos], indent, true);
  } else {
    const indent = " ".repeat(prefix.length);
    const all = lines([...opt, ...pos], indent);
    wrapped = [p.prog, ...(all.length > 1 ? [...lines(opt, indent), ...lines(pos, indent)] : all)];
  }
  return prefix + wrapped.join("\n");
}

// textwrap breaks a hyphenated word after a hyphen between letters: byte-|for-|byte.
const HYPHEN = /(?<=(?:[^\W\d]{2}|[^\W\d]-[^\W\d])-)(?=[^\W\d]-?[^\W\d])/u;

/** textwrap.wrap: fill lines greedily with words and hyphenated pieces, splitting a word longer than a line. */
function wrap(text: string, w: number): string[] {
  const chunks = split(text).flatMap((word, i) => [...(i ? [" "] : []), ...word.split(HYPHEN)]).reverse();
  const lines: string[] = [];
  while (chunks.length) {
    const line: string[] = [];
    let used = 0;
    if (chunks.at(-1) === " " && lines.length) chunks.pop();
    for (let next = chunks.at(-1); next !== undefined && used + next.length <= w; next = chunks.at(-1)) {
      line.push(next);
      used += next.length;
      chunks.pop();
    }
    const long = chunks.at(-1);
    const room = w < 1 ? 1 : w - used;
    if (long !== undefined && long.length > w && room > 0) {
      const hyphen = long.lastIndexOf("-", room - 1);
      const end = hyphen > 0 && /[^-]/.test(long.slice(0, hyphen)) ? hyphen + 1 : room;
      line.push(long.slice(0, end));
      chunks[chunks.length - 1] = long.slice(end);
    }
    if (line.at(-1) === " ") line.pop();
    if (line.length) lines.push(line.join(""));
  }
  return lines;
}

function helpText(p: Parser): string {
  const w = width();
  type Item = { invocation: string; help?: string | undefined; indent: number };
  const positional: Item[] = [];
  for (const x of p.positionals) {
    positional.push({ invocation: posMetavar(x), help: x.help, indent: 2 });
    for (const [name, c] of p.subcommands ?? []) positional.push({ invocation: name, help: c.help, indent: 4 });
  }
  const options: Item[] = [
    { invocation: "-h, --help", help: HELP, indent: 2 },
    ...p.options.map((o) => ({ invocation: o.takes ? `${o.flag} ${metavar(o)}` : o.flag, help: o.help, indent: 2 })),
  ];
  // argparse measures subcommand names at the outer indent.
  const longest = Math.max(...[...positional, ...options].map((i) => i.invocation.length + 2));
  const helpPosition = Math.min(longest + 2, Math.min(24, Math.max(w - 20, 4)));
  const helpWidth = Math.max(w - helpPosition, 11);
  const format = ({ invocation, help, indent }: Item): string => {
    const pad = " ".repeat(indent);
    if (!help) return `${pad}${invocation}\n`;
    const [first = "", ...rest] = wrap(help, helpWidth);
    const room = helpPosition - indent - 2;
    const head = invocation.length <= room ? `${pad}${invocation.padEnd(room)}  ${first}\n` : `${pad}${invocation}\n${" ".repeat(helpPosition)}${first}\n`;
    return head + rest.map((l) => " ".repeat(helpPosition) + l + "\n").join("");
  };
  const blocks = [usage(p)];
  if (p.description) blocks.push(wrap(p.description, Math.max(w, 11)).join("\n"));
  if (positional.length) blocks.push("positional arguments:\n" + positional.map(format).join("").replace(/\n$/, ""));
  blocks.push("options:\n" + options.map(format).join("").replace(/\n$/, ""));
  return blocks.join("\n\n") + "\n";
}

function error(p: Parser, message: string): Exit {
  return new Exit(2, `${usage(p)}\n${p.prog}: error: ${message}\n`);
}

type Classified = { kind: "positional" } | { kind: "unknown" } | { kind: "help"; explicit: string | null } | { kind: "option"; option: Option; explicit: string | null };

function classify(p: Parser, arg: string): Classified {
  if (!arg.startsWith("-") || arg === "-") return { kind: "positional" };
  const flags: [string, Option | null][] = [["-h", null], ["--help", null], ...p.options.map((o): [string, Option] => [o.flag, o])];
  const found = (option: Option | null, explicit: string | null): Classified =>
    option ? { kind: "option", option, explicit } : { kind: "help", explicit };
  const exact = flags.find(([f]) => f === arg);
  if (exact) return found(exact[1], null);
  const eq = arg.indexOf("=");
  if (eq !== -1) {
    const named = flags.find(([f]) => f === arg.slice(0, eq));
    if (named) return found(named[1], arg.slice(eq + 1));
  }
  if (arg.startsWith("--")) {
    const prefix = eq === -1 ? arg : arg.slice(0, eq);
    const matches = flags.filter(([f]) => f.startsWith(prefix));
    if (matches.length > 1) throw error(p, `ambiguous option: ${prefix} could match ${matches.map(([f]) => f).join(", ")}`);
    const [match] = matches;
    if (match) return found(match[1], eq === -1 ? null : arg.slice(eq + 1));
  } else if (arg.startsWith("-h")) return { kind: "help", explicit: arg.slice(2) };
  if (NEGATIVE.test(arg) || arg.includes(" ")) return { kind: "positional" };
  return { kind: "unknown" };
}

/** Parse one parser's arguments into values, collecting the ones it doesn't know into extras. */
function parse(p: Parser, argv: readonly string[], extras: string[]): Parsed {
  const values: Parsed = new Map();
  for (const o of p.options) values.set(dest(o), o.takes ? (o.default ?? null) : false);
  const starred = new Map(p.positionals.filter((x) => x.nargs === "*").map((x): [string, string[]] => [x.dest, []]));
  for (const x of p.positionals) values.set(x.dest, starred.get(x.dest) ?? null);
  const seen = new Set<string>();
  const capacity = p.positionals.some((x) => x.nargs === "*") ? Infinity : p.positionals.length;
  let taken = 0;
  let rest = false;
  const take = (arg: string) => {
    if (taken >= capacity) {
      extras.push(arg);
      return;
    }
    const x = p.positionals[Math.min(taken, p.positionals.length - 1)]!;
    taken++;
    if (x.choices && !x.choices.includes(arg)) {
      throw error(p, `argument ${x.dest}: invalid choice: ${strRepr(arg)} (choose from ${x.choices.map(strRepr).join(", ")})`);
    }
    const list = starred.get(x.dest);
    if (list) list.push(arg);
    else values.set(x.dest, arg);
    seen.add(x.dest);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (rest) {
      take(arg);
      continue;
    }
    if (arg === "--") {
      rest = true;
      continue;
    }
    const c = classify(p, arg);
    if (c.kind === "positional") take(arg);
    else if (c.kind === "unknown") extras.push(arg);
    else if (c.kind === "help") {
      if (c.explicit) throw error(p, `argument -h/--help: ignored explicit argument ${strRepr(c.explicit)}`);
      throw new Exit(0, helpText(p));
    } else if (!c.option.takes) {
      if (c.explicit !== null) throw error(p, `argument ${c.option.flag}: ignored explicit argument ${strRepr(c.explicit)}`);
      values.set(dest(c.option), true);
    } else if (c.explicit !== null) {
      values.set(dest(c.option), c.explicit);
      seen.add(dest(c.option));
    } else {
      const next = argv[i + 1];
      if (next === undefined || next === "--" || classify(p, next).kind !== "positional") {
        throw error(p, `argument ${c.option.flag}: expected one argument`);
      }
      values.set(dest(c.option), next);
      seen.add(dest(c.option));
      i++;
    }
  }
  const missing = [
    ...p.options.filter((o) => o.required && !seen.has(dest(o))).map((o) => o.flag),
    ...p.positionals.filter((x) => !x.nargs && !seen.has(x.dest)).map((x) => x.dest),
  ];
  if (missing.length) throw error(p, `the following arguments are required: ${missing.join(", ")}`);
  return values;
}

async function main(argv: readonly string[]): Promise<number> {
  const extras: string[] = [];
  let i = 0;
  let command: [string, Command] | null = null;
  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    const c = classify(TOP, arg);
    if (c.kind === "help") {
      if (c.explicit) throw error(TOP, `argument -h/--help: ignored explicit argument ${strRepr(c.explicit)}`);
      throw new Exit(0, helpText(TOP));
    }
    if (c.kind === "option" && c.option.flag === "--version") throw new Exit(0, `patchbook ${VERSION}\n`);
    if (c.kind !== "positional") {
      extras.push(arg);
      continue;
    }
    const found = COMMANDS.get(arg);
    if (!found) {
      const choices = Array.from(COMMANDS.keys()).map(strRepr).join(", ");
      throw error(TOP, `argument cmd: invalid choice: ${strRepr(arg)} (choose from ${choices})`);
    }
    command = [arg, found];
    break;
  }
  if (command === null) throw error(TOP, "the following arguments are required: cmd");
  const [name, c] = command;
  const values = parse(parserFor(name, c), argv.slice(i + 1), extras);
  if (extras.length) throw error(TOP, `unrecognized arguments: ${extras.join(" ")}`);
  return c.run(new Args(values));
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof Exit) {
    (e.code === 0 ? process.stdout : process.stderr).write(e.text);
    process.exitCode = e.code;
  } else if (e instanceof Fail) {
    process.stderr.write(`patchbook: ${e.message}\n`);
    process.exitCode = 1;
  } else throw e;
} finally {
  noticeLeftOut();
}
