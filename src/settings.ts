// Settings: each one's env var, kind and default, read from the env, the project and the user config.
import { homedir } from "node:os";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { TomlDocument } from "@decimalturn/toml-patch";
import { Book, NoBook } from "./book.ts";
import { intentSettings, PROVIDERS } from "./intent.ts";
import { Fail } from "./lib/fail.ts";
import { exists, mkdirs, pjoin, readBytes, readText, writeText } from "./lib/fs.ts";
import { strRepr } from "./lib/repr.ts";
import { decode, padEndCodePoints } from "./lib/text.ts";
import { quoteToml } from "./lib/toml.ts";

/** A parsed TOML table. Values stay unknown until a setting or the book's config reads them. */
export type Table = { readonly [key: string]: unknown };

export function isTable(value: unknown): value is Table {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const LOSSY_INTEGER = "Integer cannot be losslessly represented";

export function parseToml(text: string, path: string): Table {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    if (e.message.includes(LOSSY_INTEGER)) throw new Fail(`${path} holds an integer outside +/-(2^53 - 1), which Bun can't represent`);
    throw new Fail(`${path} isn't valid TOML: ${e.message.replace(/^TOML Parse error: /, "")}`);
  }
  if (!isTable(parsed)) throw new Fail(`${path} isn't a TOML table`);
  return parsed;
}

export function readToml(path: string): Table {
  return exists(path) ? parseToml(readText(path), path) : {};
}

/** What a setting holds, how an env var spells it, and how `config` shows it. */
type Kind<T> = { parse(name: string, raw: string): T; accept(value: unknown): T | undefined; show(value: T): string };

const text: Kind<string> = {
  parse: (_, raw) => raw,
  accept: (v) => (typeof v === "string" ? v : undefined),
  show: quoteToml,
};

const flag: Kind<boolean> = {
  parse(name, raw) {
    const word = raw.toLowerCase();
    if (!["1", "0", "true", "false", "yes", "no", "on", "off"].includes(word)) {
      throw new Fail(`${name} is true or false, not ${strRepr(raw)}`);
    }
    return ["1", "true", "yes", "on"].includes(word);
  },
  accept: (v) => (typeof v === "boolean" ? v : undefined),
  show: (v) => (v ? "true" : "false"),
};

const list: Kind<string[]> = {
  parse: (_, raw) => raw.split(/[,\s]+/).filter((v) => v),
  accept: (v) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined),
  show: (v) => "[" + v.map(quoteToml).join(", ") + "]",
};

type Setting<T> = { env: string | null; kind: Kind<NonNullable<T>>; default: T; help: string; userOnly?: true };

type Values = {
  "intent.provider": string | null;
  "intent.model": string | null;
  "intent.effort": string | null;
  "hook.enabled": boolean;
  "start.install_skill": boolean;
  "start.agents": string[];
  "store.path": string | null;
};
export type Name = keyof Values;
export type Value<N extends Name> = Values[N];
export type Source = "env" | "project" | "user" | "default";

// The most specific source wins: the env var, then the project's .patchbook/config.toml, then the
// user's config, then the default.
export const SETTINGS: { readonly [N in Name]: Setting<Values[N]> } = {
  "intent.provider": { env: "PATCHBOOK_PROVIDER", kind: text, default: null, help: "claude or codex: the CLI that writes intents (default: claude if installed)" },
  "intent.model": { env: "PATCHBOOK_MODEL", kind: text, default: null, help: "the model that writes intents (default: the provider's)" },
  "intent.effort": { env: "PATCHBOOK_EFFORT", kind: text, default: null, help: "its reasoning effort (default: the provider's)" },
  "hook.enabled": { env: "PATCHBOOK_HOOK", kind: flag, default: true, help: "record and build on each commit" },
  "start.install_skill": { env: "PATCHBOOK_SKILL", kind: flag, default: true, help: "clone and init install the patchbook-update skill" },
  "start.agents": { env: null, kind: list, default: ["claude-code", "codex"], help: "the agents clone and init install the skill for" },
  "store.path": { env: "PATCHBOOK_HOME", kind: text, default: null, help: "where upstreams are kept (user config only)", userOnly: true },
};

export const NAMES = Object.keys(SETTINGS).filter(isName);

export function isName(name: string): name is Name {
  return Object.hasOwn(SETTINGS, name);
}

export const USER_CONFIG = pjoin(process.env["XDG_CONFIG_HOME"] ?? pjoin(homedir(), ".config"), "patchbook", "config.toml");

/** `config.get(section, {}).get(key)`. */
export function lookup(config: Table, name: string): unknown {
  const [section = "", key = ""] = name.split(".");
  const table = Object.hasOwn(config, section) ? config[section] : {};
  if (!isTable(table)) throw new Fail(`${section} in the config must be a table, as in [${section}]`);
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export function configured<N extends Name>(name: N, config: Table, path: string): Value<N> | undefined {
  const raw = lookup(config, name);
  if (raw === undefined) return undefined;
  const kind: Kind<NonNullable<Values[N]>> = SETTINGS[name].kind;
  const value = kind.accept(raw);
  if (value === undefined) throw new Fail(`${name} in ${path} can't be ${JSON.stringify(raw)}`);
  return value;
}

/** A setting's value and where it came from. `project` is the book's config, if there is a book. */
export function setting<N extends Name>(name: N, project?: { config: Table; dir: string } | null): [Value<N>, Source] {
  const spec: Setting<Values[N]> = SETTINGS[name];
  const env = spec.env === null ? undefined : process.env[spec.env];
  if (env !== undefined && env !== "") return [spec.kind.parse(name, env), "env"];
  if (project && !spec.userOnly) {
    const value = configured(name, project.config, pjoin(project.dir, "config.toml"));
    if (value !== undefined) return [value, "project"];
  }
  const user = configured(name, readToml(USER_CONFIG), USER_CONFIG);
  if (user !== undefined) return [user, "user"];
  return [spec.default, "default"];
}

export function show<N extends Name>(name: N, value: NonNullable<Value<N>>): string {
  const kind: Kind<NonNullable<Values[N]>> = SETTINGS[name].kind;
  return kind.show(value);
}

/** A setting's value as an env var or `patchbook config <name> <value>` spells it. */
export function parseValue<N extends Name>(name: N, raw: string): NonNullable<Value<N>> {
  const kind: Kind<NonNullable<Values[N]>> = SETTINGS[name].kind;
  return kind.parse(name, raw);
}

/** `~` and `~/...` as the home folder. */
export function expandUser(path: string): string {
  return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

export function storeDir(): string {
  const [path] = setting("store.path");
  const base = path ? expandUser(path) : pjoin(process.env["XDG_DATA_HOME"] ?? pjoin(homedir(), ".local", "share"), "patchbook");
  return pjoin(base, "upstreams");
}

export function setToml<N extends Name>(path: string, name: N, value: NonNullable<Value<N>> | null): void {
  const raw = exists(path) ? decode(readBytes(path)) : "";
  const text = exists(path) ? readText(path) : "";
  const config = parseToml(text, path);
  const current = lookup(config, name);
  if (current === undefined && value === null) return;
  const refuse = (cause: string) => new Fail(`can't change ${name} in ${path} safely: ${cause}. The file is left as it was. Edit it by hand.`);
  const out = edited(text, config, name, value, refuse);
  mkdirs(dirname(path));
  writeText(path, withEndingsOf(raw, out));
}

function edited(text: string, config: Table, name: Name, value: unknown, refuse: (cause: string) => Fail): string {
  const out = value === null ? withoutSetting(text, name, refuse) : patched(text, name, value, refuse);
  let read: unknown;
  try {
    read = Bun.TOML.parse(out);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    throw refuse(`the edit would write invalid TOML (${e.message.replace(/^TOML Parse error: /, "")})`);
  }
  const section = name.split(".")[0] ?? "";
  const unemptied = (table: Table) => (value === null ? withoutEmpty(table, section) : table);
  const difference = firstDifference(unemptied(withSetting(config, name, value)), unemptied(read as Table), "");
  if (difference !== null) throw refuse(`the edit would ${difference}`);
  return out;
}

// where the file ends once TOML's own blanks (space, tab, newline) are cut, which JS trimEnd() overshoots
function tomlEnd(text: string): number {
  let end = text.length;
  while (end > 0 && " \t\r\n".includes(text[end - 1] as string)) end--;
  return end;
}

function patched(text: string, name: Name, value: unknown, refuse: (cause: string) => Fail): string {
  try {
    const cut = text.slice(0, tomlEnd(text));
    const body = cut === "\uFEFF" ? "" : cut; // a file of only a byte order mark has no content
    const doc = new TomlDocument(body);
    doc.patch(withSetting(doc.toJsObject, name, value), { trailingNewline: 1, bracketSpacing: false });
    const out = doc.toTomlString;
    return body === "" ? (text.startsWith("\uFEFF") ? "\uFEFF" : "") + out : out.slice(0, tomlEnd(out)) + text.slice(body.length);
  } catch (e) {
    throw refuse(`the TOML library failed on it (${e instanceof Error ? `${e.name}: ${e.message}` : String(e)})`);
  }
}

type Node = {
  type?: unknown;
  loc?: { start?: { line?: unknown }; end?: { line?: unknown } };
  key?: { value?: unknown; item?: { value?: unknown } };
  items?: unknown;
};

/**
 * The first and last line (1-based) of the plain `key = value` that sets `name`, read from the
 * parser's own syntax tree, or null when the setting is not a line of its own: a member of an inline
 * table, or a table with dotted keys under it. `cst` is marked internal, so this reads only `type`,
 * `loc.*.line`, `key.value`, `key.item.value` and `items`; a test pins that shape.
 */
function linesOfSetting(text: string, name: Name): [number, number] | null {
  const parts = name.split(".");
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
  const found: [number, number][] = [];
  let nested = false;
  const visit = (node: Node, table: string[]) => {
    const path = [...table, ...strings(node.key?.value)];
    if (!parts.every((part, i) => path[i] === part)) return;
    const [start, end] = [node.loc?.start?.line, node.loc?.end?.line];
    if (path.length === parts.length && typeof start === "number" && typeof end === "number") found.push([start, end]);
    else nested = true;
  };
  for (const block of new TomlDocument(text).cst as unknown as Node[]) {
    if (block.type === "KeyValue") visit(block, []);
    if (block.type !== "Table" || !Array.isArray(block.items)) continue;
    for (const item of block.items as Node[]) if (item.type === "KeyValue") visit(item, strings(block.key?.item?.value));
  }
  return !nested && found.length === 1 ? found[0]! : null;
}

/**
 * The library drops the comments above a key it deletes, and leaves the comments inside a multi-line
 * value as orphan lines. So a setting on lines of its own is cut out of the text, from its first line
 * to the end of its value and the comment after it. Anything else goes to the library, and then every
 * comment line of the file must still be there.
 */
function withoutSetting(text: string, name: Name, refuse: (cause: string) => Fail): string {
  const span = linesOfSetting(text, name);
  const lines = text.split("\n");
  if (span !== null) {
    const bom = span[0] === 1 && text.startsWith("\uFEFF") ? "\uFEFF" : "";
    return bom + [...lines.slice(0, span[0] - 1), ...lines.slice(span[1])].join("\n");
  }
  const out = patched(text, name, null, refuse);
  const left = new Map<string, number>();
  for (const comment of commentsOf(out)) left.set(comment, (left.get(comment) ?? 0) + 1);
  for (const comment of commentsOf(text)) {
    const n = left.get(comment) ?? 0;
    if (n === 0) throw refuse(`the TOML library would drop the comment ${JSON.stringify(comment)}`);
    left.set(comment, n - 1);
  }
  return out;
}

/** Every comment the parser finds in `text`, as written. A `#` line inside a multi-line string is not one. */
function commentsOf(text: string): string[] {
  const comments: string[] = [];
  for (const block of new TomlDocument(text).cst as unknown as { type?: unknown; raw?: unknown; items?: unknown }[]) {
    for (const node of [block, ...(Array.isArray(block.items) ? (block.items as typeof block[]) : [])]) {
      if (node.type === "Comment" && typeof node.raw === "string") comments.push(node.raw.trim());
    }
  }
  return comments;
}

/** `out` with each line the ending it had in `raw`. Lines the edit changed take the ending of the file's first line. */
function withEndingsOf(raw: string, out: string): string {
  if (!/\r/.test(raw)) return out;
  const marks = raw.match(/\r\n|\r|\n/g) ?? [];
  const body = (lines: string[]) => (lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines);
  const bare = (line: string) => line.replace(/^\uFEFF/, "");
  const was = body(raw.split(/\r\n|\r|\n/)).map(bare);
  const outLines = out.split("\n");
  const now = body(outLines);
  const nowBare = now.map(bare);
  const mark = (i: number) => marks[i] ?? marks[0] ?? "\n";
  let head = 0;
  while (head < Math.min(was.length, nowBare.length) && was[head] === nowBare[head]) head++;
  let tail = 0;
  while (tail < Math.min(was.length, nowBare.length) - head && was[was.length - 1 - tail] === nowBare[nowBare.length - 1 - tail]) tail++;
  const finalNewline = outLines.length > now.length;
  return now
    .map((line, i) => {
      if (i === now.length - 1 && !finalNewline) return line;
      return line + (i < head ? mark(i) : i >= now.length - tail ? mark(was.length - (now.length - i)) : mark(0));
    })
    .join("");
}

function withoutEmpty(config: Table, section: string): Table {
  const { [section]: table, ...rest } = config;
  return isTable(table) && Object.keys(table).length === 0 ? rest : config;
}

function firstDifference(want: unknown, got: unknown, at: string): string | null {
  if (isTable(want) && isTable(got)) {
    for (const key of new Set([...Object.keys(want), ...Object.keys(got)])) {
      const found = firstDifference(
        Object.hasOwn(want, key) ? want[key] : undefined,
        Object.hasOwn(got, key) ? got[key] : undefined,
        at === "" ? key : `${at}.${key}`,
      );
      if (found !== null) return found;
    }
    return null;
  }
  if (isDeepStrictEqual(want, got)) return null;
  if (got === undefined) return `drop ${at}`;
  if (want === undefined) return `add ${at}`;
  return `turn ${at} into ${JSON.stringify(got)}, not ${JSON.stringify(want)}`;
}

function withSetting(config: Table, name: Name, value: unknown): Table {
  const [section = "", key = ""] = name.split(".");
  const { [key]: _, ...rest } = isTable(config[section]) ? config[section] : {};
  return { ...config, [section]: value === null ? rest : { ...rest, [key]: value } };
}

/** A setting as `config` lists it: its value, filled in for the intent settings, and where it came from. */
function listed<N extends Name>(name: N, book: Book | null): [string, Source] {
  const [value, source] = setting(name, book);
  if (name === "intent.provider" || name === "intent.model" || name === "intent.effort") { // what will actually be used
    const sources = new Map<string, Source>();
    const [provider, model, effort] = intentSettings(book, true, sources);
    const used = name === "intent.provider" ? provider : name === "intent.model" ? model : effort;
    return [quoteToml(used), sources.get(name) ?? "default"];
  }
  if (name === "store.path" && value === null) return [quoteToml(dirname(storeDir())), source];
  return [value === null ? "(not set)" : show(name, value), source];
}

export async function cmdConfig(args: { name: string | null; value: string | null; project: boolean; unset: boolean }) {
  let book: Book | null = null;
  let broken: Fail | null = null;
  if (args.project || !(args.unset || args.value !== null)) {
    try {
      book = await Book.find();
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      if (!(e instanceof NoBook)) broken = e;
    }
  }
  const name = args.name || null;
  if (name !== null && !isName(name)) throw new Fail(`no setting ${name}. Settings: ${NAMES.join(", ")}`);
  if (args.project && name !== null && SETTINGS[name].userOnly) throw new Fail(`${name} can only be set in the user config`);
  if (broken && (args.project || !(args.unset || args.value !== null))) throw broken;
  if (args.project && book === null) throw new Fail("--project needs a patchbook here or above");
  const path = args.project && book ? pjoin(book.dir, "config.toml") : USER_CONFIG;
  if ((args.unset || args.value !== null) && name === null) throw new Fail("name the setting to change");
  if (args.unset && name !== null) {
    setToml(path, name, null);
    return 0;
  }
  if (args.value !== null && name !== null) {
    const value = parseValue(name, args.value);
    if (name === "intent.provider" && typeof value === "string" && !PROVIDERS.has(value)) {
      throw new Fail(`intent.provider is one of ${Array.from(PROVIDERS.keys()).join(", ")}`);
    }
    const shown = show(name, value);
    setToml(path, name, value);
    process.stdout.write(`${name} = ${shown} in ${path}\n`);
    return 0;
  }
  if (name === null) {
    process.stdout.write(`user config: ${USER_CONFIG}` + (book ? `\nproject config: ${pjoin(book.dir, "config.toml")}` : "") + "\n");
  }
  for (const n of name !== null ? [name] : NAMES) {
    const [shown, source] = listed(n, book);
    const env = SETTINGS[n].env;
    process.stdout.write(`${padEndCodePoints(n, 20)} ${padEndCodePoints(shown, 28)} ${source}` + (env && name === null ? `  [${env}]` : "") + "\n");
  }
  return 0;
}
