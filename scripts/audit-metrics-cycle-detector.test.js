'use strict';
// ENG-27: the audit script's JS cycle detector matched `require(...)` over the
// whole file text, so a `require('./lifecycle')` written inside a PROSE COMMENT
// counted as a module edge. Three such phantom edges — two comments and one
// `require.main === module` arm — were the entire 4-node SCC the report kept
// printing, round after round, as "still a false positive".
//
// The script has no gate of its own (it is not in ci.yml and `make metrics-*`
// is a manual target), which is how the detector drifted unnoticed. This test
// runs inside the JS suite — ci.yml's `plugin-tests` job, which is
// ubuntu-latest ONLY. So the `python`-vs-`python3` fallback below is never
// exercised on macOS or Windows by CI; it exists for local runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'audit-metrics.py');

/**
 * The python interpreter to drive the script with, or null.
 *
 * Fail-closed on CI, matching `has_ripgrep` in tests/cli_e2e.rs: a silent skip
 * is how a whole surface ends up with zero executed coverage while the run
 * reports green (audit 2026-08-02 P1-8). Locally an absent python is a skip;
 * on CI it must redden.
 */
function pythonBin() {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[0])'], {
      encoding: 'utf8',
    });
    if (probe.status === 0 && probe.stdout.trim() === '3') return candidate;
  }
  if (process.env.CI) {
    throw new Error(
      'no python3 on PATH: the audit-metrics cycle detector would go untested. ' +
      'Install python or drop this assert deliberately.',
    );
  }
  return null;
}

/** Run a snippet with audit-metrics.py imported as module `am`. */
function runPy(bin, snippet) {
  const prelude = [
    'import importlib.util, json',
    `spec = importlib.util.spec_from_file_location("am", ${JSON.stringify(SCRIPT)})`,
    'am = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(am)',
  ].join('\n');
  // `-B`: importing the script writes scripts/__pycache__/ otherwise, and a test
  // that leaves build residue in a tracked directory is how a .pyc ends up
  // committed — the exact ENG-23 class this round removed from vendor/.
  const res = spawnSync(bin, ['-B', '-c', prelude + '\n' + snippet], { encoding: 'utf8' });
  assert.equal(res.status, 0, `python failed:\n${res.stderr}`);
  return res.stdout.trim();
}

test('the cycle detector ignores requires that only appear in comments', (t) => {
  const bin = pythonBin();
  if (!bin) return t.skip('no python3 (local run)');

  const src = [
    "const path = require('path');",
    "// it already does `require('./phantom')` on the way in",
    '/*',
    " * and here too: require('./phantom')",
    ' */',
    "const real = require('./real');",
  ];
  const kept = JSON.parse(runPy(bin, `print(json.dumps(am.js_import_lines(${JSON.stringify(src)})))`));
  const joined = kept.join('\n');
  assert.ok(!joined.includes('./phantom'), `comment requires must be dropped; kept:\n${joined}`);
  assert.ok(joined.includes("require('./real')"), `live requires must survive; kept:\n${joined}`);
});

test('the cycle detector ignores the require.main entry-point arm', (t) => {
  const bin = pythonBin();
  if (!bin) return t.skip('no python3 (local run)');

  const braced = [
    "const real = require('./real');",
    'if (require.main === module) {',
    "  const cli = require('./phantom');",
    '  cli.run();',
    '}',
    "const later = require('./after');",
  ];
  const keptBraced = JSON.parse(
    runPy(bin, `print(json.dumps(am.js_import_lines(${JSON.stringify(braced)})))`),
  );
  const joinedBraced = keptBraced.join('\n');
  assert.ok(!joinedBraced.includes('./phantom'), `script-only require must be dropped:\n${joinedBraced}`);
  assert.ok(
    joinedBraced.includes('./real') && joinedBraced.includes('./after'),
    `the block must end at its closing brace, not swallow the rest of the file:\n${joinedBraced}`,
  );

  // The brace-less one-liner form (incremental-index.js:9) skips exactly one line.
  const oneLiner = [
    "if (require.main === module) require('./phantom').install('X');",
    "const real = require('./real');",
  ];
  const keptOne = JSON.parse(
    runPy(bin, `print(json.dumps(am.js_import_lines(${JSON.stringify(oneLiner)})))`),
  );
  assert.deepEqual(keptOne, ["const real = require('./real');"]);
});

// Negative control: the detector must still SEE a real cycle. Without this,
// every assertion above passes on a detector that dropped every line.
test('the cycle detector still reports a genuine two-file cycle', (t) => {
  const bin = pythonBin();
  if (!bin) return t.skip('no python3 (local run)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'a.js');
  const b = path.join(dir, 'b.js');
  fs.writeFileSync(a, "const b = require('./b');\nmodule.exports = { b };\n");
  fs.writeFileSync(b, "const a = require('./a');\nmodule.exports = { a };\n");

  const graph = JSON.parse(runPy(bin, [
    `g = am.js_file_graph([${JSON.stringify(a)}, ${JSON.stringify(b)}])`,
    'print(json.dumps({k: sorted(v) for k, v in g.items()}))',
  ].join('\n')));
  assert.deepEqual(graph[a], [b], 'a → b must still be an edge');
  assert.deepEqual(graph[b], [a], 'b → a must still be an edge');
});
