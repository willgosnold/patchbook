// The `upstream` remote that a fork init follows, and the URL it is given.
import { isAbsolute } from "node:path";
import { Fail } from "./lib/fail.ts";
import { exists, resolve } from "./lib/fs.ts";
import { git, redact, run, spawn } from "./lib/proc.ts";
import { quote, split } from "./lib/py.ts";
import { decode, decodeReplace } from "./lib/text.ts";

const NETWORK = /^([a-z][a-z0-9+.-]*:\/\/|[^/]*:)/i;

const gitLine = (root: string, args: string[]) => decode(run(["git", ...args], { cwd: root })).replace(/\n$/, "");

export function notAnOption(url: string): string {
  if (url.startsWith("-")) throw new Fail(`an upstream can't start with a dash: ${redact(url)}`);
  return url;
}

export function resolveFromCwd(root: string, url: string): string {
  if (resolve(".") === root || isAbsolute(url) || NETWORK.test(url)) return url;
  const here = resolve(url);
  return exists(here) ? here : url;
}

function hostEnd(url: string): number {
  const at = url.indexOf("@[");
  const start = at < 0 ? 0 : at + 1;
  return url[start] === "[" ? Math.max(url.indexOf("]", start + 1), 0) : 0;
}

function localPath(root: string, url: string): string | null {
  if (url.startsWith("file://")) {
    const bytes = Buffer.from(url.slice(7)).toString("latin1").replace(/%(?!00)([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    const slash = bytes.indexOf("/", hostEnd(bytes));
    return slash < 0 ? null : Buffer.from(bytes.slice(slash), "latin1").toString();
  }
  if (NETWORK.test(url)) return null;
  const path = url.slice(hostEnd(url));
  const home = process.env["HOME"];
  if (/^~(\/|$)/.test(path)) return home === undefined ? null : home + path.slice(1);
  return isAbsolute(path) ? path : `${root}/${path}`;
}

function commonDir(root: string, url: string): string | null {
  const path = localPath(root, url)?.replace(/(.)\/+$/, "$1");
  for (const gitDir of path === undefined ? [] : [`${path}/.git`, path, `${path}.git/.git`, `${path}.git`]) {
    const r = spawn(["git", "--git-dir", gitDir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root });
    if (r.code === 0) return resolve(decode(r.stdout).trim());
  }
  return null;
}

function isThisRepo(root: string, expanded: string): boolean {
  const theirs = commonDir(root, expanded);
  return theirs !== null && theirs === commonDir(root, root);
}

export function notThisRepo(root: string, url: string): void {
  if (isThisRepo(root, gitLine(root, ["ls-remote", "--get-url", "--", url]))) throw new Fail(`--upstream ${redact(url)} is this repo. Give the URL of the repo it follows.`);
}

function tipOf(root: string, label: string, repo: string, branch: string, shown = repo): string {
  const r = spawn(["git", "ls-remote", "--", repo, `refs/heads/${branch}`], { cwd: root });
  if (r.code !== 0) throw new Fail(redact(`couldn't read ${label} ${shown}:\n${decodeReplace(r.stderr).trim()}`));
  return split(decode(r.stdout))[0] ?? "";
}

function checkedRemoteUrl(root: string, upstream: string, branch: string): string {
  const shown = redact(upstream);
  const fillIn = shown === upstream ? "" : ", add the credentials from --upstream to the URL in this command, since patchbook does not print them";
  const fix = `To follow ${shown}${fillIn}: git config --replace-all remote.upstream.url ${quote(shown)}`;
  const urls = decode(run(["git", "config", "-z", "--get-all", "remote.upstream.url"], { cwd: root, check: false })).split("\0").slice(0, -1);
  const url = urls[urls.lastIndexOf("") + 1] ?? "";
  if (url === "") throw new Fail(`the upstream remote has no url. ${fix}`);
  const fetches = gitLine(root, ["remote", "get-url", "upstream"]);
  const expanded = gitLine(root, ["ls-remote", "--get-url", "--", url]);
  if (expanded !== fetches) throw new Fail(`the upstream remote fetches ${redact(fetches)}, but its url ${redact(url)} expands to ${redact(expanded)}. ${fix}`);
  if (isThisRepo(root, fetches)) throw new Fail(`the upstream remote fetches this repo (${redact(fetches)}). ${fix}`);
  if (fetches === upstream) return url;
  const theirs = tipOf(root, "the upstream remote", "upstream", branch, fetches);
  const mine = tipOf(root, "--upstream", upstream, branch);
  if (theirs === mine) return url;
  const tip = (sha: string) => sha.slice(0, 7) || "missing";
  throw new Fail(`the upstream remote and --upstream serve different commits for ${branch}. The remote fetches ${redact(fetches)}, --upstream is ${shown}. `
    + `${branch} is ${tip(theirs)} on the remote and ${tip(mine)} on --upstream. ${fix}`);
}

export function forkUpstream(root: string, upstream: string, branch: string): { follows: string; from: string; addRemote: boolean } {
  const remotes = split(git(["remote"], { cwd: root }));
  if (remotes.includes("upstream")) return { follows: redact(checkedRemoteUrl(root, upstream, branch)), from: "upstream", addRemote: false };
  if (remotes.includes(upstream)) throw new Fail(`--upstream ${upstream} names a remote of this repo, not a URL. Give its URL (git remote get-url ${upstream}).`);
  return { follows: redact(upstream), from: upstream, addRemote: true };
}
