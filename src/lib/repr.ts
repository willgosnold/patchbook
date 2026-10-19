const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function hex(c: number, width: number): string {
  return c.toString(16).padStart(width, "0");
}

/** Python's `repr()` of a string. */
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
