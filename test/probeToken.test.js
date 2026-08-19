// probeToken.test.js — unit tests for the /probe-token diagnostic command.
//
// Required tests (per spec):
//   1. All four attempts execute in order; spy call count === 4 even when earlier attempts fail.
//   2. Neither the token, the args, nor result content appear in streamed output.
//      Uses a distinctive sentinel flowing through the real production path.
//   3. Malformed JSON → usage message, zero invocations.
//   4. repoBoundary rules (enforced by repoBoundary.test.js — exercised by npm test).

'use strict';

const assert = require('node:assert/strict');
const test   = require('node:test');

// Load compiled production modules (NOT stubs — the sentinel must flow through the
// real code paths to make the test non-vacuous).
const {
  parseProbeArgs,
  runProbe,
  renderProbeTable,
  runAttempt,
  loopbackRoundTrip,
  handleProbeToken,
} = require('../out/probeToken');

// ─── Test 1: all four attempts execute even when earlier attempts fail ────────
//
// Mutation under test: stop after first failure → this test fails on call count.

test('PROBE-1: all four attempts execute in order regardless of earlier failures', async () => {
  let callCount = 0;
  const callOrder = [];

  // Stub that fails on the first two calls and succeeds on the remaining two.
  const invokeToolFn = async (_tok) => {
    callCount++;
    callOrder.push(callCount);
    if (callCount <= 2) {
      const err = new Error('Simulated invocation failure');
      err.code = 'invocation_error';
      throw err;
    }
    return { content: [{ value: 'stub-result' }] };
  };

  const token = Symbol('probe-test-token-1');
  const attempts = await runProbe(invokeToolFn, token);

  // All four must have been called.
  assert.equal(callCount, 4,
    `Expected exactly 4 invokeTool calls (all attempts must run); got ${callCount}`);

  // Order must be preserved.
  assert.deepEqual(callOrder, [1, 2, 3, 4], 'Attempts must execute in sequence 1→2→3→4');

  // Labels in order.
  const labels = attempts.map((a) => a.label);
  assert.deepEqual(labels, ['T1-synchronous', 'T2-microtask', 'T3-macrotask', 'T4-loopback']);

  // First two failed, last two succeeded.
  assert.equal(attempts[0].ok, false, 'T1 must be failed');
  assert.equal(attempts[1].ok, false, 'T2 must be failed');
  assert.equal(attempts[2].ok, true,  'T3 must be ok');
  assert.equal(attempts[3].ok, true,  'T4 must be ok');

  // Failed attempts report exception class.
  assert.equal(attempts[0].exceptionClass, 'Error');
  assert.equal(attempts[0].errorCode, 'invocation_error');
});

// ─── Test 2: sentinel does NOT appear in streamed output ──────────────────────
//
// Mutation under test: stream args into response → this test fails on the sentinel.
//
// The sentinel flows through the REAL handleProbeToken production path:
//   handleProbeToken → runProbe → runAttempt → invokeToolFn (our spy)
//
// The spy:
//   - Receives the toolInput (which contains SENTINEL_ARGS) in its closure (via invokeRaw)
//   - Receives the token (SENTINEL_TOKEN) directly
//   - Returns result content containing SENTINEL_RESULT
//
// handleProbeToken renders the result via renderProbeTable.
// We assert SENTINEL_ARGS, SENTINEL_TOKEN, and SENTINEL_RESULT are absent from all
// markdown() calls.

test('PROBE-2: token, args, and result content must not appear in streamed markdown', async () => {
  const SENTINEL_TOKEN  = 'PROBE2_TOKEN_SENTINEL_7a3b9c2d1e4f';
  const SENTINEL_ARGS   = 'PROBE2_ARGS_SENTINEL_5x8y2z6w0v9u';
  const SENTINEL_RESULT = 'PROBE2_RESULT_SENTINEL_3p7q1r5s9t0';

  const streamedChunks = [];
  const response = { markdown: (text) => streamedChunks.push(text) };

  // vscodeLmTools stub — just needs to recognise the tool name.
  const vscodeLmTools = [{ name: 'probe-sentinel-tool' }];

  // invokeRaw spy — captures what it received so we can verify non-leakage.
  let capturedToken = 'NOT_SET';
  let capturedInput = null;
  const invokeRaw = async (_name, options, _cancellation) => {
    // Record what we actually received (for non-vacuity check).
    capturedToken = options.toolInvocationToken;
    capturedInput = options.input;
    // Return result content containing the sentinel — must not appear in output.
    return { content: [{ value: SENTINEL_RESULT }] };
  };

  await handleProbeToken(
    `probe-sentinel-tool {"key":"${SENTINEL_ARGS}"}`,
    SENTINEL_TOKEN,
    vscodeLmTools,
    invokeRaw,
    null, // cancellation token not needed for stub
    response,
  );

  // Non-vacuity: verify the sentinel actually flowed through the production path.
  assert.equal(capturedToken, SENTINEL_TOKEN,
    'Non-vacuity: invokeRaw must have received the sentinel token');
  assert.ok(capturedInput !== null && JSON.stringify(capturedInput).includes(SENTINEL_ARGS),
    'Non-vacuity: invokeRaw must have received the sentinel in toolInput');

  // The output must have been produced (non-empty).
  assert.ok(streamedChunks.length > 0, 'response.markdown must have been called at least once');

  const allStreamed = streamedChunks.join('\n');

  // Non-vacuity: the streamed text must be non-trivially long.
  assert.ok(allStreamed.length > 20, `Streamed output is non-trivially long (${allStreamed.length} chars)`);

  // Core assertions: no sentinel must appear anywhere in the output.
  assert.equal(allStreamed.includes(SENTINEL_TOKEN), false,
    `Token sentinel must not appear in streamed markdown. Streamed:\n${allStreamed.slice(0, 300)}`);
  assert.equal(allStreamed.includes(SENTINEL_ARGS), false,
    `Args sentinel must not appear in streamed markdown. Streamed:\n${allStreamed.slice(0, 300)}`);
  assert.equal(allStreamed.includes(SENTINEL_RESULT), false,
    `Result sentinel must not appear in streamed markdown. Streamed:\n${allStreamed.slice(0, 300)}`);
});

// ─── Test 3: malformed JSON → usage message, zero invocations ─────────────────

test('PROBE-3: malformed JSON input produces a usage message and zero invocations', async () => {
  let callCount = 0;
  const streamedChunks = [];
  const response = { markdown: (text) => streamedChunks.push(text) };

  const vscodeLmTools = [{ name: 'any-tool' }];
  const invokeRaw = async () => {
    callCount++;
    return { content: [] };
  };

  // Case 1: completely malformed JSON
  await handleProbeToken(
    'any-tool {not valid json}',
    'some-token',
    vscodeLmTools,
    invokeRaw,
    null,
    response,
  );

  assert.equal(callCount, 0, 'Zero invocations on malformed JSON');
  assert.ok(streamedChunks.join('').includes('Usage'),
    'A usage message must be streamed on malformed JSON');

  // Case 2: missing JSON entirely
  streamedChunks.length = 0;
  await handleProbeToken(
    'any-tool',
    'some-token',
    vscodeLmTools,
    invokeRaw,
    null,
    response,
  );

  assert.equal(callCount, 0, 'Zero invocations when JSON is absent');
  assert.ok(streamedChunks.join('').includes('Usage'),
    'A usage message must be streamed when JSON is absent');

  // Case 3: JSON is a non-object (array)
  streamedChunks.length = 0;
  await handleProbeToken(
    'any-tool [1,2,3]',
    'some-token',
    vscodeLmTools,
    invokeRaw,
    null,
    response,
  );

  assert.equal(callCount, 0, 'Zero invocations when JSON is an array, not an object');
});

// ─── Test 4 (additional): parseProbeArgs edge cases ──────────────────────────

test('PROBE-4: parseProbeArgs parses valid input and rejects bad input', () => {
  // Valid
  const r1 = parseProbeArgs('my_tool {"foo": 42}');
  assert.equal(r1.ok, true);
  assert.equal(r1.value.toolName, 'my_tool');
  assert.deepEqual(r1.value.toolInput, { foo: 42 });

  // No JSON
  const r2 = parseProbeArgs('my_tool');
  assert.equal(r2.ok, false);
  assert.ok(r2.error.includes('Usage'));

  // Malformed JSON
  const r3 = parseProbeArgs('my_tool {bad}');
  assert.equal(r3.ok, false);

  // Empty input
  const r4 = parseProbeArgs('  ');
  assert.equal(r4.ok, false);
});

// ─── Test 5: tool not in registry → error message, zero invocations ───────────

test('PROBE-5: tool not found in vscode.lm.tools → error, no invocations', async () => {
  let callCount = 0;
  const streamedChunks = [];
  const response = { markdown: (text) => streamedChunks.push(text) };

  const vscodeLmTools = [{ name: 'other-tool' }];
  const invokeRaw = async () => { callCount++; return { content: [] }; };

  await handleProbeToken(
    'missing-tool {"x": 1}',
    'tok',
    vscodeLmTools,
    invokeRaw,
    null,
    response,
  );

  assert.equal(callCount, 0, 'Zero invocations when tool is not registered');
  assert.ok(streamedChunks.join('').includes('not found') || streamedChunks.join('').includes('not registered'),
    'Error message must mention the tool is not found');
});
