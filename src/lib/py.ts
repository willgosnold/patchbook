// Python's str and number semantics where JavaScript's differ. Python strings index code points,
// JavaScript strings UTF-16 code units, so anything that counts, slices or orders characters is here.
import type { JsonValue } from "./json.ts";

export const length = (s: string) => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

/** `s[start:end]` by code points, with Python's negative indices. */
export function slice(s: string, start: number, end?: number): string {
  return Array.from(s).slice(start, end).join("");
}

export const ljust = (s: string, width: number) => s + " ".repeat(Math.max(0, width - length(s)));

const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function hex(c: number, width: number): string {
  return c.toString(16).padStart(width, "0");
}

export function strRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === quote || ch === "\\") out += "\\" + ch;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + hex(c, 2);
    else if (c < 0x7f || !NOT_PRINTABLE.test(ch)) out += ch;
    else if (c <= 0xff) out += "\\x" + hex(c, 2);
    else if (c <= 0xffff) out += "\\u" + hex(c, 4);
    else out += "\\U" + hex(c, 8);
  }
  return out + quote;
}

export function repr(v: JsonValue): string {
  return typeof v === "string" ? strRepr(v) : str(v);
}

/** `str(value)` for a value parsed from JSON or TOML. */
export function str(v: JsonValue): string {
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return `[${v.map(repr).join(", ")}]`;
  return `{${Array.from(v, ([k, x]) => `${strRepr(k)}: ${repr(x)}`).join(", ")}}`;
}
