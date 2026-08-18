// CE-V-04 / D-3-shaped regression test (barbara-client-enum-compatibility-
// ruling.md, AR-CE-9): runs the REAL `gert` CLI against a fixture runbook
// and asserts that a coded ENUM error survives, verbatim, all the way
// through this extension's own error-derivation helper. This is executed
// against the actual runtime-backed validation path — no vendored schema,
// no local re-implementation of enum semantics — so the shape of `enum:`
// acceptance/rejection cannot silently drift out from under this
// extension.
//
// The test self-skips (rather than failing) when no `gert` binary can be
// located, so it does not require a new CI/toolchain dependency; wherever
// the engine is present (as in this workspace, built from ../gert), it
// runs for real.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const pexec = promisify(execFile);
const { deriveFailureMessage, firstLine, warningLines, extractInputDecls } = require('../out/enumInputs');

const FIXTURE_ENUM = path.join(__dirname, 'fixtures', 'enum.runbook.yaml');
const FIXTURE_WARN = path.join(__dirname, 'fixtures', 'enum-warn.runbook.yaml');
// Minimal unattended profile used by all dry-run calls. gert's Phase 1B
// fail-fast gate (runWithMode: runtimeProfile == nil && !isInteractiveTTY())
// fires whenever dry-run is invoked from a non-TTY subprocess — exactly
// what execFile does here and exactly what the extension's validateInputs
// command does. Passing this profile satisfies the gate without altering
// dry-run semantics: in dry-run mode no tools execute, so the attendance/
// approval fields are inert, and all ENUM-0xx/ENUM-W0xx signals come from
// the planner (plan-time), not from execution.
const PROFILE_UNATTENDED = path.join(__dirname, 'fixtures', 'vscode-validate-inputs.profile.yaml');

function findGertBinary() {
  const candidates = [];
  if (process.env.GERT_BIN) candidates.push(process.env.GERT_BIN);
  const ext = process.platform === 'win32' ? '.exe' : '';
  // Sibling checkout of the engine repo, as used by this development team
  // (gert-vscode and gert as sibling directories under the same root).
  candidates.push(path.join(__dirname, '..', '..', 'gert', `gert${ext}`));
  candidates.push(path.join(__dirname, '..', '..', 'gert', 'bin', `gert${ext}`));
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

const gertBin = findGertBinary();

test('CE-V-04/D-3 regression: ENUM-008 from the real CLI survives verbatim through deriveFailureMessage', { skip: !gertBin && 'no gert binary found; set GERT_BIN or build ../gert/gert(.exe)' }, async () => {
  assert.ok(fs.existsSync(FIXTURE_ENUM), 'fixture runbook must exist');
  await assert.rejects(
    pexec(gertBin, ['dry-run', '--profile', PROFILE_UNATTENDED, '--var', 'env_name=not-a-member', FIXTURE_ENUM]),
    (err) => {
      const message = deriveFailureMessage(err);
      // The CLI formats enum membership errors as either `ENUM-008: ...` or
      // `input "<name>": ENUM-008: ...` depending on engine version. Both
      // forms are acceptable: the D-3 contract is that the coded error reaches
      // the operator without being buried under a "Command failed: <argv>"
      // wrapper — not that it must be the very first token.
      assert.match(message, /ENUM-008:/, 'the coded error must be present in the message, not buried in a generic wrapper');
      assert.match(firstLine(message), /ENUM-008/, 'the code must survive into the first line shown to the operator');
      assert.doesNotMatch(message, /^Command failed/, 'must never present as a bare wrapped command failure');
      return true;
    },
  );
});

test('CE-S-01/CE-V-01 regression: a declared enum member is accepted through the real CLI (no client rejection)', { skip: !gertBin && 'no gert binary found; set GERT_BIN or build ../gert/gert(.exe)' }, async () => {
  const { stdout } = await pexec(gertBin, ['dry-run', '--profile', PROFILE_UNATTENDED, '--var', 'env_name=prod', FIXTURE_ENUM]);
  assert.match(stdout, /dry-run complete/);
});

test('CE-W-01 regression: ENUM-W001 (case-only-distinct members) is a non-fatal warning surfaced on stderr, run still succeeds', { skip: !gertBin && 'no gert binary found; set GERT_BIN or build ../gert/gert(.exe)' }, async () => {
  assert.ok(fs.existsSync(FIXTURE_WARN), 'warning fixture runbook must exist');
  const { stdout, stderr } = await pexec(gertBin, ['dry-run', '--profile', PROFILE_UNATTENDED, '--var', 'env_name=prod', FIXTURE_WARN]);
  assert.match(stdout, /dry-run complete/, 'a case-only-distinct enum must not fail the run');
  const warnings = warningLines(stderr);
  assert.ok(warnings.length >= 1, 'ENUM-W001 must reach stderr');
  assert.match(warnings[0], /ENUM-W001/);
});

// F-7 (barbara-client-enum-parity-gate-review.md): the extension's
// declared-input DTO consumption (extractInputDecls) must be proven
// against the real `gert preview --format graphjson` binary output, not
// a hand-built fixture object — this is the exact seam B-1/F-1/F-2 fixed
// on the engine side (pkg/preview/render/graphjson.Document.Inputs).
test('CE-D-01/CE-D-02 regression: extractInputDecls reads the real gert preview --format graphjson output, declared order preserved', { skip: !gertBin && 'no gert binary found; set GERT_BIN or build ../gert/gert(.exe)' }, async () => {
  const { stdout } = await pexec(gertBin, ['preview', '--format', 'graphjson', FIXTURE_ENUM]);
  const doc = JSON.parse(stdout);
  const decls = extractInputDecls(doc);
  assert.ok(decls, 'extractInputDecls must find the real inputs[] array');
  const envDecl = decls.find((d) => d.name === 'env_name');
  assert.ok(envDecl, 'env_name declaration must be present');
  assert.deepEqual(envDecl.enum, ['prod', 'staging'], 'declared order must survive verbatim through the real CLI');
  assert.equal(envDecl.required, true);
  assert.ok(!envDecl.enumRedacted, 'a non-redacted declaration must not carry enumRedacted:true');
});
