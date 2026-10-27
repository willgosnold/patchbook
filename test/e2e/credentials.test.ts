import { expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Case, Repo, TIMEOUT, sh } from "../helpers";
import { read, tree, setRemote, forkTest, repoState, fakeSsh, startingRepo } from "../e2e-fixtures.ts";

const CREDENTIAL_URLS: readonly (readonly [string, string, string, string])[] = [
  ["a password", "https://user:s3cretpw@host.invalid/team/up", "https://host.invalid/team/up", "s3cretpw"],
  ["a token as the user name", "https://s3cretpw@host.invalid/team/up", "https://host.invalid/team/up", "s3cretpw"],
  ["an ssh password", "ssh://git:s3cretpw@host.invalid/team/up", "ssh://git@host.invalid/team/up", "s3cretpw"],
  ["a token as the user name of a git+https URL", "git+https://s3cretpw@host.invalid/team/up", "git+https://host.invalid/team/up", "s3cretpw"],
  ["an ssh password with an encoded colon", "ssh://u%3ASEKRIT@127.0.0.1:1/team/up", "ssh://u@127.0.0.1:1/team/up", "SEKRIT"],
  ["an ssh password with a lower case encoded colon", "ssh://u%3aSEKRIT@127.0.0.1:1/team/up", "ssh://u@127.0.0.1:1/team/up", "SEKRIT"],
  ["a git+ssh password with an encoded colon", "git+ssh://u%3ASEKRIT@127.0.0.1:1/team/up", "git+ssh://u@127.0.0.1:1/team/up", "SEKRIT"],
  ["an ssh password with an encoded colon and an encoded at sign in the host", "ssh://u@127.0.0.1%3ASEKRIT%40x/team/up", "ssh://u@127.0.0.1%40x/team/up", "SEKRIT"],
  ...([["a no-break space", "\u00a0"], ["a space", " "], ["a tab", "\t"], ["a newline", "\n"]] as const).map(
    ([name, blank]) => [`a_password_with_${name}`, `https://user:SEKRITa${blank}SEKRITb@host.invalid/team/up`, "https://host.invalid/team/up", "SEKRIT"] as const,
  ),
];

const storeState = (t: Case): Record<string, string> | null => (existsSync(join(t.tmp, "store")) ? tree(join(t.tmp, "store")) : null);

const reachableAs = (t: Case, url: string, repo: Repo): void =>
  void Object.assign(t.env, {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `url.${repo.path}.insteadOf`, GIT_CONFIG_VALUE_0: url,
    GIT_CONFIG_KEY_1: "protocol.file.allow", GIT_CONFIG_VALUE_1: "always",
  });

const expectCredentialRefusal = ({ stdout, stderr }: { stdout: string; stderr: string }, shown: string, secret: string): void => {
  expect(stderr).toContain(`patchbook: ${shown} has credentials that patchbook would not keep.`);
  expect(stderr).toContain("Give git the password through a credential helper instead. See: git help credential");
  expect(stdout).not.toContain(secret);
  expect(stderr).not.toContain(secret);
};

for (const [how, url, shown, secret] of CREDENTIAL_URLS) {
  test(`clone refuses a URL with ${how} and creates nothing`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      reachableAs(t, url, up);
      const before = readdirSync(t.tmp).sort();
      const refused = t.pb(["clone", url, "fork"], { cwd: t.tmp, code: 1 });
      expectCredentialRefusal(refused, shown, secret);
      expect(readdirSync(t.tmp).sort()).toEqual(before);
      expect(storeState(t)).toBeNull();
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);

  for (const layout of ["fork", "folder"]) {
    test(`a ${layout} init refuses a URL with ${how} and writes nothing`, () => {
      const t = new Case();
      try {
        const { up, repo, output } = startingRepo(t, layout);
        reachableAs(t, url, up);
        const before = repoState(repo.path);
        const refused = t.pb(["init", "--upstream", url, ...output], { cwd: repo.path, code: 1 });
        expectCredentialRefusal(refused, shown, secret);
        expect(repoState(repo.path)).toEqual(before);
        expect(storeState(t)).toBeNull();
      } finally {
        t.cleanup();
      }
    }, TIMEOUT);
  }

  test(`track refuses a URL with ${how} and writes nothing`, () => {
    const t = new Case();
    try {
      const { up, repo } = startingRepo(t, "fork");
      t.pb(["init", "--upstream", up.path], { cwd: repo.path });
      repo.commit("start a patchbook");
      const extra = new Repo(join(t.tmp, "extra"));
      extra.write("lib.txt", "lib\n");
      extra.commit("start");
      reachableAs(t, url, extra);
      const before = repoState(repo.path);
      const store = storeState(t);
      const refused = t.pb(["track", "extra", url], { cwd: repo.path, code: 1 });
      expectCredentialRefusal(refused, shown, secret);
      expect(repoState(repo.path)).toEqual(before);
      expect(storeState(t)).toEqual(store);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("init and track still take an ssh URL with only a user name", () => {
  const t = new Case();
  try {
    fakeSsh(t);
    const { up, repo } = startingRepo(t, "fork");
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("lib.txt", "lib\n");
    extra.commit("start");
    const given = `ssh://git@fake${up.path}`;
    t.pb(["init", "--upstream", given], { cwd: repo.path });
    expect(repo.read(".patchbook/config.toml")).toContain(`remote = "${given}"`);
    expect(sh(["git", "remote", "get-url", "upstream"], { cwd: repo.path }).stdout.trim()).toBe(given);
    repo.commit("start a patchbook");
    t.pb(["track", "extra", `ssh://git@fake${extra.path}`], { cwd: repo.path });
    expect(repo.read(".patchbook/config.toml")).toContain(`remote = "ssh://git@fake${extra.path}"`);
  } finally {
    delete process.env["GIT_SSH_COMMAND"];
    t.cleanup();
  }
}, TIMEOUT);

test("init and track still take an ssh URL whose user name has an encoded character and no colon", () => {
  const t = new Case();
  try {
    fakeSsh(t);
    const { up, repo } = startingRepo(t, "fork");
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("lib.txt", "lib\n");
    extra.commit("start");
    const given = `ssh://g%69t@fake${up.path}`;
    t.pb(["init", "--upstream", given], { cwd: repo.path });
    expect(repo.read(".patchbook/config.toml")).toContain(`remote = "${given}"`);
    repo.commit("start a patchbook");
    t.pb(["track", "extra", `ssh://g%69t@fake${extra.path}`], { cwd: repo.path });
    expect(repo.read(".patchbook/config.toml")).toContain(`remote = "ssh://g%69t@fake${extra.path}"`);
  } finally {
    delete process.env["GIT_SSH_COMMAND"];
    t.cleanup();
  }
}, TIMEOUT);

const unreachable = [
  ["a password", "https://user:s3cretpw@127.0.0.1:1/x.git"],
  ["a password with an encoded at sign", "https://user:p%40s3cretpw@127.0.0.1:1/x.git"],
  ["an ssh password with an encoded colon", "ssh://u%3As3cretpw@127.0.0.1:1/x.git"],
] as const;

for (const command of ["check", "status", "sync"]) {
  for (const [what, remote] of unreachable) {
    forkTest(`${command} does not print ${what} of an upstream remote it cannot reach`, (t) => {
      setRemote(join(t.fork.path, ".patchbook/config.toml"), remote);
      const out = t.pb([command], { cwd: t.fork.path, code: null });
      if (command !== "status") expect(out.stderr).toContain("127.0.0.1:1/x.git");
      expect(out.stderr + out.stdout).not.toContain("s3cretpw");
    });
  }
}

for (const command of ["check", "sync"]) {
  forkTest(`${command} does not print the password of a tracked upstream's remote it cannot reach`, (t) => {
    const extra = new Repo(join(t.tmp, "extra"));
    extra.write("lib.txt", "lib\n");
    extra.commit("start");
    t.pb(["track", "extra", extra.path], { cwd: t.fork.path });
    t.fork.commit("track");
    const config = join(t.fork.path, ".patchbook/config.toml");
    writeFileSync(config, read(config).replace(`remote = "${extra.path}"`, 'remote = "https://user:s3cretpw@127.0.0.1:1/x.git"'));
    const out = t.pb([command], { cwd: t.fork.path, code: null });
    expect(out.stderr).toContain("127.0.0.1:1/x.git");
    expect(out.stderr + out.stdout).not.toContain("s3cretpw");
  });
}

forkTest("status names an upstream with no name by its host, not the password in its remote", (t) => {
  const config = join(t.fork.path, ".patchbook/config.toml");
  writeFileSync(config, read(config).replace(/^name = .*\n/m, "").replace(/^remote = .*$/m, 'remote = "https://user:s3cretpw@127.0.0.1:1"'));
  const out = t.pb(["status"], { cwd: t.fork.path, code: 1 });
  expect(out.stderr).toContain("upstream 127.0.0.1:1 has no pin yet");
  expect(out.stderr + out.stdout).not.toContain("s3cretpw");
});
