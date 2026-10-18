// The `upstream` remote that a fork init follows, and the URL it is given.
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Fail } from "./lib/fail.ts";
import { exists, pjoin, resolve } from "./lib/fs.ts";
import { git, redact, spawn } from "./lib/proc.ts";
import { quote, split } from "./lib/py.ts";
import { decode, decodeReplace } from "./lib/text.ts";

const NETWORK = /^([a-z][a-z0-9+.-]*:\/\/|[^/]*:)/i;

export function notAnOption(url: string): string {
  if (url.startsWith("-")) throw new Fail(`an upstream can't start with a dash: ${redact(url)}`);
  return url;
}

export function resolveFromCwd(root: string, url: string): string {
  if (resolve(".") === root || isAbsolute(url) || NETWORK.test(url)) return url;
  const here = resolve(url);
  return exists(here) ? here : url;
}

function localPath(root: string, url: string): string | null {
  if (/^file:\/\//i.test(url)) {
    try {
      return fileURLToPath(url);
    } catch {
      return null;
    }
  }
  return NETWORK.test(url) ? null : pjoin(root, url);
}

function commonDir(root: string, url: string): string | null {
  const path = localPath(root, url);
  for (const gitDir of path === null ? [] : [pjoin(path, ".git"), path]) {
    const r = spawn(["git", "--git-dir", gitDir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root });
    if (r.code === 0) return resolve(decode(r.stdout).trim());
  }
  return null;
}

function isThisRepo(root: string, url: string): boolean {
  const theirs = commonDir(root, git(["ls-remote", "--get-url", "--", url], { cwd: root }));
  return theirs !== null && theirs === commonDir(root, root);
}

export function notThisRepo(root: string, url: string): void {
  if (isThisRepo(root, url)) throw new Fail(`--upstream ${redact(url)} is this repo. Give the URL of the repo it follows.`);
}

function tipOf(root: string, label: string, repo: string, branch: string, shown = repo): string {
  const r = spawn(["git", "ls-remote", "--", repo, `refs/heads/${branch}`], { cwd: root });
  if (r.code !== 0) throw new Fail(redact(`couldn't read ${label} ${shown}:\n${decodeReplace(r.stderr).trim()}`));
  return split(decode(r.stdout))[0] ?? "";
}

export function checkedRemoteUrl(root: string, upstream: string, branch: string): string {
  const shown = redact(upstream);
  const fillIn = shown === upstream ? "" : ", add the credentials from --upstream to the URL in this command, since patchbook does not print them";
  const fix = `To follow ${shown}${fillIn}: git config --replace-all remote.upstream.url ${quote(shown)}`;
  const configured = git(["config", "--get-all", "remote.upstream.url"], { cwd: root, check: false });
  if (configured === "") throw new Fail(`the upstream remote has no url. ${fix}`);
  const fetches = git(["remote", "get-url", "upstream"], { cwd: root });
  if (isThisRepo(root, fetches)) throw new Fail(`the upstream remote fetches this repo (${redact(fetches)}). ${fix}`);
  const url = configured.split("\n")[0]!;
  if (fetches === upstream) return url;
  const theirs = tipOf(root, "the upstream remote", "upstream", branch, fetches);
  const mine = tipOf(root, "--upstream", upstream, branch);
  if (theirs === mine) return url;
  const tip = (sha: string) => sha.slice(0, 7) || "missing";
  throw new Fail(`the upstream remote and --upstream serve different commits for ${branch}. The remote fetches ${redact(fetches)}, --upstream is ${shown}. `
    + `${branch} is ${tip(theirs)} on the remote and ${tip(mine)} on --upstream. ${fix}`);
}
