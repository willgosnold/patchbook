// JSON.parse puts integer-like keys first, and JSON.stringify doesn't escape non-ASCII.

/** A value `loads` reads: objects as maps, in the order of their keys. */
export type JsonValue = null | boolean | number | string | JsonValue[] | Map<string, JsonValue>;

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | ReadonlyMap<string, Json>
  | { readonly [key: string]: Json };

export class JsonError extends Error {}

const ESCAPES = new Map([['"', '\\"'], ["\\", "\\\\"], ["\n", "\\n"], ["\r", "\\r"], ["\t", "\\t"], ["\b", "\\b"], ["\f", "\\f"]]);

/** A string as json.dumps writes it with ensure_ascii: everything outside space to `~` escaped. */
export function quoteString(s: string): string {
  return `"${s.replace(/[^ -~]|["\\]/g, (ch) => ESCAPES.get(ch) ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

function number(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "Infinity" : "-Infinity";
  return String(x);
}

/** `json.dumps(value)`, or with `indent`, `json.dumps(value, indent=indent)`. */
export function dumps(value: Json, indent?: number): string {
  const itemSep = indent === undefined ? ", " : ",";
  const write = (v: Json, depth: number): string => {
    if (v === null) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return number(v);
    if (typeof v === "string") return quoteString(v);
    const items: string[] = isList(v)
      ? v.map((x) => write(x, depth + 1))
      : Array.from(isMap(v) ? v : Object.entries(v), ([k, x]) => `${quoteString(k)}: ${write(x, depth + 1)}`);
    const [open, close] = isList(v) ? ["[", "]"] : ["{", "}"];
    if (items.length === 0) return open + close;
    if (indent === undefined) return open + items.join(itemSep) + close;
    const inner = "\n" + " ".repeat(indent * (depth + 1));
    return open + inner + items.join(itemSep + inner) + "\n" + " ".repeat(indent * depth) + close;
  };
  return write(value, 0);
}

function isList(v: Json): v is readonly Json[] {
  return Array.isArray(v);
}

function isMap(v: Json): v is ReadonlyMap<string, Json> {
  return v instanceof Map;
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?/y;
const CONSTANTS: [string, JsonValue][] = [
  ["null", null], ["true", true], ["false", false], ["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity],
];
const UNESCAPE = new Map([['"', '"'], ["\\", "\\"], ["/", "/"], ["b", "\b"], ["f", "\f"], ["n", "\n"], ["r", "\r"], ["t", "\t"]]);

/** `json.loads`: Python's key order, NaN and Infinity, and its strictness about control characters. */
export function loads(text: string): JsonValue {
  let i = 0;
  const fail = (what: string): never => {
    throw new JsonError(`${what} at char ${i}`);
  };
  const space = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const string = (): string => {
    i++;
    let out = "";
    for (;;) {
      const ch = text[i];
      if (ch === undefined) return fail("Unterminated string");
      if (ch === '"') break;
      if (ch < " ") return fail("Invalid control character");
      if (ch !== "\\") {
        out += ch;
        i++;
        continue;
      }
      const e = text[i + 1];
      if (e === "u") {
        const code = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(code)) return fail("Invalid \\uXXXX escape");
        out += String.fromCharCode(parseInt(code, 16));
        i += 6;
      } else {
        const plain = e === undefined ? undefined : UNESCAPE.get(e);
        if (plain === undefined) return fail("Invalid \\escape");
        out += plain;
        i += 2;
      }
    }
    i++;
    return out;
  };
  const value = (): JsonValue => {
    space();
    const ch = text[i];
    if (ch === '"') return string();
    if (ch === "[") {
      i++;
      const list: JsonValue[] = [];
      space();
      if (text[i] === "]") return i++, list;
      for (;;) {
        list.push(value());
        space();
        if (text[i] === "]") return i++, list;
        if (text[i] !== ",") return fail("Expecting ',' delimiter");
        i++;
      }
    }
    if (ch === "{") {
      i++;
      const map = new Map<string, JsonValue>();
      space();
      if (text[i] === "}") return i++, map;
      for (;;) {
        space();
        if (text[i] !== '"') return fail("Expecting property name enclosed in double quotes");
        const key = string();
        space();
        if (text[i] !== ":") return fail("Expecting ':' delimiter");
        i++;
        map.set(key, value());
        space();
        if (text[i] === "}") return i++, map;
        if (text[i] !== ",") return fail("Expecting ',' delimiter");
        i++;
      }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (m) {
      i += m[0].length;
      return Number(m[0]);
    }
    for (const [word, v] of CONSTANTS) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return v;
      }
    }
    return fail("Expecting value");
  };
  const result = value();
  space();
  if (i !== text.length) fail("Extra data");
  return result;
}
