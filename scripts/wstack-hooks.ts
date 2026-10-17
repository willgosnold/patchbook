/** wstack's rules that a config pattern can't express. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Problem = { problem: "check"; file: string; detail: string };

const ROOT = join(import.meta.dirname, "..");
// Python's \w is Unicode-aware; JS's \w is ASCII even with the u flag.
const W = String.raw`\p{L}\p{N}_`;
// `/name` for an installed skill, but not a path such as `docs/how` or `/tmp/how`.
const slashSkill = (names: string) =>
  new RegExp(String.raw`(?<![${W}/.~-])/(${names})(?![${W}/.-])`, "gu");
const CODEX_SLASH_NOTE = "start with `$`";

// Not re.escape: under the u flag, `\-` outside a class is a SyntaxError.
const escape = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

export function placeholder(kind: string, name: string): string | null {
  if (kind !== "model") return null;
  const models: Record<string, string[]> = JSON.parse(readFileSync(join(ROOT, "models.json"), "utf8"));
  if (name.startsWith("_") || !Object.hasOwn(models, name)) return null;
  return models[name].map((e) => `\`${e}\``).join(", ");
}

const slash = new Map<string, RegExp>();

/** Users type `/name` in Claude Code and `$name` in Codex, so a block naming a skill as `/name` gives both. */
export function blockTerms(path: string, block: string, outputs: ReadonlySet<string>): string[] {
  if (!path.endsWith(".md")) return [];
  const key = [...outputs].sort().join("\0");
  let re = slash.get(key);
  if (!re) {
    const names = [...new Set([...outputs].filter((p) => p.endsWith("/SKILL.md")).map((p) => p.split("/")[0]))]
      .sort((a, b) => b.length - a.length);
    re = slashSkill(names.map(escape).join("|"));
    slash.set(key, re);
  }
  if (block.includes(CODEX_SLASH_NOTE)) return [];
  const found = new Set<string>();
  for (const m of block.matchAll(re)) if (!block.includes(`$${m[1]}`)) found.add(m[0]);
  return [...found].sort();
}

export function check(outputs: ReadonlyMap<string, Uint8Array>): Problem[] {
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  const problems: Problem[] = [];
  for (const [path, data] of outputs) {
    const parts = path.split("/");
    if (parts.length === 2 && parts[1] === "SKILL.md") {
      const m = /^name: (.*)$/m.exec(text(data));
      if (!m || m[1].trim() !== parts[0])
        problems.push({ problem: "check", file: path,
          detail: "a skill's name must be its folder name (the skills CLI and Codex's $name use it)" });
    }
    if (path.endsWith("/scripts/package.json")) {
      const ignore = outputs.get(path.slice(0, path.lastIndexOf("/")) + "/.gitignore");
      if (!ignore || !text(ignore).includes("node_modules/"))
        problems.push({ problem: "check", file: path,
          detail: "gitignore node_modules/ beside it; Bun installs packages in the user's project" });
    }
  }
  return problems;
}
