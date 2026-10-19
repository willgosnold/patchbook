// UTF-8 bytes as text and back, and patchbook's rules for text: its lines, its order and its shell
// words. TextDecoder drops a leading BOM unless told not to, which would strip it from built files.
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
  return a.length === b.length && a.every((x, i) => x === b[i]);
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

/** Orders strings by code point, the same in every locale. That is the order of their UTF-8 bytes, which
 * git sorts paths in. `sort()` alone compares UTF-16 code units, which puts characters above U+FFFF
 * before U+E000 to U+FFFF. */
export function byCodePoint(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return rank(x) - rank(y);
  }
  return a.length - b.length;
}

function rank(unit: number): number {
  // Lift surrogates above U+E000-U+FFFF so the first differing code unit orders by code point.
  return unit < 0xd800 ? unit : unit < 0xe000 ? unit + 0x2000 : unit - 0x800;
}
