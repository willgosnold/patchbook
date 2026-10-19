import { describe, expect, test } from "bun:test";
import type { LastSync, SyncReport } from "../src/api.ts";
import { Fail } from "../src/lib/fail.ts";
import {
  boolean, count, jsonText, list, named, nullable, object, oid, readJson, type Shape, string, table, versioned, writeJson,
} from "../src/lib/shape.ts";
import { lastSyncText, parseLastSync } from "../src/sync.ts";

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

describe("jsonText", () => {
  test("indents by two, keeps non-ASCII as UTF-8 and ends with a newline", () => {
    expect(jsonText({ s: "café 😀", n: [1, 0.9], z: null })).toBe('{\n  "s": "café 😀",\n  "n": [\n    1,\n    0.9\n  ],\n  "z": null\n}\n');
  });

  test("refuses a number that isn't finite, naming its key", () => {
    expect(() => jsonText({ n: NaN })).toThrow('"n"');
    expect(() => jsonText({ rows: [1, Infinity] })).toThrow("Infinity");
  });
});

describe("readJson", () => {
  const Doc = object({ name: string, tags: list(string), on: boolean });

  test("reads an object into a new one with the shape's keys in the shape's order", () => {
    const read = readJson('{"on": true, "extra": 1, "tags": ["x"], "name": "n"}', Doc, "f.json");
    expect(read).toEqual({ name: "n", tags: ["x"], on: true });
    expect(Object.keys(read)).toEqual(["name", "tags", "on"]);
  });

  test("refuses text that isn't JSON, naming the file", () => {
    expect(refusal(() => readJson("<<<<<<< HEAD", Doc, "f.json"))).toStartWith("f.json isn't JSON: ");
  });

  test("refuses NaN and Infinity as tokens", () => {
    expect(refusal(() => readJson('{"n": NaN}', Doc, "f.json"))).toStartWith("f.json isn't JSON: ");
    expect(refusal(() => readJson('{"n": Infinity}', Doc, "f.json"))).toStartWith("f.json isn't JSON: ");
  });

  test("names the path of a value of the wrong type, and what it is", () => {
    expect(refusal(() => readJson('{"name": 7, "tags": [], "on": true}', Doc, "f.json"))).toBe("f.json: name must be a string, not 7.");
    expect(refusal(() => readJson('{"name": "n", "tags": ["a", null], "on": true}', Doc, "f.json"))).toBe("f.json: tags[1] must be a string, not null.");
    expect(refusal(() => readJson('{"name": "n", "tags": {}, "on": true}', Doc, "f.json"))).toBe("f.json: tags must be a list, not an object.");
    expect(refusal(() => readJson('{"name": [], "tags": [], "on": 1}', Doc, "f.json"))).toBe("f.json: name must be a string, not a list.");
  });

  test("refuses a document that isn't an object with an empty path", () => {
    expect(refusal(() => readJson("[]", Doc, "f.json"))).toBe("f.json must be an object, not a list.");
  });

  test("names a missing field", () => {
    expect(refusal(() => readJson('{"name": "n", "tags": []}', Doc, "f.json"))).toBe("f.json: on is missing.");
  });

  test("puts the fix after the refusal", () => {
    expect(refusal(() => readJson("[]", Doc, "f.json", "Delete it."))).toBe("f.json must be an object, not a list. Delete it.");
  });

  test("takes __proto__ in a file as an ordinary key", () => {
    const One = object({ name: string });
    expect(refusal(() => readJson('{"__proto__": 1}', One, "f.json"))).toBe("f.json: name is missing.");
    expect(readJson('{"__proto__": 1, "name": "n"}', One, "f.json")).toEqual({ name: "n" });
    expect(Object.getPrototypeOf(readJson('{"__proto__": {"name": "x"}, "name": "n"}', One, "f.json"))).toBe(Object.prototype);
  });
});

describe("count", () => {
  const Doc = object({ n: count });

  test("reads a whole number from 0", () => {
    expect(readJson('{"n": 0}', Doc, "f.json")).toEqual({ n: 0 });
    expect(readJson('{"n": 3}', Doc, "f.json")).toEqual({ n: 3 });
  });

  test("refuses the Infinity that 1e400 reads as", () => {
    expect(refusal(() => readJson('{"n": 1e400}', Doc, "f.json"))).toBe("f.json: n must be a whole number from 0, not Infinity.");
  });

  test("refuses a fraction, a negative and a string", () => {
    expect(refusal(() => readJson('{"n": 1.5}', Doc, "f.json"))).toBe("f.json: n must be a whole number from 0, not 1.5.");
    expect(refusal(() => readJson('{"n": -1}', Doc, "f.json"))).toBe("f.json: n must be a whole number from 0, not -1.");
    expect(refusal(() => readJson('{"n": "1"}', Doc, "f.json"))).toBe('f.json: n must be a whole number from 0, not "1".');
  });
});

describe("oid", () => {
  const Doc = object({ id: oid });

  test("reads 40 or 64 lowercase hex digits", () => {
    expect(readJson(`{"id": "${ID}"}`, Doc, "f.json")).toEqual({ id: ID });
    expect(readJson(`{"id": "${"c".repeat(64)}"}`, Doc, "f.json")).toEqual({ id: "c".repeat(64) });
  });

  test("refuses anything else", () => {
    expect(refusal(() => readJson('{"id": "abc"}', Doc, "f.json"))).toStartWith('f.json: id must be a full object id');
    expect(refusal(() => readJson(`{"id": "${"A".repeat(40)}"}`, Doc, "f.json"))).toStartWith("f.json: id must be a full object id");
    expect(refusal(() => readJson('{"id": 7}', Doc, "f.json"))).toContain(", not 7.");
  });
});

describe("nullable", () => {
  test("reads null or the shape", () => {
    const Doc = object({ from: nullable(oid) });
    expect(readJson('{"from": null}', Doc, "f.json")).toEqual({ from: null });
    expect(readJson(`{"from": "${ID}"}`, Doc, "f.json")).toEqual({ from: ID });
    expect(refusal(() => readJson('{"from": "x"}', Doc, "f.json"))).toStartWith("f.json: from must be");
  });
});

describe("named", () => {
  const Doc = object({ upstreams: named(object({ name: string })) });

  test("keeps the list's order", () => {
    expect(readJson('{"upstreams": [{"name": "b"}, {"name": "a"}]}', Doc, "f.json").upstreams.map((u) => u.name)).toEqual(["b", "a"]);
  });

  test("refuses a name twice, naming both places", () => {
    expect(refusal(() => readJson('{"upstreams": [{"name": "lib"}, {"name": "x"}, {"name": "lib"}]}', Doc, "f.json")))
      .toBe("f.json: upstreams[2] names lib, as upstreams[0] does.");
  });
});

describe("versioned", () => {
  const Doc: Shape<{ version: 2; n: number }> = versioned(2, { n: count });

  test("reads the version first, then the fields", () => {
    const read = readJson('{"n": 1, "version": 2}', Doc, "f.json");
    expect(read).toEqual({ version: 2, n: 1 });
    expect(Object.keys(read)).toEqual(["version", "n"]);
  });

  test("refuses a missing version before anything else", () => {
    expect(refusal(() => readJson('{"n": "x"}', Doc, "f.json"))).toBe("f.json has no version, so an older patchbook wrote it.");
  });

  test("refuses an older and a newer version before anything else", () => {
    expect(refusal(() => readJson('{"version": 1, "n": "x"}', Doc, "f.json"))).toBe("f.json is version 1, and this patchbook reads version 2.");
    expect(refusal(() => readJson('{"version": 3, "n": "x"}', Doc, "f.json")))
      .toBe("f.json is version 3, from a newer patchbook; this one reads version 2.");
  });

  test("refuses a version that isn't a whole number", () => {
    expect(refusal(() => readJson('{"version": "2", "n": 1}', Doc, "f.json"))).toBe('f.json: version must be a whole number, not "2".');
  });
});

describe("table", () => {
  test("reads an object as a record, and refuses anything else", () => {
    expect(readJson('{"a": 1, "_b": [true]}', table, "f.json")).toEqual({ a: 1, _b: [true] });
    expect(refusal(() => readJson("[1]", table, "f.json"))).toBe("f.json must be an object, not a list.");
  });
});

describe("writeJson", () => {
  test("writes a value through its shape, so keys come in the shape's order", () => {
    const Doc = versioned(1, { a: string, b: string });
    expect(writeJson(Doc, { b: "2", a: "1", version: 1 })).toBe('{\n  "version": 1,\n  "a": "1",\n  "b": "2"\n}\n');
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
