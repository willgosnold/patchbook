import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const BYPASS = /\bprocess\.(stdout|stderr)\b(?!\.columns\b)|\bconsole\.|\bBun\.(stdout|stderr)\b/;
const SRC = resolve(import.meta.dir, "..", "src");

test("nothing but src/lib/term.ts writes to stdout or stderr", () => {
  const files = [...new Bun.Glob("**/*.ts").scanSync(SRC)].filter((f) => f !== join("lib", "term.ts"));
  expect(files.length).toBeGreaterThan(10);
  expect(files.filter((f) => BYPASS.test(readFileSync(join(SRC, f), "utf8")))).toEqual([]);
});

test("the rule catches a stream picked by a condition", () => {
  expect(BYPASS.test("(c ? process.stdout : process.stderr).write(t)")).toBe(true);
  expect(BYPASS.test("process.stdout.columns || 80")).toBe(false);
});
