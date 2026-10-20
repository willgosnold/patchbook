// Stages the npm packages for a release from the compiled binaries.
//   bun scripts/gen-npm-packages.ts --version 1.2.3 [--release dist/release] [--out dist/npm]
// Writes <out>/patchbook (the @patchbook/cli package) and one <out>/<target id> per entry in scripts/targets.ts.
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { TARGETS, assetName, binaryName, npmName } from "./targets.ts";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    release: { type: "string", default: "dist/release" },
    out: { type: "string", default: "dist/npm" },
  },
});
const version = values.version;
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`--version must be a semver like 1.2.3 or 1.2.3-rc.1, got ${version}`);
}
const release = resolve(values.release);
const out = resolve(values.out);
const source = resolve(import.meta.dirname, "../npm/patchbook");

const writeJson = (path: string, data: unknown) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);

rmSync(out, { recursive: true, force: true });

const main = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
const mainDir = join(out, "patchbook");
cpSync(source, mainDir, { recursive: true });
copyFileSync("LICENSE", join(mainDir, "LICENSE"));
const tsc = Bun.spawnSync(
  ["node_modules/.bin/tsc", "--ignoreConfig", "src/api.ts", "--declaration", "--emitDeclarationOnly",
    "--strict", "--target", "esnext", "--outDir", mainDir],
  { stdout: "inherit", stderr: "inherit" },
);
if (tsc.exitCode !== 0) throw new Error("tsc couldn't write api.d.ts");
writeJson(join(mainDir, "package.json"), {
  ...main,
  version,
  optionalDependencies: Object.fromEntries(TARGETS.map((t) => [npmName(t), version])),
});
writeJson(
  join(mainDir, "bin/targets.json"),
  TARGETS.map((t) => ({ id: t.id, pkg: npmName(t), os: t.os, cpu: t.cpu, libc: t.libc, exe: binaryName(t) })),
);

for (const t of TARGETS) {
  const dir = join(out, t.id);
  mkdirSync(join(dir, "bin"), { recursive: true });
  const binary = join(dir, "bin", binaryName(t));
  copyFileSync(join(release, assetName(t)), binary);
  // npm keeps a file's mode only when it is executable on disk, so make sure it is.
  chmodSync(binary, 0o755);
  copyFileSync("LICENSE", join(dir, "LICENSE"));
  writeJson(join(dir, "package.json"), {
    name: npmName(t),
    version,
    description: `The patchbook binary for ${t.id}. Install \`${main.name}\` instead.`,
    license: main.license,
    repository: main.repository,
    homepage: main.homepage,
    bugs: main.bugs,
    os: [t.os],
    cpu: [t.cpu],
    ...(t.libc && { libc: [t.libc] }),
    files: ["bin"],
  });
  writeFileSync(
    join(dir, "README.md"),
    `# ${npmName(t)}\n\nThe ${t.id} binary for [patchbook](${main.homepage}). Install \`${main.name}\`, which depends on this package.\n`,
  );
}
console.log(`${TARGETS.length + 1} packages in ${out}`);
