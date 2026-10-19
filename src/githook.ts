// The pre-commit hook: on each commit, record the hand edits staged in the output, rebuild, and stage both.
import { chmodSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import type { Problem } from "./api.ts";
import {
  assemble, type Assembly, buildLockPath, type BuildLock, builtAs, type Changes, changesOf, describe, handEdits, inRepo, parseBuildLock, readBuildLock, refuseFolderToFile, writeOutput,
} from "./assemble.ts";
import { Book, buildInputs, PB, parseLock, placeholderOutputs, under } from "./book.ts";
import { type Change, readChanges } from "./changes.ts";
import { record } from "./record.ts";
import { Fail } from "./lib/fail.ts";
import {
  exists, type File, fsMessage, gitMode, isDir, isSymlink, LINK, lexists, meantMode, mkdirs, type Mode, parseGitMode, readBytes, readDisk, readTextReplace, relative, resolve,
  sameFile, type Seen, writeBytes, writeText,
} from "./lib/fs.ts";
import { blobOid } from "./lib/hash.ts";
import { type Env, git, run, shellQuote, spawn } from "./lib/proc.ts";
import { say, warn } from "./lib/term.ts";
import { byCodePoint, bytesEqual, concat, decode, decodeReplace, encode } from "./lib/text.ts";
import { type Source, setting } from "./settings.ts";
import { readBlobsOf, refuseMergedUpstream, stagedTree } from "./store.ts";
import { Undo } from "./undo.ts";

/** Git runs hooks from the top of the checkout. A linked worktree shares the hooks folder of its repo, and may hold a commit with no patchbook. */
const HAS_PATCHBOOK = "[ -f .patchbook/config.toml ]";

const SCRIPT = `#!/bin/sh
# Installed by patchbook v2. On each commit, it records hand edits to the build output in the
# patchbook, rebuilds, and stages both. Skip it once with: PATCHBOOK_HOOK=0 git commit
[ "$PATCHBOOK_HOOK" = 0 ] && exit 0
${HAS_PATCHBOOK} || exit 0
if command -v patchbook >/dev/null; then exec patchbook hook run; fi
echo "patchbook isn't installed, so this commit doesn't record hand edits." >&2
`;

const UNGUARDED_SCRIPT = `#!/bin/sh
# Installed by patchbook v2. On each commit, it records hand edits to the build output in the
# patchbook, rebuilds, and stages both. Skip it once with: PATCHBOOK_HOOK=0 git commit
[ "$PATCHBOOK_HOOK" = 0 ] && exit 0
if command -v patchbook >/dev/null; then exec patchbook hook run; fi
echo "patchbook isn't installed, so this commit doesn't record hand edits." >&2
`;

function writeHook(path: string): void {
  mkdirs(dirname(path));
  writeText(path, SCRIPT);
  chmodSync(path, 0o755);
}

const GUARD = `if [ "$PATCHBOOK_HOOK" != 0 ] && ${HAS_PATCHBOOK}; then
  if ! command -v patchbook >/dev/null; then
    echo "patchbook isn't installed, so this commit can't record hand edits to the build output." >&2
    echo "Install it with npm install -g patchbook, or skip it once with PATCHBOOK_HOOK=0 git commit" >&2
    exit 1
  fi
  patchbook hook run || exit 1
fi
`;

/** No `exec`, so the manager's checks run after it, and `|| exit 1` stops the commit when the record fails even if those checks pass.
 * Git runs hooks from the worktree root, so in a repo without a patchbook the lines do nothing, which keeps them safe in a hooks folder that every repo shares. */
const HOOK_LINES = `# patchbook: record hand edits to the build output and rebuild it, before the checks below. Skip it once with PATCHBOOK_HOOK=0 git commit
${GUARD}`;

const indent = (text: string, spaces: number) => text.replace(/^(?=.)/gm, " ".repeat(spaces));

const CALLS_PATCHBOOK = /^[^#\n]*\bpatchbook hook run\b/m;
const HOOK_CHANGE = "patchbook-hook";

type Snippet = { parts: readonly { text: string; into: (where: string) => string }[]; level: (config: string) => number };

const to = (where: string) => `to ${where}`;

const LEFTHOOK_YAML_COMMAND = `patchbook:
  priority: 1
  run: |
${indent(GUARD, 4)}`;

const LEFTHOOK_YAML: Snippet = {
  parts: [
    { text: `pre-commit:\n  commands:\n${indent(LEFTHOOK_YAML_COMMAND, 4)}`, into: to },
    { text: `  commands:\n${indent(LEFTHOOK_YAML_COMMAND, 4)}`, into: (where) => `under the pre-commit key in ${where}` },
    { text: indent(LEFTHOOK_YAML_COMMAND, 4), into: (where) => `under commands, in the pre-commit key of ${where}` },
  ],
  level(config) {
    const lines = config.split("\n");
    const start = lines.findIndex((l) => /^["']?pre-commit["']?[ \t]*:/.test(l));
    if (start < 0) return 0;
    const after = lines.slice(start + 1);
    const end = after.findIndex((l) => /^[^\s#]/.test(l));
    return (end < 0 ? after : after.slice(0, end)).some((l) => /^[ \t]+["']?commands["']?[ \t]*:/.test(l)) ? 2 : 1;
  },
};

const LEFTHOOK_TOML: Snippet = {
  parts: [{ text: `[pre-commit.commands.patchbook]\npriority = 1\nrun = '''\n${GUARD}'''\n`, into: to }],
  level: () => 0,
};

const LEFTHOOK_JSON_COMMAND = `"patchbook": {
  "priority": 1,
  "run": ${JSON.stringify(GUARD)}
}`;
const LEFTHOOK_JSON_COMMANDS = `"commands": {\n${indent(LEFTHOOK_JSON_COMMAND, 2)}\n}`;
const LEFTHOOK_JSON_KEY = `"pre-commit": {\n${indent(LEFTHOOK_JSON_COMMANDS, 2)}\n}`;

const AFTER_A_MEMBER = ", with a comma after the member before it if there is one";

const LEFTHOOK_JSON: Snippet = {
  parts: [
    { text: `{\n${indent(LEFTHOOK_JSON_KEY, 2)}\n}\n`, into: to },
    { text: LEFTHOOK_JSON_KEY + "\n", into: (where) => `inside the top-level braces of ${where}${AFTER_A_MEMBER}` },
    { text: LEFTHOOK_JSON_COMMANDS + "\n", into: (where) => `inside "pre-commit" in ${where}${AFTER_A_MEMBER}` },
    { text: LEFTHOOK_JSON_COMMAND + "\n", into: (where) => `inside "commands" in "pre-commit" in ${where}${AFTER_A_MEMBER}` },
  ],
  level(config) {
    if (!config.trim()) return 0;
    const key = config.search(/"pre-commit"\s*:/);
    return key < 0 ? 1 : /"commands"\s*:/.test(config.slice(key)) ? 3 : 2;
  },
};

/** lefthook reads each of its config names in every format. The keys run in the order lefthook looks for them, and it reads the first file it finds. */
const LEFTHOOK_FORMATS: Readonly<Record<string, Snippet>> = {
  yml: LEFTHOOK_YAML, yaml: LEFTHOOK_YAML, json: LEFTHOOK_JSON, jsonc: LEFTHOOK_JSON, toml: LEFTHOOK_TOML,
};
const LEFTHOOK_FILES = Object.keys(LEFTHOOK_FORMATS).flatMap((ext) => ["lefthook", ".lefthook", ".config/lefthook"].map((name) => `${name}.${ext}`));

/** pre-commit splits `entry` like a shell does and runs the words without one, so the guard goes through `sh -c`. */
const PRE_COMMIT_REPO = `- repo: local
  hooks:
    - id: patchbook
      name: patchbook
      entry: |
${indent(`sh -c '${GUARD.trimEnd().replaceAll("'", "'\\''")}'`, 8)}
      language: system
      pass_filenames: false
      always_run: true
`;

const PRE_COMMIT: Snippet = {
  parts: [
    { text: `repos:\n${indent(PRE_COMMIT_REPO, 2)}`, into: to },
    { text: indent(PRE_COMMIT_REPO, 2), into: (where) => `as the first item under repos in ${where}` },
    { text: `repos:\n${indent(PRE_COMMIT_REPO, 2)}`, into: (where) => `to ${where} in place of repos: []` },
  ],
  level: (config) => (/^repos[ \t]*:[ \t]*\[[ \t]*\]/m.test(config) ? 2 : /^repos[ \t]*:/m.test(config) ? 1 : 0),
};

/** Git runs `<dir>/_/pre-commit`, which runs `<dir>/pre-commit`. */
type ScriptManager = { name: string; dir: string; install: string };
/** `dispatcher` marks the hook the manager installs in `.git/hooks`. `legacy` is what its migration mode appends to the name of the hook it replaced and still runs. */
type ConfigManager = { name: string; files: readonly string[]; dispatcher: RegExp; legacy?: string; snippets: Readonly<Record<string, Snippet>>; note?: string };

const SCRIPT_MANAGERS: readonly ScriptManager[] = [
  { name: "Vite+", dir: ".vite-hooks", install: "vp config" },
  { name: "husky", dir: ".husky", install: "npx husky" },
];
// pre-commit comes first because its dispatcher marker is the more specific, and a pre-commit hook can name lefthook in a path.
const CONFIG_MANAGERS: readonly ConfigManager[] = [
  {
    name: "the pre-commit framework", files: [".pre-commit-config.yaml"],
    dispatcher: /File generated by pre-commit/, legacy: ".legacy",
    snippets: { yaml: PRE_COMMIT },
  },
  {
    name: "lefthook",
    files: LEFTHOOK_FILES,
    dispatcher: /\blefthook\b/,
    snippets: LEFTHOOK_FORMATS,
    note: "Leave parallel off: patchbook stages files, so it must run alone.",
  },
];

type Hook =
  | { kind: "git"; path: string; gitRunsIt: true }
  | { kind: "foreign"; path: string; gitRunsIt: true }
  | { kind: "script"; manager: ScriptManager; path: string; gitRunsIt: boolean }
  | { kind: "config"; manager: ConfigManager; path: string; gitRunsIt: boolean };

function hookPaths(root: string): { hooksPath: string | null; hookFile: string } {
  const [common, hooks, hookFile] = git(["rev-parse", "--git-common-dir", "--git-path", "hooks", "--git-path", "hooks/pre-commit"], { cwd: root })
    .split("\n").map((p) => (isAbsolute(p) ? p : join(root, p))) as [string, string, string];
  return { hooksPath: resolve(hooks) === resolve(join(common, "hooks")) ? null : hooks, hookFile };
}

function ours(path: string): boolean {
  if (!exists(path)) return false;
  const text = readTextReplace(path);
  return text === SCRIPT || text === UNGUARDED_SCRIPT;
}

const scriptHook = (manager: ScriptManager, dir: string, gitRunsIt: boolean): Hook => ({ kind: "script", manager, path: join(dir, "pre-commit"), gitRunsIt });

/** The config files the manager finds, in the order it reads them. A name that resolves to a file already found is the same file, not another one. */
function configFiles(root: string, manager: ConfigManager): string[] {
  const seen = new Set<string>();
  return manager.files.map((f) => join(root, f)).filter((f) => {
    if (!exists(f)) return false;
    const { dev, ino } = statSync(f);
    const id = `${dev}:${ino}`;
    return !seen.has(id) && !!seen.add(id);
  });
}

const configFile = (root: string, manager: ConfigManager): string | undefined => configFiles(root, manager)[0];

function findHook(root: string): Hook {
  const { hooksPath, hookFile } = hookPaths(root);
  if (hooksPath !== null) {
    const dir = dirname(hooksPath);
    const script = basename(hooksPath) === "_" && under(dir, root) ? SCRIPT_MANAGERS.find((m) => basename(dir) === m.dir) : undefined;
    return script ? scriptHook(script, dir, true) : { kind: "foreign", path: hookFile, gitRunsIt: true };
  }
  const text = exists(hookFile) ? readTextReplace(hookFile) : null;
  const dispatcher = text === null ? undefined : CONFIG_MANAGERS.find((m) => m.dispatcher.test(text));
  const legacyFile = dispatcher?.legacy ? hookFile + dispatcher.legacy : null;
  const runner = ours(hookFile) ? hookFile : legacyFile !== null && ours(legacyFile) ? legacyFile : null;
  const theirs = text !== null && runner === null;
  if (!theirs) {
    const script = SCRIPT_MANAGERS.find((m) => lexists(join(root, m.dir, "pre-commit")));
    if (script) return scriptHook(script, join(root, script.dir), false);
    for (const manager of dispatcher ? [dispatcher, ...CONFIG_MANAGERS] : CONFIG_MANAGERS) {
      const file = configFile(root, manager);
      if (file) return { kind: "config", manager, path: file, gitRunsIt: false };
    }
    return { kind: "git", path: runner ?? hookFile, gitRunsIt: true };
  }
  const file = dispatcher && configFile(root, dispatcher);
  return dispatcher && file ? { kind: "config", manager: dispatcher, path: file, gitRunsIt: true } : { kind: "foreign", path: hookFile, gitRunsIt: true };
}

const runsPatchbook = (hook: Hook) => exists(hook.path) && CALLS_PATCHBOOK.test(readTextReplace(hook.path));

function withPatchbook(data: Uint8Array): Uint8Array {
  if (CALLS_PATCHBOOK.test(decodeReplace(data))) return data;
  const end = data[0] === 0x23 && data[1] === 0x21 ? data.indexOf(0x0a) + 1 || data.length : 0;
  const rest = data.subarray(end);
  const newline = encode("\n");
  return concat(data.subarray(0, end), end > 0 && data[end - 1] !== 0x0a ? newline : new Uint8Array(), encode(HOOK_LINES), rest.length ? newline : new Uint8Array(), rest);
}

function shown(root: string, path: string): string {
  const inside = relative(root, resolve(path));
  return inside === ".." || inside.startsWith("../") ? path : inside;
}

const hookIntent = (m: ScriptManager, where: string) =>
  `Run patchbook first in ${where}, the pre-commit script ${m.name} runs, so commits keep recording hand edits to the build output.`;

const PUT_FIRST = (m: ScriptManager, where: string) => `patchbook: put \`patchbook hook run\` first in ${where}, which ${m.name} runs on each commit`;

const ADD_TO_CONFIG = (m: ConfigManager, where: string, config: string) => {
  const snippet = m.snippets[extname(where).slice(1)]!;
  const part = snippet.parts[snippet.level(config)]!;
  return `patchbook: ${m.name} runs this repo's pre-commit hooks. `
    + `Add this ${part.into(where)}, so ${m.name} runs patchbook first for everyone who commits here, and your checks see the rebuilt output:\n\n${part.text}${m.note ? `\n${m.note}\n` : ""}`;
};

const MANY_CONFIGS = (m: ConfigManager, wheres: string[]) =>
  `patchbook: ${m.name} has more than one config file here: ${wheres.join(", ")}. It reads ${wheres[0]} and ignores the rest, so patchbook can't tell which one to print lines for. `
  + "Merge them into one file, then run `patchbook hook install`.\n";

const ADD_TO_FOREIGN = (where: string) =>
  `patchbook: ${where} is another tool's hook; add \`patchbook hook run\` to it to record on commit. Put these lines at the top:\n\n${HOOK_LINES}`;

const UNHOOKED = (where: string) =>
  `patchbook: ${where} doesn't run \`patchbook hook run\`, so commits won't record hand edits to the build output. `
  + "Run `patchbook hook install` to see what to add.\n";

const NOT_RUN = (hook: Hook, where: string) =>
  "patchbook: git runs no pre-commit hook here, so commits won't record hand edits to the build output. "
  + (hook.kind === "script" && hook.gitRunsIt
    ? `${hook.manager.name} hasn't installed its hook in this checkout, as in a new git worktree. Run \`${hook.manager.install}\`.\n`
    : hook.kind === "foreign"
      ? `core.hooksPath has no ${where}. Run \`patchbook hook install\` to see what to put there.\n`
      : "Run `patchbook hook install`.\n");

const NOT_EXECUTABLE = (where: string) =>
  `patchbook: git ignores ${where} because it isn't executable, so git runs no pre-commit hook and commits won't record hand edits to the build output. Run \`chmod +x ${where}\`.\n`;

function writesThroughALink(book: Book, path: string): boolean {
  const inside = relative(book.root, dirname(path));
  return isSymlink(path) || inside === ".." || inside.startsWith("../") || resolve(dirname(path)) !== join(resolve(book.root), inside);
}

function isUnrecorded(book: Book, current: ReadonlyMap<string, File>, key: string): boolean {
  if (!current.has(key)) return false;
  const built = assemble(book).out.get(key);
  return !built || !CALLS_PATCHBOOK.test(decodeReplace(built.data));
}

const NEW_SCRIPT_MODE: Mode = 0o755;

async function putFirst(book: Book, hook: Extract<Hook, { kind: "script" }>, undo?: Undo): Promise<void> {
  const where = shown(book.root, hook.path);
  if (writesThroughALink(book, hook.path)) {
    warn(ADD_TO_FOREIGN(where));
    return;
  }
  const text = exists(hook.path) ? readBytes(hook.path) : null;
  const edited = withPatchbook(text ?? new Uint8Array());
  const wrote = text === null || !bytesEqual(edited, text);
  if (wrote) {
    undo?.hold(hook.path);
    if (text === null) mkdirs(dirname(hook.path));
    writeBytes(hook.path, edited);
    if (text === null) chmodSync(hook.path, NEW_SCRIPT_MODE);
  }
  const key = relative(book.root, hook.path);
  if (book.layout.kind !== "fork" || !isUnrecorded(book, book.currentOutput(), key)) {
    if (wrote) warn(PUT_FIRST(hook.manager, where) + "\n");
    return;
  }
  const seen = book.seen("disk");
  const newScript = text === null ? seen.get(key) : undefined;
  if (newScript) seen.set(key, { ...newScript, mode: NEW_SCRIPT_MODE, chosen: true });
  recordAndStage(book, seen, key, hookIntent(hook.manager, where), newScript !== undefined);
  warn(`${PUT_FIRST(hook.manager, where)}, recorded the edit in the patchbook, and staged both\n`);
}

function recordAndStage(book: Book, seen: ReadonlyMap<string, Seen>, key: string, intent: string, newScript: boolean): void {
  const oids = (): Map<string, string | null> => new Map<string, string | null>([
    ...unstaged(book.root, [PB]).map((p): [string, string | null] => [p, lexists(join(book.root, p)) ? blobOid(readDisk(join(book.root, p)).data) : null]),
    ...ignoredInPatchbook(book.root),
  ]);
  const before = oids();
  const recorded = record(book, HOOK_CHANGE, intent, { seen, edits: [key] });
  say(recorded.text);
  const wrote = Array.from(oids()).filter(([p, oid]) => oid !== before.get(p)).map(([p]) => p);
  git(["--literal-pathspecs", "add", "-A", "-f", "--", key, ...wrote], { cwd: book.root });
  stageModes(book.root, newScript ? new Map([...recorded.copies, [key, NEW_SCRIPT_MODE]]) : recorded.copies);
}

/** Give each listed index entry its mode, and return the paths it changed. `git add` keeps an entry's mode under
 * core.fileMode=false and gives a new one 644, so a mode the patchbook decided reaches the commit only this way. Links,
 * deletions and entries already at their mode are skipped, so running it twice changes nothing. Bytes are never staged:
 * each entry keeps its blob, where `update-index --chmod` would stage the working copy's. */
export function stageModes(root: string, modes: ReadonlyMap<string, Mode>, env: Env = process.env): string[] {
  if (!modes.size) return [];
  const entries: string[] = [];
  const changed: string[] = [];
  for (const entry of decode(run(["git", "ls-files", "-s", "-z"], { cwd: root, env })).split("\0")) {
    const tab = entry.indexOf("\t");
    const [name = "", oid = "", stage = ""] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    const want = modes.get(path);
    const have = parseGitMode(name);
    if (tab < 0 || stage !== "0" || want === undefined || want === LINK || have === undefined || have === LINK || have === want) continue;
    entries.push(`${gitMode(want)} ${oid}\t${path}\0`);
    changed.push(path);
  }
  if (entries.length) run(["git", "update-index", "-z", "--index-info"], { cwd: root, env, input: encode(entries.join("")) });
  return changed;
}

/** The copies behind the outputs whose bit was chosen in this commit and that the patchbook builds at that bit: ours at
 * the chosen bit, and a base copy at upstream's, which together build it. Under core.fileMode=true `git add` takes a copy's
 * mode from disk. */
function chosenCopies(book: Book, a: Assembly, staged: ReadonlyMap<string, Seen>, sinceHead: ReadonlyMap<string, unknown>): Map<string, Mode> {
  const modes = new Map<string, Mode>();
  if (book.tracksExecBit()) return modes;
  const changes = new Map(readChanges(book, []).map((c) => [c.name, c]));
  const owners = new Map<string, Change>();
  for (const c of changes.values()) for (const e of c.edits) if (e.kind === "file") owners.set(e.path, c);
  for (const [p, now] of staged) {
    const src = a.sources.get(p);
    const up = src && a.upstream.get(src.path)?.mode;
    if (!now.chosen || !sinceHead.has(p) || now.mode === LINK || src === undefined || a.out.get(p)?.mode !== now.mode) continue;
    const change = src.kind === "ours" ? changes.get(src.change) : owners.get(src.path);
    if (change === undefined) continue;
    modes.set(relative(book.root, change.content("ours", src.path)), now.mode);
    const base = change.content("base", src.path);
    if (up !== undefined && up !== LINK && lexists(base)) modes.set(relative(book.root, base), up);
  }
  return modes;
}

/** The outputs among `paths` that the patchbook builds at upstream's mode, at that mode, repo-relative. */
export function upstreamModes(book: Book, a: Assembly, paths: readonly string[]): Map<string, Mode> {
  const modes = new Map<string, Mode>();
  for (const p of paths) {
    const src = a.sources.get(p);
    const built = a.out.get(p)?.mode;
    if (src !== undefined && built !== undefined && built === a.upstream.get(src.path)?.mode) modes.set(inRepo(book, p), built);
  }
  return modes;
}

const hookEnabled = (book: Book) => setting("hook.enabled", book)[0];

const turnOn = (source: Source) =>
  source === "env" ? "Unset PATCHBOOK_HOOK to turn it on." : `Turn it on with \`patchbook config${source === "project" ? " --project" : ""} hook.enabled true\`.`;

/** What `clone` tells you to do next, which depends on whether commits will record. */
export function commitAdvice(book: Book): string {
  const { enabled, source, calls } = inspect(book);
  if (!enabled) return `hook.enabled is off, so commits won't record what you stage. ${turnOn(source)}`;
  if (!calls) return "Commits won't record what you stage until git runs a hook that calls patchbook; see above.";
  return "Make your changes, stage them, and commit: the hook records what you staged in the patchbook and rebuilds.";
}

const isExecutable = (path: string) => (statSync(path).mode & 0o111) !== 0;

function updateScript(path: string): boolean {
  const text = readTextReplace(path);
  if (text !== UNGUARDED_SCRIPT) return false;
  writeHook(path);
  warn(`patchbook: updated ${path} to skip a checkout with no patchbook\n`);
  return true;
}

export function keepGitHook(book: Book, undo?: Undo): void {
  const { hooksPath, hookFile } = hookPaths(book.root);
  if (hooksPath !== null || !hookEnabled(book) || !inBookRepo(book)) return;
  undo?.hold(dirname(hookFile));
  if (!exists(hookFile)) {
    writeHook(hookFile);
    warn("patchbook: installed a pre-commit hook that records and builds on each commit\n");
    return;
  }
  if (updateScript(hookFile)) return;
  if (ours(hookFile)) {
    if (!isExecutable(hookFile)) {
      chmodSync(hookFile, 0o755);
      warn(`patchbook: made ${shown(book.root, hookFile)} executable, so git runs it\n`);
    }
    return;
  }
  const migrated = CONFIG_MANAGERS.find((m) => m.legacy && m.dispatcher.test(readTextReplace(hookFile)))?.legacy;
  if (migrated !== undefined && exists(hookFile + migrated)) updateScript(hookFile + migrated);
}

/** Make the hook git runs call patchbook, once `keepGitHook` has installed its own in `.git/hooks`. A config or foreign hook is printed every time, because patchbook can't check where its line sits. */
export async function installHook(book: Book, undo?: Undo): Promise<boolean> {
  if (!hookEnabled(book) || !inBookRepo(book)) return true;
  const hook = findHook(book.root);
  switch (hook.kind) {
    case "git":
      return true;
    case "script":
      await putFirst(book, hook, undo);
      return true;
    case "config": {
      const files = configFiles(book.root, hook.manager);
      if (files.length > 1) {
        warn(MANY_CONFIGS(hook.manager, files.map((f) => shown(book.root, f))));
        return false;
      }
      warn(ADD_TO_CONFIG(hook.manager, shown(book.root, hook.path), readTextReplace(hook.path)));
      break;
    }
    case "foreign":
      warn(ADD_TO_FOREIGN(shown(book.root, hook.path)));
      break;
  }
  const { hookFile } = hookPaths(book.root);
  if (hook.gitRunsIt && exists(hookFile) && !isExecutable(hookFile)) warn(NOT_EXECUTABLE(shown(book.root, hookFile)));
  return true;
}

/** Install the hook, or warn why not. Until it is installed, a commit doesn't record hand edits. */
export function installHookOrWarn(book: Book, undo?: Undo): void {
  try {
    keepGitHook(book, undo);
  } catch (e) {
    const said = fsMessage(e);
    if (said === null) throw e;
    warn(`patchbook: couldn't install the pre-commit hook (${said})\nUntil it is installed, a commit doesn't record hand edits to the build output in the patchbook.\n`);
  }
}

type HookReport = { enabled: boolean; source: Source; runs: string | null; calls: boolean; checked: string | null; advice: string | null };

function inspect(book: Book): HookReport {
  const [enabled, source] = setting("hook.enabled", book);
  const hook = findHook(book.root);
  const { hookFile } = hookPaths(book.root);
  const present = exists(hookFile);
  const runs = present && isExecutable(hookFile) ? hookFile : null;
  const calls = runs !== null && (!hook.gitRunsIt || runsPatchbook(hook));
  const advice = !enabled || calls ? null
    : runs !== null ? UNHOOKED(shown(book.root, hook.path))
    : present ? NOT_EXECUTABLE(shown(book.root, hookFile))
    : NOT_RUN(hook, shown(book.root, hook.path));
  return { enabled, source, runs: runs && shown(book.root, runs), calls, checked: hook.gitRunsIt ? shown(book.root, hook.path) : null, advice };
}

export function warnUnhooked(book: Book): void {
  const { advice } = inspect(book);
  if (advice !== null) warn(advice);
}

function printHookStatus(book: Book): void {
  const { enabled, source, runs, calls, checked, advice } = inspect(book);
  const where = calls && checked !== null && runs !== checked ? `, in ${checked}` : "";
  say(`hook.enabled: ${enabled ? "on" : "off"} (${source})\ngit runs: ${runs ?? "nothing"}\ncalls patchbook: ${calls ? "yes" : "no"}${where}\n${advice ?? ""}`);
}

function unstaged(root: string, paths: string[]): string[] {
  if (!paths.length) return [];
  git(["update-index", "-q", "--refresh"], { cwd: root });
  const listed = (args: string[]) => decode(run(["git", "--literal-pathspecs", ...args, "--", ...paths], { cwd: root })).split("\0");
  return [...new Set([...listed(["diff-files", "--name-only", "-z"]), ...listed(["ls-files", "-z", "-o", "--exclude-standard"])].filter(Boolean))].sort(byCodePoint);
}

/** Git sees a staged link as unchanged when only its target changed, so the in-repo file each build input links to is checked too.
 * A target outside the repo has no index entry and is read from disk. */
function linkTargets(book: Book, inputs: string[]): string[] {
  const root = resolve(book.root);
  return inputs.filter((p) => isSymlink(join(book.root, p))).map((p) => relative(root, resolve(join(book.root, p))))
    .filter((p) => p !== "." && p !== ".." && !p.startsWith("../") && p !== ".git" && !p.startsWith(".git/"));
}

function ignoredInPatchbook(root: string): Map<string, string> {
  const listed = decode(run(["git", "ls-files", "-z", "-o", "-i", "--exclude-standard", "--", PB], { cwd: root })).split("\0");
  return new Map(listed.filter(Boolean).map((p) => [p, blobOid(readDisk(join(root, p)).data)]));
}

function refuseBehindLinks(book: Book, paths: string[]): void {
  const behind = new Map<string, string[]>();
  for (const p of paths) {
    const parts = p.split("/");
    const link = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/")).find((folder) => isSymlink(join(book.outputRoot(), folder)));
    if (link !== undefined) behind.set(link, [...(behind.get(link) ?? []), inRepo(book, p)]);
  }
  if (!behind.size) return;
  throw new Fail(Array.from(behind, ([link, files]) => `${inRepo(book, link)} is a link. Git can't stage these paths behind it:\n  ${files.join("\n  ")}`).join("\n")
    + "\nPatchbook can't record a folder turned into a link. Put the folder back, or skip the hook once with PATCHBOOK_HOOK=0.");
}

function committable(book: Book, staged: ReadonlyMap<string, File>, paths: string[]): string[] {
  const missing = paths.filter((p) => !staged.has(p));
  if (!missing.length) return paths;
  refuseBehindLinks(book, missing);
  const absent = missing.map((p) => inRepo(book, p));
  const found = spawn(["git", "check-ignore", "-z", "--stdin"], { cwd: book.root, input: encode(absent.join("\0")) });
  if (found.code !== 0 && found.code !== 1) throw new Fail(`git check-ignore failed:\n${decodeReplace(found.stderr).trim()}`);
  const ignored = new Set(decode(found.stdout).split("\0"));
  return paths.filter((p) => !ignored.has(inRepo(book, p)));
}

function committedBuildLock(book: Book): BuildLock {
  const found = spawn(["git", "cat-file", "blob", `HEAD:${relative(book.root, buildLockPath(book))}`], { cwd: book.root });
  return found.code === 0 ? parseBuildLock(decode(found.stdout)) : new Map();
}

function isFolder(book: Book, p: string): boolean {
  const f = join(book.outputRoot(), p);
  return isDir(f) && !isSymlink(f);
}

function onDisk(book: Book, p: string): File | undefined {
  const f = join(book.outputRoot(), p);
  return lexists(f) && !isFolder(book, p) ? readDisk(f) : undefined;
}

function leftByLastBuild(book: Book, lock: BuildLock | null, p: string, out?: ReadonlyMap<string, File>): boolean {
  if (lock === null || isFolder(book, p)) return false;
  const disk = onDisk(book, p);
  return disk === undefined ? !lock.has(p) : builtAs(disk, lock.get(p), out?.get(p)?.mode, book.tracksExecBit());
}

function refuseOverwrites(book: Book, clobbered: string[]): void {
  if (!clobbered.length) return;
  const intentToAdd = decode(run(["git", "diff-files", "-z", "--name-only", "--diff-filter=A"], { cwd: book.root })).split("\0").filter(Boolean);
  throw new Fail("the build changes these files, which have changes you haven't staged:\n  " + clobbered.join("\n  ")
    + "\nStaging them would record them over the build's change. "
    + (intentToAdd.length ? "git can't stash while the index holds `git add -N` entries, so first run "
      + `\`git --literal-pathspecs rm -q --cached -- ${intentToAdd.map(shellQuote).join(" ")}\`, which keeps the files on disk. Then stash` : "Stash")
    + ` them with \`git --literal-pathspecs stash push -a -- ${clobbered.map((p) => shellQuote(inRepo(book, p))).join(" ")}\`, commit, `
    + "then `git stash pop` puts them back on the new build. Or skip the hook once with PATCHBOOK_HOOK=0.");
}

function diskWrites(book: Book, lock: BuildLock | null, staged: ReadonlyMap<string, File>, out: ReadonlyMap<string, File>): { writes: Changes; userOnly: string[] } {
  const differ = [...new Set([...out.keys(), ...staged.keys(), ...(lock?.keys() ?? [])])].sort(byCodePoint)
    .filter((p) => !sameFile(onDisk(book, p), out.get(p), book.tracksExecBit()));
  const loose = new Set(unstaged(book.root, differ.map((p) => inRepo(book, p))));
  const matchesIndex = (p: string) =>
    staged.has(p) ? !loose.has(inRepo(book, p)) || sameFile(onDisk(book, p), staged.get(p), false) : !lexists(join(book.outputRoot(), p));
  const userOnly = differ.filter((p) => !matchesIndex(p) && !leftByLastBuild(book, lock, p, out));
  const writes = differ.filter((p) => !userOnly.includes(p));
  return { writes: { stale: writes.filter((p) => !out.has(p)), changed: writes.filter((p) => out.has(p)) }, userOnly };
}

/** During `git commit <paths>`, git runs the hook on `<git dir>/next-index-<pid>.lock` and holds the lock on the real index,
 * which it writes back after the commit. That lock is `<git dir>/index.lock`, unless you set GIT_INDEX_FILE yourself. */
function partialCommit(root: string): { lock: string | null } | null {
  const hooked = process.env["GIT_INDEX_FILE"];
  const dir = resolve(git(["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: root }));
  if (!hooked || dirname(resolve(hooked)) !== dir || !/^next-index-\d+\.lock$/.test(basename(hooked))) return null;
  const lock = join(dir, "index.lock");
  return { lock: exists(lock) ? lock : null };
}

function inBookRepo(book: Book): boolean {
  // The common dir, not the git dir: every linked worktree of a repo runs the same hooks folder.
  const gitDir = (cwd: string) => resolve(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd }));
  return gitDir(process.cwd()) === gitDir(book.root);
}

function refuseOtherRepo(book: Book): void {
  if (inBookRepo(book)) return;
  throw new Fail(`${PB}/config.toml is in ${book.root}, which is another git repo than the one you're in, so no hook was installed. `
    + `Run \`patchbook hook install\` in ${book.root}, or start a patchbook here with \`patchbook init\`.`);
}

/** The tree each upstream is pinned to by the upstream.lock in the index, or null when the index holds no lock.
 * The index holds only the path of a staged link, so the lock it points to is read, as the build reads it. */
function stagedPins(book: Book): Map<string, string> | null {
  const rel = relative(book.root, join(book.dir, "upstream.lock"));
  const staged = spawn(["git", "cat-file", "blob", `:${rel}`], { cwd: book.root });
  if (staged.code !== 0) return null;
  const linked = git(["ls-files", "-s", "--", rel], { cwd: book.root }).startsWith("120000 ");
  let pins;
  try {
    pins = linked ? book.lock() : parseLock(decode(staged.stdout));
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
    throw new Fail(`the ${rel} in the index can't be read (${e.message}), so the hook can't tell which copy to stage. `
      + "Stage a good lock, or skip the hook once with PATCHBOOK_HOOK=0.");
  }
  return new Map(pins.map((p) => [p.name, p.tree]));
}

/** The tree git would commit from the index, or null when it can't write one, as with unmerged paths. */
function indexTree(root: string): string | null {
  const out = spawn(["git", "write-tree"], { cwd: root });
  return out.code === 0 ? decode(out.stdout).trim() : null;
}

function headTree(root: string): string {
  const head = spawn(["git", "rev-parse", "--verify", "--quiet", "HEAD^{tree}"], { cwd: root });
  if (head.code === 0) return decode(head.stdout).trim();
  return decode(run(["git", "hash-object", "-t", "tree", "--stdin"], { cwd: root, input: new Uint8Array() })).trim();
}

/**
 * Put the pinned copy into the index for each vendor folder where the index holds anything else. The pin is the one the index's own
 * upstream.lock names, and a folder whose upstream the index has no pin for is left alone. Git has already decided what the commit holds
 * from the index it read before the hook, so a step that leaves nothing to commit says so and refuses, and any other replacement says so too.
 */
function stageVendors(book: Book): void {
  if (partialCommit(book.root) !== null) return;
  const pins = stagedPins(book);
  if (!pins) return;
  const stale: { name: string; rel: string; tree: string }[] = [];
  for (const u of book.upstreams) {
    const tree = pins.get(u.name);
    if (!u.vendor || !tree) continue;
    const rel = relative(book.root, u.vendor);
    if (stagedTree(book.root, rel) !== tree) stale.push({ name: u.name, rel, tree });
  }
  if (!stale.length) return;
  for (const { name, tree } of stale) {
    if (spawn(["git", "cat-file", "-e", `${tree}^{tree}`], { cwd: book.root }).code !== 0) {
      throw new Fail(`the pin for ${name} names tree ${tree}, which this repo doesn't have, so the hook can't stage the copy. Run \`patchbook sync ${name}\` to fetch it.`);
    }
  }
  const was = indexTree(book.root);
  try {
    for (const { rel, tree } of stale) {
      git(["--literal-pathspecs", "rm", "-rqf", "--cached", "--ignore-unmatch", "--", rel], { cwd: book.root });
      git(["read-tree", `--prefix=${rel}/`, tree], { cwd: book.root });
    }
    const head = headTree(book.root);
    if (was && was !== head && indexTree(book.root) === head) {
      throw new Fail(`nothing would be left to commit. The staged changes were all under ${stale.map((s) => s.rel).join(", ")}, `
        + `which the pre-commit hook replaces with the pinned copy of ${stale.map((s) => s.name).join(", ")}. `
        + "Record the change in the patchbook, or skip the hook once with PATCHBOOK_HOOK=0. "
        + "If the change is the removal of the copy, delete the upstream's vendor line to stop vendoring it.");
    }
  } catch (e) {
    if (was) git(["read-tree", was], { cwd: book.root });
    throw e;
  }
  for (const { name, rel } of stale) warn(`patchbook: the pre-commit hook staged the pinned copy of ${name} under ${rel}, in place of what the index held\n`);
}

export async function cmdHook(args: { action: "install" | "run" | "status" }) {
  if (args.action === "status") {
    printHookStatus(await Book.find());
    return 0;
  }
  if (args.action === "install") {
    const book = await Book.find();
    refuseOtherRepo(book);
    if (hookEnabled(book)) {
      keepGitHook(book);
      return await installHook(book) ? 0 : 1;
    } else warn(`patchbook: hook.enabled is off, so no hook was installed. ${turnOn(setting("hook.enabled", book)[1])}\n`);
    return 0;
  }
  const undo = new Undo();
  try {
    return await runHook(undo);
  } catch (e) {
    const stuck = undo.restore();
    if (stuck.length) {
      warn("patchbook: couldn't put these back as they were:\n  " + stuck.join("\n  ")
        + "\nCheck that you can write to them, then compare them with `git diff` before you commit again.\n");
    }
    throw e;
  }
}

async function runHook(undo: Undo) {
  const book = await Book.find();
  if (!setting("hook.enabled", book)[0]) return 0;
  book.refuseLinks(", or skip the hook once with PATCHBOOK_HOOK=0");
  refuseMergedUpstream(book, "hook");
  const lock = readBuildLock(book);
  const readEdits = placeholderOutputs(book).filter((p) => !leftByLastBuild(book, lock, p)).map((p) => inRepo(book, p));
  const inputs = buildInputs(book);
  const loose = unstaged(book.root, [...inputs, ...linkTargets(book, inputs), ...readEdits]);
  if (loose.length) throw new Fail("the patchbook has changes that aren't in this commit:\n  " + loose.join("\n  ") + "\nThe build reads them, so stage them (or name them in `git commit <path>`) or stash them, or skip the hook once with PATCHBOOK_HOOK=0.");
  const ignored = ignoredInPatchbook(book.root);
  const staged = book.seen("index");
  const committed = committedBuildLock(book);
  const sinceHead = book.stagedChanges();
  const removedFromIndex = (out: ReadonlyMap<string, File>) => Array.from(sinceHead).filter(([p, c]) => c.staged === null && out.has(p)).map(([p]) => p);
  const stagedEdits = (out: ReadonlyMap<string, File>) => {
    const removed = removedFromIndex(out);
    refuseBehindLinks(book, removed);
    const hand = handEdits(book, out, staged, [lock, committed]);
    refuseFolderToFile(book, out, staged, hand, ", or skip the hook once with PATCHBOOK_HOOK=0");
    return [...new Set([...committable(book, staged, hand), ...removed])].sort(byCodePoint);
  };
  const plan = (out: ReadonlyMap<string, File>) => {
    const { stale, changed } = changesOf(staged, out, book.tracksExecBit());
    const stage = new Set([...stale, ...committable(book, staged, changed)]);
    const { writes, userOnly } = diskWrites(book, lock, staged, out);
    refuseOverwrites(book, userOnly.filter((p) => stage.has(p)));
    return { stage: [...stage], disk: writes };
  };
  const asRecorded = (out: ReadonlyMap<string, File>, edits: string[]) => {
    const next = new Map(out);
    for (const p of edits) {
      const now = staged.get(p);
      if (now) next.set(p, { data: now.data, mode: meantMode(now, out.get(p)?.mode) });
      else next.delete(p);
    }
    return next;
  };
  let a = assemble(book);
  const edited = stagedEdits(a.out);
  readBlobsOf(edited.flatMap((p) => staged.get(p) ?? []));
  const kept = edited.filter((p) => !staged.has(p) && onDisk(book, p) !== undefined);
  if (kept.length) {
    throw new Fail("these files are out of the index but still on disk:\n  " + kept.join("\n  ")
      + "\n`git rm --cached` keeps a file on disk, where the next build takes it for a hand edit. Delete it with `git rm`, "
      + `or keep it with \`git --literal-pathspecs reset -q -- ${kept.map((p) => shellQuote(inRepo(book, p))).join(" ")}\`.`);
  }
  const olderBuild = edited.filter((p) => staged.has(p) && leftByLastBuild(book, lock, p, a.out));
  const buildReads = [...buildInputs(book), ...placeholderOutputs(book).map((p) => inRepo(book, p))];
  if (olderBuild.length && git(["--literal-pathspecs", "diff", "--cached", "--name-only", "--", ...buildReads], { cwd: book.root })) {
    const paths = olderBuild.map((p) => shellQuote(inRepo(book, p))).join(" ");
    throw new Fail("these staged files match no build, but their working copies match the last build:\n  " + olderBuild.join("\n  ")
      + "\nThe index may hold an older build, or edits you undid in the working copy. "
      + `To commit the last build, run \`git --literal-pathspecs add -- ${paths}\`. `
      + `To record what is staged, run \`git --literal-pathspecs checkout -- ${paths}\`, which puts it in the working copy. Then commit again.`);
  }
  const refused = a.problems.filter((p) => "refuse" in p);
  const named = refused.filter((p) => p.file === "series");
  const edits = refused.filter((p) => p.file !== "series");
  if (refused.length) {
    const lines = (ps: Problem[]) => ps.map((p) => `  ${describe(p)}\n`).join("");
    const skip = "or skip the hook once with PATCHBOOK_HOOK=0.";
    throw new Fail([
      ...(named.length ? [`refusing this commit: a change name isn't valid.\n${lines(named)}Rename it to lowercase letters, digits and dashes in series and changes/, ${skip}`] : []),
      ...(edits.length ? [`refusing this commit: a change writes where a build must not.\n${lines(edits)}Edit or remove that line in the change's CHANGE.md, ${skip}`] : []),
    ].join("\n"));
  }
  for (const p of edited.filter((p) => !a.out.has(p))) {
    const reserved = book.reservedOutput(p);
    if (reserved?.refuse) {
      throw new Fail(`refusing this commit: ${p} ${sinceHead.get(p)?.head ? "is in HEAD" : "is new"}, but a change can't write into ${reserved.place}.\n`
        + `Move ${p} out of there, or skip the hook once with PATCHBOOK_HOOK=0.`);
    }
  }
  let copies: ReadonlyMap<string, Mode> = new Map();
  if (edited.length) {
    if (!a.problems.length) plan(asRecorded(a.out, edited));
    for (const p of buildInputs(book)) undo.hold(join(book.root, p));
    const recorded = record(book, null, process.env["PATCHBOOK_INTENT"] ?? null, { seen: staged, edits: edited, undo, assembly: a });
    say(recorded.text);
    copies = recorded.copies;
    a = recorded.after ?? assemble(book);
  }
  let built: string[] = [];
  if (a.problems.length) {
    warn(`patchbook: ${a.problems.length} problems, so the output wasn't rebuilt. \`patchbook status\` lists them.\n`);
  } else {
    const left = stagedEdits(a.out);
    if (left.length) {
      throw new Fail("couldn't record these hand edits:\n  " + left.join("\n  ")
        + "\nMove them into the patchbook yourself, or skip the hook once with PATCHBOOK_HOOK=0.");
    }
    const { stage, disk } = plan(a.out);
    built = stage;
    const written = [...disk.stale, ...disk.changed];
    if (written.length) {
      for (const p of buildInputs(book)) undo.hold(join(book.root, p));
      for (const p of written) undo.hold(join(book.outputRoot(), p));
      writeOutput(book, a.out, disk);
    }
    if (built.length || written.length) warn(`patchbook: built from ${book.pins()}\n`);
  }
  const wrote = [...unstaged(book.root, buildInputs(book)), ...built.map((p) => inRepo(book, p))];
  const recordedIgnored = Array.from(ignoredInPatchbook(book.root)).filter(([p, oid]) => ignored.get(p) !== oid).map(([p]) => p);
  const adds: string[][] = [];
  if (wrote.length) adds.push(["--literal-pathspecs", "add", "-A", "--", ...wrote]);
  if (recordedIgnored.length) adds.push(["--literal-pathspecs", "add", "-A", "-f", "--", ...recordedIgnored]);
  const upstream = a.problems.length ? new Map<string, Mode>() : upstreamModes(book, a, Array.from(a.out.keys()));
  const modes = new Map([...chosenCopies(book, a, staged, sinceHead), ...upstream, ...copies]);
  for (const add of adds) git(add, { cwd: book.root });
  const moded = stageModes(book.root, modes);
  const partial = partialCommit(book.root);
  if (partial?.lock) {
    const env = { ...process.env, GIT_INDEX_FILE: partial.lock };
    for (const add of adds) git(add, { cwd: book.root, env });
    stageModes(book.root, modes, env);
  } else if (partial && (adds.length || moded.length)) {
    warn("patchbook: your index won't have what the hook staged. After the commit, run "
      + `\`git --literal-pathspecs reset -q -- ${[...new Set([...wrote, ...recordedIgnored, ...moded])].sort(byCodePoint).map(shellQuote).join(" ")}\`\n`);
  }
  stageVendors(book);
  return 0;
}
