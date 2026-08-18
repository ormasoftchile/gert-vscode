// repoBoundary.test.js — repo-wide guard against cross-repo path leaks and
// unconditional/precondition-based skips in test sources.
//
// Mirrors gert/internal/tool/repo_boundary_test.go (TestRepoBoundary_NoExternalPaths)
// which Don added in response to the same systemic defect class.
//
// **What this guard catches:**
//
//  1. Sibling-repo references — any test file that mentions a sibling repo
//     name (assembled at runtime so this file doesn't trigger itself).
//
//  2. Cross-repo ".." traversals — any `path.join(..., '..', ...)` or
//     string literal `'../'` that walks outside this repo into a sibling.
//     Specifically: occurrences of `../gert` (the engine repo) or
//     `../gert-private` (the private companion repo).
//
//  3. GERT_BIN-style sibling-repo escapes — any reference to the
//     `GERT_BIN` env variable in a unit-test file (*.test.js at
//     test/*.test.js depth, i.e. NOT in test/integration/), which is the
//     canonical escape hatch to the sibling binary.
//
//  4. `skip:` in test declarations — the `{ skip: ... }` option passed to
//     `test(name, opts, fn)` is the Node.js test runner's skip mechanism.
//     A skipping test in a unit suite is the defect pattern described in
//     .squad/decisions/inbox/ken-skip-defect.md.  Every allowlisted entry
//     carries a mandatory justification; an empty or blanket allowlist is
//     not acceptable.
//
// **Allowlist:** every entry MUST have a comment that states why the
// occurrence is safe.  Unjustified entries will be rejected in review.
// The allowlist uses paths relative to the test/ directory.

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = path.join(__dirname);
const SRC_DIR  = path.join(__dirname, '..', 'src');

// siblingRepoPatterns: assembled at runtime so this guard file does not
// trigger its own check.
const SIBLING_REPO_PATTERNS = [
  'gert' + '-private',  // the private companion repo
];

// process.env.GERT_BIN is the env-var escape hatch to a sibling-repo binary.
// Its code usage pattern is prohibited in unit test files (test/*.test.js).
// The integration suite (test/integration/) is explicitly exempt.
// We match the code pattern `process.env.GERT_BIN` (not bare `GERT_BIN`)
// to avoid false positives on documentation comments.
const GERT_BIN_PATTERN = 'process.env.GERT_BIN';

// Cross-repo path patterns: sibling-repo directory names that should never
// appear as a path component in a unit test file.
const CROSS_REPO_PATH_PATTERNS = [
  '..', // checked contextually below via the ../gert and ../gert-private checks
];

// skipAllowlist: test files that are permitted to contain the `skip:` test
// option, with a mandatory justification per entry.
// Adding a new `skip:` to any file NOT in this list fails this guard.
const skipAllowlist = {
  // No entries — there are currently no justified uses of `skip:` in unit
  // test files.  Every test in test/*.test.js must run unconditionally from
  // a clean checkout; conditional skips are prohibited.
  //
  // If a test genuinely requires an external resource (e.g. a binary),
  // it belongs in test/integration/ — see test/integration/cli.test.js.
};

// integrationTestPattern: files under test/integration/ are exempt from
// the GERT_BIN and sibling-repo binary checks because they are integration
// tests that deliberately require a binary.  They are NOT exempt from the
// sibling-repo name check (they must not read files from a sibling repo).
function isIntegrationFile(relPath) {
  return relPath.startsWith('integration' + path.sep) || relPath.startsWith('integration/');
}

// collectTestFiles walks a directory and collects all *.test.js files.
function collectTestFiles(dir, prefix) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      // Descend into subdirectories (covers test/integration/, test/suite/).
      results.push(...collectTestFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.test.js')) {
      results.push({ absPath: path.join(dir, entry.name), relPath: rel });
    }
  }
  return results;
}

// collectSrcFiles walks src/ for all .ts files (compiled source, same rules).
function collectSrcFiles(dir, prefix) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      results.push(...collectSrcFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
      results.push({ absPath: path.join(dir, entry.name), relPath: rel });
    }
  }
  return results;
}

test('repoBoundary: no cross-repo references or unconditional skips in test/ or src/', () => {
  const testFiles = collectTestFiles(TEST_DIR, '');
  const srcFiles  = collectSrcFiles(SRC_DIR, 'src/');

  const failures = [];

  function check(files, isSrc) {
    for (const { absPath, relPath } of files) {
      // The guard file excludes itself.
      if (path.basename(absPath) === 'repoBoundary.test.js') continue;

      const content = fs.readFileSync(absPath, 'utf8');
      const lower   = content.toLowerCase();
      const isIntegration = isIntegrationFile(relPath);

      // Check 1 — sibling-repo name patterns (no exception for integration files;
      // integration tests must not READ files from a sibling repo either).
      for (const pat of SIBLING_REPO_PATTERNS) {
        if (lower.includes(pat.toLowerCase())) {
          failures.push(
            `${relPath}: contains cross-repo reference ${JSON.stringify(pat)} — ` +
            `tests must read only files inside the repo root; ` +
            `move the fixture into test/fixtures/ and delete the external path`
          );
        }
      }

      // Check 2 — cross-repo ".." path traversals: ../gert or ../gert-private.
      // We look for the string sequences that would escape to a sibling repo.
      // Plain ".." used to ascend to a parent within the repo is fine and is
      // not flagged here — only the specific cross-repo sequences are banned.
      const crossRepoSequences = [
        '..', path.sep + 'gert' + path.sep,  // ../gert/ on this OS
        '../gert/',                            // forward-slash variant
        '..', path.sep + 'gert"',             // ../gert" (end of path string)
        '../gert"',
        '..', path.sep + 'gert`',
        '../gert`',
      ];
      // Simpler: just check the string literal forms.
      const crossRepoBanned = ["'../gert", '"../gert', '`../gert', "path.join(__dirname, '..', '..', 'gert'", 'path.join(__dirname, "..", "..", "gert"'];
      for (const banned of crossRepoBanned) {
        if (content.includes(banned)) {
          failures.push(
            `${relPath}: contains cross-repo path traversal ${JSON.stringify(banned)} — ` +
            `this escapes to the sibling engine repo; use test/fixtures/ instead`
          );
        }
      }

      // Check 3 — GERT_BIN references in unit test files (not integration).
      if (!isIntegration && !isSrc) {
        if (content.includes(GERT_BIN_PATTERN)) {
          failures.push(
            `${relPath}: references GERT_BIN — this is a sibling-repo binary escape; ` +
            `unit test files must not require an external binary. ` +
            `If this test requires a real binary, move it to test/integration/ and ` +
            `call requireGertBin() which fails (never skips) when the binary is absent`
          );
        }
      }

      // Check 4 — `skip:` in test declarations (unit test files only, not
      // integration, not src).
      if (!isIntegration && !isSrc) {
        // Match `{ skip:` or `{ skip :` — the Node.js test option syntax.
        if (/\bskip\s*:/.test(content)) {
          const reason = skipAllowlist[relPath];
          if (!reason) {
            failures.push(
              `${relPath}: contains a skip: test option — ` +
              `a skip must never be the default outcome (ken-skip-defect.md). ` +
              `If the test genuinely requires an unavailable precondition, it must ` +
              `FAIL with an actionable message, not silently skip. ` +
              `If a justified exception is required, add the file to skipAllowlist ` +
              `in test/repoBoundary.test.js with a comment explaining why`
            );
          } else {
            // Emit an informational note (no assert — just verifies the entry is used).
            console.log(`repoBoundary: skip: in ${relPath} is allowed (${reason})`);
          }
        }
      }
    }
  }

  check(testFiles, false);
  check(srcFiles,  true);

  if (failures.length > 0) {
    assert.fail(
      `repoBoundary: ${failures.length} violation(s) found:\n` +
      failures.map((f, i) => `  [${i + 1}] ${f}`).join('\n')
    );
  }
});
