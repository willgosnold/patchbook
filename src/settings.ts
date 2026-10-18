// Settings: each one's env var, kind and default, read from the env, the project and the user config.
import { homedir } from "node:os";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { TomlDocument } from "@decimalturn/toml-patch";
import { Book, NoBook } from "./book.ts";
import { installHookOrWarn } from "./githook.ts";
import { intentSettings, PROVIDERS } from "./intent.ts";
import { Fail } from "./lib/fail.ts";
import { exists, mkdirs, pjoin, readBytes, readText, writeText } from "./lib/fs.ts";
import { ljust, S, strRepr } from "./lib/py.ts";
import { decode } from "./lib/text.ts";
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
  parse: (_, raw) => raw.split(new RegExp(`[,${S}]+`, "u")).filter((v) => v),
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

function patched(text: string, name: Name, value: unknown, refuse: (cause: string) => Fail): string {
  try {
    const doc = new TomlDocument(text);
    doc.patch(withSetting(doc.toJsObject, name, value), { trailingNewline: 1, bracketSpacing: false });
    return doc.toTomlString;
  } catch (e) {
    throw refuse(`the TOML library failed on it (${e instanceof Error ? `${e.name}: ${e.message}` : String(e)})`);
  }
}

const MARKER = 7243981605;

/**
 * The library drops the comments above a key it deletes, and leaves the comments inside a multi-line
 * value as orphan lines when it rewrites one. So a plain `key = value` is cut out of the text. A
 * marker number set in its place shows which line the key is on, and the value ends at the first line
 * where the lines from the key parse.
 */
function withoutSetting(text: string, name: Name, refuse: (cause: string) => Fail): string {
  const lines = text.split("\n");
  const marked = patched(text, name, MARKER, refuse).split("\n");
  const at = marked.findIndex((line, i) => line !== lines[i]);
  if (at !== -1 && new RegExp(`^\\s*[^=#\\s][^=]*=\\s*${MARKER}\\s*(#.*)?$`).test(marked[at]!)) {
    for (let end = at; end < lines.length; end++) {
      if (parses(lines.slice(at, end + 1))) return [...lines.slice(0, at), ...lines.slice(end + 1)].join("\n");
    }
  }
  return patched(text, name, null, refuse);
}

function parses(lines: string[]): boolean {
  try {
    Bun.TOML.parse(lines.join("\n"));
    return true;
  } catch {
    return false;
  }
}

/** `out` with each line the ending it had in `raw`. Lines the edit changed take the ending of the file's first line. */
function withEndingsOf(raw: string, out: string): string {
  if (!raw.includes("\r\n")) return out;
  const lines = (text: string) => text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const ends = raw.split("\n").map((line) => (line.endsWith("\r") ? "\r\n" : "\n"));
  ends[ends.length - 1] = ends[0]!;
  const was = lines(raw);
  const now = lines(out);
  let head = 0;
  while (head < Math.min(was.length, now.length) && was[head] === now[head]) head++;
  let tail = 0;
  while (tail < Math.min(was.length, now.length) - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
  return now
    .map((line, i) => {
      if (i === now.length - 1) return line;
      const from = i < head ? i : i >= now.length - tail ? was.length - (now.length - i) : -1;
      return line + (from === -1 ? ends[0]! : ends[from]!);
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
  } else {
    const root = Book.root();
    try {
      if (root !== null) installHookOrWarn(root);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      process.stderr.write(`patchbook: couldn't install the pre-commit hook: ${e.message}\n`);
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
    process.stdout.write(`${ljust(n, 20)} ${ljust(shown, 28)} ${source}` + (env && name === null ? `  [${env}]` : "") + "\n");
  }
  return 0;
}
