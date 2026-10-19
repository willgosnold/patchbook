import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const usage = () => {
  console.error("usage, inside a verify-patchbook sandbox: bun scripts/bench-hook.ts <dir> <name>=<patchbook binary>... [--runs 5] [--files 6000]");
  process.exit(2);
};
const argv = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const at = argv.indexOf(name);
  if (at === -1) return fallback;
  const value = Number(argv.splice(at, 2)[1]);
  return Number.isInteger(value) && value > 0 ? value : usage();
};
const runs = option("--runs", 5);
const fileCount = option("--files", 6000);
const [dirArg, ...sideArgs] = argv;
if (!dirArg || !sideArgs.length || sideArgs.some((arg) => !/^[^=]+=./.test(arg)) || !process.env["SB"]) usage();
const dir = resolve(dirArg!);
const sides = sideArgs.map((arg) => {
  const at = arg.indexOf("=");
  const name = arg.slice(0, at);
  return { name, bin: resolve(arg.slice(at + 1)), fork: join(dir, `fork-${name}`), path: join(dir, `bin-${name}`) };
});
const modelLog = join(process.env["SB"]!, "model-calls.log");

function sh(args: string[], cwd: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(args, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

function must(args: string[], cwd: string, env: Record<string, string> = {}) {
  const r = sh(args, cwd, env);
  if (r.code !== 0) throw new Error(`${args.join(" ")} in ${cwd} exited ${r.code}:\n${r.out}`);
  return r.out;
}

function* words(seed: number) {
  const pool = ["patch", "book", "upstream", "fork", "hook", "commit", "record", "build", "status", "change", "intent", "block", "entry", "the", "a", "of", "to", "and"];
  let x = seed;
  for (;;) {
    x = (x * 1103515245 + 12345) % 2147483648;
    yield pool[x % pool.length]!;
  }
}

function makeUpstream(up: string) {
  if (existsSync(join(up, ".git"))) return;
  mkdirSync(up, { recursive: true });
  const w = words(13);
  for (let i = 0; i < fileCount; i++) {
    const paragraphs = Array.from({ length: 40 }, () => Array.from({ length: 18 }, () => w.next().value).join(" ") + ".");
    const path = join(up, `docs/d${String(Math.floor(i / 100)).padStart(2, "0")}/f${String(i % 100).padStart(2, "0")}.md`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `# File ${i}\n\n${paragraphs.join("\n\n")}\n`);
  }
  must(["git", "init", "-q", "-b", "main"], up);
  must(["git", "add", "-A"], up);
  must(["git", "commit", "-qm", "upstream"], up);
}

function setUp(side: (typeof sides)[number]) {
  mkdirSync(side.path, { recursive: true });
  if (!existsSync(join(side.path, "patchbook"))) symlinkSync(side.bin, join(side.path, "patchbook"));
  if (!existsSync(side.fork)) {
    must(["patchbook", "clone", join(dir, "up"), side.fork], dir, env(side));
    must(["git", "commit", "-q", "--allow-empty", "-m", "settle"], side.fork, env(side));
  }
  // Git's auto gc packs loose objects once enough pile up, which speeds up reads mid-run, so every fork starts packed and stays that way.
  must(["git", "config", "gc.auto", "0"], side.fork);
  must(["git", "gc", "-q", "--prune=now"], side.fork);
}

const env = (side: (typeof sides)[number]) => ({ PATH: `${side.path}:${process.env["PATH"]}` });
const calls = () => (existsSync(modelLog) ? readFileSync(modelLog, "utf8").split("\n").filter(Boolean).length : 0);

type Op = { name: string; run(side: (typeof sides)[number]): { ms: number; ok: string | null } };

function timed(args: string[], cwd: string, e: Record<string, string>) {
  const start = performance.now();
  const r = sh(args, cwd, e);
  return { ms: performance.now() - start, ...r };
}

const ops: Op[] = [
  {
    name: "git commit, no hook",
    run(s) {
      const r = timed(["git", "commit", "-q", "--allow-empty", "-m", "plain"], s.fork, { ...env(s), PATCHBOOK_HOOK: "0" });
      return { ms: r.ms, ok: r.code === 0 ? null : r.out };
    },
  },
  {
    name: "patchbook status",
    run(s) {
      const r = timed(["patchbook", "status"], s.fork, env(s));
      return { ms: r.ms, ok: r.code === 0 && r.out.includes("no problems") ? null : r.out };
    },
  },
  {
    name: "hooked commit, nothing to record",
    run(s) {
      const before = must(["git", "rev-parse", "HEAD"], s.fork).trim();
      const r = timed(["git", "commit", "-q", "--allow-empty", "-m", "empty"], s.fork, env(s));
      const changed = must(["git", "diff", "--name-only", before, "HEAD"], s.fork).trim();
      return { ms: r.ms, ok: r.code === 0 && !changed ? null : `${r.out}\nchanged: ${changed}` };
    },
  },
  {
    name: "hooked commit, one-line edit",
    run(s) {
      const base = must(["git", "rev-parse", "HEAD"], s.fork).trim();
      const file = join(s.fork, "docs/d30/f50.md");
      const text = readFileSync(file, "utf8");
      writeFileSync(file, text.replace("# File 3050", "# File 3050, edited"));
      must(["git", "add", "docs/d30/f50.md"], s.fork);
      const asked = calls();
      const r = timed(["git", "commit", "-q", "-m", "edit"], s.fork, env(s));
      const recorded = must(["git", "show", "--name-only", "--format=", "HEAD"], s.fork);
      const ok = r.code === 0 && calls() === asked + 1 && recorded.includes(".patchbook/changes/model-name/ours/docs/d30/f50.md")
        ? null : `${r.out}\nmodel calls ${calls() - asked}\ncommitted:\n${recorded}`;
      must(["git", "reset", "-q", "--hard", base], s.fork);
      const left = must(["git", "status", "--porcelain", "--ignored"], s.fork).trim();
      return { ms: r.ms, ok: ok ?? (left ? `left behind:\n${left}` : null) };
    },
  },
];

makeUpstream(join(dir, "up"));
for (const s of sides) setUp(s);
const times = new Map<string, number[]>();
for (let round = 0; round <= runs; round++) {
  const order = round % 2 ? [...sides].reverse() : sides;
  for (const op of ops) {
    for (const s of order) {
      const { ms, ok } = op.run(s);
      if (ok !== null) throw new Error(`${op.name} failed for ${s.name} in round ${round}:\n${ok}`);
      if (round === 0) continue; // warm-up: page cache and git's index stat data
      const key = `${op.name}\t${s.name}`;
      times.set(key, [...(times.get(key) ?? []), ms]);
      console.error(`round ${round}\t${key}\t${(ms / 1000).toFixed(3)}`);
    }
  }
}

const seconds = (ms: number) => (ms / 1000).toFixed(2);
console.log(`operation\tside\tbest s\tmedian s\trange s\truns`);
for (const [key, ms] of times) {
  const sortedMs = [...ms].sort((x, y) => x - y);
  const median = sortedMs[Math.floor(sortedMs.length / 2)]!;
  console.log(`${key}\t${seconds(sortedMs[0]!)}\t${seconds(median)}\t${seconds(sortedMs[0]!)}-${seconds(sortedMs.at(-1)!)}\t${ms.length}`);
}
