import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LastSync, Problem, SyncReport } from "../src/api.ts";
import type { Assembly } from "../src/assemble.ts";
import type { Reserved } from "../src/book.ts";
import type { Edit } from "../src/changes.ts";

const sandbox = mkdtempSync(join(tmpdir(), "units"));
const ambientConfigHome = process.env["XDG_CONFIG_HOME"];
process.env["XDG_CONFIG_HOME"] = join(sandbox, "config");

const { applyStructure } = await import("../src/assemble.ts");
const { blockSpans, formatEntry, nearest, parsePlaceholders, readEntries } = await import("../src/blocks.ts");
const { Book, globRe, lockText, parseLock } = await import("../src/book.ts");
const { Change, editText, formatChange, parseChange } = await import("../src/changes.ts");
const { intentSettings, pendingDiff, PROVIDERS, writeIntent } = await import("../src/intent.ts");
const { Fail } = await import("../src/lib/fail.ts");
const { setToml, USER_CONFIG } = await import("../src/settings.ts");
const { lastSyncText, parseLastSync } = await import("../src/sync.ts");

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

describe("nearest", () => {
  test("gives the similarity as similarity rounds it", () => {
    expect(nearest("abcdefgh", [{ line: 3, hash: "h", upstream: "abcdeXYZ" }])).toEqual([{ line: 3, hash: "h", similarity: 0.63 }]);
  });

  test("keeps the two most alike from 0.4, ties in the order of the candidates", () => {
    const candidates = [
      { line: 1, hash: "far", upstream: "zzzzzzzz" },
      { line: 2, hash: "tie-a", upstream: "abcdXXXX" },
      { line: 3, hash: "close", upstream: "abcdefgX" },
      { line: 4, hash: "tie-b", upstream: "XXXXefgh" },
    ];
    expect(nearest("abcdefgh", candidates).map((n) => [n.hash, n.similarity])).toEqual([["close", 0.88], ["tie-a", 0.5]]);
    expect(nearest("abcdefgh", candidates, 3).map((n) => n.hash)).toEqual(["close", "tie-a", "tie-b"]);
  });

  test("keeps a candidate at exactly 0.4 and drops one that rounds to 0.39", () => {
    const candidates = [
      { line: 1, hash: "below", upstream: "abcdef" + "X".repeat(17) },
      { line: 2, hash: "at", upstream: "ab" },
    ];
    expect(nearest("abcdefgh", candidates)).toEqual([{ line: 2, hash: "at", similarity: 0.4 }]);
  });
});

describe("pendingDiff", () => {
  test("cuts a diff past 40000 characters without splitting one", () => {
    const current = new Map([["ab", { data: new TextEncoder().encode("😀".repeat(50000) + "\n"), mode: 0o644 as const }]]);
    const diff = pendingDiff({ out: new Map() } as unknown as Assembly, current, ["ab"]);
    expect(diff.endsWith("😀\n[diff truncated]\n")).toBe(true);
    expect(Array.from(diff).length).toBe(40000 + "\n[diff truncated]\n".length);
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

describe("formats", () => {
  const refusal = (run: () => unknown): string => {
    try {
      run();
    } catch (e) {
      if (e instanceof Fail) return e.message;
      throw e;
    }
    throw new Error("expected a refusal");
  };

  const ID = "a".repeat(40);
  const OTHER = "b".repeat(40);
  const pin = (name: string, commit = ID, tree = OTHER) => ({ name, commit, tree });

  describe("upstream.lock", () => {
    const entry = (name: string) => `    {\n      "name": ${JSON.stringify(name)},\n      "commit": "${ID}",\n      "tree": "${OTHER}"\n    }`;

    test("writes the pins sorted by name by code point, name first, as UTF-8", () => {
      const text = lockText([pin("lib"), pin("é"), pin("2"), pin("Zed")]);
      expect(text).toBe(`{\n  "version": 1,\n  "upstreams": [\n${["2", "Zed", "lib", "é"].map(entry).join(",\n")}\n  ]\n}\n`);
    });

    test("reads back what it writes", () => {
      const pins = [pin("2"), pin("Zed"), pin("lib", OTHER, ID), pin("é")];
      expect(parseLock(lockText([...pins].reverse()))).toEqual(pins);
    });

    test("writes no pins as an empty list", () => {
      expect(lockText([])).toBe('{\n  "version": 1,\n  "upstreams": []\n}\n');
    });

    const lock = (upstreams: string, version = '"version": 1, ') => `{${version}"upstreams": [${upstreams}]}`;
    const lib = `{"name": "lib", "commit": "${ID}", "tree": "${OTHER}"}`;

    test("refuses text that isn't JSON, naming the file", () => {
      expect(refusal(() => parseLock("<<<<<<< HEAD\n"))).toStartWith(".patchbook/upstream.lock isn't JSON: ");
    });

    test("refuses NaN as a value", () => {
      expect(refusal(() => parseLock(lock(`{"name": "lib", "commit": NaN, "tree": "${OTHER}"}`)))).toStartWith(".patchbook/upstream.lock isn't JSON: ");
    });

    test("refuses a value of the wrong type, naming its path", () => {
      expect(refusal(() => parseLock(lock(`${lib}, {"name": "x", "commit": 7, "tree": "${OTHER}"}`))))
        .toStartWith(".patchbook/upstream.lock: upstreams[1].commit must be a full object id (40 or 64 lowercase hex digits), not 7. ");
    });

    test("refuses an id that isn't a full lowercase hex id", () => {
      expect(refusal(() => parseLock(lock(`{"name": "lib", "commit": "abc", "tree": "${OTHER}"}`)))).toContain("upstreams[0].commit must be a full object id");
    });

    test("refuses a missing field", () => {
      expect(refusal(() => parseLock(lock(`${lib}, {"name": "x", "commit": "${ID}"}`)))).toStartWith(".patchbook/upstream.lock: upstreams[1].tree is missing. ");
    });

    test("refuses a name twice", () => {
      expect(refusal(() => parseLock(lock(`${lib}, ${lib}`)))).toStartWith(".patchbook/upstream.lock: upstreams[1] names lib, as upstreams[0] does. ");
    });

    test("refuses the lock from before it had a version, saying how to fix it", () => {
      const old = JSON.stringify({ lib: { commit: ID, tree: OTHER } });
      expect(refusal(() => parseLock(old))).toBe(
        '.patchbook/upstream.lock has no version, so an older patchbook wrote it. It holds {"version": 1, "upstreams": [{"name": ..., "commit": ..., "tree": ...}]}, one entry per upstream, sorted by name.',
      );
    });

    test("refuses another version", () => {
      expect(refusal(() => parseLock(lock(lib, '"version": 2, ')))).toStartWith(".patchbook/upstream.lock is version 2, from a newer patchbook; this one reads version 1. ");
    });

    test("ignores a key it doesn't know", () => {
      expect(parseLock(`{"version": 1, "note": "x", "upstreams": [{"name": "lib", "commit": "${ID}", "tree": "${OTHER}", "extra": 1}]}`)).toEqual([pin("lib")]);
    });
  });

  describe("last-sync.json", () => {
    const report = (name: string, from: string | null): SyncReport => ({
      name, from, to: ID, upstream: ["changed café/é.txt"], merged: [{ change: "shout", path: "a.txt" }],
      conflicts: [{ change: "shout", path: "b.txt", count: 2 }, { change: "shout", path: "c.bin", detail: "binary file changed upstream" }],
      gone: [{ change: "shout", path: "d.txt", maybe: ["e.txt"] }], replacedUpstreamChanged: ["shout: f.txt"],
    });
    const doc: LastSync = { version: 2, upstreams: [report("lib", null), report("2", OTHER)] };
    const entry = (name: string, from: string) => [
      "    {",
      `      "name": "${name}",`,
      `      "from": ${from},`,
      `      "to": "${ID}",`,
      '      "upstream": [',
      '        "changed café/é.txt"',
      "      ],",
      '      "merged": [',
      "        {",
      '          "change": "shout",',
      '          "path": "a.txt"',
      "        }",
      "      ],",
      '      "conflicts": [',
      "        {",
      '          "change": "shout",',
      '          "path": "b.txt",',
      '          "count": 2',
      "        },",
      "        {",
      '          "change": "shout",',
      '          "path": "c.bin",',
      '          "detail": "binary file changed upstream"',
      "        }",
      "      ],",
      '      "gone": [',
      "        {",
      '          "change": "shout",',
      '          "path": "d.txt",',
      '          "maybe": [',
      '            "e.txt"',
      "          ]",
      "        }",
      "      ],",
      '      "replacedUpstreamChanged": [',
      '        "shout: f.txt"',
      "      ]",
      "    }",
    ].join("\n");

    test("writes the reports in the order given, name first, as UTF-8", () => {
      expect(lastSyncText(doc)).toBe(`{\n  "version": 2,\n  "upstreams": [\n${entry("lib", "null")},\n${entry("2", `"${OTHER}"`)}\n  ]\n}\n`);
    });

    test("reads back what it writes, both kinds of conflict included", () => {
      expect(parseLastSync(lastSyncText(doc))).toEqual(doc);
    });

    const text = (change: (r: Record<string, unknown>) => void, version: unknown = 2): string => {
      const r: Record<string, unknown> = JSON.parse(lastSyncText(doc)).upstreams[1];
      change(r);
      return JSON.stringify({ version, upstreams: [r] });
    };
    const what = ".patchbook/last-sync.json";
    const fix = "It only reports past syncs: delete it, and the next patchbook sync writes a new one.";

    test("refuses text that isn't JSON", () => {
      expect(refusal(() => parseLastSync("{ not json"))).toStartWith(`${what} isn't JSON: `);
      expect(refusal(() => parseLastSync('{"version": 2, "upstreams": [{"count": NaN}]}'))).toStartWith(`${what} isn't JSON: `);
    });

    test("refuses a field of the wrong type, naming its path, and says how to fix the file", () => {
      expect(refusal(() => parseLastSync(text((r) => (r["merged"] = {}))))).toBe(`${what}: upstreams[0].merged must be a list, not an object. ${fix}`);
      expect(refusal(() => parseLastSync(text((r) => (r["from"] = 7))))).toStartWith(`${what}: upstreams[0].from must be a full object id`);
    });

    test("refuses a missing field", () => {
      expect(refusal(() => parseLastSync(text((r) => delete r["to"])))).toBe(`${what}: upstreams[0].to is missing. ${fix}`);
    });

    test("refuses a count that isn't a whole number", () => {
      const bad = text((r) => (r["conflicts"] = [{ change: "x", path: "y", count: 0 }])).replace('"count":0', '"count":1e400');
      expect(refusal(() => parseLastSync(bad))).toBe(`${what}: upstreams[0].conflicts[0].count must be a whole number from 0, not Infinity. ${fix}`);
    });

    test("refuses a conflict that is neither kind, naming the field it lacks", () => {
      expect(refusal(() => parseLastSync(text((r) => (r["conflicts"] = [{ change: "x", path: "y" }]))))).toBe(`${what}: upstreams[0].conflicts[0].detail is missing. ${fix}`);
    });

    test("refuses a name twice", () => {
      const twice = JSON.stringify({ version: 2, upstreams: [JSON.parse(lastSyncText(doc)).upstreams[0], JSON.parse(lastSyncText(doc)).upstreams[0]] });
      expect(refusal(() => parseLastSync(twice))).toBe(`${what}: upstreams[1] names lib, as upstreams[0] does. ${fix}`);
    });

    test("refuses the first version and the report from before versions", () => {
      expect(refusal(() => parseLastSync(text(() => {}, 1)))).toBe(`${what} is version 1, and this patchbook reads version 2. ${fix}`);
      const unversioned = JSON.stringify({ upstreams: { upstream: { from: null, to: ID } } });
      expect(refusal(() => parseLastSync(unversioned))).toBe(`${what} has no version, so an older patchbook wrote it. ${fix}`);
    });

    test("refuses the old snake_case key", () => {
      expect(refusal(() => parseLastSync(text((r) => ((r["replaced_upstream_changed"] = r["replacedUpstreamChanged"]), delete r["replacedUpstreamChanged"])))))
        .toBe(`${what}: upstreams[0].replacedUpstreamChanged is missing. ${fix}`);
    });
  });

  describe("a placeholder file with format = json", () => {
    test("gives each key a string, or a list of strings joined with a comma and a space", () => {
      const read = parsePlaceholders('{"greet": "Say hello.", "tools": ["a", "b"], "none": [], "naïve": "é"}', "strings.json");
      expect([...read]).toEqual([["greet", "Say hello."], ["tools", "a, b"], ["none", ""], ["naïve", "é"]]);
    });

    test("skips a key that starts with an underscore, whatever it holds", () => {
      expect([...parsePlaceholders('{"_note": 5, "_list": [1, {}], "a": "x"}', "strings.json")]).toEqual([["a", "x"]]);
    });

    test("takes constructor as a name like any other, and __proto__ as a comment", () => {
      expect([...parsePlaceholders('{"__proto__": 1, "constructor": "x"}', "strings.json")]).toEqual([["constructor", "x"]]);
    });

    test("refuses text that isn't JSON, naming the file", () => {
      expect(refusal(() => parsePlaceholders("greet: hi", "strings.json"))).toStartWith("strings.json isn't JSON: ");
      expect(refusal(() => parsePlaceholders('{"a": NaN}', "strings.json"))).toStartWith("strings.json isn't JSON: ");
    });

    test("refuses a document that isn't an object", () => {
      expect(refusal(() => parsePlaceholders('["a"]', "strings.json"))).toBe("strings.json must be an object, not a list.");
    });

    test("refuses a value that is neither, naming the key and what it is", () => {
      expect(refusal(() => parsePlaceholders('{"enabled": true}', "strings.json"))).toBe('strings.json: "enabled" must be a string or a list of strings, not true.');
      expect(refusal(() => parsePlaceholders('{"n": 1}', "strings.json"))).toBe('strings.json: "n" must be a string or a list of strings, not 1.');
      expect(refusal(() => parsePlaceholders('{"n": null}', "strings.json"))).toBe('strings.json: "n" must be a string or a list of strings, not null.');
      expect(refusal(() => parsePlaceholders('{"n": {"a": "b"}}', "strings.json"))).toBe('strings.json: "n" must be a string or a list of strings, not an object.');
    });

    test("refuses a list with something other than a string in it, naming the item", () => {
      expect(refusal(() => parsePlaceholders('{"a": ["x", 1]}', "strings.json"))).toBe('strings.json: "a"[1] must be a string, not 1.');
    });
  });
});

const SANDBOX_CONFIG = join(sandbox, "config", "patchbook", "config.toml");
const inSandbox = USER_CONFIG === SANDBOX_CONFIG;

test("settings.ts reads the user config from the sandbox", () => {
  expect({ actual: USER_CONFIG, expectedSandbox: SANDBOX_CONFIG }).toEqual({ actual: SANDBOX_CONFIG, expectedSandbox: SANDBOX_CONFIG });
});

test("no other test file loads a module outside src/lib, which could read settings before this file's sandbox", () => {
  const others = readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".ts") && f !== "units.test.ts");
  const loading = /^import (?!type )[^;]*?from "\.\.\/src\/(?!lib\/)|import\("\.\.\/src\/(?!lib\/)/m;
  expect(others.filter((f) => loading.test(readFileSync(new URL(f, import.meta.url), "utf8")))).toEqual([]);
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

describe.skipIf(!inSandbox)("writeIntent", () => {
  const ambient = process.env["PATCHBOOK_PROVIDER"];

  afterEach(() => {
    PROVIDERS.delete("fake");
    if (ambient === undefined) delete process.env["PATCHBOOK_PROVIDER"];
    else process.env["PATCHBOOK_PROVIDER"] = ambient;
  });

  const answering = async (script: string): Promise<Opened> => {
    PROVIDERS.set("fake", { model: "m", effort: "e", command: () => ["sh", "-c", `cat >/dev/null; ${script}`] });
    process.env["PATCHBOOK_PROVIDER"] = "fake";
    rmSync(USER_CONFIG, { force: true });
    const root = scratch();
    put(join(root, ".patchbook", "config.toml"), '[[upstream]]\nremote = "https://example.com/x.git"\nmount = ""\n');
    return Book.open(root);
  };

  test("shows the last 500 characters of a failed model's errors without splitting one", async () => {
    const book = await answering(`printf '${"😀".repeat(600)}!' >&2; exit 1`);
    expect(() => writeIntent(book, new Map(), "", "x", true)).toThrow(`fake failed: ${"😀".repeat(499)}!. Pass --intent instead.`);
  });

  test("shows the first 500 characters of an unusable reply without splitting one", async () => {
    const book = await answering(`printf '!${"😀".repeat(600)}'`);
    expect(() => writeIntent(book, new Map(), "", "x", true)).toThrow(`.\n!${"😀".repeat(499)}\nPass a name and --intent instead.`);
  });
});

describe("parseChange", () => {
  const parse = (edits: string[]) => {
    const dir = scratch();
    const path = put(join(dir, "edits", "CHANGE.md"), `# edits\n\nintent: Try paths.\n\nedits:\n${edits.join("\n")}\n`);
    const refused: [string, string][] = [];
    const change = parseChange(path, (edit, detail) => refused.push([edit, detail]));
    return { edits: change.edits, held: change.held, refused };
  };

  const KINDS = ["file", "add", "replace", "delete"] as const;

  const AWKWARD = (() => {
    const tokens = [" ", "\t", "\n", "\r", '"', "\\", "-", ">", " -> ", " ->", " ", "﻿", "\u0085", " ", "\0", "\x01", "\x1b", "\x1f", "\x7f", "😀", "é", "/", ".", "a", "b"];
    let seed = 155;
    const random = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let r = Math.imul(seed ^ (seed >>> 15), seed | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
    const names = ["a ->", "a -> b", "-> b", '"a', '"a"', "a\rb", "a\nb", " a", "a ", "﻿a", "a\tb", 'a"b', "a\\b", "/a", "a/", "a//b", ".", "a/../b", "", "a\0b"];
    for (let i = 0; i < 1000; i++) names.push(Array.from({ length: 1 + Math.floor(random() * 6) }, () => tokens[Math.floor(random() * tokens.length)]).join(""));
    return names;
  })();
  const clean = (path: string) => !path.includes("\0") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
  const fuzz = join(scratch(), "fuzz", "CHANGE.md");
  const readLine = (line: string): Edit[] | "held" | "failed" => {
    put(fuzz, `# fuzz\n\nintent: Try paths.\n\nedits:\n${line}\n`);
    try {
      const change = parseChange(fuzz, () => {});
      return change.held.length ? "held" : change.edits;
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      return "failed";
    }
  };

  test("reads a quoted path with nothing cut at either end", () => {
    const edits = [
      '- file " lead"', '- file "trail "', '- add "\uFEFFbom-lead"', '- delete "bom-trail\uFEFF"',
      '- replace "a/ b /c"', '- move " from\uFEFF " -> " to "', '- copy "from -> x" -> "\uFEFFto\uFEFF"',
    ];
    expect(parse(edits).edits).toEqual([
      { kind: "file", path: " lead" },
      { kind: "file", path: "trail " },
      { kind: "add", path: "\uFEFFbom-lead" },
      { kind: "delete", path: "bom-trail\uFEFF" },
      { kind: "replace", path: "a/ b /c" },
      { kind: "move", path: " from\uFEFF ", dest: " to " },
      { kind: "copy", path: "from -> x", dest: "\uFEFFto\uFEFF" },
    ]);
  });

  test("reads a bare path as written, so a space inside it or a quote or backslash that does not start it is part of it", () => {
    expect(parse(["- add a b/c d", '- add a"b', "- delete a\\b", "- move a -> b -> c"]).edits).toEqual([
      { kind: "add", path: "a b/c d" },
      { kind: "add", path: 'a"b' },
      { kind: "delete", path: "a\\b" },
      { kind: "move", path: "a", dest: "b -> c" },
    ]);
  });

  test("refuses a bare path that starts or ends with whitespace, for every kind, naming the file, the line and the quoted form", () => {
    for (const ws of [" ", "\t", "\uFEFF", "\u00A0", "\u3000"]) {
      for (const kind of KINDS) {
        const quoted = editText({ kind: "add", path: `a${ws}` }).slice("add ".length);
        expect(() => parse([`- ${kind} a${ws}`])).toThrow(`CHANGE.md:6: the path ${JSON.stringify(`a${ws}`)} starts or ends with whitespace; write it in double quotes: ${quoted}`);
        expect(() => parse([`- ${kind} ${ws}a`])).toThrow("CHANGE.md:6: the path ");
      }
      for (const kind of ["move", "copy"] as const) {
        expect(() => parse([`- ${kind} a${ws} -> b`])).toThrow("starts or ends with whitespace");
        expect(() => parse([`- ${kind} a -> b${ws}`])).toThrow("starts or ends with whitespace");
        expect(() => parse([`- ${kind} a -> ${ws}b`])).toThrow("starts or ends with whitespace");
      }
    }
  });

  test("a move destination with a trailing space is refused, not built under the name with the space", () => {
    expect(() => parse(["- move a.txt -> moved.txt "])).toThrow('CHANGE.md:6: the path "moved.txt " starts or ends with whitespace; write it in double quotes: "moved.txt "');
    expect(() => parse(["- copy a.txt -> copied.txt "])).toThrow("CHANGE.md:6: the path");
  });

  test("a line number counts from the top of the file", () => {
    expect(() => parse(["- file a", "- add b ", "- file c"])).toThrow("CHANGE.md:7: ");
  });

  test.each([
    ["is not closed", '- add "a'],
    ["has text after the closing quote", '- add "a" b'],
    ["has an escape that is not one", '- add "a\\qb"'],
    ["has an octal escape of fewer than three digits", '- add "a\\39b"'],
    ["has an octal escape above 377", '- add "a\\400b"'],
    ["has octal escapes that are not UTF-8", '- add "\\377"'],
    ["has a NUL", '- add "a\\000b"'],
    ["has a destination that is not closed", '- move a -> "b'],
    ["has text after the destination", '- move a -> "b" c'],
    ["has a source with text after it", '- move "a" b -> c'],
  ])("refuses a quoted path that %s", (_why, line) => {
    expect(() => parse([line])).toThrow(/CHANGE\.md:6: .*quoted path.*malformed.*\\" \\\\ \\t \\n/);
  });

  test("only move and copy take an arrow, quoted or not", () => {
    expect(() => parse(['- add "a" -> b'])).toThrow("only move and copy take");
    expect(() => parse(["- add a -> b"])).toThrow("only move and copy take");
    expect(() => parse(['- move "a"'])).toThrow("only move and copy take");
  });

  test("writes a path bare when the bare text reads back as that path", () => {
    for (const path of ["a.txt", "a b/c d", "a-b", "dir/sub dir/file.txt", "é/日本", "a>b", "a->b", "a ->b", "a- >b", "a'b", 'a"b', "a\\b", "a ->", "a b"]) {
      expect(editText({ kind: "add", path })).toBe(`add ${path}`);
    }
    for (const kind of ["move", "copy"] as const) expect(editText({ kind, path: "a", dest: "b -> c" })).toBe(`${kind} a -> b -> c`);
  });

  test.each([
    [" lead", '" lead"'],
    ["trail ", '"trail "'],
    ["﻿x", '"﻿x"'],
    ["x﻿", '"x﻿"'],
    [" x", '" x"'],
    ["a -> b", '"a -> b"'],
    ['"a', '"\\"a"'],
    ['"a"', '"\\"a\\""'],
    ["a\tb", '"a\\tb"'],
    ["a\nb", '"a\\nb"'],
    ["a\rb", '"a\\015b"'],
    ["a\x01b", '"a\\001b"'],
    ["a\x1bb", '"a\\033b"'],
    ["a\x7fb", '"a\\177b"'],
    ["a\u0085b", '"a\\302\\205b"'],
    ['"', '"\\""'],
  ])("writes %j in double quotes", (path, written) => {
    expect(editText({ kind: "add", path })).toBe(`add ${written}`);
    expect(parse([`- add ${written}`]).edits).toEqual([{ kind: "add", path }]);
  });

  test("refuses a bare path that holds a control character, and shows it only in quotes", () => {
    for (const ch of ["\t", "\x01", "\x1b", "\x7f", "\u0085"]) {
      const quoted = editText({ kind: "add", path: `a${ch}b` }).slice("add ".length);
      for (const line of [`- add a${ch}b`, `- move a${ch}b -> c`, `- copy c -> a${ch}b`]) {
        expect(() => parse([line])).toThrow(`CHANGE.md:6: a bare path can't hold a control character; write it in double quotes: ${quoted}`);
      }
    }
  });

  test("a move or copy writes each side by itself and reads it back", () => {
    for (const kind of ["move", "copy"] as const) {
      const edit = { kind, path: " from -> x", dest: 'to"\\\n ' };
      expect(editText(edit)).toBe(`${kind} " from -> x" -> "to\\"\\\\\\n "`);
      expect(parse([`- ${editText(edit)}`]).edits).toEqual([edit]);
      expect(editText({ kind, path: "a", dest: "b c" })).toBe(`${kind} a -> b c`);
    }
  });

  test("reads the escapes git writes for a path", () => {
    const escapes = '- add "\\a\\b\\f\\n\\r\\t\\v\\"\\\\ \\357\\273\\277 \\303\\251"';
    expect(parse([escapes]).edits).toEqual([{ kind: "add", path: '\x07\b\f\n\r\t\v"\\ \uFEFF é' }]);
  });

  test("what formatChange writes for any path parses back to the same edits", () => {
    const paths = [" lead", "trail ", "\uFEFFx", "x\uFEFF", "a -> b", 'q"q', "back\\slash", "t\tab", "new\nline", "ctl\x01\x1f\x7f", "plain", "in side"];
    const dir = scratch();
    const change = new Change("edits", join(dir, "edits"), "Try paths.");
    change.edits = paths.flatMap((path) => [
      { kind: "add" as const, path },
      { kind: "move" as const, path, dest: `${path}2` },
      { kind: "copy" as const, path: `1${path}`, dest: path },
    ]);
    const file = put(join(dir, "edits", "CHANGE.md"), formatChange(change));
    expect(parseChange(file, () => {}).edits).toEqual(change.edits);
  });

  test("holds an unsafe path as written", () => {
    const got = parse(['- file "../up "', "- add ../x"]);
    expect(got.edits).toEqual([]);
    expect(got.held).toEqual(['- file "../up "', "- add ../x"]);
    expect(got.refused.map(([edit]) => edit)).toEqual(['file "../up "', "add ../x"]);
  });

  test("a move or copy source that ends in an arrow reads back as itself, and so does the line record writes for it", () => {
    for (const kind of ["move", "copy"] as const) {
      const edit = { kind, path: "a ->", dest: "b.txt" };
      expect(parse([`- ${editText(edit)}`]).edits).toEqual([edit]);
      const dir = scratch();
      const file = put(join(dir, "mv", "CHANGE.md"), `# mv\n\nintent: Move a file.\n\nedits:\n- ${kind} "a ->" -> b.txt\n`);
      const change = parseChange(file, () => {});
      writeFileSync(file, formatChange(change));
      expect(parseChange(file, () => {}).edits).toEqual([edit]);
    }
  });

  test("a path with a slash at either end is refused, bare or quoted, and never read without the slash", () => {
    const lines = ["- move a.txt -> moved /", "- copy a.txt -> b/", "- move /a -> b", "- file a/", "- add /a", "- delete a /", '- add "a/"', '- replace "/a"', '- move "a" -> "b /"'];
    const got = parse(lines);
    expect(got.edits).toEqual([]);
    expect(got.held).toEqual(lines);
    for (const [, detail] of got.refused) expect(detail).toContain("no slash at the end");
  });

  test("every path the writer writes, as a single path, a source or a destination, reads back as itself, or is refused when it is not a clean path inside the tree, and is in quotes only when its bare text would not read back", () => {
    for (const [i, name] of AWKWARD.entries()) {
      const other = AWKWARD[(i + 1) % AWKWARD.length]!;
      const pair = i % 2 ? "copy" : "move";
      const single: Edit = { kind: KINDS[i % 4]!, path: name };
      for (const edit of [single, { kind: pair, path: name, dest: other }, { kind: pair, path: other, dest: name }] satisfies Edit[]) {
        const paths = "dest" in edit ? [edit.path, edit.dest] : [edit.path];
        const line = `- ${editText(edit)}`;
        expect({ line, got: readLine(line) }).toEqual({ line, got: paths.some((p) => p.includes("\0")) ? "failed" : paths.every(clean) ? [edit] : "held" });
      }
      const bare = `- ${single.kind} ${name}`;
      if (`- ${editText(single)}` !== bare) expect({ bare, got: readLine(bare) }).not.toEqual({ bare, got: [single] });
    }
  });

  test("a hand-written bare line is read exactly as written, with clean paths and no whitespace at an end or control character, or it is refused", () => {
    for (const [i, name] of AWKWARD.entries()) {
      const other = AWKWARD[(i + 1) % AWKWARD.length]!;
      for (const paths of [[name], [name, other]]) {
        const text = `${paths.length === 2 ? "move" : KINDS[i % 4]} ${paths.join(" -> ")}`;
        if (/[\r\n]/.test(text) || paths.some((p) => p.startsWith('"'))) continue;
        const got = readLine(`- ${text}`);
        if (typeof got === "string") continue;
        const read = "dest" in got[0]! ? [got[0].path, got[0].dest] : [got[0]!.path];
        expect({ text, read: `${got[0]!.kind} ${read.join(" -> ")}` }).toEqual({ text, read: text });
        for (const p of read) expect({ p, ok: clean(p) && !/^\s|\s$|\p{Cc}/u.test(p) }).toEqual({ p, ok: true });
      }
    }
  });

  test("an edit line starts in the first column, so an indented one is refused", () => {
    expect(() => parse(["  - file a"])).toThrow("expected `- <file|add|replace|delete|move|copy> <path>`");
    expect(() => parse(["\uFEFF- file a"])).toThrow("expected `- <file|add|replace|delete|move|copy> <path>`");
  });

  test("a line of only whitespace or a BOM between edits is blank", () => {
    expect(parse(["- file a", " \t\uFEFF", "- file b"]).edits.map((e) => e.path)).toEqual(["a", "b"]);
  });
});
