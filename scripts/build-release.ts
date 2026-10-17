// Cross-compiles every target from one host and writes SHA256SUMS.
//   bun scripts/build-release.ts [--entry src/cli.ts] [--out dist/release] [--version 1.2.3]
//   bun scripts/build-release.ts --checksums-only    (after the darwin binaries are re-signed)
import { hash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BIN_NAME, TARGETS, assetName } from "./targets.ts";

const { values } = parseArgs({
  options: {
    entry: { type: "string", default: "src/cli.ts" },
    out: { type: "string", default: "dist/release" },
    version: { type: "string", default: process.env.PATCHBOOK_VERSION ?? "0.0.0-dev" },
    "checksums-only": { type: "boolean", default: false },
  },
});
const out = resolve(values.out);

function writeChecksums() {
  const prefix = `${BIN_NAME}-`;
  const lines = readdirSync(out)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => `${hash("sha256", readFileSync(join(out, name)))}  ${name}\n`);
  writeFileSync(join(out, "SHA256SUMS"), lines.join(""));
  console.log(`SHA256SUMS: ${lines.length} files`);
}

if (!values["checksums-only"]) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const target of TARGETS) {
    const outfile = join(out, assetName(target));
    console.log(`${target.id}: bun build --compile --target=${target.bun}`);
    const build = Bun.spawnSync(
      [
        process.execPath, "build", "--compile",
        `--target=${target.bun}`,
        "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
        "--define", `process.env.PATCHBOOK_VERSION=${JSON.stringify(values.version)}`,
        values.entry, "--outfile", outfile,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    if (build.exitCode !== 0) throw new Error(`${target.id}: bun build exited ${build.exitCode}`);
  }
}
writeChecksums();
