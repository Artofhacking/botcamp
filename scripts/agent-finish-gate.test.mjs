import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { decide, handle, optedOut, touchedPaths } from "./agent-finish-gate.mjs";

test("a clean session may stop", () => {
  assert.equal(
    decide({
      reason: "end_turn",
      hasSnapshot: true,
      optedOut: false,
      touched: [],
      unpushed: [],
      needsPullRequest: false,
      loopCount: 0,
    }),
    null,
  );
});

test("uncommitted session files block the stop", () => {
  const decision = decide({
    reason: "end_turn",
    hasSnapshot: true,
    optedOut: false,
    touched: ["docs/handbook.md"],
    unpushed: [],
    needsPullRequest: false,
    loopCount: 0,
  });
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /docs\/handbook\.md/);
});

test("an explicit local opt-out is recorded from the prompt", () => {
  assert.equal(optedOut(["先放本地，不要提交"]), true);
  assert.equal(optedOut(["写好并推上去"]), false);
});

test("a shutdown fire and a pre-existing dirty tree do not block", () => {
  assert.equal(decide({ reason: "shutdown", hasSnapshot: true, optedOut: false, touched: ["a"], unpushed: [], needsPullRequest: false, loopCount: 0 }), null);
  assert.deepEqual(touchedPaths({ "a.js": "same" }, { "a.js": "same" }), []);
});

test("a session edit is committed and pushed before the turn ends", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "finish-gate-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const git = (args) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
  git(["init", "-b", "task"]);
  writeFileSync(path.join(cwd, "keep.txt"), "before\n");
  git(["add", "keep.txt"]);
  git(["commit", "-m", "base"]);
  writeFileSync(path.join(cwd, "old.txt"), "already\n");

  const start = JSON.stringify({ hook_event_name: "SessionStart", session_id: "s", source: "new" });
  assert.equal(handle(start, cwd), null);

  writeFileSync(path.join(cwd, "docs.txt"), "new\n");
  const stop = JSON.stringify({ hook_event_name: "Stop", session_id: "s", reason: "end_turn" });
  const blocked = handle(stop, cwd);
  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /docs\.txt/);
  assert.doesNotMatch(blocked.reason, /old\.txt/);

  git(["add", "docs.txt"]);
  git(["commit", "-m", "add the doc"]);
  const committed = handle(stop, cwd);
  assert.match(committed.reason, /Push these commits/);

  const prompt = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: "s",
    prompt: "先放本地",
  });
  handle(prompt, cwd);
  assert.equal(handle(stop, cwd), null);
});
