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
// Deliberately tiny and dependency-free beyond node builtins. `statusline.js`
// and `user-prompt-context.js` run on hook paths with a measured startup budget;
// pulling `lifecycle.js` (2k lines) into them for a path string would spend that
// budget on a constant, which is why one of them was hardcoding the path in the
// first place.
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
