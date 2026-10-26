type Block = { header: string; snippet: string };

function blocks(advice: string): Block[] {
  const out: Block[] = [];
  for (const part of advice.split(/^(?=patchbook: )/m)) {
    const at = part.indexOf(":\n\n");
    if (!part.startsWith("patchbook: ") || at < 0) continue;
    const snippet = part.slice(at + 3).replace(/\nLeave parallel off:.*\n?$/s, "\n").replace(/\n+$/, "\n");
    out.push({ header: part.slice(0, at + 1), snippet });
  }
  return out;
}

const indentOf = (l: string) => l.length - l.trimStart().length;
const blankOrComment = (l: string) => /^\s*(#.*)?$/.test(l);
const escaped = (s: string) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

function insertAfterLine(lines: string[], at: number, snippet: string): string {
  return [...lines.slice(0, at + 1), ...snippet.replace(/\n$/, "").split("\n"), ...lines.slice(at + 1)].join("\n");
}

function findLine(lines: string[], from: number, to: number, name: string, indent: number | null): number {
  const re = new RegExp(`^( *)["']?${escaped(name.replace(/:$/, ""))}["']?[ \\t]*:`);
  for (let i = from; i < to; i++) {
    const m = re.exec(lines[i]!);
    if (m && (indent === null || m[1]!.length === indent)) return i;
  }
  return -1;
}

function blockEnd(lines: string[], start: number): number {
  const base = indentOf(lines[start]!);
  for (let i = start + 1; i < lines.length; i++) {
    if (!blankOrComment(lines[i]!) && indentOf(lines[i]!) <= base) return i;
  }
  return lines.length;
}

function locate(src: string, path: string[]): number {
  let i = 0;
  const skip = () => {
    for (;;) {
      while (/\s/.test(src[i] ?? "")) i++;
      if (src.startsWith("//", i)) { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (src.startsWith("/*", i)) { i = src.indexOf("*/", i) + 2; continue; }
      return;
    }
  };
  const str = () => { const s = i; i++; while (src[i] !== '"') i += src[i] === "\\" ? 2 : 1; i++; return src.slice(s, i); };
  let found = -1;
  const value = (at: string[]): void => {
    skip();
    const open = i;
    if (src[i] === "{" || src[i] === "[") {
      const closer = src[i] === "{" ? "}" : "]";
      i++;
      for (;;) {
        skip();
        if (src[i] === closer) break;
        let key = "";
        if (closer === "}") { key = JSON.parse(str()); skip(); i++; }
        value([...at, key]);
        skip();
        if (src[i] === ",") i++;
      }
      if (at.length === path.length && at.every((k, n) => k === path[n])) found = open;
      i++;
      return;
    }
    if (src[i] === '"') { str(); return; }
    while (i < src.length && !/[,}\]\s]/.test(src[i]!)) i++;
  };
  value([]);
  if (found < 0) throw new Error(`the file has no value at ${path.join(" > ")}`);
  return found;
}

function pasteJson(text: string, header: string, snippet: string): string {
  if (text.trim() === "") return snippet;
  const path = /top-level/.test(header) ? [] : [...header.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).reverse();
  const open = locate(text, path);
  return text.slice(0, open + 1) + "\n" + snippet.replace(/\n$/, "") + "\n" + text.slice(open + 1);
}

export function paste(config: string, advice: string): string {
  let text = config;
  for (const { header, snippet } of blocks(advice)) {
    const lines = text.split("\n");
    const file = /(?:in|of|to) (\S+?\.(?:jsonc?|ya?ml|toml))\b/.exec(header)?.[1] ?? "";
    if (/\.jsonc?$/.test(file)) {
      text = pasteJson(text, header, snippet);
    } else if (/in place of (?:the )?`?repos: \[\]/.test(header)) {
      text = text.replace(/^repos:[ \t]*\[\s*\][ \t]*$/m, snippet.replace(/\n$/, ""));
    } else if (/directly below the `/.test(header)) {
      const [, line, parentLine] = /directly below the `([^`]+)` line(?: under `([^`]+)`)?/.exec(header)!;
      const parent = parentLine ? findLine(lines, 0, lines.length, parentLine, 0) : -1;
      const at = parentLine ? findLine(lines, parent + 1, parent < 0 ? 0 : blockEnd(lines, parent), line!, null) : findLine(lines, 0, lines.length, line!, 0);
      if (at < 0) throw new Error(`the file has no \`${line}\` line to paste below`);
      text = insertAfterLine(lines, at, snippet);
    } else if (/Add this (?:to|at the end of) \S+/.test(header)) {
      text = text.trim() === "" ? snippet : text.replace(/\n?$/, "\n") + snippet;
    }
  }
  return text;
}
