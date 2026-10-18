// Settings: each one's env var, kind and default, read from the env, the project and the user config.
import { homedir } from "node:os";
import { dirname } from "node:path";
import { Book, NoBook } from "./book.ts";
import { intentSettings, PROVIDERS } from "./intent.ts";
import { Fail } from "./lib/fail.ts";
import { exists, mkdirs, pjoin, readText, writeText } from "./lib/fs.ts";
import { ljust, lstrip, rstrip, S, strip, strRepr } from "./lib/py.ts";
import { quoteToml } from "./lib/toml.ts";

/** A parsed TOML table. Values stay unknown until a setting or the book's config reads them. */
export type Table = { readonly [key: string]: unknown };

export function isTable(value: unknown): value is Table {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function parseToml(text: string, path: string): Table {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
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

/** Set or remove (value null) one key in a TOML file, keeping its other lines and comments. */
export function setToml(path: string, name: string, value: string | null): void {
  const [section = "", key = ""] = name.split(".");
  let lines = exists(path) ? readText(path).split("\n") : [];
  const head = lines.findIndex((l) => strip(l) === `[${section}]`);
  const assign = `${key} = ${value}`;
  if (head === -1) {
    if (value !== null) lines = [...(lines.length && strip(lines.at(-1)!) ? [...lines, ""] : lines), `[${section}]`, assign];
  } else {
    let end = lines.findIndex((l, i) => i > head && lstrip(l).startsWith("["));
    if (end === -1) end = lines.length;
    const keyLine = new RegExp(`^[${S}]*${key.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")}[${S}]*=`, "u");
    const at = lines.findIndex((l, i) => i > head && i < end && keyLine.test(l));
    if (at !== -1) {
      if (value === null) lines.splice(at, 1);
      else lines[at] = assign;
    } else if (value !== null) lines.splice(head + 1, 0, assign);
  }
  mkdirs(dirname(path));
  writeText(path, rstrip(lines.join("\n"), "\n") + "\n");
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
  try {
    book = await Book.find();
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
    if (!(e instanceof NoBook)) broken = e;
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
    setToml(path, name, shown);
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
