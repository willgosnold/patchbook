export interface Target {
  /** Names the release asset, the npm package and the build output. */
  id: string;
  /** Value for `bun build --target`. */
  bun: string;
  /** Node's `process.platform`, which is also npm's `os` field. */
  os: string;
  /** Node's `process.arch`, which is also npm's `cpu` field. */
  cpu: string;
  /** npm's `libc` field. Only Linux targets have one. */
  libc?: "glibc" | "musl";
  ext: "" | ".exe";
}

export const BIN_NAME = "patchbook";

export const NPM_PREFIX = "@patchbook/";

export const TARGETS: readonly Target[] = [
  { id: "linux-x64", bun: "bun-linux-x64", os: "linux", cpu: "x64", libc: "glibc", ext: "" },
  { id: "linux-x64-musl", bun: "bun-linux-x64-musl", os: "linux", cpu: "x64", libc: "musl", ext: "" },
  { id: "linux-arm64", bun: "bun-linux-arm64", os: "linux", cpu: "arm64", libc: "glibc", ext: "" },
  { id: "linux-arm64-musl", bun: "bun-linux-arm64-musl", os: "linux", cpu: "arm64", libc: "musl", ext: "" },
  { id: "darwin-x64", bun: "bun-darwin-x64", os: "darwin", cpu: "x64", ext: "" },
  { id: "darwin-arm64", bun: "bun-darwin-arm64", os: "darwin", cpu: "arm64", ext: "" },
  { id: "win32-x64", bun: "bun-windows-x64", os: "win32", cpu: "x64", ext: ".exe" },
];

/** File name of a target's binary inside a package. */
export const binaryName = (t: Target) => `${BIN_NAME}${t.ext}`;
/** File name of a target's binary among the release assets. */
export const assetName = (t: Target) => `${BIN_NAME}-${t.id}${t.ext}`;
export const npmName = (t: Target) => `${NPM_PREFIX}${t.id}`;
