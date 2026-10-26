#!/usr/bin/env bun
import { mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { cmdBuild, cmdScaffold, cmdStatus, writeBuildLock } from "./assemble.ts";
import { cmdBlocks } from "./blocks.ts";
import { Book, keepAttributes, noticeLeftOut, PB, refuseFoldedUpstream, refuseNestedGit } from "./book.ts";
import { cmdShow } from "./changes.ts";
import { cmdHook, commitAdvice, installHook, installHookOrWarn, keepGitHook } from "./githook.ts";
import { arg, command, flag, option, parseArgv, type Program } from "./lib/args.ts";
import { Fail } from "./lib/fail.ts";
import { exists, isSymlink, lexists, readText, resolve, writeText } from "./lib/fs.ts";
import { git, refuseCredentials } from "./lib/proc.ts";
import { say, warn } from "./lib/term.ts";
import { quoteToml } from "./lib/toml.ts";
import { cmdIntent, cmdRecord } from "./record.ts";
import { checkUpstreamRemote, notThisRepo } from "./remote.ts";
import { cmdConfig } from "./settings.ts";
import { cmdSkill, folderFail, installSkill, recordSkill, SCHEDULE, leftBehindSkill } from "./skill.ts";
import { absoluteRemote, defaultName, cmdUpstream, upstreamFolder } from "./store.ts";
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
  keepAttributes(root);
}

const noHook = () => ({ ...process.env, PATCHBOOK_HOOK: "0" });

async function cmdClone(args: { url: string; dir: string | null; branch: string | null }) {
  refuseCredentials(args.url);
  const dest = resolve(args.dir || basename(args.url.replace(/\/+$/, "")).replace(/\.git$/, ""));
  if (exists(dest)) throw new Fail(`${dest} already exists`);
  const clone = ["clone", "--quiet", "--origin", "upstream", ...(args.branch ? ["--branch", args.branch] : [])];
  git([...clone, "--end-of-options", args.url, dest], { cwd: dirname(dest) });
  const branch = git(["branch", "--show-current"], { cwd: dest });
  const commit = git(["rev-parse", "HEAD"], { cwd: dest });
  try {
    refuseFoldedUpstream(git(["ls-tree", "-r", "-z", "--name-only", "HEAD"], { cwd: dest }).split("\0"));
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    throw e;
  }
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
  const skill = installSkill(book);
  if (skill && !skill.blocked.length) await recordSkill(book);
  git(["add", "-A"], { cwd: dest });
  git(["commit", "--quiet", "-m", `Start a patchbook at upstream ${commit.slice(0, 7)}`], { cwd: dest, env: noHook() });
  say(`cloned ${args.url} into ${dest}, pinned at ${commit.slice(0, 7)}.\n`
    + (inherited ? `Upstream has a ${PB}/ of its own. It is not part of this fork, so patchbook removed it and builds leave it out.\n` : "")
    + `${commitAdvice(book)}\n`
    + `${SCHEDULE}\n`
    + `To publish it: gh repo create <name> --private --source ${dest} --push\n`);
  if (skill?.blocked.length) throw folderFail(skill.blocked);
  return 0;
}

function refuseDanglingLinks(root: string): void {
  for (const p of [PB, ...["config.toml", "series", "retired.md", "upstream.lock"].map((f) => `${PB}/${f}`)]) {
    if (isSymlink(join(root, p)) && !exists(join(root, p))) {
      throw new Fail(`${p} is a symlink to a missing ${p === PB ? "folder" : "file"}. Remove the link, or put back what it points to.`);
    }
  }
}

async function allOrNothing<T>(book: Book, command: string, write: (undo: Undo) => Promise<T>): Promise<T> {
  const undo = new Undo();
  const gitFiles = git(["rev-parse", "--path-format=absolute", "--git-path", "config", "--git-path", "index"], { cwd: book.root }).split("\n");
  for (const p of [resolve(book.dir), ...gitFiles, ...book.upstreams.flatMap((u) => (u.vendor ? [u.vendor] : []))]) undo.hold(p);
  try {
    return await write(undo);
  } catch (e) {
    const stuck = undo.restore();
    if (stuck.length) {
      warn(`patchbook: ${command} couldn't put these back as they were:\n  ` + stuck.join("\n  ")
        + `\nCheck that you can write to them, and put them back yourself before you run ${command} again.\n`);
    }
    throw e;
  }
}

async function cmdInit(args: {
  upstream: string; name: string | null; branch: string; path: string; outputTo: string | null; outputFrom: string; vendor: string | null;
}) {
  refuseCredentials(args.upstream);
  args.path = upstreamFolder(args.path);
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
    const skill = await allOrNothing(book, "init", async (undo) => {
      book.dropPin(name);
      syncUpstream(book, book.upstreams[0]!, args.branch, []);
      const skill = installSkill(book, undo);
      writeConfig(root, text);
      installHookOrWarn(book, undo);
      await installHook(book, undo);
      return skill;
    });
    say(`Next: patchbook build, then stage and commit.\n${SCHEDULE}\n`);
    if (skill?.blocked.length) throw folderFail(skill.blocked);
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
  const hasRemote = git(["remote"], { cwd: root }).split("\n").includes("upstream");
  if (hasRemote) checkUpstreamRemote(root, args.upstream, args.branch);
  git(["fetch", "--quiet", "--end-of-options", args.upstream, args.branch], { cwd: root });
  const base = git(["merge-base", "HEAD", "FETCH_HEAD"], { cwd: root });
  const first = book.upstreams[0]!;
  refuseFoldedUpstream(first.mounted(first.files(base)).keys());
  const installed = await allOrNothing(book, "init", async (undo) => {
    book.writeLock(name, base, first.treeOf(base));
    if (!hasRemote) git(["remote", "add", "--end-of-options", "upstream", args.upstream], { cwd: root });
    const installed = installSkill(book, undo);
    writeConfig(root, text);
    installHookOrWarn(book, undo);
    await installHook(book, undo);
    if (installed && (installed.changed.length || leftBehindSkill(book).length)) await recordSkill(book);
    return installed;
  });
  say(`pinned upstream at ${base.slice(0, 7)}, where this repo branched from ${args.upstream}.\n`
    + "Capture your existing changes with `patchbook record`, then `patchbook build`, stage, and commit.\n" + SCHEDULE + "\n");
  if (installed?.blocked.length) throw folderFail(installed.blocked);
  return 0;
}

/** Follow one more upstream, mounted at its own folder of the staged tree. */
async function cmdTrack(args: { name: string; url: string; branch: string; path: string; mount: string | null; vendor: string | null }) {
  refuseCredentials(args.url);
  args.path = upstreamFolder(args.path);
  const book = await Book.find();
  book.refuseLinkedTop();
  installHookOrWarn(book);
  if (book.upstreams.some((u) => u.name === args.name)) throw new Fail(`already following an upstream called ${args.name}`);
  const config = join(book.dir, "config.toml");
  const mount = args.mount ?? args.name;
  const text = readText(config).replace(/\n+$/, "") + "\n\n" + upstreamToml(args.name, args.url, args.path, args.branch, mount, args.vendor);
  const candidate = await Book.fromText(book.root, text);
  for (const u of candidate.upstreams) if (u.vendor) refuseNestedGit(book.root, u.name, u.vendor);
  await allOrNothing(candidate, "track", async () => {
    candidate.dropPin(args.name);
    syncUpstream(candidate, candidate.upstream(args.name), args.branch, []);
    writeText(config, text);
  });
  const where = mount ? `${mount}/` : "the root";
  say(`Its files appear at ${where} of the staged tree. Ship what you need with edits (move, copy), then build.\n`);
  return 0;
}

// The table of subcommands

const UPSTREAM_PATH = "the upstream folder to follow, if not the whole repo";
const UPSTREAM_BRANCH = "the upstream branch to follow";

export const PROGRAM: Program = {
  name: "patchbook",
  version: VERSION,
  about: ["Keep your changes to an upstream repo, each with its intent,", "and keep pulling from upstream."],
  commands: {
    clone: command({
      summary: "fork an upstream repo, with its history, and start a patchbook",
      args: { url: arg("the upstream repo's git URL"), dir: arg.optional("the folder to clone into (default: the repo's name)") },
      options: { branch: option("branch", "the branch to check out (default: upstream's default)") },
      run: (a) => cmdClone({ ...a, url: absoluteRemote(a.url) }),
    }),
    init: command({
      summary: "start a patchbook in this repo",
      options: {
        upstream: option("url", "upstream's git URL", "required"),
        name: option("name", "the upstream's name (default: last part of --path or URL)"),
        branch: option("branch", UPSTREAM_BRANCH, { default: "main" }),
        path: option("path", UPSTREAM_PATH),
        outputTo: option("dir", "build into <dir>, not over the repo (the folder layout)"),
        outputFrom: option("dir", "the staged folder that ships, with --output-to"),
        vendor: option("dir", "also keep a byte-for-byte copy of upstream in <dir>"),
      },
      run: (a) => cmdInit({ ...a, upstream: absoluteRemote(a.upstream), path: a.path ?? "", outputFrom: a.outputFrom ?? "" }),
    }),
    track: command({
      summary: "follow another upstream, mounted at its own folder",
      args: { name: arg("what to call the upstream"), url: arg("its git URL") },
      options: {
        branch: option("branch", UPSTREAM_BRANCH, { default: "main" }),
        path: option("path", UPSTREAM_PATH),
        mount: option("dir", "the staged folder its files appear under (default: <name>)"),
        vendor: option("dir", "also keep a byte-for-byte copy in <dir>"),
      },
      run: (a) => cmdTrack({ ...a, url: absoluteRemote(a.url), path: a.path ?? "" }),
    }),
    upstream: command({
      summary: "list, print, export or diff an upstream at its pin",
      about: ["Give at most one of --diff, --since and --export.", "A <path> limits a diff; --export takes none."],
      args: { name: arg("the upstream to read"), path: arg.optional("a path inside the upstream, as upstream has it") },
      options: {
        diff: flag("what upstream changed in the last sync"),
        since: option("commit", "what upstream changed since <commit>"),
        export: option("dir", "write every file at the pin into <dir>"),
      },
      exclusive: [["diff", "since", "export"], ["path", "export"]],
      run: cmdUpstream,
    }),
    check: command({ summary: "has any upstream moved? exits 10 if so", run: cmdCheck }),
    sync: command({
      summary: "move the pins to upstream and carry every change forward",
      args: {
        name: arg.optional("only this upstream"),
        ref: arg.optional("a branch, tag or commit (default: the upstream's branch)"),
      },
      run: cmdSync,
    }),
    status: command({
      summary: "list what is broken",
      options: { json: flag("machine-readable, with block text") },
      run: cmdStatus,
    }),
    build: command({
      summary: "apply the patchbook to the pinned upstreams and write the output",
      options: {
        force: flag("overwrite output files edited since the last build"),
        commit: flag("commit the result; in a fork, as a merge of upstream"),
      },
      run: cmdBuild,
    }),
    record: command({
      summary: "move edits to the output in the working tree into a change",
      about: [
        "The commit hook records only what is staged. This records the working tree.",
        "If the model can't write an intent, patchbook writes one from the edits.",
      ],
      args: { change: arg.optional("the change to add to (default: the model picks or names one)") },
      options: { intent: option("text", "what the change is for (default: the model writes it)") },
      run: cmdRecord,
    }),
    intent: command({
      summary: "fill empty intents and replace the ones patchbook wrote",
      about: ["With no <change>, it fills every change and block entry with an empty intent,", "and every change or block entry whose intent patchbook wrote."],
      args: { change: arg.optional("only this change") },
      options: { intent: option("text", "the intent for <change> (default: the model writes it)") },
      run: cmdIntent,
    }),
    hook: command({
      summary: "install the git hooks, run one, or show which hook git runs",
      args: {
        action: arg.oneOf({
          install: "install patchbook's git hooks in this repo",
          run: "run the pre-commit hook, as git does before a commit",
          build: "rebuild the output, as the post hooks do after a merge or checkout",
          status: "show which pre-commit hook git runs",
        }),
      },
      run: cmdHook,
    }),
    skill: command({
      summary: "write this patchbook's update skill into the repo",
      args: { action: arg.oneOf({ install: "write or refresh the update skill" }) },
      run: () => cmdSkill(),
    }),
    config: command({
      summary: "show settings and where each comes from, or set one",
      args: { name: arg.optional("a setting, such as intent.provider"), value: arg.optional("the value to set it to") },
      options: {
        project: flag("set it in this project's .patchbook/config.toml, not yours"),
        unset: flag("remove it, so the next layer's value applies"),
      },
      run: cmdConfig,
    }),
    show: command({
      summary: "print a change, with its file edits as diffs",
      args: { change: arg("the change to print") },
      run: cmdShow,
    }),
    blocks: command({
      summary: "print an upstream file's blocks with their hashes",
      args: { file: arg("its staged path, such as skills/arena/SKILL.md") },
      run: cmdBlocks,
    }),
    scaffold: command({
      summary: "append skeleton block entries for missing blocks",
      args: { file: arg.rest("only these staged files (default: every file)") },
      run: cmdScaffold,
    }),
  },
};

if (import.meta.main) {
  try {
    const outcome = parseArgv(PROGRAM, process.argv.slice(2));
    if (outcome.kind === "print") say(outcome.text);
    else if (outcome.kind === "refuse") {
      warn(outcome.text);
      process.exitCode = 2;
    } else process.exitCode = await outcome.run();
  } catch (e) {
    if (e instanceof Fail) warn(`patchbook: ${e.message}\n`);
    else warn(Bun.inspect(e) + "\n");
    process.exitCode = 1;
  } finally {
    noticeLeftOut();
  }
}
