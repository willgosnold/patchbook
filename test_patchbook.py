"""End-to-end tests: each one builds a throwaway upstream repo and drives the CLI against it."""

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

TOOL = Path(__file__).resolve().parent / "patchbook.py"


def sh(*args, cwd, check=True):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=check)


class Repo:
    def __init__(self, path):
        self.path = path
        path.mkdir(parents=True, exist_ok=True)
        if not (path / ".git").exists():
            sh("git", "init", "-q", "-b", "main", cwd=path)

    def write(self, rel, text, mode=0o644):
        p = self.path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(textwrap.dedent(text).lstrip("\n"))
        p.chmod(mode)

    def read(self, rel):
        return (self.path / rel).read_text()

    def rm(self, rel):
        (self.path / rel).unlink()

    def commit(self, message="change"):
        sh("git", "add", "-A", cwd=self.path)
        sh("git", "commit", "-q", "-m", message, cwd=self.path)
        return sh("git", "rev-parse", "HEAD", cwd=self.path).stdout.strip()


class Case(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.env = {**os.environ, "XDG_CACHE_HOME": str(self.tmp / "cache"),
                    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                    "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_GLOBAL": "/dev/null"}
        os.environ.update({k: v for k, v in self.env.items() if k.startswith("GIT_")})

    def pb(self, *args, cwd, code=0):
        r = subprocess.run([sys.executable, str(TOOL), *args], cwd=cwd, capture_output=True, text=True, env=self.env)
        if code is not None:
            self.assertEqual(r.returncode, code, f"patchbook {' '.join(args)}\n{r.stdout}\n{r.stderr}")
        return r


class ForkTest(Case):
    def setUp(self):
        super().setUp()
        self.up = Repo(self.tmp / "upstream")
        self.up.write("app.txt", """
            one
            two
            three
            four
            five
            six
            seven
        """)
        self.up.write("docs/guide.md", "a guide\n")
        self.up.write("bin/run.sh", "#!/bin/sh\necho run\n", 0o755)
        self.up.commit("start")
        self.pb("clone", str(self.up.path), "fork", cwd=self.tmp)
        self.fork = Repo(self.tmp / "fork")

    def record_feature(self):
        self.fork.write("app.txt", self.fork.read("app.txt").replace("two", "TWO"))
        self.fork.write("extra.txt", "ours\n")
        self.fork.rm("docs/guide.md")
        self.pb("record", "feature", "--intent", "Shout the second line, add extra.txt, drop the guide.", cwd=self.fork.path)
        self.pb("build", cwd=self.fork.path)
        self.fork.commit("record")

    def test_clone_keeps_history_and_pins(self):
        log = sh("git", "log", "--oneline", cwd=self.fork.path).stdout
        self.assertIn("start", log)
        self.assertIn("upstream", sh("git", "remote", cwd=self.fork.path).stdout)
        self.assertEqual(self.pb("check", cwd=self.fork.path).returncode, 0)

    def test_record_then_build_is_stable(self):
        self.record_feature()
        change = (self.fork.path / ".patchbook/changes/feature/CHANGE.md").read_text()
        self.assertIn("- file app.txt", change)
        self.assertIn("- add extra.txt", change)
        self.assertIn("- delete docs/guide.md", change)
        self.pb("build", cwd=self.fork.path)
        self.assertEqual(sh("git", "status", "--porcelain", cwd=self.fork.path).stdout, "")
        self.assertIn("TWO", self.pb("show", "feature", cwd=self.fork.path).stdout)

    def test_sync_merges_clean_upstream_change(self):
        self.record_feature()
        self.up.write("app.txt", self.up.read("app.txt").replace("six", "SIX"))
        head = self.up.commit("upstream edit")
        check = self.pb("check", cwd=self.fork.path, code=10)
        self.assertIn("changed app.txt", check.stdout)
        self.pb("sync", cwd=self.fork.path)
        report = json.loads((self.fork.path / ".patchbook/last-sync.json").read_text())
        self.assertEqual([m["path"] for m in report["merged"]], ["app.txt"])
        self.pb("build", "--commit", cwd=self.fork.path)
        text = self.fork.read("app.txt")
        self.assertIn("TWO", text)
        self.assertIn("SIX", text)
        parents = sh("git", "rev-list", "--parents", "-n1", "HEAD", cwd=self.fork.path).stdout.split()
        self.assertEqual(parents[2], head)  # the build merges upstream, so its history stays reachable

    def test_conflict_and_gone(self):
        self.record_feature()
        self.up.write("app.txt", self.up.read("app.txt").replace("two", "deux"))
        self.up.commit("conflicting edit")
        self.pb("sync", cwd=self.fork.path)
        status = self.pb("status", cwd=self.fork.path, code=1).stdout
        self.assertIn("conflict", status)
        self.pb("build", cwd=self.fork.path, code=1)

    def test_upstream_deletes_an_edited_file(self):
        self.record_feature()
        self.up.rm("app.txt")
        self.up.write("src/app.txt", "moved\n")
        self.up.commit("move")
        self.pb("sync", cwd=self.fork.path)
        report = json.loads((self.fork.path / ".patchbook/last-sync.json").read_text())
        self.assertEqual(report["gone"][0]["maybe"][0], "src/app.txt")
        self.assertIn("gone", self.pb("status", cwd=self.fork.path, code=1).stdout)

    def test_build_refuses_to_overwrite_hand_edits(self):
        self.record_feature()
        self.fork.write("app.txt", "hand edit\n")
        self.pb("build", cwd=self.fork.path, code=1)
        self.pb("build", "--force", cwd=self.fork.path)
        self.assertIn("TWO", self.fork.read("app.txt"))

    def test_exec_bit_survives(self):
        self.record_feature()
        self.assertTrue(os.access(self.fork.path / "bin/run.sh", os.X_OK))


class VendorTest(Case):
    def setUp(self):
        super().setUp()
        self.up = Repo(self.tmp / "upstream")
        self.up.write("plugin/skills/hello/SKILL.md", """
            ---
            name: Hello
            ---

            # Hello

            Open Cursor and say hello.

            Then wave.
        """)
        self.up.write("plugin/agents/helper.md", "A helper.\n")
        self.up.write("plugin/README.md", "For Cursor users.\n")
        self.up.write("other/ignored.md", "Not followed.\n")
        self.up.commit("start")
        self.repo = Repo(self.tmp / "adapted")
        self.repo.write("README.md", "mine\n")
        self.repo.commit("start")
        self.pb("init", "--upstream", str(self.up.path), "--path", "plugin", "--vendor", "vendor/plugin",
                "--output-from", "skills", "--output-to", "skills", cwd=self.repo.path)
        config = self.repo.path / ".patchbook/config.toml"
        config.write_text(config.read_text() + textwrap.dedent('''
            [placeholders.snippet]
            file = ".patchbook/snippets.md"
            format = "sections"

            [[check]]
            name = "cursor"
            files = ["**/*.md"]
            pattern = '\\bCursor\\b'
        '''))
        self.repo.write(".patchbook/snippets.md", "## greet\n\nSay hello in T3.\n")

    def test_missing_scaffold_patch_build(self):
        status = self.pb("status", cwd=self.repo.path, code=1).stdout
        self.assertIn("missing   skills/hello/SKILL.md", status)
        self.assertNotIn("README", status)  # only what ships is checked
        self.pb("scaffold", cwd=self.repo.path)
        entries = self.repo.path / ".patchbook/blocks/skills/hello/SKILL.md.entries"
        text = entries.read_text().replace("rules: \nintent: \n", "rules: t3\nintent: Speak T3.\n")
        head, _, _ = text.partition("--- patched\n")
        entries.write_text(head + "--- patched\n{{snippet:greet}}\n")
        self.pb("build", cwd=self.repo.path)
        out = self.repo.read("skills/hello/SKILL.md")
        self.assertIn("Say hello in T3.", out)
        self.assertNotIn("Cursor", out)
        self.assertFalse((self.repo.path / "skills/README.md").exists())
        return entries

    def test_structural_edits(self):
        self.test_missing_scaffold_patch_build()
        change = self.repo.path / ".patchbook/changes/support"
        (change / "ours/skills/support").mkdir(parents=True)
        (change / "ours/skills/support/SKILL.md.pb").write_text("---\nname: support\n---\n")
        (change / "CHANGE.md").write_text(textwrap.dedent("""
            # support

            intent: Ship the agent briefs inside a support skill.

            edits:
            - add skills/support/SKILL.md
            - move agents -> skills/support/agents
        """).lstrip())
        (self.repo.path / ".patchbook/series").write_text("support\n")
        self.pb("build", cwd=self.repo.path)
        self.assertEqual(self.repo.read("skills/support/agents/helper.md"), "A helper.\n")
        self.assertTrue((self.repo.path / "skills/support/SKILL.md").exists())

    def test_record_in_vendor_output(self):
        self.test_missing_scaffold_patch_build()
        self.repo.write("skills/hello/notes.txt", "added by hand\n")
        self.pb("record", "notes", "--intent", "Add notes.", cwd=self.repo.path)
        self.assertIn("- add skills/hello/notes.txt", (self.repo.path / ".patchbook/changes/notes/CHANGE.md").read_text())
        self.pb("build", cwd=self.repo.path)
        self.assertEqual(self.repo.read("skills/hello/notes.txt"), "added by hand\n")

    def test_upstream_rewords_a_patched_block(self):
        self.test_missing_scaffold_patch_build()
        self.repo.commit("built")
        skill = "plugin/skills/hello/SKILL.md"
        self.up.write(skill, self.up.read(skill).replace("say hello", "say hi"))
        self.up.commit("reword")
        self.pb("check", cwd=self.repo.path, code=10)
        self.pb("sync", cwd=self.repo.path)
        status = self.pb("status", cwd=self.repo.path, code=1).stdout
        self.assertIn("orphan", status)
        self.assertIn("missing", status)
        self.assertRegex(status, r"nearest new blocks: line 7 \[[0-9a-f]{12}\] 0\.9")

    def test_vendor_copy_is_guarded(self):
        self.repo.write("vendor/plugin/README.md", "edited\n")
        self.assertIn("Never edit the vendored copy", self.pb("status", cwd=self.repo.path, code=1).stderr)

    def test_other_upstream_paths_do_not_move_the_pin(self):
        self.up.write("other/ignored.md", "changed\n")
        self.up.commit("elsewhere")
        out = json.loads(self.pb("check", cwd=self.repo.path).stdout)
        self.assertFalse(out["moved"])


if __name__ == "__main__":
    unittest.main()
