// Records clip.html to an MP4, one frame at a time, so the video is smooth however slow
// the screenshots are.
//
//   node promo/record.mjs [out.mp4]          the video, at 1080x1350
//   node promo/record.mjs --stills 2000 6500  PNGs of single moments, in ms
//
// Needs ffmpeg, and Playwright with its Chromium. Playwright isn't a dependency of
// patchbook; point PLAYWRIGHT_MODULE at an installed copy if `playwright` doesn't resolve,
// and CHROMIUM at a browser binary to use instead of Playwright's own.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FPS = Number(process.env.FPS ?? 30);
const SCALE = 1.5;

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const page = await browser.newPage({ viewport: { width: 720, height: 900 }, deviceScaleFactor: SCALE });
await page.goto(pathToFileURL(join(here, "clip.html")).href + "?record");
await page.evaluate(() => document.fonts.ready);
const stage = page.locator("#stage");

const args = process.argv.slice(2);
const outDir = join(here, "out");
mkdirSync(outDir, { recursive: true });

if (args[0] === "--stills") {
  for (const ms of args.slice(1)) {
    await page.evaluate((t) => seek(t), Number(ms));
    const path = join(outDir, `still-${ms}.png`);
    await stage.screenshot({ path });
    console.log(path);
  }
} else {
  const out = resolve(args[0] ?? join(outDir, "patchbook.mp4"));
  const duration = await page.evaluate(() => DURATION);
  const ffmpeg = spawn("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((ok, fail) => ffmpeg.on("close", (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited ${code}`)))));

  const frames = Math.round((duration / 1000) * FPS);
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => seek(t), (i * 1000) / FPS);
    const png = await stage.screenshot({ type: "png" });
    if (!ffmpeg.stdin.write(png)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
    if (i % FPS === 0) process.stdout.write(`\r${i}/${frames} frames`);
  }
  ffmpeg.stdin.end();
  await done;
  console.log(`\r${frames}/${frames} frames -> ${out}`);
}
await browser.close();
