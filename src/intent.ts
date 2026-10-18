// Writing a change's name and intent with a model, through the claude or codex CLI.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assembly } from "./assemble.ts";
import type { Book } from "./book.ts";
import { CHANGE_NAME, type Change, type Roster } from "./changes.ts";
import { unifiedDiff } from "./lib/difflib.ts";
import { Fail } from "./lib/fail.ts";
import type { File } from "./lib/fs.ts";
import { JsonError, loads } from "./lib/json.ts";
import { spawn, which } from "./lib/proc.ts";
import { length, type PyValue, slice, split, splitlines, strip, strRepr } from "./lib/py.ts";
import { decode, decodeReplace, encode, isText } from "./lib/text.ts";
import { configured, readToml, type Source, setting, SETTINGS, type Table, USER_CONFIG } from "./settings.ts";

type Provider = { model: string; effort: string; command(model: string, effort: string, tmp: string): string[] };

export const PROVIDERS = new Map<string, Provider>([
  ["claude", { model: "claude-haiku-5-5", effort: "medium", command: (m, e) => ["claude", "-p", "--model", m, "--effort", e] }],
  ["codex", {
    model: "gpt-6-luna",
    effort: "high",
    command: (m, e, tmp) => ["codex", "exec", "-m", m, "-c", `model_reasoning_effort=${e}`, "--skip-git-repo-check", "-s", "read-only", "-C", tmp, "-"],
  }],
]);

const intentPrompt = (changes: string, instruction: string, diff: string) =>
  `You name and describe a change someone made to their copy of an upstream repo.
The change is kept as a patch over upstream. When upstream changes, an agent redoes the change from
its intent alone, so the intent must say what the change does and why, in one or two plain
sentences, without line numbers or code. Don't describe upstream.

Existing changes, one per line as \`name: intent\`:
${changes}

${instruction}

Reply with only a JSON object: {"change": "<name>", "intent": "<intent>"}

The edits, as diffs from what the patchbook builds to what is on disk now:
${diff}
`;

/** The edits on disk to these output paths, as one text for a model to read. */
export function pendingDiff(a: Assembly, current: ReadonlyMap<string, File>, paths: readonly string[]): string {
  const parts: string[] = [];
  for (const p of paths) {
    const now = current.get(p);
    const built = a.out.get(p);
    const old = built?.data ?? new Uint8Array();
    const fresh = now?.data ?? new Uint8Array();
    if (!(isText(old) && isText(fresh))) {
      parts.push(`binary file ${p} ${!built ? "added" : !now ? "deleted" : "changed"}\n`);
      continue;
    }
    parts.push(unifiedDiff(splitlines(decode(old), true), splitlines(decode(fresh), true), built ? `built/${p}` : "/dev/null",
      now ? `disk/${p}` : "/dev/null"));
  }
  const text = parts.join("");
  return slice(text, 0, 40000) + (length(text) > 40000 ? "\n[diff truncated]\n" : "");
}

/** The provider, model and effort for writing intents.
 *
 * A model or effort set alongside a different provider is for that provider, so it's skipped. */
export function intentSettings(book: Book | null, quiet = false, sources?: Map<string, Source>): [string, string, string] {
  let [provider, source] = setting("intent.provider", book);
  sources?.set("intent.provider", source);
  if (!provider) {
    const found = Array.from(PROVIDERS.keys()).filter((p) => which(p));
    if (!found.length && !quiet) throw new Fail("writing an intent needs the claude or codex CLI. Install one, or pass --intent.");
    provider = found[0] ?? "claude";
  }
  const spec = PROVIDERS.get(provider);
  if (!spec) throw new Fail(`intent.provider is one of ${Array.from(PROVIDERS.keys()).join(", ")}, not ${strRepr(provider)}`);
  const layers: [Source, Table | null, string][] = [
    ["env", null, ""],
    ...(book ? [["project", book.config, join(book.dir, "config.toml")] as [Source, Table, string]] : []),
    ["user", readToml(USER_CONFIG), USER_CONFIG],
  ];
  const chosen = { model: spec.model, effort: spec.effort };
  for (const key of ["model", "effort"] as const) {
    const name = `intent.${key}` as const;
    for (const [layer, config, path] of layers) {
      let value: string | null | undefined;
      if (config === null) value = process.env[SETTINGS[name].env ?? ""];
      else {
        value = configured(name, config, path);
        const other = configured("intent.provider", config, path);
        if (value && other != null && other !== provider) value = null;
      }
      if (value) {
        chosen[key] = value;
        sources?.set(name, layer);
        break;
      }
    }
  }
  return [provider, chosen.model, chosen.effort];
}

function askModel(provider: string, spec: Provider, model: string, effort: string, prompt: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "tmp"));
  let result;
  try {
    result = spawn(spec.command(model, effort, tmp), { cwd: tmp, input: encode(prompt) });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (result.code !== 0) throw new Fail(`${provider} failed: ${slice(strip(decodeReplace(result.stderr)), -500)}. Pass --intent instead.`);
  return decodeReplace(result.stdout);
}

const NAME_LENGTH = 40;

/** An intent on one line, with each run of whitespace a single space. */
export const oneLine = (text: string): string => split(text).join(" ");

/** A kebab-case change name from at most the first four words of an intent, kept within `NAME_LENGTH`, that nothing in `changes/` already uses. */
export function nameFromIntent(intent: string, roster: Roster): string {
  let base = "";
  for (const word of intent.toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 4) ?? []) {
    const next = base ? `${base}-${word}` : word;
    if (next.length > NAME_LENGTH) break;
    base = next;
  }
  return roster.free(base || "change");
}

/** Ask the chosen model for the change's name and intent. Returns the name and the intent; the name means nothing when `named` is false. */
export function writeIntent(
  book: Book, changes: ReadonlyMap<string, Change>, diff: string, name: string | null, named: boolean,
): [string, string] {
  const [provider, model, effort] = intentSettings(book);
  const listed = Array.from(changes.values(), (c) => `${c.name}: ${c.intent}`).join("\n") || "(none yet)";
  let instruction: string;
  if (!named) {
    name = "paragraphs";
    instruction = "These edits rewrite paragraphs in place; each changed paragraph keeps this intent. "
      + "Write the intent, and reply with the name paragraphs.";
  } else if (name) instruction = `The change is new and called ${name}. Write its intent, and reply with that name.`;
  else {
    instruction = "If these edits serve the purpose of one existing change, reply with that change's name and "
      + "its intent unchanged. Otherwise give a new short kebab-case name and write its intent.";
  }
  const reply = askModel(provider, PROVIDERS.get(provider)!, model, effort, intentPrompt(listed, instruction, diff));
  const m = /\{.*\}/s.exec(reply);
  let answer: PyValue = new Map();
  try {
    if (m) answer = loads(m[0]);
  } catch (e) {
    if (!(e instanceof JsonError)) throw e;
  }
  const fields = answer instanceof Map ? answer : new Map<string, PyValue>();
  const given = fields.get("change") ?? "";
  let chosen = typeof given === "string" ? given : "";
  const said = fields.get("intent");
  let intent = typeof said === "string" ? oneLine(said) : "";
  if (!CHANGE_NAME.test(chosen) || !intent) {
    throw new Fail(`${provider} didn't return a usable name and intent:\n${slice(strip(reply), 0, 500)}\nPass a name and --intent instead.`);
  }
  if (name && chosen !== name) chosen = name;
  const known = changes.get(chosen);
  if (known && named) intent = known.intent;
  return [chosen, intent];
}
