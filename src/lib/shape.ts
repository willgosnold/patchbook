// Reading JSON into typed values and writing values as JSON, the one way every patchbook format does both.
import { Fail } from "./fail.ts";

/** A value JSON.stringify writes as it is. No Map (written as {}), no undefined (dropped), no class instances. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** Where a value sits in its document, as `upstreams[1].commit`. "" is the whole document. */
type At = string;

/** A value isn't what its shape reads. `readJson` turns it into a Fail that names the file. */
export class ShapeError extends Error {
  constructor(readonly at: At, readonly problem: string) {
    super(at ? `${at} ${problem}` : problem);
  }
}

/**
 * Reads `value`, found at `at`, as a T, or throws ShapeError.
 * An object comes back new, with the shape's keys only, in the shape's order. Keys it doesn't know are dropped,
 * per DESIGN.md's version rule that a new field leaves the version alone.
 */
export type Shape<T> = (value: unknown, at: At) => T;
type Fields = Record<string, Shape<unknown>>;
type Read<F extends Fields> = { [K in keyof F]: F[K] extends Shape<infer T> ? T : never };

/** A value as a refusal names it: `7`, `null`, `"abc"`, `a list`, `an object`, `Infinity`. */
export function shown(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object" && value !== null) return "an object";
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

const wrong = (at: At, want: string, value: unknown) => new ShapeError(at, `must be ${want}, not ${shown(value)}`);
const child = (at: At, key: string) => (at ? `${at}.${key}` : key);

export const string: Shape<string> = (v, at) => {
  if (typeof v !== "string") throw wrong(at, "a string", v);
  return v;
};

export const boolean: Shape<boolean> = (v, at) => {
  if (typeof v !== "boolean") throw wrong(at, "true or false", v);
  return v;
};

/** A whole number from 0. Refuses Infinity, which JSON.parse makes of 1e400. */
export const count: Shape<number> = (v, at) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw wrong(at, "a whole number from 0", v);
  return v;
};

/** A full commit or tree id: 40 or 64 lowercase hex digits. */
export const oid: Shape<string> = (v, at) => {
  if (typeof v !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v)) throw wrong(at, "a full object id (40 or 64 lowercase hex digits)", v);
  return v;
};

export function nullable<T>(shape: Shape<T>): Shape<T | null> {
  return (v, at) => (v === null ? null : shape(v, at));
}

export function list<T>(item: Shape<T>): Shape<T[]> {
  return (v, at) => {
    if (!Array.isArray(v)) throw wrong(at, "a list", v);
    return v.map((x, i) => item(x, `${at}[${i}]`));
  };
}

/** A list of objects that each have a `name`, no name twice. The list's order is kept. */
export function named<T extends { name: string }>(item: Shape<T>): Shape<T[]> {
  return (v, at) => {
    const items = list(item)(v, at);
    const first = new Map<string, number>();
    items.forEach(({ name }, i) => {
      const seen = first.get(name);
      if (seen !== undefined) throw new ShapeError(`${at}[${i}]`, `names ${name}, as ${at}[${seen}] does`);
      first.set(name, i);
    });
    return items;
  };
}

/** A JSON object as a plain record, for the one user-keyed format (placeholders). */
export const table: Shape<Record<string, unknown>> = (v, at) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw wrong(at, "an object", v);
  return v as Record<string, unknown>;
};

/** An object with these fields, read with Object.hasOwn so `constructor` or `__proto__` in a file is just a key. */
export function object<F extends Fields>(fields: F): Shape<Read<F>> {
  return (v, at) => {
    const found = table(v, at);
    const out: Record<string, unknown> = {};
    for (const [key, shape] of Object.entries(fields)) {
      const path = child(at, key);
      if (!Object.hasOwn(found, key)) throw new ShapeError(path, "is missing");
      out[key] = shape(found[key], path);
    }
    return out as Read<F>;
  };
}

/**
 * A document whose first key is `version`. The version is checked before any other field,
 * so an old file is refused as old ("has no version", "is version 1") and not as malformed.
 */
export function versioned<V extends number, F extends Fields>(version: V, fields: F): Shape<{ version: V } & Read<F>> {
  const body = object(fields);
  return (v, at) => {
    const found = table(v, at);
    if (!Object.hasOwn(found, "version")) throw new ShapeError(at, "has no version, so an older patchbook wrote it");
    const got = found["version"];
    if (typeof got !== "number" || !Number.isSafeInteger(got)) throw wrong(child(at, "version"), "a whole number", got);
    if (got < version) throw new ShapeError(at, `is version ${got}, and this patchbook reads version ${version}`);
    if (got > version) throw new ShapeError(at, `is version ${got}, from a newer patchbook; this one reads version ${version}`);
    return { version, ...body(found, at) };
  };
}

/**
 * `text` read as JSON into T. Refuses with a Fail: "<what> isn't JSON: <parser message>.", "<what>: <at> must be <want>,
 * not <got>.", "<what>: <at> is missing.", or a version refusal. `fix`, when given, follows after a space.
 */
export function readJson<T>(text: string, shape: Shape<T>, what: string, fix?: string): T {
  const refuse = (message: string) => new Fail(fix ? `${message} ${fix}` : message);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    if (e instanceof SyntaxError) throw refuse(`${what} isn't JSON: ${e.message}.`);
    throw e;
  }
  try {
    return shape(value, "");
  } catch (e) {
    if (!(e instanceof ShapeError)) throw e;
    throw refuse(e.at ? `${what}: ${e.message}.` : `${what} ${e.message}.`);
  }
}

/** JSON as patchbook writes every format: two-space indent, non-ASCII as UTF-8, a newline at the end. Throws on NaN or Infinity, which JSON.stringify would write as null. */
export function jsonText(value: Json): string {
  const finite = (key: string, v: unknown) => {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`can't write ${v} as JSON, at key ${JSON.stringify(key)}`);
    return v;
  };
  return JSON.stringify(value, finite, 2) + "\n";
}

/** `value` put through its own shape first, so a file patchbook reads and one it writes have one key order. */
export function writeJson<T extends Json>(shape: Shape<T>, value: T): string {
  return jsonText(shape(value, ""));
}
