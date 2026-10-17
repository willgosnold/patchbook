// The patchbook-update skill, installed for the repo's agents when a patchbook starts.
import { Book } from "./book.ts";
import { spawn, which } from "./lib/proc.ts";
import { quote } from "./lib/py.ts";
import { setting } from "./settings.ts";

const SKILL = ["npx", "-y", "skills", "add", "willgosnold/patchbook", "--skill", "patchbook-update", "-y"];
export const SCHEDULE = 'To keep up with upstream, add a daily T3 scheduled task in this project: "Use the patchbook-update skill."';

/** Install the update skill for agents in the repo. Returns whether it did. */
export function installSkill(book: Book): boolean {
  if (!setting("start.install_skill", book)[0]) return false;
  const cmd = [...SKILL, ...setting("start.agents", book)[0].flatMap((agent) => ["-a", agent])];
  if (!which("npx") || spawn(cmd, { cwd: book.root }).code !== 0) {
    process.stderr.write(`patchbook: couldn't install the update skill. Run it yourself: ${cmd.map(quote).join(" ")}\n`);
    return false;
  }
  return true;
}
