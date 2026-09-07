'use strict';
// Single home for the `~/.cache/code-graph` file names.
//
// JS-05 (audit 2026-09-05): `update-state.json` was spelled in five modules,
// `install.lock` in two, `install-manifest.json` in three — and two of those
// rebuilt the whole path out of `os.homedir()` rather than joining `CACHE_DIR`,
// so the modules that would break first if the cache layout moved were also the
// two that never load the module where it was defined. A rename had to be found
// by grep. `tests/hardening.rs::cache_file_names_have_exactly_one_spelling`
// keeps this the only file that may spell them.
//
// Deliberately tiny and dependency-free beyond node builtins, for ONE consumer:
// `user-prompt-context.js` runs on the UserPromptSubmit hook path and does not
// load `lifecycle.js`, so taking a path string from there would cost it the
// whole module. Measured at 30.1 ms as shipped versus 34.5 ms if it also loaded
// `lifecycle.js` (+14%).
//
// `statusline.js` was the other hardcoded spelling and is NOT a reason for this
// file — it already does `require('./lifecycle')`, so its copy of the three path
// segments bought nothing. An earlier version of this comment claimed both
// modules needed the split (pre-ship review 2026-09-07).
const os = require('os');
const path = require('path');

const CACHE_DIR = path.join(os.homedir(), '.cache', 'code-graph');

/** Auto-update bookkeeping: available version, attempt counters, last error. */
const UPDATE_STATE_FILE = path.join(CACHE_DIR, 'update-state.json');
/** What the last install wrote, and where. Absent = never installed. */
const MANIFEST_FILE = path.join(CACHE_DIR, 'install-manifest.json');
/** Inter-process install lock (see install-lock.js). */
const INSTALL_LOCK_FILE = path.join(CACHE_DIR, 'install.lock');

module.exports = {
  CACHE_DIR,
  UPDATE_STATE_FILE,
  MANIFEST_FILE,
  INSTALL_LOCK_FILE,
};
