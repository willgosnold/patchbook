// TextDecoder drops a leading BOM unless told not to, which would strip it from built files.
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenient = new TextDecoder("utf-8", { ignoreBOM: true });
const encoder = new TextEncoder();

export const decode = (data: Uint8Array) => strict.decode(data);
/** `data.decode(errors="replace")`. */
export const decodeReplace = (data: Uint8Array) => lenient.decode(data);
export const encode = (text: string) => encoder.encode(text);

export function isText(data: Uint8Array): boolean {
  if (data.includes(0)) return false;
  try {
    strict.decode(data);
    return true;
  } catch {
    return false;
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(a, b) === 0;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

/** text without the one `\n` that ends it, if it has one. A path may start or end with whitespace, so nothing else comes off. */
export const withoutFinalNewline = (text: string): string => (text.endsWith("\n") ? text.slice(0, -1) : text);

/** Orders strings by code point, the same in every locale. That is the order of their UTF-8 bytes, which
 * git sorts paths in. `sort()` alone compares UTF-16 code units, which puts characters above U+FFFF
 * before U+E000 to U+FFFF. */
export function byCodePoint(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x - y;
    if (x > 0xffff) i++;
  }
  return a.length - b.length;
}

/** What a message writes for a value that came from outside: JSON, with every control and format character escaped too.
 * JSON.stringify leaves DEL, U+0080 to U+009F and format characters such as U+202E raw, and a terminal can act on them. */
export function quote(value: unknown): string {
  const json = JSON.stringify(value) as string | undefined;
  return (json ?? String(value)).replace(/[\p{Cc}\p{Cf}]/gu, (c) => {
    const code = c.codePointAt(0)!;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}
