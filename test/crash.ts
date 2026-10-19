// A preload for a source run of the CLI: src/sync.ts and src/lib/fs.ts get this module's rmSync, which kills the process
// just before it deletes an existing path that ends in CRASH_BEFORE_RM, and its writeFileSync, which kills it just
// before it writes a path that ends in CRASH_BEFORE_WRITE, and fails with EIO to write a path that ends in FAIL_WRITE.
import { plugin } from "bun";
import { existsSync, readFileSync, rmSync as remove, type RmOptions, type WriteFileOptions, writeFileSync as write } from "node:fs";

export * from "node:fs";

const endsIn = (path: string, variable: string): boolean => {
  const tail = process.env[variable];
  return !!tail && path.endsWith(tail);
};

export function rmSync(path: string, options?: RmOptions): void {
  if (endsIn(path, "CRASH_BEFORE_RM") && existsSync(path)) process.kill(process.pid, "SIGKILL");
  remove(path, options);
}

export function writeFileSync(path: string, data: string | NodeJS.ArrayBufferView, options?: WriteFileOptions): void {
  if (endsIn(path, "CRASH_BEFORE_WRITE")) process.kill(process.pid, "SIGKILL");
  if (endsIn(path, "FAIL_WRITE")) throw Object.assign(new Error(`EIO: i/o error, open '${path}'`), { errno: -5, code: "EIO", syscall: "open", path });
  write(path, data, options);
}

plugin({
  name: "crash",
  setup(build) {
    build.onLoad({ filter: /\/src\/(sync|lib\/fs)\.ts$/ }, ({ path }) => ({
      contents: readFileSync(path, "utf8").replace('from "node:fs"', `from ${JSON.stringify(import.meta.path)}`),
      loader: "ts",
    }));
  },
});
