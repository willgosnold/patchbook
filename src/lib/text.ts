// Bytes and text as Python's bytes.decode() and str.encode() see them. TextDecoder drops a leading
// BOM unless told not to, which would strip it from built files.
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
