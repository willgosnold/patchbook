import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TomlDocument } from "@decimalturn/toml-patch";
import { unifiedDiff } from "../src/lib/diff.ts";
import { type Opcode, SequenceMatcher } from "../src/lib/difflib.ts";
import { nonFolders, rmFolders } from "../src/lib/fs.ts";
import { git, shellQuote } from "../src/lib/proc.ts";
import { strRepr } from "../src/lib/repr.ts";
import { byCodePoint, encode, withoutFinalNewline } from "../src/lib/text.ts";

type Fixture = {
  matcher: { a: string | string[]; b: string | string[]; autojunk: boolean; ratio: number; opcodes: Opcode[] }[];
  repr: { s: string; repr: string }[];
};

const cases: Fixture = JSON.parse(readFileSync(new URL("fixtures/cpython.json", import.meta.url), "utf8"));

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
