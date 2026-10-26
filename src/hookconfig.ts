import { readJson, string as stringShape } from "./lib/shape.ts";

export type Entry = { event: string; run: string };

export type Placed = { location: string; text: string; merged: string };
export type Unplaced = { why: string };
export const PRESENT = "present";
export type Placement = Placed | Unplaced | typeof PRESENT;
export type Format = (config: string, entry: Entry, where: string) => Placement;

const COMMAND = "patchbook";

export const indent = (text: string, pad: number | string) => text.replace(/^(?=.)/gm, typeof pad === "number" ? " ".repeat(pad) : pad);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const lines = (text: string) => text.replace(/\r\n/g, "\n").split("\n");
const endsLine = (text: string) => (text === "" ? "" : text.replace(/\n?$/, "\n"));

type Spot = "file" | "hook" | "commands" | "jobs";

function spot(doc: unknown, event: string): Spot | undefined {
  if (doc === null || doc === undefined) return "file";
  if (!isRecord(doc)) return undefined;
  const hook = doc[event];
  if (hook === undefined) return "file";
  if (hook === null) return "hook";
  if (!isRecord(hook)) return undefined;
  if (hook["jobs"] !== undefined) return Array.isArray(hook["jobs"]) ? "jobs" : undefined;
  const commands = hook["commands"];
  return commands === undefined ? "hook" : commands === null || isRecord(commands) ? "commands" : undefined;
}

function hasPatchbook(doc: unknown, event: string): boolean {
  const hook = isRecord(doc) ? doc[event] : undefined;
  if (!isRecord(hook)) return false;
  const jobs = Array.isArray(hook["jobs"]) ? hook["jobs"] : [];
  return (isRecord(hook["commands"]) && COMMAND in hook["commands"]) || jobs.some((j) => isRecord(j) && j["name"] === COMMAND);
}

/** lefthook runs the commands that have a priority from the lowest up, then the rest, and equal priorities in no set order. A priority below every other, and not 0, runs first. */
function priority(doc: unknown, event: string): number {
  const hook = isRecord(doc) ? doc[event] : undefined;
  const commands = isRecord(hook) && isRecord(hook["commands"]) ? hook["commands"] : {};
  const taken = Object.values(commands).flatMap((c) => (isRecord(c) && typeof c["priority"] === "number" ? [c["priority"]] : []));
  const lowest = Math.min(...taken);
  return lowest > 1 ? 1 : Math.min(lowest, 0) - 1;
}

/** Whether `merged` parses and has patchbook's hook where `first` says. */
function checked(merged: string, parse: (text: string) => unknown, first: (doc: unknown) => boolean): boolean {
  try {
    return first(parse(merged));
  } catch {
    return false;
  }
}

const lefthookFirst = (event: string, at: Spot) => (doc: unknown): boolean => {
  const hook = isRecord(doc) ? doc[event] : undefined;
  if (!hasPatchbook(doc, event)) return false;
  return at !== "jobs" || (isRecord(hook) && Array.isArray(hook["jobs"]) && isRecord(hook["jobs"][0]) && hook["jobs"][0]["name"] === COMMAND);
};

const shape = (event: string) => `its ${event} isn't a map of commands or a list of jobs`;

const indentOf = (l: string) => l.length - l.trimStart().length;
const skippable = (l: string) => /^\s*(#.*)?$/.test(l);
const escaped = (key: string) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bare = (l: string, key: string) => new RegExp(`^\\s*["']?${escaped(key)}["']?\\s*:\\s*(#.*)?$`).test(l);
const keyRe = (key: string) => new RegExp(`^( *)["']?${escaped(key)}["']?\\s*:`);

function keyAt(ls: string[], from: number, to: number, key: string, at: number): number {
  const re = keyRe(key);
  for (let i = from; i < to; i++) {
    const m = re.exec(ls[i]!);
    if (m && m[1]!.length === at) return i;
  }
  return -1;
}

function underKey(ls: string[], parent: number): { indent: number | null; end: number } {
  const base = indentOf(ls[parent]!);
  let found: number | null = null;
  let end = parent + 1;
  for (let i = parent + 1; i < ls.length; i++) {
    if (skippable(ls[i]!)) continue;
    if (indentOf(ls[i]!) <= base) break;
    found ??= indentOf(ls[i]!);
    end = i + 1;
  }
  return { indent: found, end };
}

function yamlUnit(ls: string[]): number {
  const found = ls.filter((l) => !skippable(l)).map(indentOf).filter((n) => n > 0);
  return found.length ? Math.min(...found) : 2;
}

const after = (ls: string[], at: number, text: string) => [...ls.slice(0, at + 1), ...text.replace(/\n$/, "").split("\n"), ...ls.slice(at + 1)].join("\n");

function lefthookYaml(config: string, entry: Entry, where: string): Placement {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(config);
  } catch {
    return { why: `it isn't valid YAML` };
  }
  const at = spot(doc, entry.event);
  if (at === undefined) return { why: shape(entry.event) };
  if (hasPatchbook(doc, entry.event)) return PRESENT;
  const ls = lines(config);
  const u = yamlUnit(ls);
  const p = priority(doc, entry.event);
  const command = (n: number) => indent(`${COMMAND}:\n${indent(`priority: ${p}\nrun: |\n${indent(entry.run, u)}`, u)}`, n);
  const place = (line: number, location: string, text: string): Placement => {
    const merged = after(ls, line, text);
    return checked(merged, Bun.YAML.parse, lefthookFirst(entry.event, at)) ? { location, text, merged } : { why: `its ${entry.event} is laid out in a way patchbook can't add to` };
  };
  if (at === "file") {
    const text = `${entry.event}:\n${indent(`commands:\n${command(u)}`, u)}`;
    const merged = endsLine(config) + text;
    return { location: `at the end of ${where}`, text, merged };
  }
  const hookAt = keyAt(ls, 0, ls.length, entry.event, 0);
  if (hookAt < 0 || !bare(ls[hookAt]!, entry.event)) return { why: `its ${entry.event} key is written inline` };
  const inHook = underKey(ls, hookAt);
  const ci = inHook.indent ?? u;
  const hookLine = `\`${entry.event}:\``;
  if (at === "hook") return place(hookAt, `directly below the ${hookLine} line in ${where}`, `${" ".repeat(ci)}commands:\n${command(ci + u)}`);
  const key = at === "jobs" ? "jobs" : "commands";
  const keyLine = keyAt(ls, hookAt + 1, inHook.end, key, ci);
  if (keyLine < 0 || !bare(ls[keyLine]!, key)) return { why: `its ${key} key in ${entry.event} is written inline` };
  const location = `directly below the \`${key}:\` line under ${hookLine} in ${where}`;
  if (at === "commands") return place(keyLine, location, command(underKey(ls, keyLine).indent ?? ci + u));
  const firstJob = ls.slice(keyLine + 1).find((l) => !skippable(l));
  if (firstJob === undefined || !/^\s*-(\s|$)/.test(firstJob)) return { why: `its jobs list in ${entry.event} is empty` };
  return place(keyLine, location, indent(`- name: ${COMMAND}\n  run: |\n${indent(entry.run, 4)}`, indentOf(firstJob)));
}

function openingAt(text: string, path: readonly string[]): number {
  let i = 0;
  const skip = () => {
    for (;;) {
      while (/\s/.test(text[i] ?? "")) i++;
      if (text.startsWith("//", i)) i = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i);
      else if (text.startsWith("/*", i)) i = text.indexOf("*/", i) + 2;
      else return;
    }
  };
  const string = () => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    return text.slice(start, ++i);
  };
  const skipValue = () => {
    skip();
    if (text[i] === '"') return void string();
    if (text[i] !== "{" && text[i] !== "[") {
      while (i < text.length && !/[,}\]\s]/.test(text[i]!)) i++;
      return;
    }
    let depth = 0;
    do {
      skip();
      const c = text[i]!;
      if (c === '"') string();
      else {
        depth += c === "{" || c === "[" ? 1 : c === "}" || c === "]" ? -1 : 0;
        i++;
      }
    } while (depth > 0);
  };
  skip();
  for (const key of path) {
    i++;
    for (;;) {
      skip();
      const name = readJson(string(), stringShape, "a key in the config");
      skip();
      i++;
      skip();
      if (name === key) break;
      skipValue();
      skip();
      if (text[i] === ",") i++;
    }
  }
  return i + 1;
}

function lefthookJson(config: string, entry: Entry, where: string): Placement {
  const member = (u: string, p: number, at: Spot) => {
    const command = `"${COMMAND}": {\n${u}"priority": ${p},\n${u}"run": ${JSON.stringify(entry.run)}\n}`;
    const wrap = (key: string, inner: string) => `"${key}": {\n${indent(inner, u)}\n}`;
    return at === "file" ? wrap(entry.event, wrap("commands", command)) : at === "hook" ? wrap("commands", command)
      : at === "commands" ? command : `{\n${u}"name": "${COMMAND}",\n${u}"run": ${JSON.stringify(entry.run)}\n}`;
  };
  if (config.trim() === "") {
    const text = `{\n${indent(member("  ", 1, "file"), "  ")}\n}\n`;
    return { location: `to ${where}`, text, merged: text };
  }
  let doc: unknown;
  try {
    doc = Bun.JSONC.parse(config);
  } catch {
    return { why: `it isn't valid JSON` };
  }
  if (!isRecord(doc)) return { why: "it isn't a JSON object" };
  const at = spot(doc, entry.event);
  if (at === undefined) return { why: shape(entry.event) };
  if (hasPatchbook(doc, entry.event)) return PRESENT;
  const path = at === "file" ? [] : at === "hook" ? [entry.event] : [entry.event, at];
  const target = path.reduce<unknown>((v, k) => (isRecord(v) ? v[k] : undefined), doc);
  if (at === "jobs" ? !Array.isArray(target) : !isRecord(target)) return { why: `its ${path.join(" > ")} isn't ${at === "jobs" ? "an array" : "an object"}` };
  const members = Array.isArray(target) ? target.length : Object.keys(target as object).length;
  const u = /^([ \t]+)\S/m.exec(config)?.[1] ?? "  ";
  const depth = at === "file" ? 1 : at === "hook" ? 2 : 3;
  const text = indent(member(u, priority(doc, entry.event), at), u.repeat(depth)) + (members ? "," : "") + "\n";
  const open = openingAt(config, path);
  const merged = config.slice(0, open) + "\n" + text.replace(/\n$/, "") + config.slice(open);
  if (!checked(merged, Bun.JSONC.parse, lefthookFirst(entry.event, at))) return { why: `its ${entry.event} is laid out in a way patchbook can't add to` };
  const named = at === "file" ? "the top-level object" : at === "hook" ? `"${entry.event}"` : `"${at}" in "${entry.event}"`;
  const first = at === "jobs" ? "item" : "member";
  return { location: `as the first ${first} of ${named} in ${where}, right after its opening ${at === "jobs" ? "bracket" : "brace"}`, text, merged };
}

function lefthookToml(config: string, entry: Entry, where: string): Placement {
  let doc: unknown;
  try {
    doc = Bun.TOML.parse(config);
  } catch {
    return { why: `it isn't valid TOML` };
  }
  const at = spot(doc, entry.event);
  if (at === undefined) return { why: shape(entry.event) };
  if (at === "jobs") return { why: `its ${entry.event} uses jobs, which a TOML file can't add to from the end` };
  if (hasPatchbook(doc, entry.event)) return PRESENT;
  const text = `[${entry.event}.commands.${COMMAND}]\npriority = ${priority(doc, entry.event)}\nrun = '''\n${entry.run}'''\n`;
  const merged = endsLine(config) + text;
  if (!checked(merged, Bun.TOML.parse, lefthookFirst(entry.event, at))) return { why: `its ${entry.event} is laid out in a way patchbook can't add to` };
  return { location: `at the end of ${where}`, text, merged };
}

/** The keys run in the order lefthook looks for them, and it reads the first file it finds. */
export const LEFTHOOK: Readonly<Record<string, Format>> = { yml: lefthookYaml, yaml: lefthookYaml, json: lefthookJson, jsonc: lefthookJson, toml: lefthookToml };

const hookId = (entry: Entry) => (entry.event === "pre-commit" ? COMMAND : `${COMMAND}-${entry.event}`);

/** pre-commit splits `entry` like a shell does and runs the words without one, so the script goes through `sh -c`. */
function preCommitRepo(entry: Entry): string {
  const pre = entry.event === "pre-commit";
  return `- repo: local
  hooks:
    - id: ${hookId(entry)}
      name: ${pre ? COMMAND : `${COMMAND} ${entry.event}`}
      entry: |
${indent(`sh -c '${entry.run.trimEnd().replaceAll("'", "'\\''")}'`, 8)}
      language: system
      pass_filenames: false
      always_run: true
      stages: [${entry.event}]
${pre ? "" : "      verbose: true\n"}`;
}

function preCommit(config: string, entry: Entry, where: string): Placement {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(config);
  } catch {
    return { why: `it isn't valid YAML` };
  }
  if (doc !== null && doc !== undefined && !isRecord(doc)) return { why: "it isn't a YAML map" };
  const repos = isRecord(doc) ? doc["repos"] : undefined;
  const id = hookId(entry);
  const hooks = Array.isArray(repos) ? repos.flatMap((r) => (isRecord(r) && Array.isArray(r["hooks"]) ? r["hooks"] : [])) : [];
  if (hooks.some((h) => isRecord(h) && h["id"] === id)) return PRESENT;
  const item = preCommitRepo(entry);
  const firstIs = (d: unknown) => isRecord(d) && Array.isArray(d["repos"]) && isRecord(d["repos"][0]) && Array.isArray(d["repos"][0]["hooks"]) && isRecord(d["repos"][0]["hooks"][0]) && d["repos"][0]["hooks"][0]["id"] === id;
  const ls = lines(config);
  const at = keyAt(ls, 0, ls.length, "repos", 0);
  const whole = `repos:\n${indent(item, 2)}`;
  const failed: Unplaced = { why: "its repos list is laid out in a way patchbook can't add to" };
  if (at < 0) {
    if (repos !== undefined) return failed;
    const merged = endsLine(config) + whole;
    return checked(merged, Bun.YAML.parse, firstIs) ? { location: `at the end of ${where}`, text: whole, merged } : failed;
  }
  const rest = ls[at]!.slice(ls[at]!.indexOf(":") + 1);
  if (/^\s*\[\s*\]\s*(#.*)?$/.test(rest)) {
    const merged = [...ls.slice(0, at), ...whole.replace(/\n$/, "").split("\n"), ...ls.slice(at + 1)].join("\n");
    return checked(merged, Bun.YAML.parse, firstIs) ? { location: `in place of the \`repos: []\` line in ${where}`, text: whole, merged } : failed;
  }
  if (!bare(ls[at]!, "repos")) return failed;
  const first = ls.slice(at + 1).find((l) => !skippable(l));
  const items = first !== undefined && /^\s*-(\s|$)/.test(first);
  if (first !== undefined && indentOf(first) > 0 && !items) return failed;
  const text = indent(item, items ? indentOf(first!) : 2);
  const merged = after(ls, at, text);
  return checked(merged, Bun.YAML.parse, firstIs) ? { location: `directly below the \`repos:\` line in ${where}`, text, merged } : failed;
}

export const PRE_COMMIT: Readonly<Record<string, Format>> = { yaml: preCommit };
