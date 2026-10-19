import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TomlDocument } from "@decimalturn/toml-patch";
import { unifiedDiff } from "../src/lib/diff.ts";
import { nonFolders, rmFolders } from "../src/lib/fs.ts";
import { lineChanges, similarity } from "../src/lib/match.ts";
import { git, shellQuote } from "../src/lib/proc.ts";
import { byCodePoint, encode, quote, withoutFinalNewline } from "../src/lib/text.ts";

describe("quote", () => {
  test.each([
    ["plain", '"plain"'],
    ["a b ", '"a b "'],
    ["", '""'],
    ['say "hi"', '"say \\"hi\\""'],
    ["a\\b", '"a\\\\b"'],
    ["a\tb", '"a\\tb"'],
    ["a\nb", '"a\\nb"'],
    ["a\x1bb", '"a\\u001bb"'],
    ["a\x7fb", '"a\\u007fb"'],
    ["a\u0085b", '"a\\u0085b"'],
    ["a\u009bb", '"a\\u009bb"'],
    ["a\u202eb", '"a\\u202eb"'],
    ["a\u200bb", '"a\\u200bb"'],
    ["a\ufeffb", '"a\\ufeffb"'],
    ["a\u{e0001}b", '"a\\u{e0001}b"'],
    ["a\ud800b", '"a\\ud800b"'],
    ["a\udc00", '"a\\udc00"'],
    ["é\u{1f600}", '"é\u{1f600}"'],
  ])("writes %j as %s", (value, written) => {
    expect(quote(value)).toBe(written);
  });

  test("writes a value that is not text as JSON, with the same escapes inside", () => {
    expect(quote(3)).toBe("3");
    expect(quote(null)).toBe("null");
    expect(quote(undefined)).toBe("undefined");
    expect(quote({ "a\u009b": ["\u202e"] })).toBe('{"a\\u009b":["\\u202e"]}');
  });

  test("leaves no control or format character, and no lone surrogate, in what it writes", () => {
    const everything = Array.from({ length: 0x3000 }, (_, i) => String.fromCharCode(i)).join("") + "\u{e0001}\u{1d173}";
    expect(quote(everything)).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]/u);
  });
});

describe("byCodePoint", () => {
  test("puts a character above U+FFFF after U+E000 to U+FFFF, where sort() alone puts it before them", () => {
    const names = ["\u{1F600}", "\uFFFD", "\uE000", "a"];
    expect([...names].sort()).toEqual(["a", "\u{1F600}", "\uE000", "\uFFFD"]);
    expect([...names].sort(byCodePoint)).toEqual(["a", "\uE000", "\uFFFD", "\u{1F600}"]);
  });

  test("ignores locale: capitals come before small letters, and é after z", () => {
    expect(["é", "z", "a", "Z"].sort(byCodePoint)).toEqual(["Z", "a", "z", "é"]);
  });

  test("a prefix comes first", () => {
    expect(["ab", "a", ""].sort(byCodePoint)).toEqual(["", "a", "ab"]);
  });

  test("is the order of the UTF-8 bytes, which git sorts paths in", () => {
    const paths = ["a/b", "a-b", "a b", "B", "\u{10000}", "\u{1F600}a", "\u{1F600}", "\uFF01", "\uFFFD", "é", "e\u0301", "中", "~", ""];
    const byBytes = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    expect([...paths].sort(byCodePoint)).toEqual(byBytes);
  });
});

describe("listing a folder", () => {
  test("gives whole paths in code-point order, so a-b and a.c come before a/b as in git", () => {
    const dir = mkdtempSync(join(tmpdir(), "listing"));
    try {
      for (const folder of ["a/b", "a-b", "a.c/d"]) mkdirSync(join(dir, folder), { recursive: true });
      for (const file of ["a/b/f", "a-b/f", "a.c/d/f"]) writeFileSync(join(dir, file), "");
      expect(nonFolders(dir)).toEqual(["a-b/f", "a.c/d/f", "a/b/f"]);
      rmSync(join(dir, "a/b/f"));
      rmSync(join(dir, "a-b/f"));
      rmSync(join(dir, "a.c/d/f"));
      rmFolders(dir);
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("withoutFinalNewline", () => {
  test("takes off one final \\n and nothing else", () => {
    expect(withoutFinalNewline("a\n")).toBe("a");
    expect(withoutFinalNewline("a\n\n")).toBe("a\n");
    expect(withoutFinalNewline(" a \uFEFF\n")).toBe(" a \uFEFF");
    expect(withoutFinalNewline("a\r\n")).toBe("a\r");
    expect(withoutFinalNewline("a\0")).toBe("a\0");
    expect(withoutFinalNewline("")).toBe("");
  });
});

describe("git", () => {
  const repoWith = (names: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "git"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    for (const name of names) writeFileSync(join(dir, name), "x\n");
    return dir;
  };
  const listed = (dir: string) => git(["ls-files", "-z", "-o"], { cwd: dir }).split("\0").slice(0, -1);
  const PATHS = ["\uFEFFbom-lead", " lead", "bom-trail\uFEFF", "trail ", "a\nb", "tab\t"];

  test.each(PATHS)("leaves a path of -z output as it is: %j", (name) => {
    const dir = repoWith([name]);
    try {
      expect(listed(dir)).toEqual([name]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("leaves every name of -z output as it is, the first and the last included", () => {
    const dir = repoWith(PATHS);
    try {
      expect(listed(dir)).toEqual([...PATHS].sort(byCodePoint));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("takes the one line terminator git adds off a single value and nothing else", () => {
    const root = mkdtempSync(join(tmpdir(), "git"));
    const dirs = ["lead", " lead", "trail ", "bom\uFEFF", "\uFEFFbom"].map((name) => join(root, name));
    try {
      for (const dir of dirs) {
        mkdirSync(dir);
        Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
        expect(git(["rev-parse", "--show-toplevel"], { cwd: dir })).toBe(realpathSync(dir));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gives an empty string for no output, and keeps a blank line a command prints", () => {
    const dir = repoWith([]);
    try {
      expect(git(["ls-files", "-o"], { cwd: dir })).toBe("");
      expect(git(["var", "GIT_EDITOR"], { cwd: dir, env: { ...process.env, GIT_EDITOR: "" } })).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shellQuote", () => {
  test("sh reads each quoted word back as it was", () => {
    const words = ["", "plain", "two words", "it's", 'say "hi"', "$HOME", "`id`", "$(id)", "a\nb", "back\\slash", "*", "~", "=x", "-n", "é", "tab\there", "!", ";|&"];
    const r = Bun.spawnSync(["sh", "-c", `printf '%s\\0' ${words.map(shellQuote).join(" ")}`]);
    expect(r.stdout.toString().split("\0").slice(0, -1)).toEqual(words);
  });

  test("leaves a word of only letters, digits and @%+:,./_- bare", () => {
    expect(shellQuote("a/b.c-d_e@f%g+h:i,j")).toBe("a/b.c-d_e@f%g+h:i,j");
  });

  test("quotes =, which zsh expands at the start of a word", () => {
    expect(shellQuote("=x")).toBe("'=x'");
  });

  test("quotes an empty word, so sh still passes an argument", () => {
    expect(shellQuote("")).toBe("''");
  });
});

describe("lineChanges", () => {
  test("is empty for equal lists", () => {
    expect(lineChanges(["a", "b"], ["a", "b"])).toEqual([]);
    expect(lineChanges([], [])).toEqual([]);
  });

  test("is one stretch when nothing pairs", () => {
    expect(lineChanges(["a", "b"], ["x"])).toEqual([[0, 2, 0, 1]]);
  });

  test("gives an empty side an empty range", () => {
    expect(lineChanges([], ["a"])).toEqual([[0, 0, 0, 1]]);
    expect(lineChanges(["a"], [])).toEqual([[0, 1, 0, 0]]);
  });

  test("pairs the most lines, so a line moved to the top costs only itself", () => {
    expect(lineChanges(["A", "B", "C"], ["C", "A", "B"])).toEqual([[0, 0, 0, 1], [2, 3, 3, 3]]);
  });

  test("pairs the lines both lists end with first, so a changed first line is one stretch", () => {
    expect(lineChanges(["a", "b"], ["b", "b"])).toEqual([[0, 1, 0, 1]]);
  });

  test("pairs the lines both lists start with before those they end with", () => {
    expect(lineChanges(["a", "a"], ["a"])).toEqual([[1, 2, 1, 1]]);
    expect(lineChanges(["a"], ["a", "a"])).toEqual([[1, 1, 1, 2]]);
  });

  test("on a tie, pairs the earliest new line", () => {
    expect(lineChanges(["s", "a", "e"], ["t", "a", "a", "u"])).toEqual([[0, 1, 0, 1], [2, 3, 2, 4]]);
  });

  test("on a tie, pairs the earliest old line", () => {
    expect(lineChanges(["s", "a", "a", "e"], ["t", "a", "u"])).toEqual([[0, 1, 0, 1], [2, 4, 2, 3]]);
  });

  test("pairs a blank line or a } like any other however long the file, so two edits in 300 lines stay two stretches", () => {
    const old = Array.from({ length: 100 }, (_, k) => [`para ${k}`, "}", ""]).flat();
    const fresh = old.with(150, "PARA 50").with(153, "PARA 51");
    expect(lineChanges(old, fresh)).toEqual([[150, 151, 150, 151], [153, 154, 153, 154]]);
  });

  test("keys lines by value, so __proto__ and constructor are ordinary lines", () => {
    expect(lineChanges(["__proto__", "constructor"], ["constructor", "__proto__"])).toEqual([[0, 0, 0, 1], [1, 2, 2, 2]]);
  });

  test.each([31, 32, 33, 63, 64, 65])("pairs across 32-bit words: %d lines of abab… against baba… keep all but one", (n) => {
    const old = Array.from({ length: n }, (_, k) => "ab"[k % 2]!);
    const fresh = Array.from({ length: n }, (_, k) => "ba"[k % 2]!);
    expect(lineChanges(old, fresh)).toEqual([[0, 0, 0, 1], [n - 1, n, n, n]]);
  });

  test("is the matching the rule picks, for every pair of lists of up to 4 lines over a, b and c", () => {
    type Pair = [number, number];
    const lists: string[][] = [[]];
    for (const list of lists) if (list.length < 4) for (const e of "abc") lists.push([...list, e]);
    const matchings = (a: string[], b: string[], i: number, j: number): Pair[][] => {
      const all: Pair[][] = [[]];
      for (let x = i; x < a.length; x++) {
        for (let y = j; y < b.length; y++) if (a[x] === b[y]) for (const rest of matchings(a, b, x + 1, y + 1)) all.push([[x, y], ...rest]);
      }
      return all;
    };
    const earlier = (p: Pair[], q: Pair[]) => {
      const k = p.findIndex(([x, y], n) => x !== q[n]![0] || y !== q[n]![1]);
      return k === -1 ? 0 : p[k]![0] - q[k]![0] || p[k]![1] - q[k]![1];
    };
    const picked = (a: string[], b: string[]): Pair[] => {
      let start = 0;
      while (start < a.length && start < b.length && a[start] === b[start]) start++;
      let end = 0;
      while (end < a.length - start && end < b.length - start && a.at(-1 - end) === b.at(-1 - end)) end++;
      const ends = [
        ...Array.from({ length: start }, (_, k): Pair => [k, k]),
        ...Array.from({ length: end }, (_, k): Pair => [a.length - end + k, b.length - end + k]),
      ];
      const all = matchings(a, b, 0, 0);
      const most = Math.max(...all.map((m) => m.length));
      return all.filter((m) => m.length === most && ends.every(([x, y]) => m.some(([p, q]) => p === x && q === y))).sort(earlier)[0]!;
    };
    for (const a of lists) {
      for (const b of lists) {
        const stretches: [number, number, number, number][] = [];
        let i = 0;
        let j = 0;
        for (const [x, y] of [...picked(a, b), [a.length, b.length] as Pair]) {
          if (x > i || y > j) stretches.push([i, x, j, y]);
          i = x + 1;
          j = y + 1;
        }
        expect([a, b, lineChanges(a, b)]).toEqual([a, b, stretches]);
      }
    }
  });
});

describe("similarity", () => {
  test("is twice the matching code points over both lengths, to two places, a half up", () => {
    expect(similarity("abcdefgh", "abcdeXYZ")).toBe(0.63);
  });

  test("rounds a decimal half up where rounding the float rounds it down", () => {
    const halves = [
      { shared: 23, onlyA: 17, onlyB: 17, ratio: 0.575, float: 0.57, rounded: 0.58 },
      { shared: 113, onlyA: 88, onlyB: 86, ratio: 0.565, float: 0.56, rounded: 0.57 },
      { shared: 57, onlyA: 144, onlyB: 142, ratio: 0.285, float: 0.28, rounded: 0.29 },
    ];
    for (const { shared, onlyA, onlyB, ratio, float, rounded } of halves) {
      const a = "x".repeat(shared) + "a".repeat(onlyA);
      const b = "x".repeat(shared) + "b".repeat(onlyB);
      const r = (2 * shared) / (2 * shared + onlyA + onlyB);
      expect(r).toBe(ratio);
      expect(Math.round(r * 100) / 100).toBe(float);
      expect(similarity(a, b)).toBe(rounded);
    }
  });

  test("counts a code point once, not as its two UTF-16 halves", () => {
    expect(similarity("😀😀", "😀😁")).toBe(0.5);
  });

  test("is 1 for two empty texts and for equal ones, and 0 when nothing matches", () => {
    expect(similarity("", "")).toBe(1);
    expect(similarity("same", "same")).toBe(1);
    expect(similarity("abc", "xyz")).toBe(0);
  });

  test("pairs the most code points in order, so a reordered text keeps its longest part", () => {
    expect(similarity("abc", "cab")).toBe(0.67);
  });

  test("counts a space like any other code point however long the text, so one word changed in 300 is 0.99", () => {
    expect(similarity("word ".repeat(60), "word ".repeat(30) + "WORD " + "word ".repeat(29))).toBe(0.99);
  });

  test("leaves code points as they are, so a precomposed é and an e with a combining accent share nothing", () => {
    expect(similarity("é", "é")).toBe(0);
  });

  test.each([[31, 0.97], [32, 0.97], [33, 0.97], [63, 0.98], [64, 0.98], [65, 0.98]])("counts across 32-bit words: %d code points of abab… against baba… share all but one, so %s", (n, score) => {
    expect(similarity("ab".repeat(n).slice(0, n), "ba".repeat(n).slice(0, n))).toBe(score);
  });
});

describe("unifiedDiff", () => {
  const clean = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const inRepo = <T>(use: (dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), "diff"));
    try {
      Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env: clean });
      return use(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const gitHunks = (old: string, fresh: string): string => inRepo((dir) => {
    writeFileSync(join(dir, "old"), old);
    writeFileSync(join(dir, "new"), fresh);
    const out = Bun.spawnSync(["git", "diff", "--no-index", "--no-color", "old", "new"], { cwd: dir, env: clean }).stdout.toString();
    return out.slice(out.indexOf("@@"));
  });
  const diff = (old: string, fresh: string) => unifiedDiff(encode(old), encode(fresh), "upstream/x", "ours/x");

  test.each([
    ["marks a last line with no newline on both sides", "a\nb", "a\nc", "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n"],
    ["marks the old side when a final newline is added", "a\nb", "a\nb\n", "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n"],
    ["marks the new side when a final newline is removed", "a\nb\n", "a\nb", "@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file\n"],
    ["gives an empty old side the range 0,0", "", "a\nb\n", "@@ -0,0 +1,2 @@\n+a\n+b\n"],
    ["gives an empty new side the range 0,0", "a\nb\n", "", "@@ -1,2 +0,0 @@\n-a\n-b\n"],
    ["names the function above a hunk after its @@", "int main(void)\n{\n\ta;\n\tb;\n\tc;\n\td;\n}\n", "int main(void)\n{\n\ta;\n\tb;\n\tc;\n\tD;\n}\n",
      "@@ -3,5 +3,5 @@ int main(void)\n \ta;\n \tb;\n \tc;\n-\td;\n+\tD;\n }\n"],
  ])("is git's diff under patchbook's --- and +++ lines: %s", (_, old, fresh, hunks) => {
    expect(gitHunks(old, fresh)).toBe(hunks);
    expect(diff(old, fresh)).toBe(`--- upstream/x\n+++ ours/x\n${hunks}`);
  });

  test("is empty for equal sides", () => {
    expect(diff("a\n", "a\n")).toBe("");
    expect(diff("", "")).toBe("");
  });

  test("ignores the git config and GIT_* variables around it, and a repo around its temporary folder", () => {
    const old = "y\ny\n\ny\n}\ny\n{\nz\n";
    const fresh = "x\n\ny\n{\n{\nz\n\nz\n";
    const reference = gitHunks(old, fresh);
    inRepo((repo) => {
      Bun.spawnSync(["git", "config", "diff.algorithm", "histogram"], { cwd: repo, env: clean });
      mkdirSync(join(repo, "tmp"));
      const poison = {
        GIT_DIFF_OPTS: "-u0",
        GIT_EXTERNAL_DIFF: "false",
        GIT_CONFIG_PARAMETERS: "'diff.algorithm'='histogram' 'diff.noprefix'='true'",
        GIT_DIR: join(repo, ".git"),
        TMPDIR: join(repo, "tmp"),
      };
      const saved = Object.keys(poison).map((k) => [k, process.env[k]] as const);
      Object.assign(process.env, poison);
      try {
        writeFileSync(join(repo, "old"), old);
        writeFileSync(join(repo, "new"), fresh);
        expect(Bun.spawnSync(["git", "diff", "--no-index", "old", "new"], { cwd: repo }).stdout.toString()).not.toContain(reference);
        expect(diff(old, fresh)).toBe(`--- upstream/x\n+++ ours/x\n${reference}`);
      } finally {
        for (const [k, v] of saved) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  });
});

describe("the TOML library's syntax tree", () => {
  test("gives each key its table, its dotted path and the lines it spans, which an unset cuts by", () => {
    const text = '[ a . "b c" ]\n# above\nx = [ # open\n  1,\n] # close\ny.z = 2\n[[arr]]\nq = 1\n';
    const blocks = new TomlDocument(text).cst as unknown as {
      type: string;
      loc: { start: { line: number }; end: { line: number } };
      key: { value?: string[]; item?: { value: string[] } };
      items?: typeof blocks;
    }[];
    const table = blocks.find((block) => block.type === "Table")!;
    expect(table.key.item?.value).toEqual(["a", "b c"]);
    const keys = table.items!.filter((item) => item.type === "KeyValue");
    expect(keys.map((key) => [key.key.value, key.loc.start.line, key.loc.end.line])).toEqual([
      [["x"], 3, 5],
      [["y", "z"], 6, 6],
    ]);
    expect(blocks.map((block) => block.type)).toEqual(["Table", "TableArray"]);
  });
});
