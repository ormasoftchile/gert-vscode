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

// ─── PUMP-2: no active run + no cached token → no_active_run ─────────────────
// Tests layer 3 of the layered invocation model: no pump AND no cached token
// (unarmed) → no_active_run, invokeTool never called.
//
// Mutation proof for layer 3 gate: remove `cachedToken === undefined` check →
// no_active_run still fires (because !hasPump is true), invokeTool still not
// called — but LAYER-2 below catches this by asserting layer-2 IS invoked
// when armed. Together, PUMP-2 and LAYER-2 together prove the gate.
//
// Additional mutation: swap `!hasPump` to `hasPump` → no_active_run fires when
// pump IS active → LAYER-1 (below) fails because invokeTool count drops to 0.

test('PUMP-2: bridge rejects without invoking when no pump AND no cached token (no_active_run floor)', async (t) => {
  const registry = buildRegistryFromDir(FIXTURE_TOOLS_DIR);

  let invokeCount = 0;
  const lm = {
    tools:                   [{ name: 'icm-get-incident' }],
    getToolInvocationToken:  () => undefined,  // explicitly unarmed
    hasActivePump:           () => false,       // no pump
    invokeTool:              async () => { invokeCount++; return makeIcmResult(); },
  };

  const bridge = await McpBridge.create(lm, 0, undefined, { registry });
  t.after(() => bridge.dispose());

  const { body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge));

  assert.ok(body.error, 'bridge must return an error when no run is active and unarmed');
  assert.equal(body.error.code, 'no_active_run',
    `error code must be no_active_run, got: ${body.error.code}`);
  assert.equal(body.result, undefined, 'result must be absent');
  assert.equal(invokeCount, 0,
    `invokeTool must NOT be called when both pump and token are absent (spy count = ${invokeCount})`);
});

// ─── LAYER-1: pump active → layer 1 used, no retry on Canceled ───────────────
// Tests that when hasActivePump()===true, the bridge uses layer 1 (direct
// invokeTool, no two-attempt retry). If the precedence were inverted (layer 2
// used when pump present), Canceled would trigger a retry and callCount=2.
//
// Mutation proof A (invert precedence): change `if (hasPump)` to `if (!hasPump)`
// → layer 2 fires when pump IS active → Canceled triggers retry → callCount=2
// → assert.equal(callCount, 1) FAILS.
//
// Mutation proof B (remove layer-1 branch entirely): remove the `if (hasPump)`
// path → no invokeTool ever called → callCount=0 → fails.

test('LAYER-1: pump active → invokeTool called once, no retry on Canceled (layer 1 semantics)', async (t) => {
  const registry = buildRegistryFromDir(FIXTURE_TOOLS_DIR);
  let callCount = 0;
  const lm = {
    tools:                   [{ name: 'icm-get-incident' }],
    getToolInvocationToken:  () => 'cached-token',
    hasActivePump:           () => true,            // pump IS active
    invokeTool:              async () => { callCount++; throw new Error('Canceled'); },
  };

  const bridge = await McpBridge.create(lm, 0, undefined, { registry });
  t.after(() => bridge.dispose());

  const { body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge));

  assert.ok(body.error, 'a Canceled error must produce an error response');
  // Layer 1 does NOT retry → callCount must be exactly 1.
  assert.equal(callCount, 1,
    `layer 1 must call invokeTool exactly once (no retry). Got callCount=${callCount}`);
  // no_active_run must NOT appear — that code is the layer-3 floor.
  assert.notEqual(body.error.code, 'no_active_run',
    'error code must not be no_active_run when pump is active');
});

// ─── LAYER-2: no pump, armed → layer 2 invokes (spy count) ───────────────────
// Tests that when hasActivePump()===false but getToolInvocationToken() returns
// a token, the bridge DOES call invokeTool (layer 2), not no_active_run.
//
// Mutation proof (delete layer 2): replace layer-2 branch with an immediate
// no_active_run return → invokeTool never called → callCount=0
// → assert.ok(callCount > 0) FAILS.

test('LAYER-2: no pump, armed token → invokeTool IS invoked (spy count > 0)', async (t) => {
  const registry = buildRegistryFromDir(FIXTURE_TOOLS_DIR);
  let callCount = 0;
  const lm = {
    tools:                   [{ name: 'icm-get-incident' }],
    getToolInvocationToken:  () => 'armed-token',   // token is armed
    hasActivePump:           () => false,            // no pump
    invokeTool:              async () => { callCount++; return makeIcmResult(); },
  };

  const bridge = await McpBridge.create(lm, 0, undefined, { registry });
  t.after(() => bridge.dispose());

  const { body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge));

  // Non-vacuity: result must be a successful invocation.
  assert.ok(body.result, `layer 2 must produce a result; got error: ${JSON.stringify(body.error)}`);
  assert.ok(callCount > 0,
    `invokeTool must be called at least once in layer 2 (spy count=${callCount})`);
  assert.equal(callCount, 1, 'exactly one call on success path');
  // no_active_run must NOT be the outcome — that is the layer-3 floor (unarmed).
  assert.equal(body.error, undefined, 'must have no error on success');
});

// ─── LAYER-2b: no pump, armed, Canceled → layer 2 retries (call count = 2) ───
// Tests that layer 2 uses the two-attempt retry (invokeWithTwoAttempts) —
// same semantics as the pump path.
//
// Mutation proof (skip retry in layer 2): remove invokeWithTwoAttempts from
// layer 2, call invokeTool once without retry → callCount=1 on Canceled →
// assert.equal(callCount, 2) FAILS.

test('LAYER-2b: no pump, armed, Canceled on attempt 1 → layer 2 retries (call count = 2)', async (t) => {
  const registry = buildRegistryFromDir(FIXTURE_TOOLS_DIR);
  let callCount = 0;
  const tokens = [];
  const lm = {
    tools:                   [{ name: 'icm-get-incident' }],
    getToolInvocationToken:  () => 'armed-token',
    hasActivePump:           () => false,
    invokeTool:              async (_name, opts) => {
      callCount++;
      tokens.push(opts.toolInvocationToken);
      if (callCount === 1) throw new Error('Canceled');
      return makeIcmResult();
    },
  };

  const bridge = await McpBridge.create(lm, 0, undefined, { registry });
  t.after(() => bridge.dispose());

  const { body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge));

  assert.ok(body.result, `layer 2 retry should succeed; error=${JSON.stringify(body.error)}`);
  assert.equal(callCount, 2, 'layer 2 must use two-attempt retry: callCount must be 2');
  assert.equal(tokens[0], 'armed-token', 'attempt 1 must use the armed cached token');
  assert.equal(tokens[1], undefined, 'attempt 2 must use undefined (no-token retry)');
});

// ─── LAYER-3: no pump, unarmed → no_active_run, invokeTool never called ──────
// Already covered by updated PUMP-2 above.

// ─── LAYER-4: no pump, armed, fails → named category ≠ no_active_run ─────────
// Tests that a layer-2 invocation failure surfaces with a named error category
// (e.g. authorization_unavailable), NOT no_active_run.
// The two must be distinguishable: conflating them hides that an invocation was
// attempted but failed, versus never attempted at all.
//
// Mutation proof: return no_active_run from layer-2 catch block → body.error.code
// becomes 'no_active_run' → assert.notEqual(…, 'no_active_run') FAILS.

test('LAYER-4: no pump, armed, invocation fails → named category, not no_active_run', async (t) => {
  const registry = buildRegistryFromDir(FIXTURE_TOOLS_DIR);
  let callCount = 0;
  const lm = {
    tools:                   [{ name: 'icm-get-incident' }],
    getToolInvocationToken:  () => 'armed-token',
    hasActivePump:           () => false,
    invokeTool:              async () => {
      callCount++;
      throw new Error('auth failed: credential rejected (forbidden)');
    },
  };

  const bridge = await McpBridge.create(lm, 0, undefined, { registry });
  t.after(() => bridge.dispose());

  const { body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge));

  assert.ok(body.error, 'layer-2 failure must produce an error response');
  assert.ok(callCount > 0, 'invokeTool must have been called (layer 2 attempted)');
  assert.notEqual(body.error.code, 'no_active_run',
    `layer-2 failure must surface as a named category, not no_active_run. Got: ${body.error.code}`);
  // Specifically: auth failure classifies as authorization_unavailable.
  assert.equal(body.error.code, 'authorization_unavailable',
    `expected authorization_unavailable, got: ${body.error.code}`);
});

// ─── LAYER-5: layer-2 log lines must not contain the armed token ──────────────
// Redaction guarantee: the cached token must never appear in any output-channel
// line, on every path through layer 2 (attempt-1 success, Canceled retry, failure).
//
// Path A: Canceled on attempt 1, retry succeeds (tests invokeWithTwoAttempts log lines)
// Path B: attempt 1 succeeds directly (tests direct invokeTool log lines)
// Path C: both attempts fail (tests failure log lines)
//
// Mutation proof: change invokeWithTwoAttempts to log handlerToken →
// line includes armedToken → assert.ok(!line.includes(armedToken)) FAILS.

test('LAYER-5a: armed token absent from log lines on layer-2 Canceled retry path', async (t) => {
  const registry = buildRegistryFromDir(FIXTURE_TOOLS_DIR);
  const logLines = [];
  const output = { appendLine: (s) => logLines.push(s) };

  const armedToken = 'ARMED_TOKEN_LAYER5_SECRET_REDACT_TEST';
  let callCount = 0;
  const lm = {
    tools:                   [{ name: 'icm-get-incident' }],
    getToolInvocationToken:  () => armedToken,
    hasActivePump:           () => false,
    invokeTool:              async () => {
      callCount++;
      if (callCount === 1) throw new Error('Canceled');
      return makeIcmResult();
    },
  };

  const bridge = await McpBridge.create(lm, 0, output, { registry });
  t.after(() => bridge.dispose());

  const { body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge));

  // Non-vacuity: retry must have been triggered and log lines produced.
  assert.equal(callCount, 2, 'non-vacuity: retry must have been triggered');
  assert.ok(body.result, 'non-vacuity: invocation must succeed');
  assert.ok(logLines.length > 0, 'non-vacuity: at least one log line must exist');

  for (const line of logLines) {
    assert.ok(!line.includes(armedToken),
      `LEAK on path A: armed token found in log line: "${line}"`);
  }
});

test('LAYER-5b: armed token absent from log lines on layer-2 failure path', async (t) => {
  const registry = buildRegistryFromDir(FIXTURE_TOOLS_DIR);
  const logLines = [];
  const output = { appendLine: (s) => logLines.push(s) };

  const armedToken = 'ARMED_TOKEN_LAYER5B_SECRET_REDACT_TEST';
  let callCount = 0;
  const lm = {
    tools:                   [{ name: 'icm-get-incident' }],
    getToolInvocationToken:  () => armedToken,
    hasActivePump:           () => false,
    invokeTool:              async () => {
      callCount++;
      // Non-Canceled failure → no retry → attempt 1 fails directly.
      throw new Error('invocation error on layer-2 path B');
    },
  };

  const bridge = await McpBridge.create(lm, 0, output, { registry });
  t.after(() => bridge.dispose());

  const { body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge));

  // Non-vacuity: invocation was attempted and produced an error and log lines.
  assert.equal(callCount, 1, 'non-vacuity: attempt 1 must have been called');
  assert.ok(body.error, 'non-vacuity: invocation failure must produce error');
  assert.ok(logLines.length > 0, 'non-vacuity: log lines must exist');

  for (const line of logLines) {
    assert.ok(!line.includes(armedToken),
      `LEAK on path B: armed token found in log line: "${line}"`);
  }
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
