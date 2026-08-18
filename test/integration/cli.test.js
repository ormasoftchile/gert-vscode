// Integration tests that require a real `gert` binary.  These are NOT
// included in the `npm test` glob (`test/*.test.js`) because they exercise
// pure CLI behaviour — no extension client function is in the loop — and
// they cannot be made hermetic: a clean gert-vscode checkout has no binary.
//
// **How to run:**
//   GERT_BIN=/path/to/gert node --test test/integration/cli.test.js
//
// **A skip is never acceptable here.**  If GERT_BIN is absent the test
// FAILS with an actionable message — the same standard applied throughout
// this codebase (see test/repoBoundary.test.js).  Silence would make the
// coverage gap invisible.
//
// **Why this file exists:**
// CE-S-01/CE-V-01 originally lived in enumRuntimeRegression.test.js as a
// skip-on-missing-binary test.  That is the systemic defect class described
// in .squad/decisions/inbox/ken-skip-defect.md — a test that appears
// covered but is never reachable.  The fixture-based approach (option a)
// cannot apply here because no extension client code is in the loop: the
// test asserts only that the CLI exits 0 and emits "dry-run complete" for
// a valid enum value.  The contract is verified at the CLI level by the
// Go-side tests; this file provides a live end-to-end probe for teams who
// have GERT_BIN available (CI pipelines that build gert alongside this
// extension, or developer workstations).
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const pexec = promisify(execFile);

const FIXTURE_ENUM = path.join(__dirname, '..', 'fixtures', 'enum.runbook.yaml');

function requireGertBin() {
  if (process.env.GERT_BIN && fs.existsSync(process.env.GERT_BIN)) {
    return process.env.GERT_BIN;
  }
  // Fail loudly — never skip.  A skipped test is invisible; a failed test is
  // actionable (the operator knows exactly what is missing and what to set).
  assert.fail(
    'GERT_BIN is not set or does not exist. ' +
    'Set GERT_BIN to the path of a built gert binary before running integration tests. ' +
    'Example: GERT_BIN=../gert/gert node --test test/integration/cli.test.js'
  );
}

// CE-S-01/CE-V-01 regression: a declared enum member must be accepted by
// the real CLI — the dry run must exit 0 and report completion.
test('CE-S-01/CE-V-01 regression: a declared enum member is accepted through the real CLI (no client rejection)', async () => {
  const gertBin = requireGertBin();
  const { stdout } = await pexec(gertBin, ['dry-run', '--var', 'env_name=prod', FIXTURE_ENUM]);
  assert.match(stdout, /dry-run complete/);
});
