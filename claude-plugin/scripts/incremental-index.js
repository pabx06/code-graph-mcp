#!/usr/bin/env node
'use strict';
// FIRST statement, before this file's other requires (pre-tag review
// 2026-09-02): the handler installed after them could not catch a throw
// from `require('./lifecycle')` itself, which is exactly the broken-install
// case JS-12 exists for. Guarded on `require.main` so importing this module
// in a test does NOT install a process-wide handler that exits 0 — that
// would swallow the test's own failures.
if (require.main === module) require('./hook-fail-open').installHookFailOpen('PostToolUse:Write|Edit');

const { execFileSync } = require('child_process');
const { findBinary } = require('./find-binary');
const { hidden } = require('./proc-opts');

// Default allowance for this hook's one child, spent through the hook budget
// below. The PostToolUse deadline armed at the top of this file is 10 s.
const CHILD_TIMEOUT_MS = 8000;

/**
 * How long the indexer child may run: the default when nothing armed a deadline
 * (a test importing this module, a manual invocation), or whatever is LEFT of
 * the PostToolUse budget. `null` means the budget is exhausted — do not run.
 *
 * JS-32: the child spent a literal 8 s no matter how much of the 10 s deadline
 * `findBinary()` had already consumed, so a cold cache overran it and Claude
 * Code killed the hook on the user's own edit. Exported because `runMain()`
 * cannot be reached from a test without spawning the hook (JS-18's shape).
 */
function childBudgetMs() {
  return require('./hook-fail-open').remainingMs(CHILD_TIMEOUT_MS);
}

// v0.21 — gated default-off. v0.18.0 added query-time freshness
// (ensure_file_indexed) inside MCP tools that take a file_path arg, so a
// PostToolUse hook spawning a fresh process on every Edit/Write was redundant
// for the MCP-driven workflow and just burnt ~80ms cold-start per edit.
//
// CLI-only workflows (running `code-graph-mcp search` after Bash-side edits
// without going through MCP) need the hook to keep the DB fresh, so the knob
// lets users opt back in.
//
// Priority (high → low):
//   1. CODE_GRAPH_HOOK_INDEX=on  → run the hook (opt-in)
//   2. CODE_GRAPH_HOOK_INDEX=off → skip
//   3. default                   → skip (v0.21 flip)
function shouldRun(env = process.env) {
  const v = (env.CODE_GRAPH_HOOK_INDEX || '').toLowerCase();
  if (v === 'on' || v === '1' || v === 'true') return true;
  return false;
}

function runMain() {
  if (!shouldRun()) return;

  const bin = findBinary();
  if (!bin) return; // silent — binary not installed yet

  // Read AFTER findBinary(): that chain is what eats the budget on a cold
  // cache, and asking before it would hand the child an allowance nobody had.
  const budget = childBudgetMs();
  if (budget === null) return; // exhausted — the index waits for the next edit

  try {
    execFileSync(bin, ['incremental-index', '--quiet'], hidden({
      timeout: budget,
      stdio: ['pipe', 'pipe', 'pipe']
    }));
  } catch { /* timeout or error — silent for hook */ }
}

if (require.main === module) {
  runMain();
}

module.exports = { shouldRun, childBudgetMs, CHILD_TIMEOUT_MS };
