#!/usr/bin/env node
// Blocks an agent turn while this session's tracked edits are still local.
// Paths that were already dirty when the session started are not this session's work.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OPT_OUT =
  /leave it local|don'?t commit|do not commit|don'?t push|do not push|先放本地|先别提交|不要提交|别提交|不要推送|别推送/i;

export function decide(input) {
  if (input.subagent) return null;
  if (input.reason && input.reason !== "end_turn") return null;
  if (input.loopCount > 5) return null;
  if (!input.hasSnapshot || input.optedOut) return null;
  const pending = input.touched.length > 0 || input.unpushed.length > 0 || input.needsPullRequest;
  if (!pending) return null;
  const lines = [
    "This session's work is still only local. Commit it, push it, and open the pull request before stopping. Do not wait to be asked.",
  ];
  if (input.touched.length > 0) {
    lines.push(
      `Commit only these paths, which changed after the session started: ${input.touched.join(", ")}. Leave paths that were already dirty.`,
    );
  }
  if (input.unpushed.length > 0) {
    lines.push(`Push these commits: ${input.unpushed.join(", ")}.`);
  }
  if (input.needsPullRequest) {
    lines.push("Open a pull request for this branch. main does not need one.");
  }
  lines.push(
    "The closing report names the remote ref, the commit, and the pull request, and says whether production runs that commit. A branch, a merge, and a local build are not production.",
  );
  return { decision: "block", reason: lines.join(" ") };
}

export function optedOut(prompts) {
  return prompts.some((prompt) => OPT_OUT.test(prompt));
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function stateFile(cwd, sessionId) {
  const rel = git(cwd, ["rev-parse", "--git-path", "agent-finish"]);
  const dir = path.resolve(cwd, rel);
  mkdirSync(dir, { recursive: true });
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_") || "session";
  return path.join(dir, safe + ".json");
}

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function fileHash(cwd, relPath) {
  try {
    const bytes = readFileSync(path.join(cwd, relPath));
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return "absent";
  }
}

export function dirtyMap(cwd) {
  let text = "";
  try {
    text = git(cwd, ["status", "--porcelain"]);
  } catch {
    return {};
  }
  const map = {};
  for (const line of text.split("\n")) {
    if (line.length < 4) continue;
    let file = line.slice(3);
    const arrow = file.lastIndexOf(" -> ");
    if (arrow !== -1) file = file.slice(arrow + 4);
    map[file] = fileHash(cwd, file);
  }
  return map;
}

export function touchedPaths(before, after) {
  const touched = [];
  for (const [file, hash] of Object.entries(after)) {
    if (before[file] !== hash) touched.push(file);
  }
  return touched.sort();
}

function unpushedCommits(cwd, from, to) {
  if (!from || from === to) return [];
  let list = "";
  try {
    list = git(cwd, ["rev-list", `${from}..${to}`]);
  } catch {
    return [];
  }
  return list
    .split("\n")
    .filter(Boolean)
    .filter((sha) => {
      try {
        return git(cwd, ["branch", "-r", "--contains", sha]).length === 0;
      } catch {
        return true;
      }
    })
    .map((sha) => sha.slice(0, 12));
}

function needsPullRequest(cwd) {
  let branch = "";
  try {
    branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return false;
  }
  if (branch === "main" || branch === "HEAD") return false;
  try {
    git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  } catch {
    return false;
  }
  try {
    execFileSync("gh", ["pr", "view", "--json", "number"], { cwd, stdio: "ignore" });
    return false;
  } catch (error) {
    const missing = error && error.status === 1;
    return missing;
  }
}

function eventName(input, argvMode) {
  if (argvMode === "cursor-start" || argvMode === "sessionStart") return "SessionStart";
  if (argvMode === "cursor-prompt" || argvMode === "prompt") return "UserPromptSubmit";
  if (argvMode === "cursor-stop" || argvMode === "stop") return "Stop";
  return input.hook_event_name || input.hookEventName || "";
}

function sessionId(input) {
  return input.session_id || input.sessionId || input.conversation_id || input.conversationId || "session";
}

function promptText(input) {
  const value = input.prompt || input.userPrompt || input.user_prompt || input.message || "";
  return String(value).slice(0, 2000);
}

function cursorReply(decision) {
  if (!decision) return null;
  return { followup_message: decision.reason };
}

export function handle(raw, cwd, argvMode) {
  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    return null;
  }
  const event = eventName(input, argvMode);
  const file = stateFile(cwd, sessionId(input));
  if (event === "SessionStart" || event === "session_start") {
    const source = input.source || "";
    if ((source === "load" || source === "resume") && readState(file)) return null;
    writeFileSync(
      file,
      JSON.stringify({ head: git(cwd, ["rev-parse", "HEAD"]), dirty: dirtyMap(cwd), prompts: [] }),
    );
    return null;
  }
  if (event === "UserPromptSubmit" || event === "user_prompt_submit") {
    const state = readState(file) || { head: "", dirty: {}, prompts: [] };
    state.prompts = [...(state.prompts || []), promptText(input)].slice(-20);
    writeFileSync(file, JSON.stringify(state));
    return null;
  }
  if (event !== "Stop" && event !== "stop" && event !== "SubagentStop") return null;
  const state = readState(file);
  const head = state ? git(cwd, ["rev-parse", "HEAD"]) : "";
  const touched = state ? touchedPaths(state.dirty || {}, dirtyMap(cwd)) : [];
  const unpushed = state ? unpushedCommits(cwd, state.head, head) : [];
  const pushedSessionWork = Boolean(state && state.head && state.head !== head && touched.length === 0 && unpushed.length === 0);
  const decision = decide({
    reason: input.reason,
    subagent: Boolean(input.subagentType || input.subagent_type),
    loopCount: Number(input.loop_count || input.loopCount || 0),
    hasSnapshot: Boolean(state && state.head),
    optedOut: optedOut((state && state.prompts) || []),
    touched,
    unpushed,
    needsPullRequest: pushedSessionWork && needsPullRequest(cwd),
  });
  if (argvMode && argvMode.startsWith("cursor-")) return cursorReply(decision);
  return decision;
}

function main() {
  try {
    const reply = handle(readFileSync(0, "utf8"), process.cwd(), process.argv[2]);
    if (reply) process.stdout.write(JSON.stringify(reply));
  } catch {
    // A broken git checkout must not trap the turn.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
