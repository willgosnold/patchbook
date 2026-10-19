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

/** The lines of text as git counts them. Each ends after a `\n` and keeps it, and the last may have none.
 * Nothing else ends a line, so a `\r`, `\f` or U+2028 stays inside one. */
export function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
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
