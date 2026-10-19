// src/lib against what CPython gives on the same cases. Regenerate with: python3 test/fixtures/generate.py
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TomlDocument } from "@decimalturn/toml-patch";
import { type Opcode, SequenceMatcher, unifiedDiff } from "../src/lib/difflib.ts";
import { nonFolders, rmFolders } from "../src/lib/fs.ts";
import { dumps, loads } from "../src/lib/json.ts";
import {
  floatRepr, lstrip, quote, replace, round2, rstrip, split, splitlines, str, strip, strRepr,
} from "../src/lib/py.ts";
import { byCodePoint } from "../src/lib/text.ts";

type Fixture = {
  matcher: { a: string | string[]; b: string | string[]; autojunk: boolean; ratio: number; opcodes: Opcode[] }[];
  unified: { a: string; b: string; fromfile: string; tofile: string; diff: string }[];
  splitlines: { s: string; keep: string[]; drop: string[] }[];
  strip: { s: string; strip: string; lstrip: string; rstrip: string; split: string[] }[];
  round: { x: number; round: string }[];
  floats: { x: number; repr: string }[];
  json: { text: string; dumps: string; indent: string; str: string }[];
  repr: { s: string; repr: string }[];
  replace: { s: string; old: string; new: string; out: string }[];
  quote: { s: string; out: string }[];
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

test.each(cases.unified)("unified_diff %#", (c) => {
  expect(unifiedDiff(splitlines(c.a, true), splitlines(c.b, true), c.fromfile, c.tofile)).toBe(c.diff);
});

test.each(cases.splitlines)("splitlines %#", (c) => {
  expect(splitlines(c.s, true)).toEqual(c.keep);
  expect(splitlines(c.s)).toEqual(c.drop);
});

test.each(cases.strip)("strip and split %#", (c) => {
  expect(strip(c.s)).toBe(c.strip);
  expect(lstrip(c.s)).toBe(c.lstrip);
  expect(rstrip(c.s)).toBe(c.rstrip);
  expect(split(c.s)).toEqual(c.split);
});

test("round(x, 2), ties to even", () => {
  for (const c of cases.round) expect([c.x, floatRepr(round2(c.x).value)]).toEqual([c.x, c.round]);
});

test("repr(float)", () => {
  for (const c of cases.floats) expect(floatRepr(c.x)).toBe(c.repr);
});

test.each(cases.json)("json loads, dumps and str %#", (c) => {
  const value = loads(c.text);
  expect(dumps(value)).toBe(c.dumps);
  expect(dumps(value, 2)).toBe(c.indent);
  expect(str(value)).toBe(c.str);
});

test("repr(str)", () => {
  for (const c of cases.repr) expect(strRepr(c.s)).toBe(c.repr);
});

test("str.replace", () => {
  for (const c of cases.replace) expect(replace(c.s, c.old, c.new)).toBe(c.out);
});

test("shlex.quote", () => {
  for (const c of cases.quote) expect(quote(c.s)).toBe(c.out);
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
