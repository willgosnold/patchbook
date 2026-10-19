// Renames the tests whose names start with `test_` to the sentences in scripts/test-names.tsv.
//
//   bun scripts/rename-tests.ts            apply the table to test/*.test.ts
//   bun scripts/rename-tests.ts --propose  print a row for each name the table lacks, to review and add
//
// A row is the old name, a tab, the new name. A name written as a template keeps its `${...}` parts,
// byte for byte, in both columns. The script stops, changing nothing, when a test has no row or a
// row matches no test.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const testDir = join(root, "test");
const tablePath = join(import.meta.dir, "test-names.tsv");

type Literal = { start: number; end: number; delimiter: string; text: string };

/** The index of the `}` that closes the `${` at `open`. */
function skipExpression(src: string, open: number): number {
  let depth = 1;
  let i = open + 2;
  for (; depth > 0; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'") {
      for (i++; src[i] !== c; i++) if (src[i] === "\\") i++;
    } else if (c === "`") {
      i = skipTemplate(src, i);
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
    }
  }
  return i - 1;
}

/** The index of the backtick that closes the template opened at `open`. */
function skipTemplate(src: string, open: number): number {
  let i = open + 1;
  for (; src[i] !== "`"; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "$" && src[i + 1] === "{") i = skipExpression(src, i);
  }
  return i;
}

function testNames(src: string): Literal[] {
  const found: Literal[] = [];
  for (const m of src.matchAll(/(["`])test_/g)) {
    const start = m.index!;
    const delimiter = m[1]!;
    let end = start + 1;
    if (delimiter === "`") {
      end = skipTemplate(src, start);
    } else {
      for (; src[end] !== '"'; end++) if (src[end] === "\\") end++;
    }
    found.push({ start, end, delimiter, text: src.slice(start + 1, end) });
  }
  return found;
}

/** The sentence a name says, before anyone reviews it: no `test_`, and spaces for underscores outside `${...}`. */
function proposed(name: string): string {
  let out = "";
  for (let i = 0; i < name.length; i++) {
    if (name[i] === "$" && name[i + 1] === "{") {
      const end = skipExpression(name, i);
      out += name.slice(i, end + 1);
      i = end;
    } else {
      out += name[i] === "_" ? " " : name[i];
    }
  }
  return out.replace(/^test /, "");
}

/** The parts of a name outside `${...}`, where a quote or backslash would end or escape the literal. */
function plainText(name: string): string {
  let out = "";
  for (let i = 0; i < name.length; i++) {
    if (name[i] === "$" && name[i + 1] === "{") i = skipExpression(name, i);
    else out += name[i];
  }
  return out;
}

const files = readdirSync(testDir).filter((f) => f.endsWith(".test.ts")).map((f) => join(testDir, f));
const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

if (process.argv.includes("--propose")) {
  const table = new Map(
    readFileSync(tablePath, "utf8").split("\n").filter(Boolean).map((row) => row.split("\t") as [string, string]),
  );
  for (const src of sources.values()) {
    for (const { text } of testNames(src)) if (!table.has(text)) console.log(`${text}\t${proposed(text)}`);
  }
  process.exit(0);
}

const rows = readFileSync(tablePath, "utf8").split("\n").filter(Boolean).map((row) => row.split("\t") as [string, string]);
const table = new Map(rows);
if (table.size !== rows.length) throw new Error("test-names.tsv names a test twice");
for (const [, sentence] of rows) if (/^test_/.test(sentence)) throw new Error(`still a test_ name: ${sentence}`);

const used = new Set<string>();
const missing: string[] = [];
const edits = new Map<string, string>();
for (const [file, src] of sources) {
  let out = src;
  for (const lit of testNames(src).reverse()) {
    const sentence = table.get(lit.text);
    if (sentence === undefined) {
      missing.push(lit.text);
      continue;
    }
    if (plainText(sentence).includes(lit.delimiter) || plainText(sentence).includes("\\")) throw new Error(`cannot write ${sentence} in ${lit.delimiter}`);
    used.add(lit.text);
    out = out.slice(0, lit.start + 1) + sentence + out.slice(lit.end);
  }
  edits.set(file, out);
}
const unused = rows.map(([old]) => old).filter((old) => !used.has(old));
if (missing.length > 0 || unused.length > 0) {
  for (const name of missing) console.error(`no row for ${name}`);
  for (const name of unused) console.error(`no test named ${name}`);
  process.exit(1);
}
for (const [file, out] of edits) if (out !== sources.get(file)) writeFileSync(file, out);
console.log(`renamed ${used.size} tests`);
