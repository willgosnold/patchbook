import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carriesCrashInjection } from "../crash-build.ts";
import { CMD, TIMEOUT, sh } from "../helpers";

describe("CrashInjection", () => {
  test("the command under test carries no crash injection", () => {
    const src = join(import.meta.dir, "..", "..", "src");
    const shipped = process.env["PATCHBOOK_CMD"] ? [CMD[0]!] : (readdirSync(src, { recursive: true }) as string[]).filter((p) => p.endsWith(".ts")).map((p) => join(src, p));
    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.filter(carriesCrashInjection)).toEqual([]);
  });

  test("a crash build is found to carry crash injection", () => {
    const dir = mkdtempSync(join(tmpdir(), "crash"));
    try {
      const built = join(dir, "patchbook");
      sh([process.execPath, join(import.meta.dir, "..", "crash-build.ts"), "build", built], { cwd: dir });
      expect(carriesCrashInjection(built)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT);
});
