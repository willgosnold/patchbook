// Every name src/sync.ts and src/lib/fs.ts import from `node:fs` must be exported here: a bundler can't re-export a builtin with `export *`.
import type { BunPlugin } from "bun";
import { existsSync, readFileSync, rmSync as remove, type RmOptions, type WriteFileOptions, writeFileSync as write } from "node:fs";

export {
  accessSync, appendFileSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync,
  statSync, symlinkSync, unlinkSync,
} from "node:fs";

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

export const crashPlugin: BunPlugin = {
  name: "crash",
  setup(build) {
    build.onLoad({ filter: /\/src\/(sync|lib\/fs)\.ts$/ }, ({ path }) => ({
      contents: readFileSync(path, "utf8").replace('from "node:fs"', `from ${JSON.stringify(import.meta.path)}`),
      loader: "ts",
    }));
  },
};
