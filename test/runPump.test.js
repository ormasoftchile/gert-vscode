// runPump.test.js — 8 mandatory tests for the in-handler invocation pump.
//
// Tests:
//   PUMP-1: pump resolves an enqueued invocation from within the handler context
//   PUMP-2: a tool call arriving with no active run is rejected without invoking
//   PUMP-3: two-attempt fallback — Canceled on attempt 1, retry with undefined succeeds
//   PUMP-4: a non-Canceled failure does NOT trigger the retry
//   PUMP-5: the handler does not return before terminal state
//   PUMP-6: cancellation deletes the run and unwinds the pump without leaking promises
//   PUMP-7: pump is closed when the run loop returns (token lifecycle invariant)
//   PUMP-8: handler token must not appear in output-channel logs (redaction)
//
// Run with: node --test test/runPump.test.js  (or via npm test)

'use strict';

const assert  = require('node:assert/strict');
const http    = require('node:http');
const path    = require('node:path');
const test    = require('node:test');

// ─── Load compiled modules ───────────────────────────────────────────────────

const { RunPump, invokeWithTwoAttempts, isCanceledError } = require('../out/runPump');
const { runLoop }              = require('../out/runLoop');
const { McpBridge }            = require('../out/mcpBridge');
const { buildRegistryFromDir } = require('../out/toolDefinitionRegistry');

const FIXTURE_TOOLS_DIR = path.join(__dirname, 'fixtures', 'tools');

// ─── Shared helpers ──────────────────────────────────────────────────────────

async function postBridge(url, payload) {
  return new Promise((resolve, reject) => {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const opts = new URL(url);
    const req = http.request(
      { hostname: opts.hostname, port: Number(opts.port), path: '/', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

function makeRequest(bridge, overrides = {}) {
  return {
    version:          'vscode-mcp-bridge/v1',
    request_id:       `req-${Math.random().toString(36).slice(2)}`,
    tool:             'icm',
    action:           'get-incident',
    args:             { incident_id: '12345' },
    capability_proof: bridge.bridgeToken,
    ...overrides,
  };
}

function makeIcmResult() {
  return {
    content: [{
      value: JSON.stringify({
        title: 'CPU spike', service: 'api-gateway', environment: 'prod',
        logical_server: 'srv-01', database: 'db-primary',
      }),
    }],
  };
}

// ─── PUMP-1: pump resolves from handler context ───────────────────────────────
// Mutation proof: change `resolve` to `reject` in RunPump.enqueue → the
// await throws and the test fails ("await invokePromise" becomes an unhandled
// rejection caught as a test failure).

test('PUMP-1: pump resolves an enqueued invocation when the handler drains and resolves it', async () => {
  const pump = new RunPump();

  const invokePromise = pump.enqueue('my-tool', { arg: 'value' });

  // Simulate the chat handler draining the pump.
  const items = pump.drainSync();
  assert.equal(items.length, 1, 'pump must have one pending item');
  assert.equal(items[0].toolName, 'my-tool');
  assert.deepEqual(items[0].input, { arg: 'value' });

  // Simulate the chat handler resolving with the vscode result.
  const RESULT = { content: [{ value: '{"status":"ok"}' }] };
  items[0].resolve(RESULT);

  const result = await invokePromise;
  assert.deepEqual(result, RESULT,
    'enqueue Promise must resolve with the value passed to item.resolve');
});

// ─── PUMP-2: no active run → rejected without invoking ───────────────────────
// Mutation proof: remove `if (this.lm.hasActivePump?.() === false)` gate from
// mcpBridge handle() → invokeTool is called, invokeCount increments to 1,
// assert.equal(invokeCount, 0) fails.

test('PUMP-2: bridge rejects without invoking when no active run (no_active_run gate)', async (t) => {
  const registry = buildRegistryFromDir(FIXTURE_TOOLS_DIR);

  let invokeCount = 0;
  const lm = {
    tools:                   [{ name: 'icm-get-incident' }],
    getToolInvocationToken:  () => 'some-token',
    hasActivePump:           () => false,          // explicit: no active run
    invokeTool:              async () => { invokeCount++; return makeIcmResult(); },
  };

  const bridge = await McpBridge.create(lm, 0, undefined, { registry });
  t.after(() => bridge.dispose());

  const { body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge));

  assert.ok(body.error, 'bridge must return an error when no run is active');
  assert.equal(body.error.code, 'no_active_run',
    `error code must be no_active_run, got: ${body.error.code}`);
  assert.equal(body.result, undefined, 'result must be absent');
  assert.equal(invokeCount, 0,
    `invokeTool must NOT be called when gate fires (spy count = ${invokeCount})`);
});

// ─── PUMP-3: two-attempt fallback — Canceled → retry → success ───────────────
// Mutation proof: remove the `if (isCanceledError(firstErr) && handlerToken !== undefined)`
// retry branch from invokeWithTwoAttempts → callCount stays 1, assert.equal(callCount, 2)
// fails.

test('PUMP-3: two-attempt fallback — Canceled on attempt 1, retry with undefined succeeds', async () => {
  const calls = [];
  let callCount = 0;

  const realInvoke = async (name, input, token) => {
    callCount++;
    calls.push({ name, input, token, attempt: callCount });
    if (callCount === 1) {
      throw new Error('Canceled');   // VS Code Canceled class error
    }
    return { content: [{ value: '{"status":"ok"}' }] };
  };

  let resolved = null;
  const item = {
    toolName: 'my-tool',
    input:    { id: '42' },
    resolve:  (v) => { resolved = v; },
    reject:   (e) => { throw e; },
  };

  const FAKE_TOKEN = Symbol('handler-token');
  await invokeWithTwoAttempts(item, FAKE_TOKEN, realInvoke, undefined);

  assert.equal(callCount, 2, 'both attempts must be made');
  assert.strictEqual(calls[0].token, FAKE_TOKEN,
    'attempt 1 must pass the handler token');
  assert.equal(calls[1].token, undefined,
    'attempt 2 must pass undefined (no-token retry)');
  assert.ok(resolved, 'item must be resolved after attempt 2 succeeds');
});

// ─── PUMP-4: non-Canceled failure → no retry ─────────────────────────────────
// Mutation proof: change `isCanceledError` to always return true → a non-Canceled
// error triggers the retry, callCount becomes 2, assert.equal(callCount, 1) fails.

test('PUMP-4: non-Canceled failure on attempt 1 does not trigger retry', async () => {
  let callCount = 0;
  const realInvoke = async () => {
    callCount++;
    throw new Error('Provider rejected: invalid input');
  };

  let rejected = null;
  const item = {
    toolName: 'my-tool',
    input:    {},
    resolve:  () => {},
    reject:   (e) => { rejected = e; },
  };

  await invokeWithTwoAttempts(item, 'some-token', realInvoke, undefined);

  assert.equal(callCount, 1, 'only one attempt for non-Canceled errors');
  assert.ok(rejected instanceof Error, 'item must be rejected');
  assert.match(rejected.message, /invalid input/);
});

// ─── PUMP-5: handler does not return before terminal state ────────────────────
// Mutation proof: return immediately from runLoop (e.g., return { reason: 'terminal',
// status: 'done' }) → loopResolved is true before the 20ms wait,
// assert.equal(loopResolved, false) fails.

test('PUMP-5: run loop does not resolve before terminal state', async () => {
  const pump = new RunPump();
  let terminalResolve;
  const terminalPromise = new Promise((r) => { terminalResolve = r; });

  let loopResolved = false;
  const loopTask = runLoop(
    pump, 'run-5',
    {
      waitForTerminal: (_id, _signal) => terminalPromise,
      deleteRun:       async () => {},
      onProgress:      () => {},
    },
    'handler-token',
    async () => {},
    new Promise(() => {}), // never cancel
    60_000,
    undefined,
  ).then((r) => { loopResolved = true; return r; });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(loopResolved, false,
    'loop must NOT resolve before terminal state arrives');

  // Signal terminal state.
  terminalResolve('completed');
  const result = await loopTask;

  assert.equal(loopResolved, true, 'loop must resolve after terminal state');
  assert.equal(result.reason, 'terminal');
  assert.equal(result.status, 'completed');
});

// ─── PUMP-6: cancellation deletes run, closes pump, no leaked promises ────────
// Mutation proof: remove the `await deps.deleteRun(runId)` call from the
// 'cancelled' case in runLoop → deleteRunCalled stays false,
// assert.equal(deleteRunCalled, true) fails.

test('PUMP-6: cancellation calls deleteRun and closes pump without leaking promises', async () => {
  const pump = new RunPump();
  let deleteRunCalled = false;

  let cancelResolve;
  const cancelPromise = new Promise((r) => { cancelResolve = r; });

  const loopTask = runLoop(
    pump, 'run-cancel-6',
    {
      waitForTerminal: () => new Promise(() => {}),  // never terminal
      deleteRun: async (runId) => {
        assert.equal(runId, 'run-cancel-6', 'deleteRun must receive the correct run ID');
        deleteRunCalled = true;
      },
      onProgress: () => {},
    },
    'handler-token',
    async () => {},
    cancelPromise,
    60_000,
    undefined,
  );

  await new Promise((r) => setTimeout(r, 10));
  cancelResolve();

  const result = await loopTask;
  assert.equal(result.reason, 'cancelled');
  assert.equal(deleteRunCalled, true, 'deleteRun must be called on cancellation');
  assert.equal(pump.closed, true, 'pump must be closed after cancellation');

  // After pump is closed, any new enqueue must reject immediately (no leaked promises).
  const postCancelEnqueue = pump.enqueue('tool', {});
  await assert.rejects(postCancelEnqueue, /RunPump: pump is closed/,
    'post-cancellation enqueue must reject immediately');
});

// ─── PUMP-7: pump closed on any exit (token lifecycle invariant) ──────────────
// Mutation proof: remove `pump.close('run loop exiting')` from the finally block
// in runLoop → pump.closed stays false for 'terminal',
// assert.equal(pump.closed, true) fails.

test('PUMP-7: pump is closed when the run loop returns (no stale references across all exit paths)', async () => {
  // Verify across all three exit paths that the pump is unconditionally closed.
  // This ensures stale lm.invokeTool() Promises from the bridge can't hang
  // after the handler exits.

  for (const exitPath of ['terminal', 'cancelled', 'deadline']) {
    let cancelResolve;
    const cancelPromise = exitPath === 'cancelled'
      ? new Promise((r) => { cancelResolve = r; })
      : new Promise(() => {}); // never

    const waitForTerminal = () => exitPath === 'terminal'
      ? Promise.resolve('completed')
      : new Promise(() => {}); // never

    const deadlineMs = exitPath === 'deadline' ? 20 : 60_000;

    const pump = new RunPump();
    const loopTask = runLoop(pump, 'run-lifecycle', {
      waitForTerminal,
      deleteRun: async () => {},
      onProgress: () => {},
    }, 'tok', async () => {}, cancelPromise, deadlineMs, undefined);

    if (exitPath === 'cancelled') {
      await new Promise((r) => setTimeout(r, 10));
      cancelResolve();
    }

    await loopTask;
    assert.equal(pump.closed, true, `pump must be closed after ${exitPath}`);

    // Any new enqueue must reject immediately (no stale references).
    const stale = pump.enqueue('tool', {});
    await assert.rejects(stale, undefined,
      `stale enqueue must reject after ${exitPath}`);
  }
});

// ─── PUMP-8 path matrix: token must not appear in output-channel logs ─────────
//
// invokeWithTwoAttempts has four execution paths:
//   8a: attempt 1 succeeds
//   8b: attempt 1 fails with non-Canceled error (no retry)
//   8c: attempt 1 fails Canceled → attempt 2 succeeds
//   8d: attempt 1 fails Canceled → attempt 2 also fails
//
// Each test injects a known token string, runs the specific path, collects
// every log line written to the output channel, and asserts the token does
// not appear. Non-vacuity: each asserts ≥1 log line was produced.
//
// Mutation proofs per path:
//   8a: inject `output?.appendLine('token=' + handlerToken)` before the
//       "attempt 1 succeeded" line → PUMP-8a fails.
//   8b: inject before the "attempt 1 failed (no retry)" line → PUMP-8b fails.
//   8c: inject before the "attempt 2 succeeded" line → PUMP-8c fails.
//   8d: inject before the "attempt 2 failed" line → PUMP-8d fails.

const FAKE_TOKEN_8 = 'FAKE_HANDLER_TOKEN_REDACT_pumP8_zyx987';

function makeSpy8(realInvoke) {
  const logLines = [];
  const output = { appendLine: (s) => logLines.push(s) };
  const checkRedaction = (label) => {
    assert.ok(logLines.length >= 1,
      `${label}: must produce ≥1 log line (non-vacuity)`);
    for (const line of logLines) {
      assert.equal(line.includes(FAKE_TOKEN_8), false,
        `${label}: token must not appear in log line: "${line.slice(0, 120)}"`);
    }
  };
  return { logLines, output, checkRedaction };
}

test('PUMP-8a: token absent on attempt-1 success path', async () => {
  const { output, checkRedaction } = makeSpy8();
  const item = {
    toolName: 'test-tool', input: {},
    resolve: () => {}, reject: (e) => { throw e; },
  };
  await invokeWithTwoAttempts(item, FAKE_TOKEN_8,
    async () => ({ content: [{ value: '{}' }] }), output);
  checkRedaction('PUMP-8a');
});

test('PUMP-8b: token absent on attempt-1 non-Canceled failure path', async () => {
  const { output, checkRedaction } = makeSpy8();
  let rejected = null;
  const item = {
    toolName: 'test-tool', input: {},
    resolve: () => {},
    reject: (e) => { rejected = e; },
  };
  await invokeWithTwoAttempts(item, FAKE_TOKEN_8,
    async () => { throw new Error('Provider rejected: bad input'); }, output);
  assert.ok(rejected instanceof Error, 'item must be rejected');
  checkRedaction('PUMP-8b');
});

test('PUMP-8c: token absent on Canceled retry → success path', async () => {
  const { output, checkRedaction } = makeSpy8();
  let callCount = 0;
  const item = {
    toolName: 'test-tool', input: {},
    resolve: () => {}, reject: (e) => { throw e; },
  };
  await invokeWithTwoAttempts(item, FAKE_TOKEN_8, async () => {
    if (++callCount === 1) throw new Error('Canceled');
    return { content: [{ value: '{}' }] };
  }, output);
  assert.equal(callCount, 2, 'must make 2 attempts');
  checkRedaction('PUMP-8c');
});

test('PUMP-8d: token absent on Canceled retry → failure path', async () => {
  const { output, checkRedaction } = makeSpy8();
  let rejected = null;
  const item = {
    toolName: 'test-tool', input: {},
    resolve: () => {},
    reject: (e) => { rejected = e; },
  };
  await invokeWithTwoAttempts(item, FAKE_TOKEN_8,
    async () => { throw new Error('Canceled'); }, output);
  assert.ok(rejected instanceof Error, 'item must be rejected after attempt 2 also fails');
  checkRedaction('PUMP-8d');
});
