// The patchbook-update skill, embedded in the binary and written into the repo for its agents.
import { readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import skill from "../skills/patchbook-update/SKILL.md" with { type: "text" };
import { assemble, describe, handEdits } from "./assemble.ts";
import { Book } from "./book.ts";
import { appendSeries, readChanges, Roster } from "./changes.ts";
import { Fail } from "./lib/fail.ts";
import { exists, fsMessage, isDir, isSymlink, lexists, mkdirs, readBytes, writeText } from "./lib/fs.ts";
import { spawn } from "./lib/proc.ts";
import { say, warn } from "./lib/term.ts";
import { bytesEqual, decode, encode, withoutFinalNewline } from "./lib/text.ts";
import { cmdRecord } from "./record.ts";
import { setting } from "./settings.ts";
import { Undo } from "./undo.ts";

const NAME = "patchbook-update";
const CHANGE = "patchbook-update-skill";
export const SCHEDULE = 'To keep up with upstream, have an agent run "Use the patchbook-update skill." in this repo every day. https://github.com/willgosnold/patchbook#scheduled-updates shows how, with T3 Code, cron or CI.';

/** Each agent reads the skill from .agents/skills, or from a folder that links there. */
const AGENTS: ReadonlyMap<string, { link: string | null }> = new Map([
  ["claude-code", { link: ".claude/skills" }],
  ["codex", { link: null }],
]);

const FILE = `.agents/skills/${NAME}/SKILL.md`;
const LINK = `.claude/skills/${NAME}`;
const SKILL_BYTES = encode(skill);

const pointsAt = (at: string, target: string) => isSymlink(at) && readlinkSync(at) === relative(dirname(at), target);

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * With `.claude/skills` linked to `.agents/skills`, the link path is the skill folder itself.
 * A link that dangles still counts, since making `.agents/skills` makes it live.
 */
const sharesSkills = (root: string, p: string) => {
  const parent = dirname(join(root, p));
  const skills = join(root, ".agents", "skills");
  if (isSymlink(parent) && resolve(dirname(parent), readlinkSync(parent)) === skills) return true;
  const shared = real(skills);
  return shared !== null && real(parent) === shared;
};

export const folderFail = (blocked: readonly string[]) =>
  new Fail(`the update skill was not installed, since a folder sits where it goes:\n  ${blocked.join("\n  ")}\n`
    + "Move or remove the folder, then run `patchbook skill install`.");

const linkNote = (p: string) => `patchbook: ${p} is a symlink, and install won't write through a link\n`;

function link(at: string, target: string, hold: (p: string) => void): boolean {
  if (pointsAt(at, target)) return false;
  hold(at);
  if (lexists(at)) unlinkSync(at);
  mkdirs(dirname(at));
  symlinkSync(relative(dirname(at), target), at);
  return true;
}

/**
 * Install the update skill for agents in the repo. Returns the paths it changed, or null if it installed nothing.
 * It writes nothing, at any skill path, when one holds a copy that HEAD doesn't, which would be lost.
 * It also writes nothing when a folder sits at a skill path, and returns those paths as `blocked` for the caller to fail with.
 */
export function installSkill(book: Book, outer?: Undo): { changed: string[]; blocked: string[] } | null {
  if (!setting("start.install_skill", book)[0]) return null;
  const agents = setting("start.agents", book)[0];
  const unknown = agents.filter((a) => !AGENTS.has(a));
  if (unknown.length) {
    warn(`patchbook: can't install the skill for ${unknown.join(", ")}. `
      + `start.agents can name ${Array.from(AGENTS.keys()).join(", ")}.\n`);
  }
  const known = agents.flatMap((a) => AGENTS.get(a) ?? []);
  if (!known.length) return null;
  const linked = symlinked(book);
  if (linked.length) {
    for (const p of linked) warn(linkNote(p));
    return null;
  }
  const blocked = folders(book);
  if (blocked.length) return { changed: [], blocked };
  const dir = join(book.root, ".agents", "skills", NAME);
  const file = join(book.root, FILE);
  const changed: string[] = [];
  const undo = new Undo();
  const hold = (p: string) => {
    undo.hold(p);
    outer?.hold(p);
  };
  try {
    const { lost } = replacements(book);
    if (lost.length) {
      warn(`patchbook: the update skill was not installed, since these skill files differ from the shipped copy and no commit holds them:\n  ${lost.join("\n  ")}\n`
        + "Commit them, or move them away, then run `patchbook skill install`.\n");
      return null;
    }
    hold(dir);
    mkdirs(dir);
    for (const { link: folder } of known) {
      if (!folder || sharesSkills(book.root, `${folder}/${NAME}`)) continue;
      const at = join(book.root, folder, NAME);
      if (link(at, dir, hold)) changed.push(at);
    }
    if (!exists(file) || !bytesEqual(readBytes(file), SKILL_BYTES)) {
      writeText(file, skill);
      changed.unshift(file);
    }
  } catch (e) {
    // A file where a folder should go, or a read-only repo, shouldn't stop `clone` or `init` from finishing.
    const said = fsMessage(e);
    if (said === null) throw e;
    undo.restore();
    warn(`patchbook: couldn't install the update skill (${said})\n`);
    return null;
  }
  return { changed: changed.map((p) => relative(book.root, p)), blocked: [] };
}

const ownsSkill = (p: string) => p === FILE || p === LINK;

function installed(book: Book, p: string): boolean {
  const at = join(book.root, p);
  if (p === FILE) return exists(at) && bytesEqual(readBytes(at), SKILL_BYTES);
  return sharesSkills(book.root, p) || pointsAt(at, join(book.root, ".agents", "skills", NAME));
}

const recorded = (book: Book) => readChanges(book, []).some((c) => c.name === CHANGE);

/** The skill files on disk that no change records yet. Unlike `changed`, this counts files an earlier run already wrote. */
export const unrecordedSkill = (book: Book): string[] => handEdits(book, assemble(book).out, book.seen("disk")).filter(ownsSkill);

/** The unrecorded skill files that no commit holds, which an earlier `init` that stopped early left behind. */
export const leftBehindSkill = (book: Book): string[] =>
  unrecordedSkill(book).filter((p) => !spawn(["git", "ls-files", "--", p], { cwd: book.root }).stdout.length);

/** Record the skill files as the `patchbook-update-skill` change, and leave every other edit waiting. */
export async function recordSkill(book: Book): Promise<number> {
  process.chdir(book.root);
  const intent = recorded(book)
    ? null
    : "Install the patchbook-update skill, so an agent can pull upstream and carry these changes forward.";
  // An `init` that stopped early can leave this folder out of the series, and patchbook owns the name, so it adopts the folder.
  if (Roster.read(book).stray(CHANGE) === "folder") appendSeries(book, CHANGE);
  return cmdRecord({ change: CHANGE, intent, only: ownsSkill });
}

/** The skill paths an install would write, for the agents the settings name. */
function wanted(book: Book): string[] {
  const known = setting("start.agents", book)[0].flatMap((a) => AGENTS.get(a) ?? []);
  return known.length ? [FILE, ...known.flatMap(({ link: folder }) => (folder ? [`${folder}/${NAME}`] : []))] : [];
}

const prefixes = (p: string) => p.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));

/**
 * The paths an install writes through that are links: every folder above a path it writes, and SKILL.md.
 * The link paths are left out, since install owns those. A link path that is the skill folder already
 * leaves out its parent too, which is the shared link, but its own folders above still count.
 */
function symlinked(book: Book): string[] {
  const through = wanted(book).flatMap((p) => {
    if (p === FILE) return prefixes(p);
    return prefixes(p).slice(0, sharesSkills(book.root, p) ? -2 : -1);
  });
  return Array.from(new Set(through)).filter((p) => isSymlink(join(book.root, p)));
}

const folders = (book: Book) => wanted(book).filter((p) =>
  !isSymlink(join(book.root, p)) && isDir(join(book.root, p)) && !sharesSkills(book.root, p));

/**
 * What HEAD holds at `p` as a file or a link, read from its tree, which neither skip-worktree nor assume-unchanged hides.
 * Null when HEAD holds neither, and when git fails to say: an unreadable HEAD keeps nothing.
 */
function headEntry(book: Book, p: string): { link: boolean; bytes: Uint8Array } | null {
  const listed = spawn(["git", "ls-tree", "HEAD", "--", p], { cwd: book.root });
  if (listed.code !== 0) return null;
  const [, mode, sha, path] = /^(100644|100755|120000) blob (\w+)\t(.*)$/.exec(withoutFinalNewline(decode(listed.stdout))) ?? [];
  if (!sha || path !== p) return null;
  const blob = spawn(["git", "cat-file", "blob", sha], { cwd: book.root });
  return blob.code === 0 ? { link: mode === "120000", bytes: blob.stdout } : null;
}

/**
 * Whether two files hold the same bytes once each `\r\n` is read as `\n`. A lone `\r` still differs.
 * If either holds a NUL byte, as raw UTF-16 does, the bytes must match exactly, since its CR bytes can be part of a character.
 */
// latin1 maps each byte to one character, so no two different byte strings compare equal. UTF-8 decoding would merge invalid bytes.
const sameLines = (a: Uint8Array, b: Uint8Array) => {
  if (a.includes(0) || b.includes(0)) return bytesEqual(a, b);
  const lf = (data: Uint8Array) => Buffer.from(data).toString("latin1").replaceAll("\r\n", "\n");
  return lf(a) === lf(b);
};

/** With `core.symlinks=false`, checkout writes a link as a plain file holding its target. */
const symlinksOff = (book: Book) => decode(spawn(["git", "config", "--bool", "core.symlinks"], { cwd: book.root }).stdout).trim() === "false";

/**
 * Whether HEAD holds what is on disk at `p`: the same bytes for a link's target, and for a file the same bytes up to line endings.
 * No git conversion runs, so a clean filter cannot hide disk text from the comparison. A path a filter rewrites is refused.
 */
function inHead(book: Book, p: string): boolean {
  const held = headEntry(book, p);
  if (!held) return false;
  const at = join(book.root, p);
  if (isSymlink(at)) return held.link && bytesEqual(readlinkSync(at, "buffer"), held.bytes);
  return (!held.link || symlinksOff(book)) && sameLines(readBytes(at), held.bytes);
}

/**
 * The paths an install would replace, split by whether HEAD holds the copy on disk.
 * An ignored or untracked path is in no HEAD, so it is lost. `kept` is what the `replaced` line may name.
 */
function replacements(book: Book): { kept: string[]; lost: string[] } {
  const kept: string[] = [];
  const lost: string[] = [];
  const blocked = folders(book);
  for (const p of wanted(book)) {
    if (!lexists(join(book.root, p)) || blocked.includes(p) || installed(book, p)) continue;
    (inHead(book, p) ? kept : lost).push(p);
  }
  return { kept, lost };
}

const ignored = (book: Book, p: string) =>
  spawn(["git", "check-ignore", "-q", "--", p], { cwd: book.root }).code === 0;

export async function cmdSkill(): Promise<number> {
  const book = await Book.find();
  const [on, from] = setting("start.install_skill", book);
  if (!on) {
    say(`start.install_skill is off (${from}), so the update skill was not installed\n`);
    return 0;
  }
  const a = assemble(book);
  const problems = a.problems.filter((p) => p.problem !== "conflict");
  if (problems.length) {
    for (const p of problems) warn(describe(p) + "\n");
    throw new Fail(`${problems.length} problems; nothing installed. \`patchbook status\` lists them.`);
  }
  const linked = symlinked(book);
  if (linked.length) {
    for (const p of linked) warn(linkNote(p));
    throw new Fail(`the update skill was not installed at ${linked.join(", ")}`);
  }
  const blocked = folders(book);
  if (blocked.length) throw folderFail(blocked);
  const held = book.layout.kind === "fork"
    ? wanted(book).filter((p) => Array.from(a.out.keys()).some((k) => k.startsWith(`${p}/`))) : [];
  if (held.length) {
    throw new Fail(`the update skill was not installed, since the patchbook still holds a folder where it goes:\n  ${held.join("\n  ")}\n`
      + "Commit its removal so the hook records it, or run `patchbook record`, then run this again.");
  }
  const { kept, lost } = replacements(book);
  const hidden = lost.filter((p) => ignored(book, p));
  const uncommitted = lost.filter((p) => !hidden.includes(p));
  const refusals = [
    uncommitted.length && "these skill files differ from the shipped copy and are not in a commit, "
      + `and installing would replace them:\n  ${uncommitted.join("\n  ")}\n`
      + "Commit them first, then run this again. A file hidden with `--skip-worktree` or `--assume-unchanged` stays out of a commit"
      + " until `git update-index --no-skip-worktree` or `--no-assume-unchanged` undoes it, or you move the file."
      + (book.layout.kind === "fork" ? " In a fork the hook records the commit." : ""),
    hidden.length && "these skill files differ from the shipped copy and git ignores them, "
      + `so no commit can keep them, and installing would replace them:\n  ${hidden.join("\n  ")}\n`
      + "Move the file, or stop ignoring the path, then run this again.",
  ].filter(Boolean);
  if (refusals.length) throw new Fail(refusals.join("\n"));
  const fork = book.layout.kind === "fork";
  const unrecorded = fork ? unrecordedSkill(book) : [];
  const result = installSkill(book);
  if (result === null) {
    throw new Fail(setting("start.agents", book)[0].length ? "the update skill was not installed"
      : "start.agents is empty, so the update skill was not installed");
  }
  const { changed } = result;
  say(changed.map((p) => `wrote ${p}\n`).join(""));
  say(kept.map((p) => `replaced ${p}; your copy is in HEAD\n`).join(""));
  const record = fork && (changed.length > 0 || unrecorded.length > 0);
  const code = record ? await recordSkill(book) : 0;
  if (!changed.length && !record) say("the update skill is already current\n");
  return code;
}
