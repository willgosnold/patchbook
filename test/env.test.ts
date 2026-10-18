import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Case, Repo, sh } from "./helpers";

const SEEDED = "PATCHBOOK_ENV_TEST_SEEDED";
const ABSENT = "PATCHBOOK_HOME";

let before: Record<string, string | undefined>;
let ambient: Record<string, string | undefined>;

const current = (): Record<string, string | undefined> => ({ ...process.env });

beforeEach(() => {
  ambient = current();
  delete process.env[ABSENT];
  process.env[SEEDED] = "set before the case";
  before = current();
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ambient)) delete process.env[k];
  for (const [k, v] of Object.entries(ambient)) process.env[k] = v;
});

test("a live case leaves process.env alone", () => {
  const t = new Case();
  try {
    expect(current()).toEqual(before);
  } finally {
    t.cleanup();
  }
});

test("process.env is as it was after the case ends", () => {
  new Case().cleanup();
  expect(current()).toEqual(before);
});

test("a case keeps its settings in its own env", () => {
  const t = new Case();
  try {
    expect(t.env["PATCHBOOK_HOME"]).toBe(join(t.tmp, "store"));
    expect(t.env["GIT_AUTHOR_NAME"]).toBe("t");
    expect(t.env["PATCHBOOK_HOOK"]).toBe("0");
    expect(t.env[SEEDED]).toBe("set before the case");
  } finally {
    t.cleanup();
  }
});

test("repos still commit as the test identity", () => {
  const t = new Case();
  try {
    const repo = new Repo(join(t.tmp, "repo"));
    repo.write("a.txt", "a\n");
    repo.commit("first");
    expect(sh(["git", "log", "-1", "--format=%an <%ae>"], { cwd: repo.path }).stdout).toBe("t <t@t>\n");
  } finally {
    t.cleanup();
  }
  expect(current()).toEqual(before);
});
