// runHandoff.test.js — tests for the pure Run Authenticated handoff sequence.
//
// These tests operate on the ACTUAL PRODUCTION PATH (performRunHandoff with
// the real stashPendingRun / buildRunChatQuery collaborators), not on crafted
// strings. They are designed to fail under Cristiano's mutation:
//
//   const query = buildRunChatQuery(nonce, runbookPath)
//                 + ' ' + Object.entries(collectedInputs).map(([k,v])=>k+'='+v).join(' ');
//
// Tests:
//   HANDOFF-1: chat query contains the nonce
//   HANDOFF-2: chat query contains the runbook path
//   HANDOFF-3: chat query does NOT contain any collected input value
//              (sentinel: 'SENTINEL_SECRET_DO_NOT_LEAK_xQ9z')
//   HANDOFF-4: pending store received the inputs intact (non-vacuity —
//              proves redaction is not achieved by silently dropping data)
//   HANDOFF-5: executeCommand is called with workbench.action.chat.open
//              and the exact query string (non-vacuity control)
//   HANDOFF-6: cancel on first prompt → returns undefined, no command executed
//   HANDOFF-7: formatRunStartLog does not include input values (log-line guard)

'use strict';

const assert = require('node:assert/strict');
const test   = require('node:test');

const { performRunHandoff } = require('../out/runHandoff');
const { stashPendingRun, claimPendingRun, resetForTest } = require('../out/pendingRunStore');
const { buildRunChatQuery, formatRunStartLog }            = require('../out/runbookArgParse');
const { CANCELLED, UNSET }                               = require('../out/runHandoff');

const RUNBOOK = '/workspace/deploy.runbook.yaml';
const SECRET  = 'SENTINEL_SECRET_DO_NOT_LEAK_xQ9z';

// Helper: build deps with real store + query builder, fake prompter & commander.
function makeDeps({ promptValues = {}, capturedCommands = [] } = {}) {
  const decls = Object.keys(promptValues);
  let promptIdx = 0;
  return {
    promptForInput: async (decl) => {
      const val = promptValues[decl.name];
      if (val === undefined) return UNSET;
      if (val === '__CANCEL__') return CANCELLED;
      return val;
    },
    stashPendingRun,                // real production collaborator
    buildRunChatQuery,              // real production collaborator
    executeCommand: async (cmd, opts) => {
      capturedCommands.push({ cmd, opts });
    },
  };
}

// ─── HANDOFF-1: query contains the nonce ──────────────────────────────────

test('HANDOFF-1: chat query contains the nonce', async () => {
  resetForTest();
  const captured = [];
  const result = await performRunHandoff(RUNBOOK, [], makeDeps({ capturedCommands: captured }));

  assert.ok(result !== undefined, 'handoff must complete');
  assert.ok(result.query.includes(`_nonce=${result.nonce}`),
    `query must contain _nonce=<nonce>; got: ${result.query}`);
  resetForTest();
});

// ─── HANDOFF-2: query contains runbook path ───────────────────────────────

test('HANDOFF-2: chat query contains the runbook path', async () => {
  resetForTest();
  const result = await performRunHandoff(RUNBOOK, [], makeDeps());

  assert.ok(result !== undefined, 'handoff must complete');
  assert.ok(result.query.includes(RUNBOOK),
    `query must contain runbook path; got: ${result.query}`);
  resetForTest();
});

// ─── HANDOFF-3: query does NOT contain input values ───────────────────────
//
// This is the primary anti-leak assertion.  Under Cristiano's mutation:
//   const query = buildRunChatQuery(nonce, runbookPath)
//                 + ' ' + Object.entries(collectedInputs).map(...)
// the sentinel value would appear in result.query and this test would fail.

test('HANDOFF-3: chat query does NOT contain any collected input value (leak guard)', async () => {
  resetForTest();
  const decls = [
    { name: 'api_key',  required: true },
    { name: 'username', required: true },
  ];
  const result = await performRunHandoff(RUNBOOK, decls, makeDeps({
    promptValues: {
      api_key:  SECRET,
      username: 'SENTINEL_USER_xQ9z',
    },
  }));

  assert.ok(result !== undefined, 'handoff must complete');

  // Non-vacuity: confirm inputs were actually collected.
  assert.equal(result.collectedInputs.api_key,  SECRET,
    'non-vacuity: api_key must be collected before redaction check');
  assert.equal(result.collectedInputs.username, 'SENTINEL_USER_xQ9z',
    'non-vacuity: username must be collected before redaction check');

  // Primary assertion: inputs must NOT appear in the query.
  assert.ok(!result.query.includes(SECRET),
    `LEAK: api_key value found in chat query — secrets must never appear in query.\nQuery was: ${result.query}`);
  assert.ok(!result.query.includes('SENTINEL_USER_xQ9z'),
    `LEAK: username value found in chat query.\nQuery was: ${result.query}`);
  resetForTest();
});

// ─── HANDOFF-4: store received the inputs intact ──────────────────────────
//
// Proves redaction is not achieved by silently dropping data: the inputs
// must flow correctly into the pending store and be retrievable via claim.

test('HANDOFF-4: pending store received the exact input values (non-vacuity)', async () => {
  resetForTest();
  const decls = [{ name: 'token', required: true }];
  const result = await performRunHandoff(RUNBOOK, decls, makeDeps({
    promptValues: { token: SECRET },
  }));

  assert.ok(result !== undefined, 'handoff must complete');

  // Claim the entry using the nonce that was returned.
  const entry = claimPendingRun(result.nonce);
  assert.ok(entry !== undefined,
    'pending store must have an entry for the returned nonce');
  assert.equal(entry.inputs.token, SECRET,
    `store must hold the exact input value; got: ${JSON.stringify(entry.inputs)}`);
  resetForTest();
});

// ─── HANDOFF-5: executeCommand receives workbench.action.chat.open ────────
//
// Proves the command and opts are wired correctly (non-vacuity control).

test('HANDOFF-5: executeCommand called with workbench.action.chat.open and query', async () => {
  resetForTest();
  const captured = [];
  const result = await performRunHandoff(RUNBOOK, [], makeDeps({ capturedCommands: captured }));

  assert.ok(result !== undefined, 'handoff must complete');
  assert.equal(captured.length, 1, 'executeCommand must be called exactly once');
  assert.equal(captured[0].cmd, 'workbench.action.chat.open');
  assert.equal(captured[0].opts.query, result.query,
    'opts.query must match the returned query string');
  assert.equal(captured[0].opts.isPartialQuery, false);
  resetForTest();
});

// ─── HANDOFF-6: cancel → undefined, no command ───────────────────────────

test('HANDOFF-6: cancel on prompt returns undefined, no command executed', async () => {
  resetForTest();
  const decls = [{ name: 'secret', required: true }];
  const captured = [];
  const result = await performRunHandoff(RUNBOOK, decls, makeDeps({
    promptValues: { secret: '__CANCEL__' },
    capturedCommands: captured,
  }));

  assert.equal(result, undefined, 'cancelled handoff must return undefined');
  assert.equal(captured.length, 0, 'no command must be executed after cancel');
  resetForTest();
});

// ─── HANDOFF-7: formatRunStartLog does not include input values ───────────
//
// The log line uses runId and runbookPath only.  Secret values must never
// appear in the log string, regardless of the call-site mutation.

test('HANDOFF-7: formatRunStartLog does not include input value (log-line guard)', () => {
  const runId = 'run-abc123';
  const logLine = formatRunStartLog(runId, RUNBOOK);

  assert.ok(logLine.includes(runId),     'non-vacuity: runId must appear in log line');
  assert.ok(logLine.includes(RUNBOOK),   'non-vacuity: runbook path must appear in log line');
  assert.ok(!logLine.includes(SECRET),
    `LEAK: secret value found in log line.\nLine was: ${logLine}`);
  // Confirm the format is what the extension uses.
  assert.match(logLine, /\[gert run\] run=run-abc123/);
});
