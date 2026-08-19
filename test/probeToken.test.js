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
  buildSchemaDump,
  schemaVerdict,
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

// ─── Test 6: schema dump renders property NAMES; supplied VALUES never appear ──
//
// Mutation under test: (b) printing a supplied input value in the verdict
// → this test fails because SENTINEL_INPUT_VALUE appears in the streamed output.
//
// The sentinel flows through handleProbeToken → buildSchemaDump → schemaVerdict
// (the REAL production path).  Non-vacuity is verified by asserting the verdict
// actually contains the required-property name (proving schemaVerdict ran).

test('PROBE-6: schema dump renders property names; supplied input values never appear', async () => {
  const SENTINEL_INPUT_VALUE = 'PROBE6_INPUT_VAL_SENTINEL_8k4m2n9p';

  const streamedChunks = [];
  const response = { markdown: (text) => streamedChunks.push(text) };

  // Tool has a schema with a required property 'requiredField' and one optional 'knownField'.
  // The caller supplies only 'suppliedOnly' (not in schema) with the sentinel as its value.
  // This produces both a "missing required" and a "not in schema" verdict line — both property
  // names must appear; the sentinel value must not.
  const vscodeLmTools = [{
    name: 'schema-probe-tool',
    description: 'Probe tool for schema dump test',
    inputSchema: {
      type: 'object',
      properties: {
        requiredField: { type: 'string' },
        knownField: { type: 'integer' },
      },
      required: ['requiredField'],
    },
  }];

  const invokeRaw = async () => ({ content: [] });

  await handleProbeToken(
    `schema-probe-tool {"suppliedOnly":"${SENTINEL_INPUT_VALUE}"}`,
    Symbol('probe6-token'),
    vscodeLmTools,
    invokeRaw,
    null,
    response,
    null,   // no output channel needed for this assertion
    false,  // unsafeErrorText off
  );

  const allStreamed = streamedChunks.join('\n');

  // Non-vacuity: the verdict must have run and mention property names.
  assert.ok(allStreamed.includes('requiredField'),
    `Non-vacuity: "requiredField" (missing required property name) must appear in streamed output.\nStreamed:\n${allStreamed.slice(0, 500)}`);
  assert.ok(allStreamed.includes('suppliedOnly'),
    `Non-vacuity: "suppliedOnly" (unknown property name) must appear in streamed output.\nStreamed:\n${allStreamed.slice(0, 500)}`);

  // Core assertion: the supplied input VALUE must never appear anywhere.
  assert.equal(allStreamed.includes(SENTINEL_INPUT_VALUE), false,
    `Supplied input value sentinel must NOT appear in streamed output.\nStreamed:\n${allStreamed.slice(0, 500)}`);

  // Schema JSON block must be present (inputSchema is public metadata — streaming it is intentional).
  assert.ok(allStreamed.includes('```json'),
    'Schema fenced code block must appear in output');
});

// ─── Test 7: unsafeErrorText=false → raw error message appears NOWHERE ────────
//
// Mutation under test: (a) stream the raw error message into the chat response
// → this test fails because the sentinel appears in streamedChunks.
//
// The sentinel is the Error message; it flows through handleProbeToken →
// runProbe → runAttempt (the real production path).  The output channel is
// a real mock so we can verify it stays empty too.

test('PROBE-7: unsafeErrorText=false → raw error message appears NOWHERE (not in chat, not in output channel)', async () => {
  const SENTINEL_MSG = 'PROBE7_ERR_MSG_SENTINEL_4v8x3y7z';

  const streamedChunks = [];
  const response = { markdown: (text) => streamedChunks.push(text) };
  const outputLines = [];
  const outputChannel = { appendLine: (line) => outputLines.push(line) };

  const vscodeLmTools = [{ name: 'err-tool', description: 'x', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: [] } }];

  // invokeRaw always throws with the sentinel message.
  const invokeRaw = async () => {
    throw new Error(SENTINEL_MSG);
  };

  await handleProbeToken(
    'err-tool {"q":"input"}',
    Symbol('probe7-token'),
    vscodeLmTools,
    invokeRaw,
    null,
    response,
    outputChannel,
    false, // unsafeErrorText OFF
  );

  const allStreamed = streamedChunks.join('\n');
  const allLogged  = outputLines.join('\n');

  // Sentinel must not appear in chat response.
  assert.equal(allStreamed.includes(SENTINEL_MSG), false,
    `Raw error message must NOT appear in streamed markdown (unsafeErrorText=false).\nStreamed:\n${allStreamed.slice(0, 500)}`);

  // Sentinel must not appear in output channel.
  assert.equal(allLogged.includes(SENTINEL_MSG), false,
    `Raw error message must NOT appear in output channel (unsafeErrorText=false).\nLogged:\n${allLogged.slice(0, 500)}`);

  // Non-vacuity: the probe must have run (we should have a results table).
  assert.ok(allStreamed.includes('T1-synchronous'),
    'Non-vacuity: probe results table must be present in streamed output');
});

// ─── Test 8: unsafeErrorText=true → raw message in output channel ONLY ─────────
//
// Mutation under test: (a) stream the raw error message into the chat response
// → this test fails because the sentinel appears in streamedChunks.

test('PROBE-8: unsafeErrorText=true → raw error message in output channel only, never in chat', async () => {
  const SENTINEL_MSG = 'PROBE8_ERR_MSG_SENTINEL_9w2r6s1t';

  const streamedChunks = [];
  const response = { markdown: (text) => streamedChunks.push(text) };
  const outputLines = [];
  const outputChannel = { appendLine: (line) => outputLines.push(line) };

  const vscodeLmTools = [{ name: 'err-tool-2', description: 'y', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: [] } }];

  const invokeRaw = async () => {
    throw new Error(SENTINEL_MSG);
  };

  await handleProbeToken(
    'err-tool-2 {"q":"input2"}',
    Symbol('probe8-token'),
    vscodeLmTools,
    invokeRaw,
    null,
    response,
    outputChannel,
    true, // unsafeErrorText ON
  );

  const allStreamed = streamedChunks.join('\n');
  const allLogged  = outputLines.join('\n');

  // Sentinel must NOT appear in the chat response.
  assert.equal(allStreamed.includes(SENTINEL_MSG), false,
    `Raw error message must NOT appear in streamed markdown (even when unsafeErrorText=true).\nStreamed:\n${allStreamed.slice(0, 500)}`);

  // Sentinel MUST appear in the output channel.
  assert.ok(allLogged.includes(SENTINEL_MSG),
    `Raw error message MUST appear in output channel when unsafeErrorText=true.\nLogged:\n${allLogged.slice(0, 500)}`);

  // Non-vacuity: the probe must have run.
  assert.ok(allStreamed.includes('T1-synchronous'),
    'Non-vacuity: probe results table must be present in streamed output');
});

// ─── Test 9: provider_unavailable failure populates category + hint in attempt record ─
//
// Mutation under test: strip category/providerHint from ProbeAttemptRecord (or always
// set to null) → this test fails because the record fields are null/wrong.
//
// The sentinel flows through handleProbeToken → runProbe → runAttempt (real path).
// Non-vacuity: assert the sentinel was actually received by the spy (proves the path ran).

test('PROBE-9: provider_unavailable error populates category and providerHint in attempt record and table', async () => {
  // Exact live string from T2/T3/T4 probe output.
  const LIVE_ERROR = 'MCP server could not be started: 401 status sending message to https://icm-mcp-prod.azure-api.net/v1/:';

  let invokeCallCount = 0;
  const invokeToolFn = async (_tok) => {
    invokeCallCount++;
    throw new Error(LIVE_ERROR);
  };

  const token = Symbol('probe9-token');
  const attempts = await runProbe(invokeToolFn, token);

  // Non-vacuity: all four invocations must have been made.
  assert.equal(invokeCallCount, 4, `Non-vacuity: expected 4 invocations, got ${invokeCallCount}`);

  // Every attempt must be failed.
  for (const a of attempts) {
    assert.equal(a.ok, false, `${a.label} must be failed`);
    // Category must be provider_unavailable — this goes through classifyInvocationError.
    assert.equal(a.category, 'provider_unavailable',
      `${a.label}: category must be provider_unavailable; got ${a.category}`);
    // providerHint must include the matched phrase and HTTP status.
    assert.ok(a.providerHint !== null,
      `${a.label}: providerHint must not be null`);
    assert.ok(a.providerHint.includes('MCP server could not be started'),
      `${a.label}: providerHint must include the matched phrase. Got: ${a.providerHint}`);
    assert.ok(a.providerHint.includes('HTTP 401'),
      `${a.label}: providerHint must include HTTP 401. Got: ${a.providerHint}`);
    // providerHint must NOT include URL path.
    assert.equal(a.providerHint.includes('/v1/'), false,
      `${a.label}: providerHint must NOT include URL path. Got: ${a.providerHint}`);
  }

  // Table rendering: category and hint columns must appear.
  const table = renderProbeTable('test-tool', attempts);
  assert.ok(table.includes('provider_unavailable'),
    `Table must include "provider_unavailable". Table:\n${table.slice(0, 500)}`);
  assert.ok(table.includes('MCP server could not be started'),
    `Table must include the matched phrase hint. Table:\n${table.slice(0, 500)}`);
  // Table must NOT include the raw live error message (arbitrary provider text).
  assert.equal(table.includes('sending message to'), false,
    `Table must NOT include arbitrary provider text "sending message to". Table:\n${table.slice(0, 500)}`);
});
