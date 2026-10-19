// The pre-commit hook: on each commit, record hand edits to the output, rebuild, and stage both.
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Problem } from "./api.ts";
import { assemble, describe, handEdits, writeOutput } from "./assemble.ts";
import { Book } from "./book.ts";
import { cmdRecord } from "./record.ts";
import { Fail } from "./lib/fail.ts";
import { exists, type File, isDir, lexists, mkdirs, readDisk, readTextReplace, relative, sameFile, writeText } from "./lib/fs.ts";
import { blobOid } from "./lib/hash.ts";
import { git, run } from "./lib/proc.ts";
import { length, slice, sorted } from "./lib/py.ts";
import { decode } from "./lib/text.ts";
import { setting } from "./settings.ts";

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

/** {path: blob id, or null if deleted} for every path git status lists. */
function dirty(root: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const entries = decode(run(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root })).split("\0");
  const paths = entries.filter((e) => length(e) > 3 && slice(e, 2, 3) === " ").map((e) => slice(e, 3));
  for (const path of paths) {
    const f = join(root, path);
    out.set(path, lexists(f) && !isDir(f) ? blobOid(readDisk(f).data) : null);
  }
  return out;
}

function sameOutput(a: ReadonlyMap<string, File>, b: ReadonlyMap<string, File>): boolean {
  return a.size === b.size && Array.from(a).every(([p, f]) => sameFile(f, b.get(p)));
}

export async function cmdHook(args: { action: "install" | "run" }) {
  if (args.action === "install") {
    installHook(git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() }), true);
    return 0;
  }
  const book = await Book.find();
  if (!setting("hook.enabled", book)[0]) return 0;
  const before = dirty(book.root);
  let a = assemble(book);
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
  const edited = handEdits(book, a.out);
  for (const p of edited.filter((p) => !a.out.has(p))) {
    const reserved = book.reservedOutput(p);
    if (reserved?.refuse) {
      throw new Fail(`refusing this commit: ${p} is new, but a change can't write into ${reserved.place}.\n`
        + `Move ${p} out of there, or skip the hook once with PATCHBOOK_HOOK=0.`);
    }
  }
  if (edited.length) {
    await cmdRecord({ change: null, intent: process.env["PATCHBOOK_INTENT"] ?? null });
    a = assemble(book);
  }
  if (a.problems.length) {
    process.stderr.write(`patchbook: ${a.problems.length} problems, so the output wasn't rebuilt. \`patchbook status\` lists them.\n`);
  } else {
    const left = handEdits(book, a.out);
    if (left.length) {
      throw new Fail("couldn't record these hand edits:\n  " + left.join("\n  ")
        + "\nMove them into the patchbook yourself, or skip the hook once with PATCHBOOK_HOOK=0.");
    }
    if (!sameOutput(a.out, book.currentOutput())) {
      writeOutput(book, a.out);
      process.stderr.write(`patchbook: built from ${book.pins()}\n`);
    }
  }
  const after = dirty(book.root);
  const outRel = relative(book.root, book.outputRoot());
  const changed = Array.from(new Set([...before.keys(), ...after.keys()])).filter((p) => (before.get(p) ?? null) !== (after.get(p) ?? null));
  const stage = sorted(new Set([...changed, ...edited.map((p) => (outRel !== "." ? `${outRel}/${p}` : p))]));
  if (stage.length) git(["add", "-A", "--", ...stage], { cwd: book.root });
  return 0;
}
