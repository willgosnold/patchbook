// The `upstream` remote that a fork init follows, and the URL it is given.
import { isAbsolute } from "node:path";
import { Fail } from "./lib/fail.ts";
import { exists, resolve } from "./lib/fs.ts";
import { git, redact, spawn } from "./lib/proc.ts";
import { quote, split } from "./lib/py.ts";
import { decode, decodeReplace } from "./lib/text.ts";

export function notAnOption(url: string): string {
  if (url.startsWith("-")) throw new Fail(`an upstream can't start with a dash: ${redact(url)}`);
  return url;
}

export function resolveFromCwd(root: string, url: string): string {
  if (resolve(".") === root || isAbsolute(url) || /^([a-z][a-z0-9+.-]*:\/\/|[^/]*:)/i.test(url)) return url;
  const here = resolve(url);
  return exists(here) ? here : url;
}

function tipOf(root: string, label: string, repo: string, branch: string, shown = repo): string {
  const r = spawn(["git", "ls-remote", "--", repo, `refs/heads/${branch}`], { cwd: root });
  if (r.code !== 0) throw new Fail(redact(`couldn't read ${label} ${shown}:\n${decodeReplace(r.stderr).trim()}`));
  return split(decode(r.stdout))[0] ?? "";
}

export function requireSameRepo(root: string, upstream: string, branch: string): void {
  const fix = `To follow ${redact(upstream)}: git config --replace-all remote.upstream.url ${quote(redact(upstream))}`;
  if (git(["config", "--get-all", "remote.upstream.url"], { cwd: root, check: false }) === "") throw new Fail(`the upstream remote has no url. ${fix}`);
  const fetches = git(["remote", "get-url", "upstream"], { cwd: root });
  if (fetches === upstream) return;
  const theirs = tipOf(root, "the upstream remote", "upstream", branch, fetches);
  const mine = tipOf(root, "--upstream", upstream, branch);
  if (theirs === mine) return;
  const tip = (sha: string) => sha.slice(0, 7) || "missing";
  throw new Fail(`the upstream remote and --upstream name different repos. The remote fetches ${redact(fetches)}, --upstream is ${redact(upstream)}. `
    + `${branch} is ${tip(theirs)} on the remote and ${tip(mine)} on --upstream. ${fix}`);
}
