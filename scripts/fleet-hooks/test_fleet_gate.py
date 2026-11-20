"""fleet_gate.py as Claude Code runs it: JSON on stdin, exit 2 + stderr to refuse. Run: python3 -m unittest -v test_fleet_gate"""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

GATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fleet_gate.py")


class Gate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cfg = os.path.join(self.tmp.name, "cfg.json")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("FLEET_")}
        self.env.update(FLEET_HOOKS_CONFIG=self.cfg, FLEET_HOOKS_STATE=os.path.join(self.tmp.name, "state"))

    def run_gate(self, mode, tool="Bash", agent="a1", env=None, cwd=None, **inp):
        d = {"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": inp}
        if cwd:
            d["cwd"] = cwd
        if agent:
            d["agent_id"] = agent
        r = subprocess.run([sys.executable, "-S", GATE, mode], input=json.dumps(d), capture_output=True, text=True,
                           env=dict(self.env, **(env or {})))
        return r.returncode, r.stderr

    def bash(self, cmd, **kw):
        return self.run_gate("poll", command=cmd, **kw)

    # poll gate
    def test_long_sleep_refused_with_alternative(self):
        code, err = self.bash("sleep 60 && gh run list")
        self.assertEqual(code, 2)
        self.assertIn("gh run watch", err)
        self.assertIn("Monitor", err)

    def test_sleeps_add_up_and_units(self):
        self.assertEqual(self.bash("sleep 10; make; sleep 10")[0], 2)
        self.assertEqual(self.bash("sleep 1m")[0], 2)
        self.assertEqual(self.bash("sleep 2 && curl -s localhost:3000")[0], 0)

    def test_unbounded_poll_loop_refused_bounded_allowed(self):
        self.assertEqual(self.bash("until curl -s x; do sleep 5; done")[0], 2)
        self.assertEqual(self.bash("while ! test -f done.txt; do sleep 2; done")[0], 2)
        self.assertEqual(self.bash("for i in $(seq 30); do check && break; sleep 10; done")[0], 2)
        self.assertEqual(self.bash("timeout 600 bash -c 'until curl -s x; do sleep 5; done'")[0], 0)
        self.assertEqual(self.bash("for f in *.png; do convert $f; done; sleep 1")[0], 0, "sleep after the loop")
        self.assertEqual(self.bash("while read l; do echo $l; done < f")[0], 0)

    def test_background_sleep_refused(self):
        self.assertEqual(self.bash("sleep 5", run_in_background=True)[0], 2)

    def test_status_polls_capped_per_agent(self):
        for _ in range(3):
            self.assertEqual(self.bash("gh run list -L 3")[0], 0)
        code, err = self.bash("gh run view 123")
        self.assertEqual(code, 2)
        self.assertIn("status check number 4", err)
        self.assertEqual(self.bash("gh run view 123 --log-failed")[0], 0, "reading a log is not a poll")
        self.assertEqual(self.bash("gh run list", agent="a2")[0], 0, "counted per agent")
        self.assertEqual(self.bash("heavy --status")[0], 2)

    def test_lead_session_and_other_tools_not_gated(self):
        self.assertEqual(self.bash("sleep 600", agent=None)[0], 0)
        self.assertEqual(self.run_gate("poll", tool="Read", file_path="/x")[0], 0)

    def test_zero_turns_off_and_threshold_configurable(self):
        self.assertEqual(self.bash("sleep 600", env={"FLEET_POLL_SLEEP_MAX": "0"})[0], 0)
        self.assertEqual(self.bash("until x; do sleep 1; done", env={"FLEET_POLL_SLEEP_MAX": "0"})[0], 0)
        with open(self.cfg, "w") as fh:
            json.dump({"poll_sleep_max": 100}, fh)
        self.assertEqual(self.bash("sleep 60")[0], 0)
        self.assertEqual(self.bash("sleep 60", env={"FLEET_POLL_SLEEP_MAX": "30"})[0], 2, "env beats the file")

    def test_bad_config_fails_loudly(self):
        with open(self.cfg, "w") as fh:
            fh.write("{oops")
        code, err = self.bash("ls")
        self.assertEqual(code, 2)
        self.assertIn("misconfigured", err)
        with open(self.cfg, "w") as fh:
            json.dump({"commit_cap": -1}, fh)
        self.assertEqual(self.run_gate("cap", tool="Read")[0], 2)
        with open(self.cfg, "w") as fh:
            json.dump({"comit_cap": 5}, fh)
        code, err = self.bash("ls")
        self.assertIn("unknown setting", err)
        self.assertEqual(self.bash("ls", env={"FLEET_COMMIT_CAP": "lots"}, agent="z")[0], 2)

    # commit cap
    def cap(self, n, tool="Read", cwd=None, **inp):
        return [self.run_gate("cap", tool=tool, env={"FLEET_COMMIT_CAP": "5", "FLEET_COMMIT_CAP_REPEAT": "2"},
                              cwd=cwd, **inp) for _ in range(n)]

    def test_cap_warns_repeats_then_stops(self):
        r = self.cap(4)
        self.assertTrue(all(c == 0 for c, _ in r))
        code, err = self.cap(1)[0]                             # call 5
        self.assertEqual(code, 2)
        self.assertIn("since its last commit", err)
        self.assertIn("SubagentHandback", err)
        self.assertEqual([c for c, _ in self.cap(4)], [0, 2, 0, 2])  # 6..9: every 2nd refused
        self.assertEqual([c for c, _ in self.cap(2)], [2, 2])        # 10, 11: hard stop
        self.assertEqual(self.cap(1, tool="Bash", command="git status")[0][0], 0, "git still runs")
        self.assertEqual(self.cap(1, tool="Bash", command="sudo -u core nightly agent say x hi")[0][0], 0)
        self.assertEqual(self.cap(1, tool="SubagentHandback", message="stuck")[0][0], 0)

    def test_commit_resets_the_count(self):
        self.cap(4)
        self.assertEqual(self.cap(1, tool="Bash", command="git -C repo commit -qm x")[0][0], 0)
        self.assertTrue(all(c == 0 for c, _ in self.cap(4)))
        self.cap(1, tool="Bash", command="git merge-base a b")             # call 5: git is exempt, but no reset
        self.assertEqual([c for c, _ in self.cap(2)], [0, 2], "merge-base is no commit")

    def test_cap_zero_is_unlimited(self):
        r = [self.run_gate("cap", tool="Read", env={"FLEET_COMMIT_CAP": "0"}) for _ in range(3)]
        self.assertTrue(all(c == 0 for c, _ in r))

    # vjudge-second-review-1: false positives and false resets
    def test_quoted_and_heredoc_data_is_not_code(self):
        self.assertEqual(self.bash('grep -rn "sleep 60" scripts/')[0], 0)
        self.assertEqual(self.bash('git commit -qm "poll: while true; do sleep 30; done is refused"')[0], 0)
        self.assertEqual(self.bash("sudo -u core nightly note k 'until ok; do sleep 9; done'")[0], 0)
        self.assertEqual(self.bash("cat > t.sh <<'EOF'\nwhile true; do sleep 60; done\nEOF\nchmod +x t.sh")[0], 0)
        self.assertEqual(self.bash("python3 - <<'EOF'\nt = 'until x; do sleep 5; done'\nEOF")[0], 0,
                         "found live 2026-11-20: a python here-document holding test text was refused")
        self.assertEqual(self.bash("bash -c 'sleep 60'")[0], 2, "a shell's quoted text is code")
        self.assertEqual(self.bash("bash <<EOF\nsleep 60\nEOF")[0], 2, "a here-document fed to a shell is code")
        self.assertEqual(self.bash("ssh box 'until ok; do sleep 5; done'")[0], 2)

    def test_short_for_retry_is_not_a_poll(self):
        self.assertEqual(self.bash("for i in 1 2 3; do curl -sf x && break; sleep 2; done")[0], 0)
        self.assertEqual(self.bash("for i in {1..5}; do t && break; sleep 3; done")[0], 0)
        self.assertEqual(self.bash("for i in $(seq 10); do t && break; sleep 3; done")[0], 2, "10 x 3 s")
        self.assertEqual(self.bash("for f in $(ls); do t; sleep 1; done")[0], 2, "unknown length")

    def test_background_only_refused_as_a_timer(self):
        self.assertEqual(self.bash("./server & sleep 2; curl -s localhost:8000", run_in_background=True)[0], 0)
        self.assertEqual(self.bash("sleep 10; tail -5 log", run_in_background=True)[0], 2)

    def test_status_count_resets_with_window_and_commit(self):
        env = {"FLEET_POLL_STATUS_WINDOW": "1"}
        for _ in range(3):
            self.bash("heavy --status", env=env)
        time.sleep(1.2)
        self.assertEqual(self.bash("heavy --status", env=env)[0], 0, "old checks aged out of the window")
        for _ in range(3):
            self.bash("gh run list", agent="w")
        self.run_gate("cap", agent="w", command="git commit -qm x")
        self.run_gate("cap", agent="w", tool="Read")
        self.assertEqual(self.bash("gh run list", agent="w")[0], 0, "a commit starts a new count")

    def test_exempt_needs_git_or_nightly_as_the_command(self):
        self.cap(10)
        self.assertEqual(self.cap(1, tool="Bash", command="cat .git/config")[0][0], 2)
        self.assertEqual(self.cap(1, tool="Bash", command="ls ~/stack/nightly/bin")[0][0], 2)
        self.assertEqual(self.cap(1, tool="Bash", command="cd ~/wt/x && git add -A && git status")[0][0], 0)
        self.assertEqual(self.cap(1, tool="Bash", command="sudo -u core /home/core/stack/nightly/bin/nightly "
                                                          "note k done")[0][0], 0)

    def test_commit_word_must_be_the_git_subcommand(self):
        self.cap(4)
        self.cap(1, tool="Bash", command="git cat-file commit HEAD")              # call 5, exempt, no reset
        self.assertEqual([c for c, _ in self.cap(2)], [0, 2], "call 7 refused: cat-file commit is no commit")
        self.cap(1, tool="Bash", command="git commit --dry-run")
        self.assertEqual(self.cap(1)[0][0], 2, "a dry run is no commit")

    def git(self, repo, *a):
        subprocess.run(["git", "-C", repo] + list(a), check=True, capture_output=True,
                       env=dict(self.env, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t",
                                GIT_COMMITTER_EMAIL="t@t"))

    def test_failed_commit_resets_nothing_and_a_real_one_does(self):
        repo = os.path.join(self.tmp.name, "r")
        os.makedirs(repo)
        self.git(repo, "init", "-q")
        self.git(repo, "commit", "-q", "--allow-empty", "-m", "a")
        time.sleep(1.1)
        self.cap(4)
        self.assertEqual(self.cap(1, tool="Bash", cwd=repo, command="git commit -qm nothing-staged")[0][0], 0)
        self.assertEqual([c for c, _ in self.cap(2)], [0, 2], "the commit failed (HEAD did not move): call 7 refused")
        self.cap(1, tool="Bash", command="cd %s && git commit -qm x" % repo)
        self.git(repo, "commit", "-q", "--allow-empty", "-m", "b")              # the commit runs
        self.assertTrue(all(c == 0 for c, _ in self.cap(4)), "count restarted after the commit landed")
        self.assertEqual(self.cap(1)[0][0], 2)

    def test_timeout_bounds_loops_however_nested(self):
        """Replayed from real transcripts, 2026-11-20: all one blocking call each."""
        ok = ["timeout 235 ssh ph 'timeout 225 bash -c \"until test -f d; do sleep 5; done\"'",
              "timeout 590 ssh ph 'while pgrep godot; do sleep 5; done'",
              "ssh ph 'timeout 200 bash -c \"until test -f d; do sleep 5; done\"'",
              "for i in 1; do timeout 178 bash -c 'until grep -q x log; do sleep 30; done'; done",
              "sudo -u gamedev timeout 240 bash -c 'until test -f d; do sleep 5; done'",
              "nohup bash -c 'while pgrep -f job; do sleep 10; done; ./next' >/dev/null 2>&1 &"]
        for cmd in ok:
            self.assertEqual(self.bash(cmd)[0], 0, cmd)
        bad = ["timeout 118 bash -c 'sleep 115'", "timeout 200 bash -c 'sleep 60; true'",
               "ssh ph 'until test -f d; do sleep 5; done'", "while x; do sleep 5; done &",
               "bash -c 'while x; do sleep 5; done' & timeout 9 true"]
        for cmd in bad:
            self.assertEqual(self.bash(cmd)[0], 2, cmd)

    def test_hook_start_is_cheap(self):
        t = time.time()
        for _ in range(5):
            self.run_gate("cap", tool="Read")
        self.assertLess((time.time() - t) / 5, 0.5, "a hook on every tool call must stay cheap")


if __name__ == "__main__":
    unittest.main()
