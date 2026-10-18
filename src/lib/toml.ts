const ESCAPES = new Map([['"', '\\"'], ["\\", "\\\\"], ["\b", "\\b"], ["\t", "\\t"], ["\n", "\\n"], ["\f", "\\f"], ["\r", "\\r"]]);

export function quoteToml(s: string): string {
  return `"${s.replace(/[\p{Cc}"\\]/gu, (ch) => ESCAPES.get(ch) ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}
