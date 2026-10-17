// The patchbook-update skill, embedded in the binary and written into the repo for its agents.
import { symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import skill from "../skills/patchbook-update/SKILL.md" with { type: "text" };
import { Book } from "./book.ts";
import { isDir, isSymlink, lexists, mkdirs, writeText } from "./lib/fs.ts";
import { setting } from "./settings.ts";

const NAME = "patchbook-update";
export const SCHEDULE = 'To keep up with upstream, add a daily T3 scheduled task in this project: "Use the patchbook-update skill."';

/** Each agent reads the skill from .agents/skills, or from a folder that links there. */
const AGENTS: ReadonlyMap<string, { link: string | null }> = new Map([
  ["claude-code", { link: ".claude/skills" }],
  ["codex", { link: null }],
]);

/** Point `at` to `target`, unless a real folder is already there. */
function link(root: string, at: string, target: string): void {
  if (isSymlink(at) || (lexists(at) && !isDir(at))) unlinkSync(at);
  else if (lexists(at)) {
    process.stderr.write(`patchbook: ${relative(root, at)} is a folder, so the skill there was left as it is\n`);
    return;
  }
  mkdirs(dirname(at));
  symlinkSync(relative(dirname(at), target), at);
}

/** Install the update skill for agents in the repo. Returns whether it did. */
export function installSkill(book: Book): boolean {
  if (!setting("start.install_skill", book)[0]) return false;
  const agents = setting("start.agents", book)[0];
  const unknown = agents.filter((a) => !AGENTS.has(a));
  if (unknown.length) {
    process.stderr.write(`patchbook: can't install the skill for ${unknown.join(", ")}. `
      + `start.agents can name ${Array.from(AGENTS.keys()).join(", ")}.\n`);
  }
  const known = agents.flatMap((a) => AGENTS.get(a) ?? []);
  if (!known.length) return false;
  const dir = join(book.root, ".agents", "skills", NAME);
  mkdirs(dir);
  writeText(join(dir, "SKILL.md"), skill);
  for (const { link: folder } of known) if (folder) link(book.root, join(book.root, folder, NAME), dir);
  return true;
}
