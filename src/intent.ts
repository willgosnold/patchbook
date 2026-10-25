// Writing a change's name and intent with a model, through the claude or codex CLI.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assembly } from "./assemble.ts";
import type { Book } from "./book.ts";
import { CHANGE_NAME, type Change, type Edit, editText, notAChangeName, pathText, type Roster } from "./changes.ts";
import { unifiedDiff } from "./lib/diff.ts";
import { Fail } from "./lib/fail.ts";
import type { File } from "./lib/fs.ts";
import { spawn, which } from "./lib/proc.ts";
import { nullable, readJson, type Shape, string, table } from "./lib/shape.ts";
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

const intentPrompt = (changes: string, reply: string, subjects: string) =>
  `You name and describe changes someone made to their copy of an upstream repo.
Each change is kept as a patch over upstream. When upstream changes, an agent redoes a change from
its intent alone, so an intent must say what the change does and why, in one or two plain
sentences, without line numbers or code. Don't describe upstream.

Existing changes, one per line as \`name: intent\`:
${changes}

Reply with only a JSON object: ${reply}

${subjects}`;

/** The reply the prompt asks for. The new edits' intent is `intent`, never an entry of `intents`: asked to key it by a name it had just
 * invented, the model often keyed it by a changed path. `intents` is only for the names the prompt quotes. */
const replyShape = (picking: boolean, fresh: boolean, refreshing: boolean): string => {
  const fields = [...(picking ? ['"change": "<name>"'] : []), ...(fresh ? ['"intent": "<intent>"'] : []), ...(refreshing ? ['"intents": {"<name>": "<intent>", ...}'] : [])];
  return `{${fields.join(", ")}}.` + (refreshing ? ' "intents" has an intent for each name in quotes below, under that name.' : "");
};

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

/** Each group's list of changed paths, then its diffs. Each diff of every group gets an equal share of 40000 characters; a short one
 * leaves what it doesn't use to the longer ones. */
export function listDiffs(groups: readonly (readonly Part[])[]): string[] {
  const chars = groups.flat().map((p) => Array.from(p.diff));
  const kept: number[] = [];
  let left = DIFF_LIMIT;
  Array.from(chars.keys()).sort((a, b) => chars[a]!.length - chars[b]!.length).forEach((i, n, all) => {
    kept[i] = Math.min(chars[i]!.length, Math.floor(left / (all.length - n)));
    left -= kept[i]!;
  });
  const diffs = chars.map((c, i) => (c.length > kept[i]! ? c.slice(0, kept[i]).join("") + CUT : c.join("")));
  let at = 0;
  return groups.map((parts) => `Changed paths:\n${parts.map((p) => p.line + "\n").join("")}\n${diffs.slice(at, (at += parts.length)).join("")}`);
}

/** The block entry at `path`, as a paragraph that changed from `upstream` to `patched`. */
export const entryPart = (path: string, upstream: string, patched: string): Part =>
  textPart(path, "paragraph changed", unifiedDiff(encode(upstream + "\n"), encode(patched + "\n"), `upstream/${path}`, `disk/${path}`));

/** The edits on disk to these output paths. */
export function pendingParts(a: Assembly, current: ReadonlyMap<string, File>, paths: readonly string[]): Part[] {
  return paths.map((p): Part => {
    const now = current.get(p);
    const built = a.out.get(p);
    const old = built?.data ?? new Uint8Array();
    const fresh = now?.data ?? new Uint8Array();
    const what = !built ? "added" : !now ? "deleted" : "changed";
    if (!(isText(old) && isText(fresh))) return binaryPart(p, what);
    return textPart(p, what, unifiedDiff(old, fresh, built ? `built/${p}` : "/dev/null", now ? `disk/${p}` : "/dev/null"));
  });
}

/** The change's edits, with `overlay` (copy path to bytes) in place of the ours copies a record is about to write, and without the
 * `dropped` edits it is about to take out. */
export function changeParts(c: Change, overlay: ReadonlyMap<string, Uint8Array> = new Map(), dropped: readonly { kind: string; path: string }[] = []): Part[] {
  const ours = (path: string) => overlay.get(path) ?? c.read("ours", path);
  const part = (before: Uint8Array | null, after: Uint8Array | null, path: string, what: string): Part => {
    const old = before ?? new Uint8Array();
    const fresh = after ?? new Uint8Array();
    if (!(isText(old) && isText(fresh))) return binaryPart(path, what);
    return textPart(path, what, unifiedDiff(old, fresh, before ? `upstream/${path}` : "/dev/null", `ours/${path}`));
  };
  return c.edits.filter((e) => !dropped.some((d) => d.kind === e.kind && d.path === e.path)).map((e): Part => {
    if (e.kind === "file") return part(c.read("base", e.path), ours(e.path), e.path, "changed");
    if (e.kind === "add") return part(null, ours(e.path), e.path, "added");
    if (e.kind === "replace") return part(null, ours(e.path), e.path, "replaced");
    return { line: editText(e), diff: "" };
  });
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

const strings: Shape<Map<string, string>> = (v, at) => new Map(Object.entries(table(v, at)).map(([k, x]) => [k, string(x, `${at}.${k}`)]));

/** A field the prompt may not ask for is undefined when the reply leaves it out. */
type Answer = { change: string | null | undefined; intent: string | null | undefined; intents: Map<string, string> };

const REPLY: Shape<Answer> = (v, at) => {
  const reply = table(v, at);
  const field = <T>(key: string, shape: Shape<T>): T | undefined => (Object.hasOwn(reply, key) ? shape(reply[key], at ? `${at}.${key}` : key) : undefined);
  return { change: field("change", nullable(string)), intent: field("intent", nullable(string)), intents: field("intents", strings) ?? new Map() };
};

/** An intent on one line, with each run of whitespace a single space. */
export const oneLine = (text: string): string => text.trim().replace(/\s+/g, " ");

/** Words joined in kebab case, as many as fit within `NAME_LENGTH`. */
function kebab(words: readonly string[]): string {
  let base = "";
  for (const word of words) {
    const next = base ? `${base}-${word}` : word;
    if (next.length > NAME_LENGTH) break;
    base = next;
  }
  return base;
}

const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** A kebab-case change name from at most the first four words of an intent, kept within `NAME_LENGTH`, that nothing in `changes/` already uses. */
export function nameFromIntent(intent: string, roster: Roster): string {
  return roster.free(kebab(words(intent).slice(0, 4)) || "change");
}

const VERBS = {
  file: { says: "Edits", names: "edit" }, add: { says: "Adds", names: "add" }, replace: { says: "Replaces", names: "replace" },
  delete: { says: "Deletes", names: "delete" }, move: { says: "Moves", names: "move" }, rename: { says: "Renames", names: "rename" },
  copy: { says: "Copies", names: "copy" },
} as const;

/** What an edit does: its verb, and what it does it to, with each path as an edit line writes it, so a path can't break the intent's
 * line. A move within one folder is a rename, and a move or copy to the same path under another folder, as out of an upstream's mount,
 * says only the folder it comes from. */
function action(e: Edit): [keyof typeof VERBS, string] {
  if (e.kind !== "move" && e.kind !== "copy") return [e.kind, pathText(e.path)];
  const folder = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), 0));
  const verb = e.kind === "move" && folder(e.path) === folder(e.dest) ? "rename" : e.kind;
  const what = e.path.endsWith("/" + e.dest) ? [e.dest, "from", e.path.slice(0, -e.dest.length - 1)] : [e.path, "to", e.dest];
  return [verb, `${pathText(what[0]!)} ${what[1]} ${pathText(what[2]!)}`];
}

const LISTED = 3;

/** The intent patchbook writes for edits when no model can: a sentence for each kind of edit, in the order they come, naming the
 * first `LISTED` paths of each. */
export function intentFromEdits(edits: readonly Edit[]): string {
  const said = new Map<keyof typeof VERBS, string[]>();
  for (const [verb, what] of edits.map(action)) said.set(verb, [...said.get(verb) ?? [], what]);
  return Array.from(said, ([verb, all]) => {
    const shown = all.length > LISTED ? [...all.slice(0, LISTED), `${all.length - LISTED} more`] : all;
    return `${VERBS[verb].says} ${shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0]}.`;
  }).join(" ");
}

/** A kebab-case change name from the first of the edits, kept within `NAME_LENGTH`. */
export function nameFromEdits(edits: readonly Edit[]): string {
  const [verb, what] = action(edits[0]!);
  return kebab([VERBS[verb].names, ...words(what)]);
}

const FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n[ \t]*```$/;

/** The JSON a reply holds: the whole reply, or the inside of the one code fence it is. */
function replyText(reply: string): string {
  const text = reply.trim();
  return FENCE.exec(text)?.[1] ?? text;
}

export const PARAGRAPHS = "paragraphs";

/** An existing change or block entry a record adds to: its intent now, "" when it has none, and its whole diff. */
export type Refresh = { key: string; was: string; parts: readonly Part[] };
/** A record's new edits and new block entries. With `named` and no `name`, the model files them into an existing change or names a new one. */
export type Fresh = { name: string | null; named: boolean; parts: readonly Part[] };
/** The picked change, when Fresh asked for a pick, and an intent for every key asked: each Refresh's, and Fresh's change name or PARAGRAPHS.
 * The model writes Fresh's in `intent` and each Refresh's in `intents`; this map is where record finds them all. */
export type Reply = { change: string | null; intents: ReadonlyMap<string, string> };

/** Ask the chosen model, in one call, for the intent of the fresh edits and of every refresh. */
export function writeIntents(book: Book, offered: ReadonlyMap<string, Change>, fresh: Fresh | null, refresh: readonly Refresh[]): Reply {
  const [provider, model, effort] = intentSettings(book);
  if (provider === NO_MODEL) throw new ModelFailed("intent.provider is none", "intent.provider is none, so no model writes intents. Pass --intent.");
  const listed = Array.from(offered.values(), (c) => `${c.name}: ${c.intent?.text ?? "(no intent yet)"}`).join("\n") || "(none yet)";
  const picking = fresh !== null && fresh.named && fresh.name === null;
  const said = [
    ...(fresh === null ? [] : [
      !fresh.named
        ? `For these edits: they rewrite paragraphs in place, and each changed paragraph keeps one intent. Put it in "intent".`
        : fresh.name
        ? `For these edits: they are a new change called ${fresh.name}. Write its intent in "intent".`
        : "For these edits: if they serve the purpose of one existing change, set change to its name and write its intent again, to cover what it "
          + `did and these edits. Otherwise set change to a new short kebab-case name and write its intent. Put its intent in "intent".`
          + (refresh.length ? ' If you pick a change named below, put its intent in "intent" and leave it out of "intents".' : ""),
    ]),
    ...refresh.map((r) => `For ${JSON.stringify(r.key)}: ${r.was ? "write its intent again" : "write its intent"}, to cover all of its edits below. `
      + `Its intent now: ${r.was || "(no intent yet)"}`),
  ];
  const diffs = listDiffs([...(fresh ? [fresh.parts] : []), ...refresh.map((r) => r.parts)]);
  const subjects = said.map((line, i) => `${line}\n${diffs[i]}`).join("\n");
  const [seconds] = setting("intent.timeout", book);
  const reply = askModel(provider, PROVIDERS.get(provider)!, model, effort, seconds, intentPrompt(listed, replyShape(picking, fresh !== null, refresh.length > 0), subjects));
  const unusable = (why: string) => new ModelFailed(
    `${provider} didn't return a usable name and intent: ${why.split("\n")[0]!.replace(/\.$/, "")}`,
    `${provider} didn't return a usable name and intent. ${why}\n${Array.from(reply.trim()).slice(0, 500).join("")}\nPass a name and --intent instead.`,
  );
  let answer;
  try {
    answer = readJson(replyText(reply), REPLY, `${provider}'s reply`);
  } catch (e) {
    throw e instanceof Fail ? unusable(e.message) : e;
  }
  const change = picking ? answer.change ?? null : null;
  if (picking && change === null) throw unusable(`${provider}'s reply: change is ${answer.change === undefined ? "missing" : "null"}.`);
  if (change !== null && !CHANGE_NAME.test(change)) throw unusable(`${provider}'s reply: ${notAChangeName(change)}.`);
  const intents = new Map<string, string>();
  const take = (key: string, intent: string | null | undefined, at: string) => {
    const text = oneLine(intent ?? "");
    if (!text) throw unusable(`${provider}'s reply: ${at} is ${intent === undefined ? "missing" : intent === null ? "null" : "blank"}.`);
    intents.set(key, text);
  };
  if (fresh) take(change ?? fresh.name ?? PARAGRAPHS, answer.intent, "intent");
  for (const r of refresh) if (r.key !== change) take(r.key, answer.intents.get(r.key), `intents.${r.key}`);
  return { change, intents };
}
