import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Problem } from "../src/api.ts";
import type { Reserved } from "../src/book.ts";

const sandbox = mkdtempSync(join(tmpdir(), "units"));
const ambientConfigHome = process.env["XDG_CONFIG_HOME"];
process.env["XDG_CONFIG_HOME"] = join(sandbox, "config");

const { applyStructure } = await import("../src/assemble.ts");
const { blockSpans, formatEntry, readEntries } = await import("../src/blocks.ts");
const { Book, globRe } = await import("../src/book.ts");
const { Change } = await import("../src/changes.ts");
const { intentSettings, PROVIDERS } = await import("../src/intent.ts");
const { Fail } = await import("../src/lib/fail.ts");
const { setToml, USER_CONFIG } = await import("../src/settings.ts");

type Entry = ReturnType<typeof readEntries> extends Map<string, infer E> ? E : never;
type Source = ReturnType<typeof applyStructure> extends Map<string, infer S> ? S : never;
type Opened = Awaited<ReturnType<typeof Book.open>>;
type Layers = NonNullable<Parameters<typeof intentSettings>[2]>;

if (ambientConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
else process.env["XDG_CONFIG_HOME"] = ambientConfigHome;

let seq = 0;
const scratch = (): string => {
  const dir = join(sandbox, String(seq++));
  mkdirSync(dir, { recursive: true });
  return dir;
};
const put = (path: string, text: string): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const spans = (text: string): [number, number][] => blockSpans(text.split("\n"));

describe("blockSpans", () => {
  test("nothing, or only blank lines, has no blocks", () => {
    expect(blockSpans([])).toEqual([]);
    expect(spans("\n\n")).toEqual([]);
  });

  test("each run of non-blank lines is a block", () => {
    expect(spans("a\nb\n\nc\n\n\n\nd")).toEqual([[0, 2], [3, 4], [7, 8]]);
  });

  test("a trailing newline leaves no extra block", () => {
    expect(spans("a\n\nb\n")).toEqual([[0, 1], [2, 3]]);
  });

  test("lines of only whitespace separate blocks", () => {
    expect(spans("a\n \t \nb")).toEqual([[0, 1], [2, 3]]);
  });

  test("whitespace is what JavaScript's \\s matches, so a no-break space or a BOM is blank and \\x1c or U+0085 is not", () => {
    expect(spans("a\n\u00a0\ufeff\u3000\nb")).toEqual([[0, 1], [2, 3]]);
    expect(spans("a\n\x1c\x85\nb")).toEqual([[0, 3]]);
  });

  test("frontmatter is its own block, closed by the next ---", () => {
    expect(spans("---\nname: x\n---\ntext\n\nmore")).toEqual([[0, 3], [3, 4], [5, 6]]);
  });

  test("frontmatter is cut at the closing line even when a blank line follows it", () => {
    expect(spans("---\nname: x\n---\n\ntext")).toEqual([[0, 3], [4, 5]]);
  });

  test("a leading --- with no closing one is part of the first block", () => {
    expect(spans("---\ntext\n\nmore")).toEqual([[0, 2], [3, 4]]);
  });

  test("a --- that is not on the first line is not frontmatter", () => {
    expect(spans("intro\n---\nx\n---\ny")).toEqual([[0, 5]]);
  });

  test("blank lines inside a backtick fence do not end the block", () => {
    expect(spans("before\n\n```js\na\n\nb\n```\n\nafter")).toEqual([[0, 1], [2, 7], [8, 9]]);
  });

  test("a tilde fence works the same way", () => {
    expect(spans("~~~\na\n\nb\n~~~\n\nafter")).toEqual([[0, 5], [6, 7]]);
  });

  test("an indented fence still opens", () => {
    expect(spans("  ```\na\n\nb\n  ```\n\nafter")).toEqual([[0, 5], [6, 7]]);
  });

  test("a fence closes on a line of the same character that is at least as long", () => {
    expect(spans("````\na\n\n`````\n\nafter")).toEqual([[0, 4], [5, 6]]);
  });

  test("a shorter fence line does not close a longer fence", () => {
    expect(spans("````\na\n```\n\nb\n````\n\nafter")).toEqual([[0, 6], [7, 8]]);
  });

  test("the other fence character does not close a fence", () => {
    expect(spans("```\na\n~~~\n\nb\n```\n\nafter")).toEqual([[0, 6], [7, 8]]);
  });

  test("a closing fence line carrying text does not close", () => {
    expect(spans("```\na\n``` js\n\nb\n```\n\nafter")).toEqual([[0, 6], [7, 8]]);
  });

  test("an unclosed fence runs to the end of the file", () => {
    expect(spans("```\na\n\nb\n\nc")).toEqual([[0, 6]]);
  });

  test("a fence with no blank line before it stays in its block", () => {
    expect(spans("text\n```\ncode\n\nmore code\n```\nafter\n\nlast")).toEqual([[0, 7], [8, 9]]);
  });

  test("a fence after frontmatter opens as usual", () => {
    expect(spans("---\nk: v\n---\n```\na\n\nb\n```")).toEqual([[0, 3], [3, 8]]);
  });
});

describe("globRe", () => {
  const matches = (pattern: string, ...paths: string[]): boolean[] => paths.map((p) => globRe(pattern).test(p));

  test("a literal pattern matches only itself", () => {
    expect(matches("docs/guide.md", "docs/guide.md", "docs/guide.mdx", "x/docs/guide.md", "docs/guide-md")).toEqual([true, false, false, false]);
  });

  test("* stays within one folder", () => {
    expect(matches("*.md", "a.md", ".md", "dir/a.md", "a.mdx")).toEqual([true, true, false, false]);
    expect(matches("docs/*/x.md", "docs/a/x.md", "docs/x.md", "docs/a/b/x.md")).toEqual([true, false, false]);
  });

  test("? is one character that is not a slash", () => {
    expect(matches("a?c", "abc", "ac", "abbc", "a/c")).toEqual([true, false, false, false]);
  });

  test("? counts a character outside the BMP once", () => {
    expect(matches("a?", "a😀", "a")).toEqual([true, false]);
  });

  test("**/ matches no folder or any number of them", () => {
    expect(matches("**/*.md", "a.md", "d/a.md", "d/e/a.md", "d/a.txt")).toEqual([true, true, true, false]);
    expect(matches("a/**/b", "a/b", "a/x/b", "a/x/y/b", "a/xb", "b")).toEqual([true, true, true, false, false]);
  });

  test("a trailing ** matches everything below the folder", () => {
    expect(matches("docs/**", "docs/a", "docs/a/b.md", "docs", "other/a")).toEqual([true, true, false, false]);
  });

  test("a lone ** matches any path", () => {
    expect(matches("**", "", "a", "a/b/c")).toEqual([true, true, true]);
  });

  test("regex syntax in the pattern is literal", () => {
    expect(matches("a.b", "a.b", "axb")).toEqual([true, false]);
    expect(matches("(x)+[y]{2}|z^$", "(x)+[y]{2}|z^$", "xyyz")).toEqual([true, false]);
    expect(matches("a\\b", "a\\b", "ab")).toEqual([true, false]);
  });

  test("the match is anchored at both ends", () => {
    expect(matches("a", "a", "ba", "ab")).toEqual([true, false, false]);
  });
});

describe("setToml", () => {
  const file = (): string => join(scratch(), "nested", "config.toml");
  const read = (path: string): string => readFileSync(path, "utf8");

  test("creates the file and its folders with the section and key", () => {
    const path = file();
    setToml(path, "intent.model", "m");
    expect(read(path)).toBe('[intent]\nmodel = "m"\n');
  });

  test("appends a missing section after a blank line", () => {
    const path = put(file(), "[hook]\nenabled = false\n");
    setToml(path, "intent.model", "m");
    expect(read(path)).toBe('[hook]\nenabled = false\n\n[intent]\nmodel = "m"\n');
  });

  test("replaces the key where it is, keeping comments and other keys", () => {
    const path = put(file(), '# mine\n[intent]\nprovider = "claude"\nmodel = "old" # why\n# note\neffort = "high"\n');
    setToml(path, "intent.model", "new");
    expect(read(path)).toBe('# mine\n[intent]\nprovider = "claude"\nmodel = "new" # why\n# note\neffort = "high"\n');
  });

  test("adds a missing key to its section", () => {
    const path = put(file(), '[intent]\nprovider = "claude"\n\n[hook]\nenabled = true\n');
    setToml(path, "intent.model", "m");
    expect(read(path)).toBe('[intent]\nprovider = "claude"\nmodel = "m"\n\n[hook]\nenabled = true\n');
  });

  test("leaves a same-named key in another section alone", () => {
    const path = put(file(), '[a]\nmodel = "a"\n[intent]\nmodel = "old"\n[b]\nmodel = "b"\n');
    setToml(path, "intent.model", "new");
    expect(read(path)).toBe('[a]\nmodel = "a"\n[intent]\nmodel = "new"\n[b]\nmodel = "b"\n');
  });

  test("does not mistake a longer key for the one it sets", () => {
    const path = put(file(), '[intent]\nmodel_hint = "a"\nmodel = "b"\n');
    setToml(path, "intent.model", "c");
    expect(read(path)).toBe('[intent]\nmodel_hint = "a"\nmodel = "c"\n');
  });

  test("matches an indented key and keeps its indentation", () => {
    const path = put(file(), '[intent]\n  model   = "b"\n');
    setToml(path, "intent.model", "c");
    expect(read(path)).toBe('[intent]\n  model   = "c"\n');
  });

  test("removes a key and keeps the rest", () => {
    const path = put(file(), '[intent]\nprovider = "claude"\nmodel = "m"\n\n[hook]\nenabled = true\n');
    setToml(path, "intent.model", null);
    expect(read(path)).toBe('[intent]\nprovider = "claude"\n\n[hook]\nenabled = true\n');
  });

  test("removing a key that is not there changes nothing", () => {
    const text = '[intent]\nprovider = "claude"\n';
    const path = put(file(), text);
    setToml(path, "intent.model", null);
    setToml(path, "hook.enabled", null);
    expect(read(path)).toBe(text);
  });

  test("keeps the end of the file as it was, adding no newline", () => {
    const path = put(file(), '[intent]\nmodel = "m"\n');
    setToml(path, "intent.effort", "low");
    expect(read(path)).toBe('[intent]\nmodel = "m"\neffort = "low"\n');
    const blanks = put(file(), '[intent]\nmodel = "m"\n\n\n\n');
    setToml(blanks, "intent.effort", "low");
    expect(read(blanks)).toBe('[intent]\nmodel = "m"\neffort = "low"\n\n\n\n');
  });

  test("keeps the other sections valid TOML", () => {
    const path = put(file(), '[intent]\nprovider = "codex"\n\n[hook]\nenabled = true\n');
    setToml(path, "intent.model", "m");
    setToml(path, "hook.enabled", false);
    expect(Bun.TOML.parse(read(path))).toEqual({ intent: { provider: "codex", model: "m" }, hook: { enabled: false } });
  });
});

describe("entries", () => {
  const entry = (over: Partial<Entry> = {}): Entry => ({
    hash: "0123456789ab", kind: "translation", rules: "t3", intent: "Say T3.", upstream: "Open Cursor.", patched: "Open T3.", ...over,
  });
  const file = (...entries: Entry[]): string => put(join(scratch(), "x.entries"), entries.map(formatEntry).join("\n"));
  const roundTrip = (...entries: Entry[]): Entry[] => Array.from(readEntries(file(...entries)).values());

  test("formatEntry writes the head, the fields, then both texts", () => {
    expect(formatEntry(entry())).toBe(
      "=== entry 0123456789ab\nkind: translation\nrules: t3\nintent: Say T3.\n--- upstream\nOpen Cursor.\n--- patched\nOpen T3.\n",
    );
  });

  test("an entry survives a round trip", () => {
    expect(roundTrip(entry())).toEqual([entry()]);
  });

  test("several entries keep their order", () => {
    const all = [entry({ hash: "aaaaaaaaaaaa" }), entry({ hash: "bbbbbbbbbbbb", kind: "policy", rules: "" }), entry({ hash: "cccccccccccc", kind: "keep", patched: "Open Cursor." })];
    expect(roundTrip(...all)).toEqual(all);
  });

  test("multi-line texts with blank lines survive", () => {
    const e = entry({ upstream: "one\n\n  two\n```\nx\n\ny\n```", patched: "uno\n\n  dos" });
    expect(roundTrip(e)).toEqual([e]);
  });

  test("an empty patched text, a deleted block, survives", () => {
    const e = entry({ patched: "" });
    expect(roundTrip(e)).toEqual([e]);
  });

  test("a blank line around a text is trimmed", () => {
    const path = put(join(scratch(), "x.entries"), "=== entry 0123456789ab\nkind: keep\nrules: \nintent: Same.\n--- upstream\n\nkeep\n\n--- patched\n\nkeep\n\n");
    expect(readEntries(path).get("0123456789ab")).toEqual(entry({ kind: "keep", rules: "", intent: "Same.", upstream: "keep", patched: "keep" }));
  });

  test("a wrapped intent is joined with single spaces", () => {
    const path = put(join(scratch(), "x.entries"), "=== entry 0123456789ab\nkind: policy\nrules: \nintent: First part\n  second part\n\n   third\n--- upstream\nu\n--- patched\np\n");
    expect(readEntries(path).get("0123456789ab")?.intent).toBe("First part second part third");
  });

  test("the fields can come in any order", () => {
    const path = put(join(scratch(), "x.entries"), "=== entry 0123456789ab\nintent: I\nrules: r\nkind: translation\n--- upstream\nu\n--- patched\np\n");
    expect(readEntries(path).get("0123456789ab")).toEqual(entry({ intent: "I", rules: "r", upstream: "u", patched: "p" }));
  });

  test("an empty file has no entries", () => {
    expect(readEntries(put(join(scratch(), "x.entries"), "")).size).toBe(0);
  });

  test("a duplicate hash is refused, with its line", () => {
    const path = file(entry(), entry());
    expect(() => readEntries(path)).toThrow(Fail);
    expect(() => readEntries(path)).toThrow(`${path}:10: duplicate entry 0123456789ab`);
  });

  test("text before the first entry is refused", () => {
    const path = put(join(scratch(), "x.entries"), "stray\n=== entry 0123456789ab\n");
    expect(() => readEntries(path)).toThrow(`${path}:1: text before the first entry`);
  });

  test("a line that is not a field is refused", () => {
    const path = put(join(scratch(), "x.entries"), "=== entry 0123456789ab\nkind: keep\nbogus: 1\n");
    expect(() => readEntries(path)).toThrow(`${path}:3: expected one of kind, rules, intent`);
  });

  test("a head that is not 12 hex digits is not an entry", () => {
    const path = put(join(scratch(), "x.entries"), "=== entry XYZ\n");
    expect(() => readEntries(path)).toThrow("text before the first entry");
  });
});

describe("applyStructure", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const upstream = (...paths: string[]) => new Map(paths.map((p) => [p, { data: bytes(p), mode: 0o644 as const }]));
  const up = (path: string): Source => ({ kind: "up", path });
  const ours = (change: string, path: string): Source => ({ kind: "ours", change, path });
  const none = (): Reserved | null => null;
  const vendored = (p: string): Reserved | null => (p.startsWith("vendor/") ? { place: "the vendored copy vendor", refuse: false } : null);
  const change = (name: string, edits: ConstructorParameters<typeof Change>[3], withOurs: string[] = []) => {
    const c = new Change(name, scratch(), "intent", edits);
    for (const p of withOurs) c.write("ours", p, bytes(`ours ${p}`));
    return c;
  };
  const apply = (changes: InstanceType<typeof Change>[], files: ReturnType<typeof upstream>, held: (p: string) => Reserved | null = none) => {
    const problems: Problem[] = [];
    const tree = applyStructure(changes, files, problems, held);
    return { tree: Object.fromEntries([...tree].sort(([a], [b]) => (a < b ? -1 : 1))), problems };
  };

  test("with no changes every file comes from upstream", () => {
    expect(apply([], upstream("a", "d/b")).tree).toEqual({ a: up("a"), "d/b": up("d/b") });
  });

  test("a file edit leaves the structure alone", () => {
    const r = apply([change("c", [{ kind: "file", path: "a" }])], upstream("a"));
    expect(r).toEqual({ tree: { a: up("a") }, problems: [] });
  });

  describe("add", () => {
    test("puts the change's ours copy at a new path", () => {
      const r = apply([change("c", [{ kind: "add", path: "new.txt" }], ["new.txt"])], upstream("a"));
      expect(r).toEqual({ tree: { a: up("a"), "new.txt": ours("c", "new.txt") }, problems: [] });
    });

    test("refuses a path upstream already has", () => {
      const r = apply([change("c", [{ kind: "add", path: "a" }], ["a"])], upstream("a"));
      expect(r.tree).toEqual({ a: up("a") });
      expect(r.problems).toEqual([{ problem: "invalid", file: "changes/c", edit: "add a", detail: "a already exists; use replace" }]);
    });

    test("refuses a path that is inside a folder upstream has at that name", () => {
      const r = apply([change("c", [{ kind: "add", path: "d" }], ["d"])], upstream("d/b"));
      expect(r.problems).toMatchObject([{ problem: "invalid", detail: "d already exists; use replace" }]);
    });

    test("needs the ours copy", () => {
      const r = apply([change("c", [{ kind: "add", path: "new.txt" }])], upstream("a"));
      expect(r.tree).toEqual({ a: up("a") });
      expect(r.problems).toMatchObject([{ problem: "invalid", edit: "add new.txt", detail: "its ours copy is missing" }]);
    });

    test("refuses a path inside a vendored copy", () => {
      const r = apply([change("c", [{ kind: "add", path: "vendor/x" }], ["vendor/x"])], upstream("a"), vendored);
      expect(r.tree).toEqual({ a: up("a") });
      expect(r.problems).toMatchObject([{ problem: "invalid", detail: "vendor/x would be written into the vendored copy vendor" }]);
    });
  });

  describe("replace", () => {
    test("swaps the source of an existing path", () => {
      const r = apply([change("c", [{ kind: "replace", path: "a" }], ["a"])], upstream("a", "b"));
      expect(r).toEqual({ tree: { a: ours("c", "a"), b: up("b") }, problems: [] });
    });

    test("reports a path upstream no longer has", () => {
      const r = apply([change("c", [{ kind: "replace", path: "gone" }], ["gone"])], upstream("a"));
      expect(r.tree).toEqual({ a: up("a") });
      expect(r.problems).toEqual([{ problem: "gone", file: "changes/c", edit: "replace gone", detail: "gone no longer exists" }]);
    });

    test("needs the ours copy", () => {
      const r = apply([change("c", [{ kind: "replace", path: "a" }])], upstream("a"));
      expect(r.tree).toEqual({ a: up("a") });
      expect(r.problems).toMatchObject([{ problem: "invalid", detail: "its ours copy is missing" }]);
    });
  });

  describe("delete", () => {
    test("drops a file", () => {
      expect(apply([change("c", [{ kind: "delete", path: "a" }])], upstream("a", "b"))).toEqual({ tree: { b: up("b") }, problems: [] });
    });

    test("drops everything under a folder, and not a sibling with the same prefix", () => {
      const r = apply([change("c", [{ kind: "delete", path: "d" }])], upstream("d/x", "d/e/y", "dd/z"));
      expect(r).toEqual({ tree: { "dd/z": up("dd/z") }, problems: [] });
    });

    test("reports a path that is not there", () => {
      const r = apply([change("c", [{ kind: "delete", path: "nope" }])], upstream("a"));
      expect(r.tree).toEqual({ a: up("a") });
      expect(r.problems).toEqual([{ problem: "gone", file: "changes/c", edit: "delete nope", detail: "nope no longer exists" }]);
    });
  });

  describe("move", () => {
    test("renames a file and keeps its source", () => {
      const r = apply([change("c", [{ kind: "move", path: "a", dest: "z" }])], upstream("a", "b"));
      expect(r).toEqual({ tree: { b: up("b"), z: up("a") }, problems: [] });
    });

    test("renames a folder's contents", () => {
      const r = apply([change("c", [{ kind: "move", path: "d", dest: "e/f" }])], upstream("d/x", "d/g/y", "k"));
      expect(r).toEqual({ tree: { "e/f/g/y": up("d/g/y"), "e/f/x": up("d/x"), k: up("k") }, problems: [] });
    });

    test("refuses to land on an existing path", () => {
      const r = apply([change("c", [{ kind: "move", path: "a", dest: "b" }])], upstream("a", "b"));
      expect(r.tree).toEqual({ a: up("a"), b: up("b") });
      expect(r.problems).toEqual([{ problem: "invalid", file: "changes/c", edit: "move a -> b", detail: "b already exists" }]);
    });

    test("refuses to land in a vendored copy", () => {
      const r = apply([change("c", [{ kind: "move", path: "a", dest: "vendor/a" }])], upstream("a"), vendored);
      expect(r.tree).toEqual({ a: up("a") });
      expect(r.problems).toMatchObject([{ problem: "invalid", detail: "vendor/a would be written into the vendored copy vendor" }]);
    });

    test("reports a path that is not there", () => {
      const r = apply([change("c", [{ kind: "move", path: "nope", dest: "z" }])], upstream("a"));
      expect(r.problems).toMatchObject([{ problem: "gone", detail: "nope no longer exists" }]);
    });
  });

  describe("copy", () => {
    test("keeps the original and adds the copy", () => {
      const r = apply([change("c", [{ kind: "copy", path: "a", dest: "z" }])], upstream("a"));
      expect(r).toEqual({ tree: { a: up("a"), z: up("a") }, problems: [] });
    });

    test("refuses to land on an existing path", () => {
      const r = apply([change("c", [{ kind: "copy", path: "a", dest: "b" }])], upstream("a", "b"));
      expect(r.tree).toEqual({ a: up("a"), b: up("b") });
      expect(r.problems).toMatchObject([{ problem: "invalid", detail: "b already exists" }]);
    });
  });

  test("a later edit sees the tree an earlier one left", () => {
    const first = change("one", [{ kind: "move", path: "a", dest: "b" }]);
    const second = change("two", [{ kind: "replace", path: "b" }, { kind: "delete", path: "c" }], ["b"]);
    expect(apply([first, second], upstream("a", "c"))).toEqual({ tree: { b: ours("two", "b") }, problems: [] });
  });

  test("one failed edit does not stop the rest", () => {
    const c = change("c", [{ kind: "delete", path: "nope" }, { kind: "delete", path: "a" }]);
    const r = apply([c], upstream("a", "b"));
    expect(r.tree).toEqual({ b: up("b") });
    expect(r.problems).toHaveLength(1);
  });
});

const SANDBOX_CONFIG = join(sandbox, "config", "patchbook", "config.toml");
const inSandbox = USER_CONFIG === SANDBOX_CONFIG;

test("settings.ts reads the user config from the sandbox", () => {
  expect({ actual: USER_CONFIG, expectedSandbox: SANDBOX_CONFIG }).toEqual({ actual: SANDBOX_CONFIG, expectedSandbox: SANDBOX_CONFIG });
});

describe.skipIf(!inSandbox)("intentSettings", () => {
  const VARS = ["PATCHBOOK_PROVIDER", "PATCHBOOK_MODEL", "PATCHBOOK_EFFORT"];
  const claude = PROVIDERS.get("claude")!;
  const codex = PROVIDERS.get("codex")!;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries([...VARS, "PATH"].map((k) => [k, process.env[k]]));
    for (const k of VARS) delete process.env[k];
    if (inSandbox) rmSync(USER_CONFIG, { force: true });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const user = (text: string): void => void put(USER_CONFIG, text);
  const project = async (intent = ""): Promise<Opened> => {
    const root = scratch();
    put(join(root, ".patchbook", "config.toml"), `[[upstream]]\nremote = "https://example.com/x.git"\nmount = ""\n${intent}`);
    return Book.open(root);
  };
  const sources = (book: Opened | null) => {
    const map: Layers = new Map();
    const chosen = intentSettings(book, true, map);
    return { chosen, map: Object.fromEntries(map) };
  };

  test("with nothing set it uses the provider's own defaults", () => {
    process.env["PATCHBOOK_PROVIDER"] = "codex";
    expect(sources(null)).toEqual({
      chosen: ["codex", codex.model, codex.effort],
      map: { "intent.provider": "env" },
    });
  });

  test("the env var beats the project, and the project beats the user", async () => {
    user('[intent]\nmodel = "from-user"\neffort = "user-effort"\n');
    const book = await project('[intent]\nmodel = "from-project"\neffort = "project-effort"\n');
    process.env["PATCHBOOK_PROVIDER"] = "claude";
    process.env["PATCHBOOK_MODEL"] = "from-env";
    expect(sources(book)).toEqual({
      chosen: ["claude", "from-env", "project-effort"],
      map: { "intent.provider": "env", "intent.model": "env", "intent.effort": "project" },
    });
  });

  test("the user config applies when nothing above it does", async () => {
    user('[intent]\nprovider = "codex"\nmodel = "from-user"\n');
    const book = await project();
    expect(sources(book)).toEqual({
      chosen: ["codex", "from-user", codex.effort],
      map: { "intent.provider": "user", "intent.model": "user" },
    });
  });

  test("the project's provider beats the user's", async () => {
    user('[intent]\nprovider = "codex"\n');
    const book = await project('[intent]\nprovider = "claude"\n');
    expect(sources(book).chosen).toEqual(["claude", claude.model, claude.effort]);
    expect(sources(book).map["intent.provider"]).toBe("project");
  });

  test("a model written for another provider is skipped", async () => {
    const book = await project('[intent]\nprovider = "claude"\nmodel = "claude-only"\neffort = "max"\n');
    process.env["PATCHBOOK_PROVIDER"] = "codex";
    expect(sources(book)).toEqual({
      chosen: ["codex", codex.model, codex.effort],
      map: { "intent.provider": "env" },
    });
  });

  test("the skip falls through to the next layer that fits", async () => {
    user('[intent]\nmodel = "for-anyone"\n');
    const book = await project('[intent]\nprovider = "claude"\nmodel = "claude-only"\n');
    process.env["PATCHBOOK_PROVIDER"] = "codex";
    expect(sources(book).chosen).toEqual(["codex", "for-anyone", codex.effort]);
    expect(sources(book).map["intent.model"]).toBe("user");
  });

  test("a model with no provider beside it applies to whichever provider is chosen", async () => {
    const book = await project('[intent]\nmodel = "any"\n');
    process.env["PATCHBOOK_PROVIDER"] = "codex";
    expect(sources(book).chosen).toEqual(["codex", "any", codex.effort]);
  });

  test("a model written for this provider applies", async () => {
    const book = await project('[intent]\nprovider = "codex"\nmodel = "mine"\n');
    expect(sources(book).chosen).toEqual(["codex", "mine", codex.effort]);
  });

  test("an env var does not need to match the provider", () => {
    process.env["PATCHBOOK_PROVIDER"] = "claude";
    process.env["PATCHBOOK_EFFORT"] = "low";
    expect(sources(null).chosen).toEqual(["claude", claude.model, "low"]);
  });

  test("an empty env var counts as unset", async () => {
    const book = await project('[intent]\nmodel = "from-project"\n');
    process.env["PATCHBOOK_PROVIDER"] = "claude";
    process.env["PATCHBOOK_MODEL"] = "";
    expect(sources(book).chosen[1]).toBe("from-project");
  });

  test("the model and the effort are chosen on their own", async () => {
    const book = await project('[intent]\neffort = "project-effort"\n');
    process.env["PATCHBOOK_PROVIDER"] = "claude";
    process.env["PATCHBOOK_MODEL"] = "env-model";
    expect(sources(book).chosen).toEqual(["claude", "env-model", "project-effort"]);
  });

  test("an unknown provider is refused", () => {
    process.env["PATCHBOOK_PROVIDER"] = "gemini";
    expect(() => intentSettings(null, true)).toThrow(Fail);
    expect(() => intentSettings(null, true)).toThrow("intent.provider is one of claude, codex, not 'gemini'");
  });

  test("a setting of the wrong type is refused, naming the file", async () => {
    process.env["PATCHBOOK_PROVIDER"] = "claude";
    const book = await project("[intent]\nmodel = 3\n");
    expect(() => intentSettings(book, true)).toThrow(`intent.model in ${join(book.dir, "config.toml")} can't be 3`);
  });
});
