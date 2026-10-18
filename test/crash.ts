// A preload for a source run of the CLI: src/sync.ts gets this module's rmSync, which kills the process
// just before it deletes an existing path that ends in CRASH_BEFORE_RM.
import { plugin } from "bun";
import { existsSync, readFileSync, rmSync as remove, type RmOptions } from "node:fs";

export * from "node:fs";

export function rmSync(path: string, options?: RmOptions): void {
  if (path.endsWith(process.env["CRASH_BEFORE_RM"]!) && existsSync(path)) process.kill(process.pid, "SIGKILL");
  remove(path, options);
}

plugin({
  name: "crash",
  setup(build) {
    build.onLoad({ filter: /\/src\/sync\.ts$/ }, ({ path }) => ({
      contents: readFileSync(path, "utf8").replace('from "node:fs"', `from ${JSON.stringify(import.meta.path)}`),
      loader: "ts",
    }));
  },
});
