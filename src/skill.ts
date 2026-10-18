// The patchbook-update skill, embedded in the binary and written into the repo for its agents.
import { chmodSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import skill from "../skills/patchbook-update/SKILL.md" with { type: "text" };
import { assemble, describe, handEdits } from "./assemble.ts";
import { Book } from "./book.ts";
import { readChanges } from "./changes.ts";
import { Fail } from "./lib/fail.ts";
import { exists, isDir, isSymlink, lexists, mkdirs, readBytes, readText, writeText } from "./lib/fs.ts";
import { git } from "./lib/proc.ts";
import { cmdRecord } from "./record.ts";
import { setting } from "./settings.ts";

const NAME = "patchbook-update";
const CHANGE = "patchbook-update-skill";
export const SCHEDULE = 'To keep up with upstream, add a daily T3 scheduled task in this project: "Use the patchbook-update skill."';

/** Each agent reads the skill from .agents/skills, or from a folder that links there. */
const AGENTS: ReadonlyMap<string, { link: string | null }> = new Map([
  ["claude-code", { link: ".claude/skills" }],
  ["codex", { link: null }],
]);

const FILE = `.agents/skills/${NAME}/SKILL.md`;
const LINK = `.claude/skills/${NAME}`;

const pointsAt = (at: string, target: string) => isSymlink(at) && readlinkSync(at) === relative(dirname(at), target);

const folderNote = (root: string, at: string) =>
  `patchbook: ${relative(root, at)} is a folder, so the skill there was left as it is\n`;

/**
 * Point `at` to `target`, unless a real folder is already there.
 * Returns null when it left a folder alone. Pushes onto `undo` what puts things back.
 */
function link(root: string, at: string, target: string, undo: (() => void)[]): boolean | null {
  if (pointsAt(at, target)) return false;
  if (isSymlink(at)) {
    const was = readlinkSync(at);
    unlinkSync(at);
    undo.push(() => symlinkSync(was, at));
  } else if (lexists(at) && !isDir(at)) {
    const was = readBytes(at);
    const mode = statSync(at).mode;
    unlinkSync(at);
    undo.push(() => {
      writeFileSync(at, was, { mode });
      chmodSync(at, mode & 0o7777);
    });
  } else if (lexists(at)) {
    process.stderr.write(folderNote(root, at));
    return null;
  }
  mkdirs(dirname(at));
  symlinkSync(relative(dirname(at), target), at);
  undo.push(() => rmSync(at, { force: true }));
  return true;
}

/** Install the update skill for agents in the repo. Returns the paths it changed, or null if it installed nothing. */
export function installSkill(book: Book): { changed: string[] } | null {
  if (!setting("start.install_skill", book)[0]) return null;
  const agents = setting("start.agents", book)[0];
  const unknown = agents.filter((a) => !AGENTS.has(a));
  if (unknown.length) {
    process.stderr.write(`patchbook: can't install the skill for ${unknown.join(", ")}. `
      + `start.agents can name ${Array.from(AGENTS.keys()).join(", ")}.\n`);
  }
  const known = agents.flatMap((a) => AGENTS.get(a) ?? []);
  if (!known.length) return null;
  const dir = join(book.root, ".agents", "skills", NAME);
  const file = join(book.root, FILE);
  const changed: string[] = [];
  const undo: (() => void)[] = [];
  try {
    mkdirs(dir);
    for (const { link: folder } of known) {
      if (!folder) continue;
      const at = join(book.root, folder, NAME);
      if (link(book.root, at, dir, undo)) changed.push(at);
    }
    if (!exists(file) || readText(file) !== skill) {
      writeText(file, skill);
      changed.unshift(file);
    }
  } catch (e) {
    // A file where a folder should go, or a read-only repo, shouldn't stop `clone` or `init` from finishing.
    if (!(e instanceof Error && "errno" in e)) throw e;
    for (const put of undo.reverse()) put();
    process.stderr.write(`patchbook: couldn't install the update skill: ${e.message}\n`);
    return null;
  }
  return { changed: changed.map((p) => relative(book.root, p)) };
}

const ownsSkill = (p: string) => p === FILE || p === LINK;

function installed(book: Book, p: string): boolean {
  const at = join(book.root, p);
  if (p === FILE) return exists(at) && readText(at) === skill;
  return pointsAt(at, join(book.root, ".agents", "skills", NAME));
}

const recorded = (book: Book) => readChanges(book, []).some((c) => c.name === CHANGE);

/** Record the skill files as the `patchbook-update-skill` change, and leave every other edit waiting. */
export async function recordSkill(book: Book): Promise<number> {
  process.chdir(book.root);
  return cmdRecord({
    change: CHANGE,
    intent: recorded(book)
      ? null
      : "Install the patchbook-update skill, so an agent can pull upstream and carry these changes forward.",
    only: ownsSkill,
  });
}

/** The skill paths an install would write, for the agents the settings name. */
function wanted(book: Book): string[] {
  const known = setting("start.agents", book)[0].flatMap((a) => AGENTS.get(a) ?? []);
  return known.length ? [FILE, ...known.flatMap(({ link: folder }) => (folder ? [`${folder}/${NAME}`] : []))] : [];
}

/** The link paths that are real folders, which install leaves as they are. */
const folders = (book: Book) =>
  wanted(book).filter((p) => p !== FILE && !isSymlink(join(book.root, p)) && isDir(join(book.root, p)));

/** The paths an install would replace that no commit keeps: those with uncommitted changes, and those git ignores. */
function unkept(book: Book): { uncommitted: string[]; ignored: string[] } {
  const found: { uncommitted: string[]; ignored: string[] } = { uncommitted: [], ignored: [] };
  for (const p of wanted(book)) {
    if (!lexists(join(book.root, p)) || installed(book, p)) continue;
    const status = git(["status", "--porcelain", "--ignored", "--untracked-files=all", "--", p],
      { cwd: book.root, check: false });
    if (status.startsWith("!!")) found.ignored.push(p);
    else if (status) found.uncommitted.push(p);
  }
  return found;
}

export async function cmdSkill(): Promise<number> {
  const book = await Book.find();
  const [on, from] = setting("start.install_skill", book);
  if (!on) {
    process.stdout.write(`start.install_skill is off (${from}), so the update skill was not installed\n`);
    return 0;
  }
  const a = assemble(book);
  const problems = a.problems.filter((p) => p.problem !== "conflict");
  if (problems.length) {
    for (const p of problems) process.stderr.write(describe(p) + "\n");
    throw new Fail(`${problems.length} problems; nothing installed. \`patchbook status\` lists them.`);
  }
  const blocked = folders(book);
  if (blocked.length) {
    for (const p of blocked) process.stderr.write(folderNote(book.root, join(book.root, p)));
    throw new Fail(`the update skill was not installed at ${blocked.join(", ")}`);
  }
  const { uncommitted, ignored } = unkept(book);
  const refusals = [
    uncommitted.length && "these skill files differ from the shipped copy and are not in a commit, "
      + `and installing would replace them:\n  ${uncommitted.join("\n  ")}\n`
      + "Commit them first, then run this again. In a fork the hook records the commit.",
    ignored.length && "these skill files differ from the shipped copy and git ignores them, "
      + `so no commit can keep them, and installing would replace them:\n  ${ignored.join("\n  ")}\n`
      + "Move the file, or stop ignoring the path, then run this again.",
  ].filter(Boolean);
  if (refusals.length) throw new Fail(refusals.join("\n"));
  const replacing = wanted(book).filter((p) => lexists(join(book.root, p)) && !installed(book, p));
  const fork = book.layout.kind === "fork";
  // `handEdits` sees skill files that match the shipped copy but were never recorded, which `changed` does not.
  const unrecorded = fork ? handEdits(book, a.out).filter(ownsSkill) : [];
  const result = installSkill(book);
  if (result === null) {
    throw new Fail(setting("start.agents", book)[0].length ? "the update skill was not installed"
      : "start.agents is empty, so the update skill was not installed");
  }
  const { changed } = result;
  process.stdout.write(changed.map((p) => `wrote ${p}\n`).join(""));
  process.stdout.write(replacing.map((p) => `replaced ${p}; your copy is in HEAD\n`).join(""));
  const record = fork && (changed.length > 0 || unrecorded.length > 0);
  const code = record ? await recordSkill(book) : 0;
  if (!changed.length && !record) process.stdout.write("the update skill is already current\n");
  return code;
}
