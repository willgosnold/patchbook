// The pre-commit hook: on each commit, record hand edits to the output, rebuild, and stage both.
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { assemble, handEdits, writeOutput } from "./assemble.ts";
import { Book } from "./book.ts";
import { cmdRecord } from "./record.ts";
import { Fail } from "./lib/fail.ts";
import { exists, type File, isDir, lexists, mkdirs, readDisk, readTextReplace, relative, resolve, sameFile, writeText } from "./lib/fs.ts";
import { blobOid } from "./lib/hash.ts";
import { git, run } from "./lib/proc.ts";
import { length, quote, slice, sorted } from "./lib/py.ts";
import { decode } from "./lib/text.ts";
import { setting } from "./settings.ts";

export const HOOK_MARK = "# Installed by patchbook.";

/** How the hook runs this patchbook: the compiled binary, or bun with this script. */
function self(): string[] {
  const script = resolve(Bun.main);
  return script.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, script];
}

/** Install the pre-commit hook, unless the repo already has a pre-commit hook of its own. */
export function installHook(root: string, verbose = false): void {
  const path = git(["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"], { cwd: root });
  if (exists(path)) {
    if (!readTextReplace(path).includes(HOOK_MARK) && verbose) {
      process.stderr.write(`patchbook: ${path} is another tool's hook; add \`patchbook hook run\` to it to record on commit.\n`);
    }
    return;
  }
  const me = self();
  mkdirs(dirname(path));
  writeText(path, `#!/bin/sh
${HOOK_MARK} On each commit, it records hand edits to the build output in the
# patchbook, rebuilds, and stages both. Skip it once with: PATCHBOOK_HOOK=0 git commit
[ "$PATCHBOOK_HOOK" = 0 ] && exit 0
if [ -f ${quote(me.at(-1)!)} ]; then exec ${me.map(quote).join(" ")} hook run; fi
if command -v patchbook >/dev/null; then exec patchbook hook run; fi
echo "patchbook isn't installed, so this commit doesn't record hand edits." >&2
`);
  chmodSync(path, 0o755);
  process.stderr.write("patchbook: installed a pre-commit hook that records and builds on each commit\n");
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
  const edited = handEdits(book, a.out);
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
