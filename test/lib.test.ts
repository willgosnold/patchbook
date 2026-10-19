import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TomlDocument } from "@decimalturn/toml-patch";
import { type Opcode, SequenceMatcher, unifiedDiff } from "../src/lib/difflib.ts";
import { nonFolders, rmFolders } from "../src/lib/fs.ts";
import { dumps, loads } from "../src/lib/json.ts";
import { git, shellQuote } from "../src/lib/proc.ts";
import { str, strRepr } from "../src/lib/repr.ts";
import { byCodePoint, lines, padEndCodePoints, withoutFinalNewline } from "../src/lib/text.ts";

type Fixture = {
  matcher: { a: string | string[]; b: string | string[]; autojunk: boolean; ratio: number; opcodes: Opcode[] }[];
  unified: { a: string; b: string; fromfile: string; tofile: string; diff: string }[];
  json: { text: string; dumps: string; indent: string; str: string }[];
  repr: { s: string; repr: string }[];
};

const cases: Fixture = JSON.parse(readFileSync(new URL("fixtures/cpython.json", import.meta.url), "utf8"));

describe("lines", () => {
  test("ends each line after its \\n, which the line keeps", () => {
    expect(lines("one\ntwo\n")).toEqual(["one\n", "two\n"]);
  });

  test("keeps the \\r of a \\r\\n in the line, as git does", () => {
    expect(lines("one\r\ntwo\r\n")).toEqual(["one\r\n", "two\r\n"]);
  });

  test("breaks only at \\n, so a lone \\r, \\f, \\v, \\x1c, U+0085, U+2028 and U+2029 stay inside a line", () => {
    expect(lines("a\rb\fc\vd\x1ce\x85f\u2028g\u2029h\n")).toEqual(["a\rb\fc\vd\x1ce\x85f\u2028g\u2029h\n"]);
  });

  test("a last line with no \\n is still a line", () => {
    expect(lines("one\ntwo")).toEqual(["one\n", "two"]);
  });

  test("an empty text has no lines, and a lone \\n is one empty line", () => {
    expect(lines("")).toEqual([]);
    expect(lines("\n")).toEqual(["\n"]);
  });

  test("the lines join back into the text", () => {
    for (const text of ["", "\n\n", "a\r\nb\rc", "x\u2028y\n\nz"]) expect(lines(text).join("")).toBe(text);
  });

  test("counts the lines git counts", () => {
    const dir = mkdtempSync(join(tmpdir(), "lines"));
    try {
      for (const text of ["a\rb\fc\u2028d\ne", "one\r\ntwo\r\n", "\n\n\n", "no newline"]) {
        const file = join(dir, "file");
        writeFileSync(file, text);
        const r = Bun.spawnSync(["git", "diff", "--no-index", "--numstat", "/dev/null", file], { cwd: import.meta.dir });
        expect([text, Number(r.stdout.toString().split("\t")[0])]).toEqual([text, lines(text).length]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("padEndCodePoints", () => {
  test("pads to a width in code points, where padEnd counts UTF-16 units", () => {
    expect(padEndCodePoints("é😀", 4)).toBe("é😀  ");
    expect("é😀".padEnd(4)).toBe("é😀 ");
    expect(padEndCodePoints("ab", 4)).toBe("ab  ");
  });

  test("leaves a text that is already as wide or wider", () => {
    expect(padEndCodePoints("😀😀", 2)).toBe("😀😀");
    expect(padEndCodePoints("abc", 2)).toBe("abc");
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

describe("SequenceMatcher", () => {
  test.each(cases.matcher.map((c, i) => [i, c] as const))("case %d", (_, c) => {
    const m = new SequenceMatcher<string>(c.a, c.b, c.autojunk);
    expect(m.ratio()).toBe(c.ratio);
    expect(m.getOpcodes()).toEqual(c.opcodes);
  });

  test("covers emoji, combining marks, CJK and prototype names", () => {
    const text = cases.matcher.flatMap((c) => [c.a, c.b].flat()).join("");
    for (const s of ["😀", "👍🏽", "é", "中", "constructor", "__proto__"]) expect(text).toContain(s);
  });
});

// generate.py cut these texts with Python's str.splitlines, which also breaks at \r, \v, \f, \x1c-\x1e, \x85, U+2028 and U+2029.
const pythonLines = (s: string): string[] =>
  s.match(/[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]*(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])|[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]+$/gu) ?? [];

test.each(cases.unified)("unified_diff %#", (c) => {
  expect(unifiedDiff(pythonLines(c.a), pythonLines(c.b), c.fromfile, c.tofile)).toBe(c.diff);
});

const withoutFloats = (c: Fixture["json"][number]) => !/\d[.eE]|NaN|Infinity/.test(c.text);

test.each(cases.json.filter(withoutFloats))("json loads, dumps and str %#", (c) => {
  const value = loads(c.text);
  expect(dumps(value)).toBe(c.dumps);
  expect(dumps(value, 2)).toBe(c.indent);
  expect(str(value)).toBe(c.str);
});

test("json reads every number as a plain number, so 1.0 is written back as 1", () => {
  expect(dumps(loads("[1.0, -0.0, 1e5, 1e-05, 0.5, 2]"))).toBe("[1, 0, 100000, 0.00001, 0.5, 2]");
  expect(str(loads("2.0"))).toBe("2");
});

test("repr(str)", () => {
  for (const c of cases.repr) expect(strRepr(c.s)).toBe(c.repr);
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
