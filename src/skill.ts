// The patchbook-update skill, embedded in the binary and written into the repo for its agents.
import { readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import skill from "../skills/patchbook-update/SKILL.md" with { type: "text" };
import { assemble, handEdits } from "./assemble.ts";
import { Book } from "./book.ts";
import { Fail } from "./lib/fail.ts";
import { exists, isDir, isSymlink, lexists, mkdirs, readText, writeText } from "./lib/fs.ts";
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

/** Point `at` to `target`, unless a real folder is already there. */
function link(root: string, at: string, target: string): boolean {
  const to = relative(dirname(at), target);
  if (isSymlink(at) && readlinkSync(at) === to) return false;
  if (isSymlink(at) || (lexists(at) && !isDir(at))) unlinkSync(at);
  else if (lexists(at)) {
    process.stderr.write(`patchbook: ${relative(root, at)} is a folder, so the skill there was left as it is\n`);
    return false;
  }
  mkdirs(dirname(at));
  symlinkSync(to, at);
  return true;
}

/** Install the update skill for agents in the repo. Returns the paths it changed, or null if it installed nothing. */
export function installSkill(book: Book): string[] | null {
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
  const file = join(dir, "SKILL.md");
  const changed: string[] = [];
  try {
    mkdirs(dir);
    if (!exists(file) || readText(file) !== skill) {
      writeText(file, skill);
      changed.push(file);
    }
    for (const { link: folder } of known) {
      const at = folder && join(book.root, folder, NAME);
      if (at && link(book.root, at, dir)) changed.push(at);
    }
  } catch (e) {
    // A file where a folder should go, or a read-only repo, shouldn't stop `clone` or `init` from finishing.
    if (!(e instanceof Error && "errno" in e)) throw e;
    process.stderr.write(`patchbook: couldn't install the update skill: ${e.message}\n`);
    return null;
  }
  return changed.map((p) => relative(book.root, p));
}

export function recordSkill(book: Book): Promise<number> {
  const known = exists(join(book.dir, "changes", CHANGE));
  return cmdRecord({
    change: CHANGE,
    intent: known ? null : "Install the patchbook-update skill, so an agent can pull upstream and carry these changes forward.",
  });
}

export async function cmdSkill(): Promise<number> {
  const book = await Book.find();
  const [on, from] = setting("start.install_skill", book);
  if (!on) {
    process.stdout.write(`start.install_skill is off (${from}), so the update skill was not installed\n`);
    return 0;
  }
  const fork = book.layout.kind === "fork";
  const edited = fork ? handEdits(book, assemble(book).out) : [];
  if (edited.length) {
    const shown = edited.slice(0, 20).join("\n  ") + (edited.length > 20 ? "\n  ..." : "");
    throw new Fail(`these output files changed since the last build, and recording the skill would take them too:\n  ${shown}\n`
      + "Commit them, so the hook records them, or run `patchbook record`, then run this again.");
  }
  const changed = installSkill(book);
  if (changed === null) throw new Fail("the update skill was not installed");
  if (!changed.length) {
    process.stdout.write("the update skill is already current\n");
    return 0;
  }
  process.stdout.write(changed.map((p) => `wrote ${p}\n`).join(""));
  return fork ? recordSkill(book) : 0;
}
