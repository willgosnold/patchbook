import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { crashPlugin } from "./crash.ts";

const ENTRY = resolve(import.meta.dir, "..", "src", "cli.ts");
const MARKERS = ["CRASH_BEFORE_RM", "CRASH_BEFORE_WRITE"];

export async function buildCrash(outfile: string): Promise<void> {
  const built = await Bun.build({
    entrypoints: [ENTRY],
    plugins: [crashPlugin],
    compile: { outfile, autoloadDotenv: false, autoloadBunfig: false },
  });
  if (!built.success) throw new Error(`crash build failed:\n${built.logs.join("\n")}`);
}

export const carriesCrashInjection = (file: string): boolean => {
  const bytes = readFileSync(file);
  return MARKERS.some((marker) => bytes.includes(marker));
};

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "build" && args.length === 1) {
    await buildCrash(resolve(args[0]!));
  } else if (mode === "check" && args.length > 0) {
    const tainted = args.filter(carriesCrashInjection);
    for (const file of tainted) console.error(`${file} carries crash-injection code`);
    if (tainted.length) process.exit(1);
    console.log(`no crash-injection code in ${args.length} file(s)`);
  } else {
    console.error("usage: bun test/crash-build.ts build <outfile> | check <file>...");
    process.exit(2);
  }
}
