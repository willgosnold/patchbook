import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Source } from "../src/assemble.ts";
import { Change, type Edit } from "../src/changes.ts";
import type { File } from "../src/lib/fs.ts";
import { encode } from "../src/lib/text.ts";
import { classify, type Edited, needOf, type Snapshot } from "../src/record.ts";

const tmp = mkdtempSync(join(tmpdir(), "pb-record-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const f = (text: string): File => ({ data: encode(text), mode: 0o644 });
const change = (name: string, edits: Edit[], copies: Record<string, string> = {}): Change => {
  const c = new Change(name, join(tmp, name), `${name}.`, edits);
  for (const [path, text] of Object.entries(copies)) c.write("ours", path, encode(text));
  return c;
};
const added = change("added", [{ kind: "add", path: "skills/new.md" }], { "skills/new.md": "new\n" });
const replaced = change("replaced", [{ kind: "replace", path: "skills/rep.md" }], { "skills/rep.md": "rep\n" });
const templated = change("templated", [{ kind: "add", path: "skills/tpl.md" }], { "skills/tpl.md": "Uses {{snippet:v}}.\n" });
const owner = change("owner", [{ kind: "file", path: "skills/owned.md" }]);
const up = (path: string): Source => ({ kind: "up", path });
const ours = (c: Change, path: string): Source => ({ kind: "ours", change: c.name, path });

const draft = (hash: string, intent: string | null) => ({ hash, kind: "policy", rules: "", intent, upstream: "up", patched: "ours" });
const kept = draft("aaaaaaaaaaaa", "Speak T3.");
const fresh = draft("bbbbbbbbbbbb", null);
const plans = new Map([
  ["skills/para.md", { path: "", entries: new Map([[kept.hash, kept]]), notes: [] }],
  ["skills/para-new.md", { path: "", entries: new Map([[kept.hash, kept], [fresh.hash, fresh]]), notes: [] }],
]);

const cases: [path: string, built: string | null, disk: string | null, source: Source | null, is: Partial<Edited>, needsName: boolean][] = [
  ["fresh.md", null, "new", null, { kind: "add", staged: "skills/fresh.md" }, true],
  ["dropped.md", null, "back", up("skills/dropped.md"), { kind: "skip", reason: "a hook leaves it out of the build; change the hook to keep it" }, false],
  ["gone.md", "up", null, up("skills/gone.md"), { kind: "delete-upstream", staged: "skills/gone.md" }, true],
  ["gone-para.md", "up", null, up("skills/gone-para.md"), { kind: "delete-upstream", staged: "skills/gone-para.md" }, true],
  ["new.md", "new", null, ours(added, "skills/new.md"), { kind: "unadd", change: added, staged: "skills/new.md" }, false],
  ["rep.md", "rep", null, ours(replaced, "skills/rep.md"), { kind: "unreplace", change: replaced, staged: "skills/rep.md" }, false],
  ["copied.md", "new", "edited", ours(added, "skills/new.md"), { kind: "update-ours", change: added, staged: "skills/new.md" }, false],
  ["tpl.md", "Uses v.", "Uses w.", ours(templated, "skills/tpl.md"),
    { kind: "skip", reason: "its copy in templated uses placeholders; edit that copy directly" }, false],
  ["owned.md", "up", "edited", up("skills/owned.md"), { kind: "file-edit", rel: "skills/owned.md", to: { kind: "owned", change: owner } }, false],
  ["plain.md", "up", "edited", up("skills/plain.md"), { kind: "file-edit", rel: "skills/plain.md", to: { kind: "recorded", base: f("upstream") } }, true],
  ["moved.md", "up", "edited", up("skills/orig.md"), { kind: "file-edit", rel: "skills/orig.md", to: { kind: "recorded", base: f("upstream") } }, true],
  ["para.md", "up", "edited", up("skills/para.md"), { kind: "paragraph-edit", plan: plans.get("skills/para.md")! }, false],
  ["unplanned.md", "up", "edited", up("skills/unplanned.md"), { kind: "skip", reason: "no plan" }, false],
];
const pick = (i: 1 | 2) => new Map(cases.flatMap((c) => (c[i] === null ? [] : [[c[0], f(c[i])] as const])));
const world: Snapshot = {
  out: pick(1),
  current: pick(2),
  sources: new Map(cases.flatMap(([p, , , s]) => (s ? [[p, s] as const] : []))),
  upstream: new Map(cases.flatMap(([, , , s]) => (s?.kind === "up" ? [[s.path, f("upstream")] as const] : []))),
  changes: new Map([added, replaced, templated, owner].map((c) => [c.name, c])),
  owners: new Map([["skills/owned.md", owner]]),
  blocks: new Set(["skills/dropped.md", "skills/gone-para.md", "skills/para.md", "skills/para-new.md", "skills/unplanned.md"]),
  prefix: "skills/",
  plan: (rel) => plans.get(rel) ?? "no plan",
};

const one = (w: Snapshot, path: string): Edited => classify(w, [path])[0]!;

test.each(cases)("%s", (path, _built, _disk, _source, is, needsName) => {
  const e = one(world, path);
  expect(e).toMatchObject({ path, ...is });
  expect(needOf(e).named).toBe(needsName);
});

test("an owned file edit goes to the very change that owns it", () => {
  const e = one(world, "owned.md");
  expect(e.kind === "file-edit" && e.to.kind === "owned" && e.to.change).toBe(owner);
});

test("a paragraph edit needs an intent only for its new entries that have none", () => {
  const w = { ...world, out: new Map([["para-new.md", f("up")]]), current: new Map([["para-new.md", f("edited")]]),
    sources: new Map([["para-new.md", up("skills/para-new.md")]]) };
  expect(needOf(one(w, "para-new.md"))).toEqual({ named: false, drafts: [fresh] });
  expect(needOf(one(world, "para.md"))).toEqual({ named: false, drafts: [] });
});

test("a path built from nothing throws while classifying", () => {
  const w = { ...world, out: new Map([["ghost.md", f("x")]]), current: new Map([["ghost.md", f("y")]]) };
  expect(() => one(w, "ghost.md")).toThrow("ghost.md is built from nothing");
});

const twins = (sources: [string, Source][], edits: Record<string, string | null>): Snapshot => ({
  ...world,
  out: new Map(sources.map(([p]) => [p, f("built")])),
  current: new Map(Object.entries(edits).flatMap(([p, t]) => (t === null ? [] : [[p, f(t)] as const]))),
  sources: new Map(sources),
});

test("outputs built from one ours copy are all skipped when more than one is edited or deleted", () => {
  const w = twins([["new.md", ours(added, "skills/new.md")], ["new2.md", ours(added, "skills/new.md")], ["new3.md", ours(added, "skills/new.md")]],
    { "new.md": "a", "new2.md": null, "new3.md": "built" });
  expect(classify(w, ["new.md", "new2.md"])).toEqual([
    { kind: "skip", path: "new.md", reason: "its copy in added also builds new2.md, which this record changes too; edit added directly, or to give them different text, remove the copy edit and record the destination again" },
    { kind: "skip", path: "new2.md", reason: "its copy in added also builds new.md, which this record changes too; edit added directly, or to give them different text, remove the copy edit and record the destination again" },
  ]);
  expect(classify(w, ["new.md"])).toMatchObject([{ kind: "update-ours", path: "new.md" }]);
});

test("outputs built from one upstream file are all skipped when more than one is edited, but a delete stands alone", () => {
  const w = twins([["plain.md", up("skills/plain.md")], ["plain2.md", up("skills/plain.md")], ["plain3.md", up("skills/plain.md")]],
    { "plain.md": "a", "plain2.md": "b", "plain3.md": null });
  expect(classify(w, ["plain.md", "plain2.md", "plain3.md"])).toMatchObject([
    { kind: "skip", path: "plain.md", reason: "upstream's skills/plain.md also builds plain2.md, which this record changes too; edit only one of them, or to give them different text, remove the copy edit and record the destination again" },
    { kind: "skip", path: "plain2.md", reason: "upstream's skills/plain.md also builds plain.md, which this record changes too; edit only one of them, or to give them different text, remove the copy edit and record the destination again" },
    { kind: "delete-upstream", path: "plain3.md", staged: "skills/plain3.md" },
  ]);
  expect(classify(w, ["plain.md", "plain3.md"])).toMatchObject([{ kind: "file-edit", path: "plain.md" }, { kind: "delete-upstream", path: "plain3.md" }]);
});
