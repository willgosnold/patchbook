import { expect, test } from "bun:test";
import { join } from "node:path";
import { Case, TIMEOUT } from "../helpers";
import { read } from "../e2e-fixtures.ts";

test("--version prints the package version", () => {
  const t = new Case();
  try {
    const out = t.pb(["--version"], { cwd: t.tmp }).stdout;
    expect(out).toBe(`patchbook ${JSON.parse(read(join(import.meta.dir, "../../package.json"))).version}\n`);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("help prints to stdout and exits 0", () => {
  const t = new Case();
  try {
    const out = t.pb(["sync", "--help"], { cwd: t.tmp });
    expect(out.stdout).toStartWith("usage: patchbook sync ");
    expect(out.stderr).toBe("");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("a usage error prints two lines to stderr and exits 2", () => {
  const t = new Case();
  try {
    const out = t.pb(["sync", "--forse"], { cwd: t.tmp, code: 2 });
    expect(out.stdout).toBe("");
    expect(out.stderr).toBe('patchbook sync: unknown option "--forse"\nRun `patchbook sync --help` for its arguments and options.\n');
  } finally {
    t.cleanup();
  }
}, TIMEOUT);
