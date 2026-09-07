'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { findBinary } = require('./find-binary');
const { shouldRun } = require('./incremental-index');

// ── shouldRun gate (v0.21 opt-in flip) ──────────────────

test('shouldRun: default (no env) is OFF', () => {
  // v0.21: hook-driven incremental-index is opt-in. Rely on
  // ensure_file_indexed query-time freshness for MCP workflows.
  assert.equal(shouldRun({}), false);
});

test('shouldRun: CODE_GRAPH_HOOK_INDEX=on enables hook (opt-in)', () => {
  assert.equal(shouldRun({ CODE_GRAPH_HOOK_INDEX: 'on' }), true);
});

test('shouldRun: CODE_GRAPH_HOOK_INDEX=1 enables hook (truthy alias)', () => {
  assert.equal(shouldRun({ CODE_GRAPH_HOOK_INDEX: '1' }), true);
});

test('shouldRun: CODE_GRAPH_HOOK_INDEX=true enables hook (truthy alias)', () => {
  assert.equal(shouldRun({ CODE_GRAPH_HOOK_INDEX: 'true' }), true);
});

test('shouldRun: CODE_GRAPH_HOOK_INDEX=off keeps hook off (explicit)', () => {
  assert.equal(shouldRun({ CODE_GRAPH_HOOK_INDEX: 'off' }), false);
});

test('shouldRun: CODE_GRAPH_HOOK_INDEX with empty string is OFF', () => {
  assert.equal(shouldRun({ CODE_GRAPH_HOOK_INDEX: '' }), false);
});

test('shouldRun: CODE_GRAPH_HOOK_INDEX is case-insensitive', () => {
  assert.equal(shouldRun({ CODE_GRAPH_HOOK_INDEX: 'ON' }), true);
  assert.equal(shouldRun({ CODE_GRAPH_HOOK_INDEX: 'On' }), true);
  assert.equal(shouldRun({ CODE_GRAPH_HOOK_INDEX: 'TRUE' }), true);
});

test('hook script default-env spawn does not invoke the binary (default OFF)', () => {
  // End-to-end check: with the v0.21 opt-in flip, a default-env spawn of
  // incremental-index.js exits 0 immediately without touching the binary.
  const script = path.join(__dirname, 'incremental-index.js');
  const cleanEnv = { ...process.env };
  delete cleanEnv.CODE_GRAPH_HOOK_INDEX;
  const t0 = Date.now();
  const proc = spawnSync(process.execPath, [script], {
    env: cleanEnv,
    encoding: 'utf8',
    timeout: 2000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Should be much faster than the 80ms+ cold-start of running the binary.
  // 500ms is generous — actual is ~30-50ms node startup.
  assert.equal(proc.status, 0, `expected exit 0, got ${proc.status}; stderr: ${proc.stderr}`);
  assert.equal(proc.stdout, '', 'stdout must be empty when default-OFF');
  assert.ok(Date.now() - t0 < 500, 'default-OFF must short-circuit fast (< 500ms)');
});

// ── JS-32: the last registered hook that armed a budget and ignored it ──────
//
// `installHookFailOpen('PostToolUse:Write|Edit')` arms a 10 s deadline; the
// child below spent a literal 8 s regardless of what was left of it, and
// `findBinary()` runs first. Warm that fits; cold — first install, version
// bump, after `clearCache()` — the version probes plus 8 s overrun the deadline
// and Claude Code kills the hook on the user's own edit. JS-18 fixed the same
// shape in user-prompt-context.js; this was the one file left.

test('childBudgetMs reports the three budget states (JS-32)', () => {
  const { childBudgetMs, CHILD_TIMEOUT_MS } = require('./incremental-index');
  const { resetHookDeadline } = require('./hook-fail-open');

  try {
    // Nothing armed (a test importing this module): unchanged default.
    resetHookDeadline();
    assert.equal(childBudgetMs(), CHILD_TIMEOUT_MS);

    // More budget than the default: the default still caps it, so this change
    // cannot make the indexer run LONGER than it used to.
    resetHookDeadline(Date.now() + 60_000);
    assert.equal(childBudgetMs(), CHILD_TIMEOUT_MS);

    // Less: take what is left, as an integer — `child_process` throws
    // ERR_OUT_OF_RANGE on a fractional timeout and this hook's catch would
    // swallow that into silence.
    resetHookDeadline(Date.now() + 900);
    const tight = childBudgetMs();
    assert.ok(Number.isInteger(tight) && tight > 0 && tight <= 900, `got ${tight}`);

    // Exhausted: null means DO NOT RUN. Not 0 — node reads `timeout: 0` as no
    // timeout at all, which is the unbounded child this exists to prevent.
    resetHookDeadline(Date.now() - 1);
    assert.equal(childBudgetMs(), null);
  } finally {
    resetHookDeadline();
  }
});

test('no child of this hook carries a hard-coded timeout (JS-32)', () => {
  // The literal is the defect, so this reads the source: re-introducing
  // `timeout: 8000` would pass every behavioural assertion above while
  // restoring the overrun. The helper test and this one each cover half —
  // three states, and the wiring that spends them.
  const src = fs.readFileSync(path.join(__dirname, 'incremental-index.js'), 'utf8');
  const literals = src.match(/^\s*timeout:\s*\d+/gm) || [];
  assert.deepEqual(literals, [],
    `every child must take its timeout from childBudgetMs(); found ${literals.join(', ')}`);
  assert.match(src, /timeout: budget/,
    'the exec options must read the budget variable');
  assert.match(src, /budget === null/,
    'an exhausted budget must skip the child, not spend a default');
});

test('incremental-index bails silently when cwd is not a git repo', (t) => {
  const bin = findBinary();
  if (!bin) {
    // Binary not built — skip rather than fail; matches session-init.test.js convention.
    return;
  }
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-graph-no-git-')));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const result = spawnSync(bin, ['incremental-index', '--quiet'], {
    cwd: tmpRoot,
    timeout: 8000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
  assert.equal(
    fs.existsSync(path.join(tmpRoot, '.code-graph')),
    false,
    '.code-graph must not be created outside a git repo',
  );
});

test('incremental-index runs inside a minimal git repo without creating stray state', (t) => {
  const bin = findBinary();
  if (!bin) return;
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-graph-git-')));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  fs.mkdirSync(path.join(tmpRoot, '.git'));
  const result = spawnSync(bin, ['incremental-index', '--quiet'], {
    cwd: tmpRoot,
    timeout: 8000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
  // Index may or may not materialize for an empty repo; the contract is that the guard does NOT block this case.
});
