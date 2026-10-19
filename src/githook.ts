// The pre-commit hook: on each commit, record the hand edits staged in the output, rebuild, and stage both.
import { chmodSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Problem } from "./api.ts";
import { assemble, buildLockPath, type BuildLock, type Changes, changesOf, describe, handEdits, parseBuildLock, readBuildLock, writeOutput } from "./assemble.ts";
import { Book, buildInputs, PB, placeholderOutputs } from "./book.ts";
import { cmdRecord } from "./record.ts";
import { Fail } from "./lib/fail.ts";
import { exists, type File, isDir, isSymlink, lexists, mkdirs, readDisk, readTextReplace, relative, resolve, sameFile, writeText } from "./lib/fs.ts";
import { blobOid } from "./lib/hash.ts";
import { git, run, spawn } from "./lib/proc.ts";
import { quote, sorted, strip } from "./lib/py.ts";
import { bytesEqual, decode, decodeReplace, encode } from "./lib/text.ts";
import { setting } from "./settings.ts";
import { linksUnder, Undo } from "./undo.ts";

const SCRIPT = `#!/bin/sh
# Installed by patchbook v2. On each commit, it records hand edits to the build output in the
# patchbook, rebuilds, and stages both. Skip it once with: PATCHBOOK_HOOK=0 git commit
[ "$PATCHBOOK_HOOK" = 0 ] && exit 0
if command -v patchbook >/dev/null; then exec patchbook hook run; fi
echo "patchbook isn't installed, so this commit doesn't record hand edits." >&2
`;

/** One word of `shlex.quote` output: bare, or in single quotes, with `'"'"'` standing for a quote. */
const WORD = `(?:[^\\s'"]+|'[^']*'|"'")+`;
/** The hook the Python version wrote, which embedded the paths of its interpreter and script. Anything else was edited. */
const PYTHON_HOOK = new RegExp(`^#!/bin/sh
# Installed by patchbook\\. On each commit, it records hand edits to the build output in the
# patchbook, rebuilds, and stages both\\. Skip it once with: PATCHBOOK_HOOK=0 git commit
\\[ "\\$PATCHBOOK_HOOK" = 0 \\] && exit 0
if \\[ -f ${WORD} \\]; then exec ${WORD} ${WORD} hook run; fi
if command -v patchbook >/dev/null; then exec patchbook hook run; fi
echo "patchbook isn't installed, so this commit doesn't record hand edits\\." >&2
$`);

function writeHook(path: string): void {
  mkdirs(dirname(path));
  writeText(path, SCRIPT);
  chmodSync(path, 0o755);
}

/** Install the pre-commit hook, or rewrite the stock one the Python version wrote. Any other hook is left alone, edited or not ours. */
export function installHook(root: string, verbose = false): void {
  const path = git(["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"], { cwd: root });
  if (!exists(path)) {
    writeHook(path);
    process.stderr.write("patchbook: installed a pre-commit hook that records and builds on each commit\n");
    return;
  }
  const text = readTextReplace(path);
  if (PYTHON_HOOK.test(text)) {
    writeHook(path);
    process.stderr.write(`patchbook: updated ${path} to run patchbook from PATH\n`);
  } else if (text !== SCRIPT && verbose) {
    process.stderr.write(`patchbook: ${path} is another tool's hook; add \`patchbook hook run\` to it to record on commit.\n`);
  }
}

/** Install the hook, or warn why not. Until it is installed, a commit doesn't record hand edits. */
export function installHookOrWarn(root: string): void {
  try {
    installHook(root);
  } catch (e) {
    if (!(e instanceof Error && "errno" in e)) throw e;
    process.stderr.write(`patchbook: couldn't install the pre-commit hook: ${e.message}\nUntil it is installed, a commit doesn't record hand edits to the build output in the patchbook.\n`);
  }
}

function unstaged(root: string, paths: string[]): string[] {
  if (!paths.length) return [];
  git(["update-index", "-q", "--refresh"], { cwd: root });
  const listed = (args: string[]) => decode(run(["git", "--literal-pathspecs", ...args, "--", ...paths], { cwd: root })).split("\0");
  return sorted(new Set([...listed(["diff-files", "--name-only", "-z"]), ...listed(["ls-files", "-z", "-o", "--exclude-standard"])].filter(Boolean)));
}

function ignoredInPatchbook(root: string): Map<string, string> {
  const listed = decode(run(["git", "ls-files", "-z", "-o", "-i", "--exclude-standard", "--", PB], { cwd: root })).split("\0");
  return new Map(listed.filter(Boolean).map((p) => [p, blobOid(readDisk(join(root, p)).data)]));
}

const inRepo = (book: Book, p: string) => relative(book.root, join(book.outputRoot(), p));

function committable(book: Book, staged: ReadonlyMap<string, File>, paths: string[]): string[] {
  const absent = paths.filter((p) => !staged.has(p)).map((p) => inRepo(book, p));
  if (!absent.length) return paths;
  const found = spawn(["git", "check-ignore", "-z", "--stdin"], { cwd: book.root, input: encode(absent.join("\0")) });
  if (found.code !== 0 && found.code !== 1) throw new Fail(`git check-ignore failed:\n${strip(decodeReplace(found.stderr))}`);
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

function leftByLastBuild(book: Book, lock: BuildLock | null, p: string): boolean {
  if (lock === null || isFolder(book, p)) return false;
  const disk = onDisk(book, p);
  return disk === undefined ? !lock.has(p) : lock.get(p) === blobOid(disk.data);
}

function refuseOverwrites(book: Book, clobbered: string[]): void {
  if (!clobbered.length) return;
  const intentToAdd = decode(run(["git", "diff-files", "-z", "--name-only", "--diff-filter=A"], { cwd: book.root })).split("\0").filter(Boolean);
  throw new Fail("the build changes these files, which have changes you haven't staged:\n  " + clobbered.join("\n  ")
    + "\nStaging them would record them over the build's change. "
    + (intentToAdd.length ? "git can't stash while the index holds `git add -N` entries, so first run "
      + `\`git --literal-pathspecs rm -q --cached -- ${intentToAdd.map(quote).join(" ")}\`, which keeps the files on disk. Then stash` : "Stash")
    + ` them with \`git --literal-pathspecs stash push -a -- ${clobbered.map((p) => quote(inRepo(book, p))).join(" ")}\`, commit, `
    + "then `git stash pop` puts them back on the new build. Or skip the hook once with PATCHBOOK_HOOK=0.");
}

function diskWrites(book: Book, lock: BuildLock | null, staged: ReadonlyMap<string, File>, out: ReadonlyMap<string, File>): { writes: Changes; userOnly: string[] } {
  const differ = sorted(new Set([...out.keys(), ...staged.keys(), ...(lock?.keys() ?? [])]))
    .filter((p) => !sameFile(onDisk(book, p), out.get(p), book.tracksExecBit()));
  const loose = new Set(unstaged(book.root, differ.map((p) => inRepo(book, p))));
  const matchesIndex = (p: string) =>
    staged.has(p) ? !loose.has(inRepo(book, p)) || sameFile(onDisk(book, p), staged.get(p), false) : !lexists(join(book.outputRoot(), p));
  const userOnly = differ.filter((p) => !matchesIndex(p) && !leftByLastBuild(book, lock, p));
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

export async function cmdHook(args: { action: "install" | "run" }) {
  if (args.action === "install") {
    installHook(git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() }), true);
    return 0;
  }
  const undo = new Undo();
  try {
    return await runHook(undo);
  } catch (e) {
    const stuck = undo.restore();
    if (stuck.length) {
      process.stderr.write("patchbook: couldn't put these back as they were:\n  " + stuck.join("\n  ")
        + "\nCheck that you can write to them, then compare them with `git diff` before you commit again.\n");
    }
    throw e;
  }
}

/** A recorded symlink is stored as one, at `changes/<name>/<side>/<path>.pb`, and the record replaces it. A link to a folder is
 * not one, since the record writes into it. The walk reaches `p` only through real folders, so none above it is a link. */
const isRecordedLink = (changes: string, p: string) => {
  const [, side, ...path] = relative(changes, p).split("/");
  return (side === "base" || side === "ours") && path.length > 0 && p.endsWith(".pb") && !isDir(p);
};

/** The record writes through a link and git can't see what lands behind it, so a failed run couldn't put that back.
 * Only what the hook writes counts: it never writes `config.toml` or `upstream.lock`. */
function refuseLinkedInputs(book: Book): void {
  const inPatchbook = (name: string) => join(book.root, PB, name);
  const linked = [
    ...["blocks", "changes", "series", "build.lock"].map(inPatchbook).filter(isSymlink),
    ...linksUnder(inPatchbook("blocks")),
    ...linksUnder(inPatchbook("changes")).filter((p) => !isRecordedLink(inPatchbook("changes"), p)),
  ].map((p) => relative(book.root, p));
  if (linked.length) {
    throw new Fail(linked.map((p) => `${p} is a link`).join(", ") + ". The hook records into it, so replace the link with a copy of what it points to, or skip the hook once with PATCHBOOK_HOOK=0.");
  }
}

async function runHook(undo: Undo) {
  const book = await Book.find();
  if (!setting("hook.enabled", book)[0]) return 0;
  refuseLinkedInputs(book);
  const lock = readBuildLock(book);
  const readEdits = placeholderOutputs(book).filter((p) => !leftByLastBuild(book, lock, p)).map((p) => inRepo(book, p));
  const loose = unstaged(book.root, [...buildInputs(book), ...readEdits]);
  if (loose.length) throw new Fail("the patchbook has changes that aren't in this commit:\n  " + loose.join("\n  ") + "\nThe build reads them, so stage them (or name them in `git commit <path>`) or stash them, or skip the hook once with PATCHBOOK_HOOK=0.");
  const ignored = ignoredInPatchbook(book.root);
  const staged = book.stagedOutput();
  const committed = committedBuildLock(book);
  const sinceHead = book.stagedChanges();
  const removedFromIndex = (out: ReadonlyMap<string, File>) => Array.from(sinceHead).filter(([p, c]) => c.staged === null && out.has(p)).map(([p]) => p);
  const stagedEdits = (out: ReadonlyMap<string, File>) =>
    sorted(new Set([...committable(book, staged, handEdits(book, out, staged, [lock, committed])), ...removedFromIndex(out)]));
  const modeOnly = (out: ReadonlyMap<string, File>, p: string) => {
    const [now, next] = [staged.get(p), out.get(p)];
    return now !== undefined && next !== undefined && bytesEqual(now.data, next.data);
  };
  const keepsStagedMode = (out: ReadonlyMap<string, File>, p: string) => {
    const c = sinceHead.get(p);
    const handStaged = c !== undefined && c.head !== null && c.head !== c.staged;
    return modeOnly(out, p) && (handStaged || sameFile(onDisk(book, p), out.get(p), book.tracksExecBit()));
  };
  const plan = (out: ReadonlyMap<string, File>) => {
    const { stale, changed } = changesOf(staged, out, book.tracksExecBit());
    const stage = new Set([...stale, ...committable(book, staged, changed).filter((p) => !keepsStagedMode(out, p))]);
    const { writes, userOnly } = diskWrites(book, lock, staged, out);
    refuseOverwrites(book, userOnly.filter((p) => stage.has(p)));
    return { stage: [...stage], disk: writes };
  };
  const asRecorded = (out: ReadonlyMap<string, File>, edits: string[]) => {
    const next = new Map(out);
    for (const p of edits) {
      const now = staged.get(p);
      if (now) next.set(p, { data: now.data, mode: out.get(p)?.mode ?? now.mode });
      else next.delete(p);
    }
    return next;
  };
  let a = assemble(book);
  const edited = stagedEdits(a.out);
  const kept = edited.filter((p) => !staged.has(p) && onDisk(book, p) !== undefined);
  if (kept.length) {
    throw new Fail("these files are out of the index but still on disk:\n  " + kept.join("\n  ")
      + "\n`git rm --cached` keeps a file on disk, where the next build takes it for a hand edit. Delete it with `git rm`, "
      + `or keep it with \`git --literal-pathspecs reset -q -- ${kept.map((p) => quote(inRepo(book, p))).join(" ")}\`.`);
  }
  const olderBuild = edited.filter((p) => staged.has(p) && leftByLastBuild(book, lock, p));
  const buildReads = [...buildInputs(book), ...placeholderOutputs(book).map((p) => inRepo(book, p))];
  if (olderBuild.length && git(["--literal-pathspecs", "diff", "--cached", "--name-only", "--", ...buildReads], { cwd: book.root })) {
    const paths = olderBuild.map((p) => quote(inRepo(book, p))).join(" ");
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
      throw new Fail(`refusing this commit: ${p} is new, but a change can't write into ${reserved.place}.\n`
        + `Move ${p} out of there, or skip the hook once with PATCHBOOK_HOOK=0.`);
    }
  }
  if (edited.length) {
    if (!a.problems.length) plan(asRecorded(a.out, edited));
    for (const p of buildInputs(book)) undo.hold(join(book.root, p));
    await cmdRecord({ change: null, intent: process.env["PATCHBOOK_INTENT"] ?? null, current: staged, edits: edited });
    a = assemble(book);
  }
  let built: string[] = [];
  if (a.problems.length) {
    process.stderr.write(`patchbook: ${a.problems.length} problems, so the output wasn't rebuilt. \`patchbook status\` lists them.\n`);
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
    if (built.length || written.length) process.stderr.write(`patchbook: built from ${book.pins()}\n`);
  }
  const wrote = [...unstaged(book.root, buildInputs(book)), ...built.map((p) => inRepo(book, p))];
  const recordedIgnored = Array.from(ignoredInPatchbook(book.root)).filter(([p, oid]) => ignored.get(p) !== oid).map(([p]) => p);
  const adds: string[][] = [];
  if (wrote.length) adds.push(["--literal-pathspecs", "add", "-A", "--", ...wrote]);
  if (recordedIgnored.length) adds.push(["--literal-pathspecs", "add", "-A", "-f", "--", ...recordedIgnored]);
  if (adds.length) {
    for (const add of adds) git(add, { cwd: book.root });
    const partial = partialCommit(book.root);
    if (partial?.lock) for (const add of adds) git(add, { cwd: book.root, env: { ...process.env, GIT_INDEX_FILE: partial.lock } });
    else if (partial) {
      process.stderr.write("patchbook: your index won't have what the hook staged. After the commit, run "
        + `\`git --literal-pathspecs reset -q -- ${[...wrote, ...recordedIgnored].map(quote).join(" ")}\`\n`);
    }
  }
  return 0;
}
