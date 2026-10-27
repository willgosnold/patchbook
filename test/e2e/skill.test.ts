import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Case, Repo, TIMEOUT, permissionTest, sh } from "../helpers";
import { read, isSymlink, tree, committedFiles, SKILL_FILE, initFork } from "../e2e-fixtures.ts";

const SKILL_LINK = ".claude/skills/patchbook-update";
const SKILL_COPY = read(join(import.meta.dir, "../../skills/patchbook-update/SKILL.md"));
const folderFail = (...paths: string[]) =>
  `patchbook: the update skill was not installed, since a folder sits where it goes:\n  ${paths.join("\n  ")}\nMove or remove the folder, then run \`patchbook skill install\`.\n`;
const STALE_SKILL = "---\nname: patchbook-update\n---\n\nAn older skill.\n";

function skillFork(t: Case): Repo {
  const up = new Repo(join(t.tmp, "upstream"));
  up.write("app.txt", "one\ntwo\n");
  up.commit("start");
  t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
  return new Repo(join(t.tmp, "fork"));
}

test("skill install adds the skill to a fork without one and records it", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    expect(existsSync(join(fork.path, SKILL_FILE))).toBe(false);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(out).toContain(`wrote ${SKILL_FILE}`);
    expect(out).toContain(`wrote ${SKILL_LINK}`);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(readlinkSync(join(fork.path, SKILL_LINK))).toBe("../../.agents/skills/patchbook-update");
    expect(fork.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    expect(t.pb(["show", "patchbook-update-skill"], { cwd: fork.path }).stdout).toContain("Install the patchbook-update skill");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
    fork.commit("skill");
    t.pb(["build"], { cwd: fork.path });
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install replaces a stale skill in a fork and a second run changes nothing", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record"], { cwd: fork.path });
    unlinkSync(join(fork.path, SKILL_LINK));
    t.pb(["record"], { cwd: fork.path });
    fork.commit("an older skill, and no link");

    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(out).toContain(`wrote ${SKILL_FILE}`);
    expect(out).toContain(`wrote ${SKILL_LINK}`);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(readlinkSync(join(fork.path, SKILL_LINK))).toBe("../../.agents/skills/patchbook-update");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
    expect(fork.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    fork.commit("refresh the skill");
    t.pb(["build"], { cwd: fork.path });
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");

    const before = tree(fork.path);
    const again = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(again).toBe("the update skill is already current\n");
    expect(tree(fork.path)).toEqual(before);
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install keeps the intent of the change it updates", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record", "patchbook-update-skill", "--intent", "Let agents pull upstream."], { cwd: fork.path });
    fork.commit("an older skill");
    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(read(join(fork.path, ".patchbook/changes/patchbook-update-skill/CHANGE.md"))).toContain("intent: Let agents pull upstream.\n");
    expect(out).not.toContain("intent ");
    expect(modelWasAsked(t)).toBe(false);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install replaces an intent patchbook wrote with the skill's own", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "0", PATCHBOOK_PROVIDER: "none" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record", "patchbook-update-skill"], { cwd: fork.path });
    expect(read(join(fork.path, ".patchbook/changes/patchbook-update-skill/CHANGE.md"))).toContain("intent (by patchbook): ");
    fork.commit("an older skill");
    t.env["PATCHBOOK_SKILL"] = "1";
    t.pb(["skill", "install"], { cwd: fork.path });
    expect(read(join(fork.path, ".patchbook/changes/patchbook-update-skill/CHANGE.md"))).toContain("intent: Install the patchbook-update skill, so an agent can pull upstream and carry these changes forward.\n");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install in a fork refuses to replace an uncommitted edit to the skill", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record"], { cwd: fork.path });
    fork.commit("an older skill");
    fork.write(SKILL_FILE, STALE_SKILL + "My own line.\n");
    fork.write("app.txt", "one\nTWO\n");
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stderr).not.toContain("app.txt");
    expect(out.stderr).toContain("Commit them first");
    expect(out.stderr).not.toContain("patchbook record");
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install records the skill on its own while other edits wait", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    fork.write("app.txt", "one\nTWO\n");
    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(out).toContain(`wrote ${SKILL_FILE}`);
    expect(fork.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    const shown = t.pb(["show", "patchbook-update-skill"], { cwd: fork.path }).stdout;
    expect(shown).toContain(SKILL_INTENT);
    expect(shown).not.toContain("app.txt");
    expect(modelWasAsked(t)).toBe(false);
    expect(fork.read("app.txt")).toBe("one\nTWO\n");

    t.pb(["record", "shout-two", "--intent", "Shout the second line."], { cwd: fork.path });
    expect(fork.read(".patchbook/series")).toBe("patchbook-update-skill\nshout-two\n");
    expect(t.pb(["show", "shout-two"], { cwd: fork.path }).stdout).toContain("app.txt");
    expect(t.pb(["show", "shout-two"], { cwd: fork.path }).stdout).not.toContain("SKILL.md");
    expect(t.pb(["show", "patchbook-update-skill"], { cwd: fork.path }).stdout).not.toContain("app.txt");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install refreshes a recorded skill while other edits wait", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record", "patchbook-update-skill", "--intent", "Let agents pull upstream."], { cwd: fork.path });
    fork.commit("an older skill");
    fork.write("app.txt", "one\nTWO\n");
    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(out).toContain(`wrote ${SKILL_FILE}`);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(read(join(fork.path, ".patchbook/changes/patchbook-update-skill/CHANGE.md"))).toContain("Let agents pull upstream.");
    expect(fork.read("app.txt")).toBe("one\nTWO\n");
    expect(fork.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    expect(read(join(fork.path, ".patchbook/changes/patchbook-update-skill/CHANGE.md"))).not.toContain("app.txt");
    expect(t.pb(["skill", "install"], { cwd: fork.path }).stdout).toBe("the update skill is already current\n");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install in the folder layout overwrites the file and records no change", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.md", "a\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.write(SKILL_FILE, STALE_SKILL + "Edited by hand.\n");
    repo.commit("start");
    t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: repo.path });
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });

    const out = t.pb(["skill", "install"], { cwd: repo.path }).stdout;
    expect(out).toBe(`wrote ${SKILL_FILE}\nwrote ${SKILL_LINK}\nreplaced ${SKILL_FILE}; your copy is in HEAD\n`);
    expect(repo.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(isSymlink(join(repo.path, SKILL_LINK))).toBe(true);
    expect(existsSync(join(repo.path, ".patchbook/changes"))).toBe(false);
    expect(repo.read(".patchbook/series")).toBe("");

    const before = tree(repo.path);
    expect(t.pb(["skill", "install"], { cwd: repo.path }).stdout).toBe("the update skill is already current\n");
    expect(tree(repo.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install follows start.agents and start.install_skill", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    const off = t.pb(["skill", "install"], { cwd: fork.path });
    expect(off.stdout).toContain("start.install_skill is off (env)");
    expect(existsSync(join(fork.path, ".agents"))).toBe(false);

    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    t.pb(["config", "start.agents", "codex", "--project"], { cwd: fork.path });
    fork.commit("settings");
    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(out).toContain(`wrote ${SKILL_FILE}`);
    expect(out).not.toContain(SKILL_LINK);
    expect(existsSync(join(fork.path, ".claude"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install fails when start.agents names only an agent it cannot install for", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    t.pb(["config", "start.agents", "cursor", "--project"], { cwd: fork.path });
    fork.commit("settings");
    const none = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(none.stderr).toContain("can't install the skill for cursor");
    expect(none.stderr).toContain("the update skill was not installed");
    expect(existsSync(join(fork.path, ".agents"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

const SKILL_INTENT = "Install the patchbook-update skill, so an agent can pull upstream and carry these changes forward.";

const modelWasAsked = (t: Case): boolean => existsSync(join(t.tmp, "prompt.txt"));

test("init in a fork records the skill so install finds it current", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const mine = initFork(t);
    expect(mine.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    expect(t.pb(["show", "patchbook-update-skill"], { cwd: mine.path }).stdout).toContain(SKILL_INTENT);
    expect(t.pb(["status"], { cwd: mine.path }).stdout).toContain("no problems");
    expect(t.pb(["skill", "install"], { cwd: mine.path }).stdout).toBe("the update skill is already current\n");
    expect(modelWasAsked(t)).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("init in a fork with edits of its own records the skill apart from them", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const mine = initFork(t, true);
    expect(mine.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    const shown = t.pb(["show", "patchbook-update-skill"], { cwd: mine.path }).stdout;
    expect(shown).toContain(SKILL_INTENT);
    expect(shown).not.toContain("app.txt");
    expect(modelWasAsked(t)).toBe(false);
    expect(t.pb(["skill", "install"], { cwd: mine.path }).stdout).toBe("the update skill is already current\n");

    t.pb(["record", "shout-two", "--intent", "Shout the second line."], { cwd: mine.path });
    expect(mine.read(".patchbook/series")).toBe("patchbook-update-skill\nshout-two\n");
    expect(t.pb(["show", "shout-two"], { cwd: mine.path }).stdout).toContain("app.txt");
    expect(t.pb(["show", "shout-two"], { cwd: mine.path }).stdout).not.toContain("SKILL.md");
    expect(modelWasAsked(t)).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

const SKILL_REFUSED = "Commit them, or move them away, then run `patchbook skill install`";

test("init in a fork keeps an uncommitted edit to the skill and records nothing", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const mine = new Repo(join(t.tmp, "mine"));
    mine.write(SKILL_FILE, STALE_SKILL + "My own line.\n");
    const out = t.pb(["init", "--upstream", up.path], { cwd: mine.path });
    expect(mine.read(SKILL_FILE)).toBe(STALE_SKILL + "My own line.\n");
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stderr).toContain(SKILL_REFUSED);
    expect(isSymlink(join(mine.path, SKILL_LINK)) || existsSync(join(mine.path, SKILL_LINK))).toBe(false);
    expect(mine.read(".patchbook/series")).toBe("");
    expect(existsSync(join(mine.path, ".patchbook/changes"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("init in the folder layout keeps an uncommitted edit to the skill", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.md", "a\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    repo.write(SKILL_FILE, STALE_SKILL + "My own line.\n");
    const out = t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: repo.path });
    expect(repo.read(SKILL_FILE)).toBe(STALE_SKILL + "My own line.\n");
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stderr).toContain(SKILL_REFUSED);
    expect(isSymlink(join(repo.path, SKILL_LINK)) || existsSync(join(repo.path, SKILL_LINK))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("init keeps an uncommitted file at the skill link and writes no skill", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const mine = new Repo(join(t.tmp, "mine"));
    mine.write(SKILL_LINK, "my own notes\n");
    const out = t.pb(["init", "--upstream", up.path], { cwd: mine.path });
    expect(mine.read(SKILL_LINK)).toBe("my own notes\n");
    expect(isSymlink(join(mine.path, SKILL_LINK))).toBe(false);
    expect(out.stderr).toContain(SKILL_LINK);
    expect(out.stderr).toContain(SKILL_REFUSED);
    expect(existsSync(join(mine.path, ".agents"))).toBe(false);
    expect(mine.read(".patchbook/series")).toBe("");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

permissionTest("init finishes with a note when the skill file cannot be read", () => {
  for (const folder of [false, true]) {
    const t = new Case();
    let file = "";
    try {
      Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\ntwo\n");
      up.commit("start");
      let repo: Repo;
      if (folder) {
        repo = new Repo(join(t.tmp, "adapted"));
        repo.write("README.md", "mine\n");
        repo.commit("start");
      } else {
        sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
        repo = new Repo(join(t.tmp, "mine"));
      }
      repo.write(SKILL_FILE, STALE_SKILL);
      repo.commit("skill");
      file = join(repo.path, SKILL_FILE);
      const mode = statSync(file).mode & 0o777;
      chmodSync(file, 0o000);
      const out = t.pb(["init", "--upstream", up.path, ...(folder ? ["--output-to", "out"] : [])], { cwd: repo.path });
      expect(out.stderr).toContain("couldn't install the update skill");
      expect(statSync(file).mode & 0o777).toBe(0);
      chmodSync(file, mode);
      expect(repo.read(SKILL_FILE)).toBe(STALE_SKILL);
      expect(statSync(file).mode & 0o777).toBe(mode);
      if (!folder) expect(repo.read(".patchbook/series")).toBe("");
    } finally {
      if (file && existsSync(file)) chmodSync(file, 0o644);
      t.cleanup();
    }
  }
});

test("init in a fork records nothing for a skill it did not write", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const mine = new Repo(join(t.tmp, "mine"));
    mine.write(SKILL_FILE, SKILL_COPY);
    mkdirSync(join(mine.path, ".claude/skills"), { recursive: true });
    symlinkSync("../../.agents/skills/patchbook-update", join(mine.path, SKILL_LINK));
    mine.commit("the skill, by hand");
    const out = t.pb(["init", "--upstream", up.path], { cwd: mine.path }).stdout;
    expect(out).not.toContain(SKILL_FILE);
    expect(mine.read(".patchbook/series")).toBe("");
    expect(modelWasAsked(t)).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("init in a fork takes the intent from the series not from a leftover folder", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const mine = new Repo(join(t.tmp, "mine"));
    mine.write(".patchbook/changes/patchbook-update-skill/CHANGE.md", "# patchbook-update-skill\n\nintent: A leftover.\n\nedits:\n");
    mine.commit("a leftover change folder");
    t.pb(["init", "--upstream", up.path], { cwd: mine.path });
    expect(mine.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    expect(t.pb(["show", "patchbook-update-skill"], { cwd: mine.path }).stdout).toContain(SKILL_INTENT);
    expect(modelWasAsked(t)).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install records a skill that an older init left unrecorded", () => {
  const t = new Case();
  try {
    const mine = initFork(t);
    mine.write(SKILL_FILE, SKILL_COPY);
    mkdirSync(join(mine.path, ".claude/skills"), { recursive: true });
    symlinkSync("../../.agents/skills/patchbook-update", join(mine.path, SKILL_LINK));
    expect(mine.read(".patchbook/series")).toBe("");
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    t.pb(["skill", "install"], { cwd: mine.path });
    expect(mine.read(".patchbook/series")).toBe("patchbook-update-skill\n");
    expect(t.pb(["show", "patchbook-update-skill"], { cwd: mine.path }).stdout).toContain(SKILL_INTENT);
    expect(t.pb(["status"], { cwd: mine.path }).stdout).toContain("no problems");
    expect(modelWasAsked(t)).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install refuses when the change is missing from the series", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record"], { cwd: fork.path });
    writeFileSync(join(fork.path, ".patchbook/series"), "");
    fork.commit("an older skill, and an empty series");
    rmSync(join(t.tmp, "prompt.txt"), { force: true });
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain("patchbook-update-skill is not in the series");
    expect(modelWasAsked(t)).toBe(false);
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install in the folder layout refuses to replace an uncommitted edit", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.md", "a\n");
    up.commit("start");
    const repo = new Repo(join(t.tmp, "adapted"));
    repo.write("README.md", "mine\n");
    repo.commit("start");
    t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: repo.path });
    repo.write(SKILL_FILE, "My own guidance.\n");
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const before = tree(repo.path);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(repo.read(SKILL_FILE)).toBe("My own guidance.\n");
    expect(tree(repo.path)).toEqual(before);

    repo.commit("my guidance");
    t.pb(["skill", "install"], { cwd: repo.path });
    expect(repo.read(SKILL_FILE)).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install recreates a link that was deleted", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    unlinkSync(join(fork.path, SKILL_LINK));
    const out = t.pb(["skill", "install"], { cwd: fork.path });
    expect(out.stdout).toContain(`wrote ${SKILL_LINK}`);
    expect(readlinkSync(join(fork.path, SKILL_LINK))).toBe("../../.agents/skills/patchbook-update");
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

permissionTest("skill install that cannot make the link leaves the stale skill alone", () => {
  const t = new Case();
  const skills = join(t.tmp, "fork/.claude/skills");
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record"], { cwd: fork.path });
    unlinkSync(join(fork.path, SKILL_LINK));
    t.pb(["record"], { cwd: fork.path });
    fork.commit("an older skill, and no link");
    mkdirSync(skills, { recursive: true });
    chmodSync(skills, 0o555);

    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain("couldn't install the update skill");
    expect(out.stderr).toContain("the update skill was not installed");
    expect(fork.read(SKILL_FILE)).toBe(STALE_SKILL);
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");

    chmodSync(skills, 0o755);
    t.pb(["skill", "install"], { cwd: fork.path });
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
  } finally {
    if (existsSync(skills)) chmodSync(skills, 0o755);
    t.cleanup();
  }
});

permissionTest("skill install that cannot write the skill takes back the link it made", () => {
  const t = new Case();
  const file = join(t.tmp, "fork", SKILL_FILE);
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record"], { cwd: fork.path });
    unlinkSync(join(fork.path, SKILL_LINK));
    t.pb(["record"], { cwd: fork.path });
    fork.commit("an older skill, and no link");
    chmodSync(file, 0o444);

    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain("couldn't install the update skill");
    expect(out.stderr).toContain("the update skill was not installed");
    expect(existsSync(join(fork.path, SKILL_LINK))).toBe(false);
    expect(isSymlink(join(fork.path, SKILL_LINK))).toBe(false);
    expect(fork.read(SKILL_FILE)).toBe(STALE_SKILL);
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");

    chmodSync(file, 0o644);
    t.pb(["skill", "install"], { cwd: fork.path });
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(isSymlink(join(fork.path, SKILL_LINK))).toBe(true);
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
  } finally {
    if (existsSync(file)) chmodSync(file, 0o644);
    t.cleanup();
  }
});

/** A folder-layout repo with the skill installed and committed. */
function skillFolder(t: Case): Repo {
  const up = new Repo(join(t.tmp, "upstream"));
  up.write("a.md", "a\n");
  up.commit("start");
  const repo = new Repo(join(t.tmp, "adapted"));
  repo.write("README.md", "mine\n");
  repo.commit("start");
  t.pb(["init", "--upstream", up.path, "--output-to", "out"], { cwd: repo.path });
  Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
  t.pb(["skill", "install"], { cwd: repo.path });
  repo.commit("the skill");
  return repo;
}

const retarget = (repo: Repo, to: string): void => {
  unlinkSync(join(repo.path, SKILL_LINK));
  symlinkSync(to, join(repo.path, SKILL_LINK));
};

test("skill install in a fork does not lose a recorded customization that is not committed", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, SKILL_COPY + "My own line.\n");
    const mine = fork.read(SKILL_FILE);
    t.pb(["record"], { cwd: fork.path });
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stderr).toContain("Commit them first");
    expect(out.stderr).toContain("In a fork the hook records the commit");
    expect(fork.read(SKILL_FILE)).toBe(mine);
    expect(tree(fork.path)).toEqual(before);

    fork.commit("my own line");
    expect(t.pb(["skill", "install"], { cwd: fork.path }).stdout).toContain(`wrote ${SKILL_FILE}`);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(sh(["git", "log", "--all", "-p"], { cwd: fork.path }).stdout).toContain("+My own line.");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install in a fork does not lose a recorded link that is not committed", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    retarget(fork, "../../elsewhere");
    t.pb(["record"], { cwd: fork.path });
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(SKILL_LINK);
    expect(readlinkSync(join(fork.path, SKILL_LINK))).toBe("../../elsewhere");
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install in the folder layout refuses to replace an uncommitted link", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    retarget(repo, "../../elsewhere");
    const before = tree(repo.path);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain(SKILL_LINK);
    expect(out.stderr).toContain("Commit them first");
    expect(out.stderr).not.toContain("hook");
    expect(readlinkSync(join(repo.path, SKILL_LINK))).toBe("../../elsewhere");
    expect(tree(repo.path)).toEqual(before);

    repo.commit("my link");
    t.pb(["skill", "install"], { cwd: repo.path });
    expect(readlinkSync(join(repo.path, SKILL_LINK))).toBe("../../.agents/skills/patchbook-update");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install in the folder layout refuses to replace an uncommitted file at the link", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    unlinkSync(join(repo.path, SKILL_LINK));
    repo.write(SKILL_LINK, "My own file, not a link.\n");
    const before = tree(repo.path);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain(SKILL_LINK);
    expect(repo.read(SKILL_LINK)).toBe("My own file, not a link.\n");
    expect(tree(repo.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

permissionTest("skill install that cannot write the skill puts back a link it replaced", () => {
  const t = new Case();
  let file = "";
  try {
    const repo = skillFolder(t);
    file = join(repo.path, SKILL_FILE);
    retarget(repo, "../../elsewhere");
    repo.write(SKILL_FILE, STALE_SKILL);
    repo.commit("a wrong link and an older skill");
    chmodSync(file, 0o444);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain("couldn't install the update skill");
    expect(readlinkSync(join(repo.path, SKILL_LINK))).toBe("../../elsewhere");
    expect(sh(["git", "status", "--porcelain"], { cwd: repo.path }).stdout).toBe("");
  } finally {
    if (file && existsSync(file)) chmodSync(file, 0o644);
    t.cleanup();
  }
});

permissionTest("skill install that cannot write the skill puts back a file it replaced", () => {
  const t = new Case();
  let file = "";
  try {
    const repo = skillFolder(t);
    file = join(repo.path, SKILL_FILE);
    unlinkSync(join(repo.path, SKILL_LINK));
    repo.write(SKILL_LINK, "My own file, not a link.\n");
    repo.write(SKILL_FILE, STALE_SKILL);
    repo.commit("a file at the link and an older skill");
    chmodSync(file, 0o444);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain("couldn't install the update skill");
    expect(isSymlink(join(repo.path, SKILL_LINK))).toBe(false);
    expect(repo.read(SKILL_LINK)).toBe("My own file, not a link.\n");
    expect(sh(["git", "status", "--porcelain"], { cwd: repo.path }).stdout).toBe("");
  } finally {
    if (file && existsSync(file)) chmodSync(file, 0o644);
    t.cleanup();
  }
});

test("skill install in a fork refuses to replace a customization that git ignores", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    fork.write(".gitignore", ".agents/\n.claude/\n");
    fork.commit("ignore the agents' folders");
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    t.pb(["skill", "install"], { cwd: fork.path });
    fork.write(SKILL_FILE, SKILL_COPY + "My own line.\n");
    const mine = fork.read(SKILL_FILE);
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stderr).toContain("git ignores");
    expect(out.stderr).not.toContain("Commit them first");
    expect(out.stdout).not.toContain("wrote");
    expect(fork.read(SKILL_FILE)).toBe(mine);
    expect(tree(fork.path)).toEqual(before);

    fork.write(SKILL_FILE, SKILL_COPY);
    expect(t.pb(["skill", "install"], { cwd: fork.path }).stdout).toBe("the update skill is already current\n");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install in the folder layout refuses to replace a link that git ignores", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    repo.write(".gitignore", ".claude/\n");
    sh(["git", "rm", "-q", "--cached", SKILL_LINK], { cwd: repo.path });
    repo.commit("ignore .claude");
    retarget(repo, "../../elsewhere");
    const before = tree(repo.path);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain(SKILL_LINK);
    expect(out.stderr).toContain("git ignores");
    expect(readlinkSync(join(repo.path, SKILL_LINK))).toBe("../../elsewhere");
    expect(tree(repo.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
  test(`skill install in a fork refuses to replace an edit that git hides with ${flag}`, () => {
    const t = new Case();
    try {
      Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
      const fork = skillFork(t);
      t.pb(["skill", "install"], { cwd: fork.path });
      fork.write(SKILL_FILE, SKILL_COPY + "My own line.\n");
      const mine = fork.read(SKILL_FILE);
      sh(["git", "update-index", flag, SKILL_FILE], { cwd: fork.path });
      expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");
      const before = tree(fork.path);
      const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
      expect(out.stderr).toContain(SKILL_FILE);
      expect(out.stderr).toContain("git update-index --no-skip-worktree");
      expect(out.stdout).not.toContain("your copy is in HEAD");
      expect(out.stdout).not.toContain("wrote");
      expect(fork.read(SKILL_FILE)).toBe(mine);
      expect(tree(fork.path)).toEqual(before);
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

test("skill install in the folder layout refuses to replace a link that git hides", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    retarget(repo, "../../elsewhere");
    sh(["git", "update-index", "--assume-unchanged", SKILL_LINK], { cwd: repo.path });
    expect(sh(["git", "status", "--porcelain"], { cwd: repo.path }).stdout).toBe("");
    const before = tree(repo.path);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain(SKILL_LINK);
    expect(out.stdout).not.toContain("your copy is in HEAD");
    expect(readlinkSync(join(repo.path, SKILL_LINK))).toBe("../../elsewhere");
    expect(tree(repo.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install replaces a committed customization and names the commit that keeps it", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL + "My own line.\n");
    const mine = fork.read(SKILL_FILE);
    t.pb(["record"], { cwd: fork.path });
    fork.commit("my own line");
    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(out).toContain(`replaced ${SKILL_FILE}; your copy is in HEAD`);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(sh(["git", "show", `HEAD:${SKILL_FILE}`], { cwd: fork.path }).stdout).toBe(mine);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install replaces a committed customization that checkout wrote with CRLF", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    repo.write(".gitattributes", "*.md eol=crlf\n");
    repo.commit("crlf checkout");
    repo.write(SKILL_FILE, STALE_SKILL + "My own line.\n");
    const mine = repo.read(SKILL_FILE);
    repo.commit("my own line");
    repo.rm(SKILL_FILE);
    sh(["git", "checkout", "--", SKILL_FILE], { cwd: repo.path });
    expect(repo.read(SKILL_FILE)).toBe(mine.replaceAll("\n", "\r\n"));
    expect(sh(["git", "status", "--porcelain"], { cwd: repo.path }).stdout).toBe("");
    const out = t.pb(["skill", "install"], { cwd: repo.path }).stdout;
    expect(out).toContain(`replaced ${SKILL_FILE}; your copy is in HEAD`);
    expect(repo.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(sh(["git", "show", `HEAD:${SKILL_FILE}`], { cwd: repo.path }).stdout).toBe(mine);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("clone installs the skill over a committed copy that checkout wrote with CRLF", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write(".gitattributes", "*.md eol=crlf\n");
    up.write(SKILL_FILE, SKILL_COPY);
    up.commit("start");
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    expect(out.stderr).not.toContain("was not installed");
    const fork = new Repo(join(t.tmp, "fork"));
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(existsSync(join(fork.path, SKILL_LINK))).toBe(true);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install replaces a committed link that checkout wrote as a file without symlinks", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    retarget(repo, "../../elsewhere");
    repo.commit("a wrong link");
    sh(["git", "config", "core.symlinks", "false"], { cwd: repo.path });
    repo.rm(SKILL_LINK);
    sh(["git", "checkout", "--", SKILL_LINK], { cwd: repo.path });
    expect(lstatSync(join(repo.path, SKILL_LINK)).isSymbolicLink()).toBe(false);
    expect(sh(["git", "status", "--porcelain"], { cwd: repo.path }).stdout).toBe("");
    const out = t.pb(["skill", "install"], { cwd: repo.path }).stdout;
    expect(out).toContain(`replaced ${SKILL_LINK}; your copy is in HEAD`);
    expect(sh(["git", "show", `HEAD:${SKILL_LINK}`], { cwd: repo.path }).stdout).toBe("../../elsewhere");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install refuses a plain file at a committed link when checkout would have written a link", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    retarget(repo, "../../elsewhere");
    repo.commit("a wrong link");
    repo.rm(SKILL_LINK);
    repo.write(SKILL_LINK, "../../elsewhere");
    expect(lstatSync(join(repo.path, SKILL_LINK)).isSymbolicLink()).toBe(false);
    const before = tree(repo.path);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain(SKILL_LINK);
    expect(out.stdout).not.toContain("your copy is in HEAD");
    expect(repo.read(SKILL_LINK)).toBe("../../elsewhere");
    expect(tree(repo.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

/** A clean filter that drops every line holding SECRET, applied to markdown. */
const dropSecrets = (repo: Repo): void => {
  repo.write(".gitattributes", "*.md filter=strip\n");
  sh(["git", "config", "filter.strip.clean", "sed /SECRET/d"], { cwd: repo.path });
  sh(["git", "config", "filter.strip.smudge", "cat"], { cwd: repo.path });
};

test("skill install refuses to replace a line that a clean filter drops from what git stores", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    dropSecrets(repo);
    repo.write(SKILL_FILE, STALE_SKILL);
    repo.commit("an older skill");
    repo.write(SKILL_FILE, STALE_SKILL + "SECRET=hunter2\n");
    const before = tree(repo.path);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stdout).not.toContain("your copy is in HEAD");
    expect(repo.read(SKILL_FILE)).toBe(STALE_SKILL + "SECRET=hunter2\n");
    expect(tree(repo.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install refuses a lone carriage return edit", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    fork.write(SKILL_FILE, STALE_SKILL);
    fork.commit("an older skill");
    fork.write(SKILL_FILE, STALE_SKILL.replace("\n", "\r"));
    const before = fork.read(SKILL_FILE);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stdout).not.toContain("your copy is in HEAD");
    expect(fork.read(SKILL_FILE)).toBe(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install refuses a file whose non-UTF-8 bytes differ from head", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    writeBytes(fork, SKILL_FILE, NOT_UTF8);
    fork.commit("a skill that is not text");
    writeBytes(fork, SKILL_FILE, SWAPPED);
    const before = readFileSync(join(fork.path, SKILL_FILE));
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stdout).not.toContain("your copy is in HEAD");
    expect(readFileSync(join(fork.path, SKILL_FILE))).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install keeps a committed CRLF file whose disk copy has LF", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    fork.write(SKILL_FILE, STALE_SKILL.replaceAll("\n", "\r\n"));
    fork.commit("an older skill with CRLF");
    fork.write(SKILL_FILE, STALE_SKILL);
    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(out).toContain(`replaced ${SKILL_FILE}; your copy is in HEAD\n`);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install refuses a UTF-16 file whose disk copy adds carriage returns", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    writeBytes(fork, SKILL_FILE, Buffer.from([0x58, 0x00, 0x0a, 0x0a]));
    fork.commit("a skill that is UTF-16");
    writeBytes(fork, SKILL_FILE, Buffer.from([0x58, 0x00, 0x0d, 0x0a, 0x0d, 0x0a]));
    const before = readFileSync(join(fork.path, SKILL_FILE));
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stdout).not.toContain("your copy is in HEAD");
    expect(readFileSync(join(fork.path, SKILL_FILE))).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("init keeps a line that a clean filter drops from what git stores and records nothing", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const mine = new Repo(join(t.tmp, "mine"));
    dropSecrets(mine);
    mine.write(SKILL_FILE, STALE_SKILL);
    mine.commit("an older skill");
    mine.write(SKILL_FILE, STALE_SKILL + "SECRET=hunter2\n");
    const out = t.pb(["init", "--upstream", up.path], { cwd: mine.path });
    expect(mine.read(SKILL_FILE)).toBe(STALE_SKILL + "SECRET=hunter2\n");
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stderr).toContain(SKILL_REFUSED);
    expect(isSymlink(join(mine.path, SKILL_LINK)) || existsSync(join(mine.path, SKILL_LINK))).toBe(false);
    expect(mine.read(".patchbook/series")).toBe("");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install refuses to replace an edit when git cannot read head", () => {
  const t = new Case();
  try {
    const repo = skillFolder(t);
    repo.write(SKILL_FILE, "My own guidance.\n");
    sh(["git", "symbolic-ref", "HEAD", "refs/heads/unborn"], { cwd: repo.path });
    const before = tree(repo.path);
    const out = t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stdout).not.toContain("your copy is in HEAD");
    expect(repo.read(SKILL_FILE)).toBe("My own guidance.\n");
    expect(tree(repo.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("init in a fork keeps a customized skill that git ignores and records nothing", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const mine = new Repo(join(t.tmp, "mine"));
    mine.write(".gitignore", ".agents/\n");
    mine.commit("ignore the agents' folder");
    mine.write(SKILL_FILE, STALE_SKILL + "My own line.\n");
    const out = t.pb(["init", "--upstream", up.path], { cwd: mine.path });
    expect(mine.read(SKILL_FILE)).toBe(STALE_SKILL + "My own line.\n");
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stderr).toContain(SKILL_REFUSED);
    expect(isSymlink(join(mine.path, SKILL_LINK)) || existsSync(join(mine.path, SKILL_LINK))).toBe(false);
    expect(mine.read(".patchbook/series")).toBe("");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install in a fork writes and records nothing when an untracked folder is at the link", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record"], { cwd: fork.path });
    fork.commit("an older skill");
    sh(["git", "rm", "-q", "--cached", SKILL_LINK], { cwd: fork.path });
    sh(["git", "commit", "-q", "-m", "untrack the link"], { cwd: fork.path });
    rmSync(join(fork.path, SKILL_LINK));
    fork.write(`${SKILL_LINK}/notes.txt`, "Mine.\n");
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(folderFail(SKILL_LINK));
    expect(out.stdout).toBe("");
    expect(fork.read(SKILL_FILE)).toBe(STALE_SKILL);
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

permissionTest("skill install that cannot write the skill puts back the mode of a file it replaced", () => {
  const t = new Case();
  const umask = process.umask(0o022);
  let file = "";
  try {
    const repo = skillFolder(t);
    file = join(repo.path, SKILL_FILE);
    unlinkSync(join(repo.path, SKILL_LINK));
    repo.write(SKILL_LINK, "My own file, not a link.\n", 0o664);
    repo.write(SKILL_FILE, STALE_SKILL);
    repo.commit("a file at the link and an older skill");
    chmodSync(file, 0o444);
    t.pb(["skill", "install"], { cwd: repo.path, code: 1 });
    expect(repo.read(SKILL_LINK)).toBe("My own file, not a link.\n");
    expect(statSync(join(repo.path, SKILL_LINK)).mode & 0o7777).toBe(0o664);
  } finally {
    process.umask(umask);
    if (file && existsSync(file)) chmodSync(file, 0o644);
    t.cleanup();
  }
});

test("skill install says which committed skill paths it replaced", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    expect(t.pb(["skill", "install"], { cwd: fork.path }).stdout).not.toContain("replaced");
    fork.write(SKILL_FILE, STALE_SKILL);
    retarget(fork, "../../elsewhere");
    t.pb(["record"], { cwd: fork.path });
    fork.commit("an older skill and a wrong link");
    const out = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(out).toContain(`replaced ${SKILL_FILE}; your copy is in HEAD\n`);
    expect(out).toContain(`replaced ${SKILL_LINK}; your copy is in HEAD\n`);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(t.pb(["skill", "install"], { cwd: fork.path }).stdout).toBe("the update skill is already current\n");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

/** A committed link at `at` in `repo`, pointing at `target`. */
function commitLink(repo: Repo, at: string, target: string): void {
  mkdirSync(dirname(join(repo.path, at)), { recursive: true });
  symlinkSync(target, join(repo.path, at));
  repo.commit(`${at} is a link`);
}

/** A folder outside the repo, holding a customized skill. */
function outsideSkill(t: Case): string {
  const shared = join(t.tmp, "shared");
  mkdirSync(join(shared, "skills/patchbook-update"), { recursive: true });
  writeFileSync(join(shared, "skills/patchbook-update/SKILL.md"), SKILL_COPY + "Kept outside the repo.\n");
  return shared;
}

test("skill install does not write through a symlink at the skill file", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const notes = join(t.tmp, "notes.md");
    writeFileSync(notes, "Notes kept outside the repo.\n");
    commitLink(fork, SKILL_FILE, notes);
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(`${SKILL_FILE} is a symlink`);
    expect(out.stderr).toContain("install won't write through a link");
    expect(out.stdout).toBe("");
    expect(read(notes)).toBe("Notes kept outside the repo.\n");
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install does not ask for a commit when the skill file is an uncommitted symlink", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const notes = join(t.tmp, "notes.md");
    writeFileSync(notes, "Notes kept outside the repo.\n");
    mkdirSync(join(fork.path, ".agents/skills/patchbook-update"), { recursive: true });
    symlinkSync(notes, join(fork.path, SKILL_FILE));
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(`${SKILL_FILE} is a symlink`);
    expect(out.stderr).not.toContain("Commit them first");
    expect(read(notes)).toBe("Notes kept outside the repo.\n");
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install does not write through a symlink at a folder above the skill", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const shared = outsideSkill(t);
    commitLink(fork, ".agents", shared);
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(".agents is a symlink");
    expect(out.stderr).toContain("install won't write through a link");
    expect(out.stdout).toBe("");
    expect(read(join(shared, "skills/patchbook-update/SKILL.md"))).toBe(SKILL_COPY + "Kept outside the repo.\n");
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("clone finishes without installing when a folder above the skill is a symlink", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.txt", "a\n");
    commitLink(up, ".agents", outsideSkill(t));
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    expect(out.stderr).toContain(".agents is a symlink");
    expect(read(join(t.tmp, "shared/skills/patchbook-update/SKILL.md"))).toBe(SKILL_COPY + "Kept outside the repo.\n");
    const fork = join(t.tmp, "fork");
    expect(sh(["git", "log", "--format=%s"], { cwd: fork }).stdout).toContain("Start a patchbook at upstream");
    expect(isSymlink(join(fork, SKILL_LINK))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("init finishes without installing when the skill file is a symlink", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const mine = new Repo(join(t.tmp, "mine"));
    const notes = join(t.tmp, "notes.md");
    writeFileSync(notes, "Notes kept outside the repo.\n");
    commitLink(mine, SKILL_FILE, notes);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["init", "--upstream", up.path], { cwd: mine.path });
    expect(out.stderr).toContain(`${SKILL_FILE} is a symlink`);
    expect(read(notes)).toBe("Notes kept outside the repo.\n");
    expect(isSymlink(join(mine.path, SKILL_FILE))).toBe(true);
    expect(isSymlink(join(mine.path, SKILL_LINK))).toBe(false);
    expect(existsSync(join(mine.path, ".patchbook/config.toml"))).toBe(true);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

const KEPT = SKILL_COPY + "Kept outside the repo.\n";

/** A folder outside the repo with a regular file where the skill link would go. */
function outsideClaude(t: Case): string {
  const outside = join(t.tmp, "outside-claude");
  mkdirSync(join(outside, "skills"), { recursive: true });
  writeFileSync(join(outside, "skills/patchbook-update"), "Kept outside the repo.\n");
  return outside;
}

/** Commit a link at `at`, run `skill install`, and expect a refusal that leaves `kept` and the repo as they were. */
function expectNoWriteThrough(at: string, target: (t: Case) => string, kept: string, text: string): void {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const outside = target(t);
    commitLink(fork, at, outside);
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(`${at} is a symlink`);
    expect(out.stderr).toContain("install won't write through a link");
    expect(out.stdout).toBe("");
    expect(read(join(t.tmp, kept))).toBe(text);
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}

test("skill install does not write through a symlink at .agents/skills", () => {
  expectNoWriteThrough(".agents/skills", (t) => join(outsideSkill(t), "skills"),
    "shared/skills/patchbook-update/SKILL.md", KEPT);
}, TIMEOUT);

test("skill install does not write through a symlink at the skill folder", () => {
  expectNoWriteThrough(".agents/skills/patchbook-update", (t) => join(outsideSkill(t), "skills/patchbook-update"),
    "shared/skills/patchbook-update/SKILL.md", KEPT);
}, TIMEOUT);

test("skill install does not write through a symlink at .claude", () => {
  expectNoWriteThrough(".claude", outsideClaude, "outside-claude/skills/patchbook-update", "Kept outside the repo.\n");
}, TIMEOUT);

test("skill install does not write through a symlink at .claude/skills", () => {
  expectNoWriteThrough(".claude/skills", (t) => join(outsideClaude(t), "skills"),
    "outside-claude/skills/patchbook-update", "Kept outside the repo.\n");
}, TIMEOUT);

test("clone finishes without installing when .claude is a symlink", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.txt", "a\n");
    commitLink(up, ".claude", outsideClaude(t));
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    expect(out.stderr).toContain(".claude is a symlink");
    expect(read(join(t.tmp, "outside-claude/skills/patchbook-update"))).toBe("Kept outside the repo.\n");
    expect(isSymlink(join(t.tmp, "fork/.claude"))).toBe(true);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("init finishes without installing when .claude/skills is a symlink", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("app.txt", "one\ntwo\n");
    up.commit("start");
    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const mine = new Repo(join(t.tmp, "mine"));
    commitLink(mine, ".claude/skills", join(outsideClaude(t), "skills"));
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["init", "--upstream", up.path], { cwd: mine.path });
    expect(out.stderr).toContain(".claude/skills is a symlink");
    expect(read(join(t.tmp, "outside-claude/skills/patchbook-update"))).toBe("Kept outside the repo.\n");
    expect(existsSync(join(mine.path, ".patchbook/config.toml"))).toBe(true);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

/** The common layout: Claude Code's skills folder is a link to the folder Codex reads. */
function sharedLayout(repo: Repo): void {
  repo.write(".agents/skills/other/SKILL.md", "Another skill.\n");
  commitLink(repo, ".claude/skills", "../.agents/skills");
}

test("skill install counts a .claude/skills link to .agents/skills as installed", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    sharedLayout(fork);
    const first = t.pb(["skill", "install"], { cwd: fork.path });
    expect(first.stderr).toBe("");
    expect(first.stdout).toContain(`wrote ${SKILL_FILE}\n`);
    expect(first.stdout).not.toContain(SKILL_LINK);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(isSymlink(join(fork.path, ".claude/skills"))).toBe(true);
    const second = t.pb(["skill", "install"], { cwd: fork.path });
    expect(second.stderr).toBe("");
    expect(second.stdout).toBe("the update skill is already current\n");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("clone and init print no folder note for a .claude/skills link to .agents/skills", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.txt", "a\n");
    sharedLayout(up);
    const cloned = t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    expect(cloned.stderr).not.toContain("is a folder");
    expect(cloned.stderr).not.toContain("is a symlink");
    expect(read(join(t.tmp, "fork", SKILL_FILE))).toBe(SKILL_COPY);

    sh(["git", "clone", "-q", up.path, join(t.tmp, "mine")], { cwd: t.tmp });
    const inited = t.pb(["init", "--upstream", up.path], { cwd: join(t.tmp, "mine") });
    expect(inited.stderr).not.toContain("is a folder");
    expect(inited.stderr).not.toContain("is a symlink");
    expect(read(join(t.tmp, "mine", SKILL_FILE))).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install and clone install the codex copy when the shared link dangles", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    commitLink(fork, ".claude/skills", "../.agents/skills");
    const installed = t.pb(["skill", "install"], { cwd: fork.path });
    expect(installed.stderr).toBe("");
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(isSymlink(join(fork.path, ".claude/skills"))).toBe(true);

    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.txt", "a\n");
    commitLink(up, ".claude/skills", "../.agents/skills");
    const cloned = t.pb(["clone", up.path, "fork2"], { cwd: t.tmp });
    expect(cloned.stderr).not.toContain("is a symlink");
    expect(cloned.stderr).not.toContain("is a folder");
    expect(read(join(t.tmp, "fork2", SKILL_FILE))).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

/** An outside `.claude` whose `skills` is the shared link, so a lexical read of that link would match. */
function outsideSharedClaude(t: Case): string {
  const outside = join(t.tmp, "outside-claude2");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "keep.txt"), "Kept outside the repo.\n");
  symlinkSync("../.agents/skills", join(outside, "skills"));
  return outside;
}

test("skill install and clone refuse a .claude symlink to an outside folder whose skills link is shared", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    commitLink(fork, ".claude", outsideSharedClaude(t));
    const installed = t.pb(["skill", "install"], { code: 1, cwd: fork.path });
    expect(installed.stderr).toContain(".claude is a symlink");

    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.txt", "a\n");
    commitLink(up, ".claude", join(t.tmp, "outside-claude2"));
    const cloned = t.pb(["clone", up.path, "fork2"], { cwd: t.tmp });
    expect(cloned.stderr).toContain(".claude is a symlink");

    expect(read(join(t.tmp, "outside-claude2/keep.txt"))).toBe("Kept outside the repo.\n");
    expect(existsSync(join(t.tmp, "outside-claude2/.agents"))).toBe(false);
    expect(existsSync(join(t.tmp, ".agents"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

const NOT_UTF8 = Buffer.from([0x62, 0x61, 0x64, 0x20, 0xff, 0xfe, 0x20, 0x62, 0x79, 0x74, 0x65, 0x73, 0x0a]);
const SWAPPED = Buffer.from([0x62, 0x61, 0x64, 0x20, 0xfe, 0xff, 0x20, 0x62, 0x79, 0x74, 0x65, 0x73, 0x0a]);

function writeBytes(repo: Repo, rel: string, data: Uint8Array): void {
  mkdirSync(dirname(join(repo.path, rel)), { recursive: true });
  writeFileSync(join(repo.path, rel), data);
}

test("clone replaces a skill file that is not UTF-8", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write("a.txt", "a\n");
    writeBytes(up, SKILL_FILE, NOT_UTF8);
    up.commit("start");
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["clone", up.path, "fork"], { cwd: t.tmp });
    expect(out.stderr).not.toContain("TypeError");
    expect(read(join(t.tmp, "fork", SKILL_FILE))).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install treats a skill file that is not UTF-8 like any other that differs", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    writeBytes(fork, SKILL_FILE, NOT_UTF8);
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain(SKILL_FILE);
    expect(out.stderr).toContain("Commit them first");
    expect(out.stderr).not.toContain("TypeError");
    expect(tree(fork.path)).toEqual(before);

    fork.commit("a skill that is not utf-8");
    const done = t.pb(["skill", "install"], { cwd: fork.path }).stdout;
    expect(done).toContain(`replaced ${SKILL_FILE}; your copy is in HEAD\n`);
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install leaves a folder at the skill file and exits 1", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    fork.write(`${SKILL_FILE}/notes.txt`, "Mine.\n");
    const before = tree(fork.path);
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toBe(folderFail(SKILL_FILE));
    expect(out.stdout).toBe("");
    expect(tree(fork.path)).toEqual(before);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("clone keeps the patchbook and exits 1 when a folder is at the skill file", () => {
  const t = new Case();
  try {
    const up = new Repo(join(t.tmp, "upstream"));
    up.write(`${SKILL_FILE}/notes.txt`, "Mine.\n");
    up.commit("start");
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const out = t.pb(["clone", up.path, "fork"], { cwd: t.tmp, code: 1 });
    expect(out.stderr).toContain(folderFail(SKILL_FILE));
    expect(out.stderr).not.toContain("EISDIR");
    expect(out.stdout).toContain("cloned ");
    const fork = new Repo(join(t.tmp, "fork"));
    expect(fork.read(`${SKILL_FILE}/notes.txt`)).toBe("Mine.\n");
    expect(existsSync(join(fork.path, ".claude"))).toBe(false);
    expect(sh(["git", "log", "-1", "--format=%s"], { cwd: fork.path }).stdout).toStartWith("Start a patchbook at upstream");
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
    t.pb(["build"], { cwd: fork.path });
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");

    renameSync(join(fork.path, SKILL_FILE), join(t.tmp, "my-skill-folder"));
    const early = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(early.stderr).toContain(`the patchbook still holds a folder where it goes:\n  ${SKILL_FILE}\n`);
    expect(t.pb(["status"], { cwd: fork.path, code: 1 }).stdout).toContain(`unrecorded ${SKILL_FILE}/notes.txt`);
    t.pb(["record", "my-folder", "--intent", "Drop my skill folder."], { cwd: fork.path });
    t.pb(["skill", "install"], { cwd: fork.path });
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
    expect(fork.read(".patchbook/series")).toBe("my-folder\npatchbook-update-skill\n");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
    expect(t.pb(["skill", "install"], { cwd: fork.path }).stdout).toBe("the update skill is already current\n");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

for (const layout of ["fork", "folder"]) {
  test(`a ${layout} init keeps the patchbook and exits 1 when a folder is at the skill file`, () => {
    const t = new Case();
    try {
      const up = new Repo(join(t.tmp, "upstream"));
      up.write("app.txt", "one\n");
      up.commit("start");
      let repo: Repo;
      if (layout === "fork") {
        sh(["git", "clone", "-q", up.path, "mine"], { cwd: t.tmp });
        repo = new Repo(join(t.tmp, "mine"));
      } else {
        repo = new Repo(join(t.tmp, "adapted"));
        repo.write("README.md", "mine\n");
        repo.commit("start");
      }
      repo.write(`${SKILL_FILE}/notes.txt`, "Mine.\n");
      repo.commit("a folder of my own");
      Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
      const out = t.pb(["init", "--upstream", up.path, ...(layout === "folder" ? ["--output-to", "out"] : [])], { cwd: repo.path, code: 1 });
      expect(out.stderr).toContain(folderFail(SKILL_FILE));
      expect(out.stderr).not.toContain("EISDIR");
      expect(repo.read(`${SKILL_FILE}/notes.txt`)).toBe("Mine.\n");
      expect(existsSync(join(repo.path, ".claude"))).toBe(false);
      expect(existsSync(join(repo.path, ".patchbook/config.toml"))).toBe(true);
      const first = t.pb(["status"], { cwd: repo.path, code: layout === "fork" ? 1 : 0 }).stdout;
      expect(first).toContain(layout === "fork" ? `unrecorded ${SKILL_FILE}/notes.txt` : "no problems");

      renameSync(join(repo.path, SKILL_FILE), join(t.tmp, "my-skill-folder"));
      t.pb(["skill", "install"], { cwd: repo.path });
      expect(repo.read(SKILL_FILE)).toBe(SKILL_COPY);
      expect(t.pb(["status"], { cwd: repo.path }).stdout).toContain("no problems");
      expect(t.pb(["skill", "install"], { cwd: repo.path }).stdout).toBe("the update skill is already current\n");
    } finally {
      t.cleanup();
    }
  }, TIMEOUT);
}

permissionTest("no skill or hook failure shows a raw errno code", () => {
  const t = new Case();
  const locked: string[] = [];
  const noErrno = (stderr: string) => {
    for (const code of ["EISDIR", "ENOENT", "EACCES", "ENOTDIR", "EPERM", "EEXIST", "EROFS"]) expect(stderr).not.toContain(code);
  };
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const holder = new Repo(join(t.tmp, "holder"));
    holder.write(`${SKILL_FILE}/notes.txt`, "Mine.\n");
    holder.commit("start");
    noErrno(t.pb(["clone", holder.path, "cloned"], { cwd: t.tmp, code: 1 }).stderr);
    sh(["git", "clone", "-q", holder.path, "inited"], { cwd: t.tmp });
    const inited = join(t.tmp, "inited");
    noErrno(t.pb(["init", "--upstream", holder.path], { cwd: inited, code: 1 }).stderr);
    noErrno(t.pb(["skill", "install"], { cwd: inited, code: 1 }).stderr);

    Object.assign(t.env, { PATCHBOOK_SKILL: "0" });
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const skills = join(fork.path, ".claude/skills");
    mkdirSync(skills, { recursive: true });
    chmodSync(skills, 0o555);
    locked.push(skills);
    const link = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(link.stderr).toContain("couldn't install the update skill");
    noErrno(link.stderr);

    const git = join(fork.path, ".git");
    rmSync(join(git, "hooks"), { recursive: true });
    chmodSync(git, 0o555);
    locked.push(git);
    const hook = t.pb(["record"], { cwd: fork.path });
    expect(hook.stderr).toContain("couldn't install the pre-commit hook");
    noErrno(hook.stderr);
  } finally {
    for (const p of locked) if (existsSync(p)) chmodSync(p, 0o755);
    t.cleanup();
  }
});

test("skill install goes ahead when a sync left a conflict", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    const up = new Repo(join(t.tmp, "upstream"));
    fork.write("app.txt", "ONE\ntwo\n");
    t.pb(["record", "shout-one", "--intent", "Shout the first line."], { cwd: fork.path });
    fork.write(SKILL_FILE, STALE_SKILL);
    t.pb(["record", "patchbook-update-skill"], { cwd: fork.path });
    fork.commit("mine");
    up.write("app.txt", "uno\ntwo\n");
    up.commit("upstream changes line one");
    t.pb(["sync"], { cwd: fork.path });
    expect(t.pb(["status"], { cwd: fork.path, code: 1 }).stdout).toContain("conflict");

    t.pb(["skill", "install"], { cwd: fork.path });
    expect(fork.read(SKILL_FILE)).toBe(SKILL_COPY);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("skill install says why when start.agents is empty", () => {
  const t = new Case();
  try {
    const fork = skillFork(t);
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    t.pb(["config", "start.agents", "", "--project"], { cwd: fork.path });
    fork.commit("settings");
    const out = t.pb(["skill", "install"], { cwd: fork.path, code: 1 });
    expect(out.stderr).toContain("start.agents is empty");
    expect(existsSync(join(fork.path, ".agents"))).toBe(false);
  } finally {
    t.cleanup();
  }
}, TIMEOUT);

test("commit records a hand edit in a fork cloned with the skill", () => {
  const t = new Case();
  try {
    Object.assign(t.env, { PATCHBOOK_SKILL: "1" });
    const fork = skillFork(t);
    fork.write("app.txt", "one\nTWO\n");
    sh(["git", "add", "app.txt"], { cwd: fork.path });
    const commit = sh(["git", "commit", "-q", "-m", "shout"], { cwd: fork.path, check: false, env: { ...t.env, PATCHBOOK_HOOK: "1", PATCHBOOK_INTENT: "Shout two." } });
    expect(commit.stderr).not.toContain("is a link");
    expect(commit.code).toBe(0);
    expect(committedFiles(fork)).toContain("app.txt");
    expect(t.pb(["status"], { cwd: fork.path }).stdout).toContain("no problems");
    expect(sh(["git", "status", "--porcelain"], { cwd: fork.path }).stdout).toBe("");
  } finally {
    t.cleanup();
  }
}, TIMEOUT);
