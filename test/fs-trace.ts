// A preload for a source run of the CLI: every src/ module gets a node:fs whose sync calls first append the
// absolute paths they were given to the file named by PATCHBOOK_FS_TRACE, one path a line.
import { plugin } from "bun";
import * as fs from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src") + "/";
const PATH_ARGS: Record<string, number[]> = { renameSync: [0, 1], copyFileSync: [0, 1], linkSync: [0, 1], cpSync: [0, 1], symlinkSync: [1] };
const calls = Object.keys(fs).filter((name) => name.endsWith("Sync") && typeof fs[name as keyof typeof fs] === "function");

const traced = `
import * as fs from "node:fs";
import { resolve } from "node:path";
const log = process.env.PATCHBOOK_FS_TRACE;
const note = (args, at) => {
  for (const i of at) {
    const p = args[i];
    if (typeof p === "string" || p instanceof URL || Buffer.isBuffer(p)) fs.appendFileSync(log, resolve(String(p)) + "\\n");
  }
};
export * from "node:fs";
${calls.map((name) => `export const ${name} = (...a) => (note(a, ${JSON.stringify(PATH_ARGS[name] ?? [0])}), fs.${name}(...a));`).join("\n")}
`;

plugin({
  name: "fs-trace",
  setup(build) {
    build.module("patchbook-traced-fs", () => ({ contents: traced, loader: "js" }));
    build.onLoad({ filter: new RegExp(`^${SRC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*\\.ts$`) }, ({ path }) => ({
      contents: fs.readFileSync(path, "utf8").replaceAll('from "node:fs"', 'from "patchbook-traced-fs"'),
      loader: "ts",
    }));
  },
});
