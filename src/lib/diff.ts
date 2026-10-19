import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Fail } from "./fail.ts";
import { spawn } from "./proc.ts";
import { decodeReplace } from "./text.ts";

/** The diff git prints from old to fresh with its default settings, under `--- from` and `+++ to`; empty when they are equal.
 *
 * git gets no config, no attributes and none of our GIT_* variables, and finds no repo above the folder it runs in,
 * so the hunks are the same on every machine. */
export function unifiedDiff(old: Uint8Array, fresh: Uint8Array, from: string, to: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "tmp"));
  try {
    writeFileSync(join(tmp, "old"), old);
    writeFileSync(join(tmp, "new"), fresh);
    const env = { PATH: process.env["PATH"], HOME: tmp, GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: dirname(tmp) };
    const result = spawn(["git", "diff", "--no-index", "--text", "--", "old", "new"], { cwd: tmp, env });
    if (result.code === 0) return "";
    if (result.code !== 1) throw new Fail(`git diff failed:\n${decodeReplace(result.stderr).trim()}`);
    const out = decodeReplace(result.stdout);
    return `--- ${from}\n+++ ${to}\n${out.slice(out.indexOf("\n@@") + 1)}`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
