// Python's str and number semantics where JavaScript's differ. Python strings index code points,
// JavaScript strings UTF-16 code units, so anything that counts, slices or orders characters is here.

/** Python's `\s` and `str.isspace()`, as a regex class body. */
export const S = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
/** Python's `\w` for str patterns: letters, numbers and the underscore. */
export const W = "\\p{L}\\p{N}_";

const SPACE = new Set(
  [0x9, 0xa, 0xb, 0xc, 0xd, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]
    .concat(Array.from({ length: 11 }, (_, i) => 0x2000 + i)),
);

export function isSpace(ch: string): boolean {
  return ch.length === 1 && SPACE.has(ch.charCodeAt(0));
}

function trim(s: string, chars: string | undefined, left: boolean, right: boolean): string {
  if (chars === undefined) {
    // Every Python whitespace character is in the BMP, so code units are safe here.
    let start = 0;
    let end = s.length;
    while (left && start < end && SPACE.has(s.charCodeAt(start))) start++;
    while (right && end > start && SPACE.has(s.charCodeAt(end - 1))) end--;
    return s.slice(start, end);
  }
  const strip = new Set(chars);
  const cps = Array.from(s);
  let start = 0;
  let end = cps.length;
  while (left && start < end && strip.has(cps[start]!)) start++;
  while (right && end > start && strip.has(cps[end - 1]!)) end--;
  return cps.slice(start, end).join("");
}

export const strip = (s: string, chars?: string) => trim(s, chars, true, true);
export const lstrip = (s: string, chars?: string) => trim(s, chars, true, false);
export const rstrip = (s: string, chars?: string) => trim(s, chars, false, true);

/** `str.split()` with no separator: runs of whitespace, no empty strings. */
export function split(s: string): string[] {
  return s.split(new RegExp(`[${S}]+`, "u")).filter((w) => w !== "");
}

/** `str.replace(old, new)`, including Python's insertion around every character when `old` is empty. */
export function replace(s: string, old: string, by: string): string {
  if (old === "") return by + Array.from(s).map((ch) => ch + by).join("");
  return s.split(old).join(by);
}

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

/** A number that Python holds as a float, so it prints as `1.0` and not `1`. */
export class PyFloat {
  constructor(readonly value: number) {}
}

/** `repr(float)`: the shortest round-tripping digits, in exponent form below 1e-4 and from 1e16. */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  const [mantissa = "0", exp = "0"] = Math.abs(x).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const point = Number(exp) + 1;
  if (point > -4 && point <= 16) {
    if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
    if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
    return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  const e = point - 1;
  const head = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${sign}${head}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
}

/** `round(x, 2)`: correctly rounded, ties to even. `toFixed` rounds ties away from zero. */
export function round2(x: number): PyFloat {
  // x * 100 is exactly halfway between integers only when x is an odd multiple of 1/8.
  const eighths = x * 8;
  if (Number.isInteger(eighths) && eighths % 2 !== 0) {
    const low = Math.floor(x * 100);
    return new PyFloat((low % 2 === 0 ? low : low + 1) / 100);
  }
  return new PyFloat(Number(x.toFixed(2)));
}

/** A value as Python holds parsed JSON: ints as numbers, floats as PyFloat, objects as ordered maps. */
export type PyValue = null | boolean | number | PyFloat | string | PyValue[] | Map<string, PyValue>;

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

export function repr(v: PyValue): string {
  return typeof v === "string" ? strRepr(v) : str(v);
}

/** `str(value)` for a value parsed from JSON or TOML. */
export function str(v: PyValue): string {
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  if (v instanceof PyFloat) return floatRepr(v.value);
  if (Array.isArray(v)) return `[${v.map(repr).join(", ")}]`;
  return `{${Array.from(v, ([k, x]) => `${strRepr(k)}: ${repr(x)}`).join(", ")}}`;
}

/** `shlex.quote`. */
export function quote(s: string): string {
  if (s === "") return "''";
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replaceAll("'", `'"'"'`) + "'";
}
