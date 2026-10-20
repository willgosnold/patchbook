// Writing a change's name and intent with a model, through the claude or codex CLI.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assembly } from "./assemble.ts";
import type { Book } from "./book.ts";
import { CHANGE_NAME, type Change, editText, notAChangeName, type Roster } from "./changes.ts";
import { unifiedDiff } from "./lib/diff.ts";
import { Fail } from "./lib/fail.ts";
import type { File } from "./lib/fs.ts";
import { spawn, which } from "./lib/proc.ts";
import { object, readJson, string } from "./lib/shape.ts";
import { decodeReplace, encode, isText, quote } from "./lib/text.ts";
import { configured, readToml, type Source, setting, SETTINGS, type Table, USER_CONFIG } from "./settings.ts";

export const NO_MODEL = "none";

export class ModelFailed extends Fail {
  constructor(readonly why: string, message: string) {
    super(message);
  }
}

type Provider = { model: string; effort: string; command(model: string, effort: string, tmp: string): string[] };

export const PROVIDERS = new Map<string, Provider>([
  // Not --bare or --setting-sources: a login or a Bedrock or Vertex setup can live in the user's settings.
  ["claude", {
    model: "claude-haiku-5-5",
    effort: "medium",
    command: (m, e) => ["claude", "-p", "--model", m, "--effort", e, "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"],
  }],
  ["codex", {
    model: "gpt-6-luna",
    effort: "high",
    command: (m, e, tmp) => ["codex", "exec", "-m", m, "-c", `model_reasoning_effort=${e}`, "--skip-git-repo-check", "-s", "read-only", "--ephemeral", "-C", tmp, "-"],
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

const DIFF_LIMIT = 40000;
const CUT = "\n[diff truncated]\n";

/** One changed path: its line in the path list, and its diff, empty for a binary file or an edit with no diff. */
export type Part = { line: string; diff: string };

/** The `+` and `-` lines of a diff's hunks, after the two header lines. */
const countLines = (diff: string): string => {
  const lines = diff.split("\n").slice(2);
  return `+${lines.filter((l) => l.startsWith("+")).length} -${lines.filter((l) => l.startsWith("-")).length} lines`;
};

const textPart = (path: string, what: string, diff: string): Part => ({ line: `${path}: ${what}, ${countLines(diff)}`, diff });

const binaryPart = (path: string, what: string): Part => ({ line: `${path}: binary, ${what}`, diff: "" });

/** The list of changed paths, then their diffs. Each diff gets an equal share of 40000 characters; a short one leaves what it doesn't use to the longer ones. */
export function listDiffs(parts: readonly Part[]): string {
  const chars = parts.map((p) => Array.from(p.diff));
  const kept: number[] = [];
  let left = DIFF_LIMIT;
  Array.from(chars.keys()).sort((a, b) => chars[a]!.length - chars[b]!.length).forEach((i, n, all) => {
    kept[i] = Math.min(chars[i]!.length, Math.floor(left / (all.length - n)));
    left -= kept[i]!;
  });
  const diffs = chars.map((c, i) => (c.length > kept[i]! ? c.slice(0, kept[i]).join("") + CUT : c.join("")));
  return `Changed paths:\n${parts.map((p) => p.line + "\n").join("")}\n${diffs.join("")}`;
}

/** The block entry at `path`, as a paragraph that changed from `upstream` to `patched`. */
export const entryPart = (path: string, upstream: string, patched: string): Part =>
  textPart(path, "paragraph changed", unifiedDiff(encode(upstream + "\n"), encode(patched + "\n"), `upstream/${path}`, `disk/${path}`));

/** The edits on disk to these output paths, then `more`, as one text for a model to read. */
export function pendingDiff(a: Assembly, current: ReadonlyMap<string, File>, paths: readonly string[], more: readonly Part[] = []): string {
  const files = paths.map((p): Part => {
    const now = current.get(p);
    const built = a.out.get(p);
    const old = built?.data ?? new Uint8Array();
    const fresh = now?.data ?? new Uint8Array();
    const what = !built ? "added" : !now ? "deleted" : "changed";
    if (!(isText(old) && isText(fresh))) return binaryPart(p, what);
    return textPart(p, what, unifiedDiff(old, fresh, built ? `built/${p}` : "/dev/null", now ? `disk/${p}` : "/dev/null"));
  });
  return listDiffs([...files, ...more]);
}

export function changeDiff(c: Change): string {
  const part = (before: Uint8Array | null, after: Uint8Array | null, path: string, what: string): Part => {
    const old = before ?? new Uint8Array();
    const fresh = after ?? new Uint8Array();
    if (!(isText(old) && isText(fresh))) return binaryPart(path, what);
    return textPart(path, what, unifiedDiff(old, fresh, before ? `upstream/${path}` : "/dev/null", `ours/${path}`));
  };
  return listDiffs(c.edits.map((e): Part => {
    if (e.kind === "file") return part(c.read("base", e.path), c.read("ours", e.path), e.path, "changed");
    if (e.kind === "add") return part(null, c.read("ours", e.path), e.path, "added");
    if (e.kind === "replace") return part(null, c.read("ours", e.path), e.path, "replaced");
    return { line: editText(e), diff: "" };
  }));
}

/** The provider, model and effort for writing intents.
 *
 * A model or effort set alongside a different provider is for that provider, so it's skipped. */
export function intentSettings(book: Book | null, quiet = false, sources?: Map<string, Source>): [string, string, string] {
  let [provider, source] = setting("intent.provider", book);
  sources?.set("intent.provider", source);
  if (!provider) {
    const found = Array.from(PROVIDERS.keys()).filter((p) => which(p));
    if (!found.length && !quiet) {
      throw new ModelFailed("no claude or codex CLI found", "writing an intent needs the claude or codex CLI. Install one, or pass --intent.");
    }
    provider = found[0] ?? "claude";
  }
  if (provider === NO_MODEL) return [NO_MODEL, "", ""];
  const spec = PROVIDERS.get(provider);
  if (!spec) throw new Fail(`intent.provider is one of ${[...PROVIDERS.keys(), NO_MODEL].join(", ")}, not ${quote(provider)}`);
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

function askModel(provider: string, spec: Provider, model: string, effort: string, seconds: number, prompt: string): string {
  if (!which(provider)) throw new ModelFailed(`the ${provider} CLI isn't installed`, `the ${provider} CLI isn't installed. Install it, or pass --intent.`);
  const tmp = mkdtempSync(join(tmpdir(), "tmp"));
  let result;
  try {
    result = spawn(spec.command(model, effort, tmp), { cwd: tmp, input: encode(prompt), timeout: Math.ceil(seconds * 1000) });
  } catch (e) {
    const reason = `the ${provider} CLI can't start: ${String(e instanceof Error ? e.message : e).split("\n")[0]}`;
    throw new ModelFailed(reason, `${reason}. Pass --intent instead.`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (result.timedOut) throw new ModelFailed(`${provider} took longer than ${seconds}s`, `${provider} took longer than ${seconds}s (intent.timeout). Pass --intent instead.`);
  if (result.code !== 0) {
    const said = Array.from(decodeReplace(result.stderr).trim()).slice(-500).join("");
    throw new ModelFailed(`${provider} failed: ${said.split("\n")[0] || `exit code ${result.code}`}`, `${provider} failed: ${said}. Pass --intent instead.`);
  }
  return decodeReplace(result.stdout);
}

const NAME_LENGTH = 40;

const REPLY = object({ change: string, intent: string });

/** An intent on one line, with each run of whitespace a single space. */
export const oneLine = (text: string): string => text.trim().replace(/\s+/g, " ");

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

const FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n[ \t]*```$/;

/** The JSON a reply holds: the whole reply, or the inside of the one code fence it is. */
function replyText(reply: string): string {
  const text = reply.trim();
  return FENCE.exec(text)?.[1] ?? text;
}

/** Ask the chosen model for the change's name and intent. Returns the name and the intent; the name means nothing when `named` is false. */
export function writeIntent(
  book: Book, changes: ReadonlyMap<string, Change>, diff: string, name: string | null, named: boolean, filling = false,
): [string, string] {
  const [provider, model, effort] = intentSettings(book);
  if (provider === NO_MODEL) throw new ModelFailed("intent.provider is none", "intent.provider is none, so no model writes intents. Pass --intent.");
  const listed = Array.from(changes.values(), (c) => `${c.name}: ${c.intent || "(no intent yet)"}`).join("\n") || "(none yet)";
  let instruction: string;
  if (!named) {
    name = "paragraphs";
    instruction = "These edits rewrite paragraphs in place; each changed paragraph keeps this intent. "
      + "Write the intent, and reply with the name paragraphs.";
  } else if (filling) instruction = `The change is called ${name} and has no intent yet. Write its intent, and reply with that name.`;
  else if (name) instruction = `The change is new and called ${name}. Write its intent, and reply with that name.`;
  else {
    instruction = "If these edits serve the purpose of one existing change, reply with that change's name and "
      + "its intent unchanged. Otherwise give a new short kebab-case name and write its intent.";
  }
  const [seconds] = setting("intent.timeout", book);
  const reply = askModel(provider, PROVIDERS.get(provider)!, model, effort, seconds, intentPrompt(listed, instruction, diff));
  const unusable = (why: string) => new ModelFailed(
    `${provider} didn't return a usable name and intent`,
    `${provider} didn't return a usable name and intent. ${why}\n${Array.from(reply.trim()).slice(0, 500).join("")}\nPass a name and --intent instead.`,
  );
  let answer;
  try {
    answer = readJson(replyText(reply), REPLY, `${provider}'s reply`);
  } catch (e) {
    throw e instanceof Fail ? unusable(e.message) : e;
  }
  let chosen = answer.change;
  let intent = oneLine(answer.intent);
  if (!CHANGE_NAME.test(chosen)) throw unusable(`${provider}'s reply: ${notAChangeName(chosen)}.`);
  if (!intent) throw unusable(`${provider}'s reply: intent is blank.`);
  if (name && chosen !== name) chosen = name;
  const known = changes.get(chosen);
  if (known?.intent && named && !filling) intent = known.intent;
  return [chosen, intent];
}
