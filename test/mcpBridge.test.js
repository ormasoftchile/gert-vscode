// mcpBridge.test.js — unit tests for the Gert↔VS Code loopback bridge.
//
// All vscode.lm calls are stubbed; no real authenticated MCP tool is required.
// Run with: node --test test/mcpBridge.test.js  (or via npm test)

'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

// ─── Load compiled bridge ────────────────────────────────────────────────────
const {
  McpBridge,
  TOOL_ACTION_REGISTRY,
  resolveSpec,
  normalizeResult,
  extractTextFromResult,
} = require('../out/mcpBridge');

// ─── Helpers ─────────────────────────────────────────────────────────────────

// postBridge sends one HTTP POST to the bridge and returns { status, body }.
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
          try {
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

// makeRequest builds a valid bridge request.
function makeRequest(bridge, overrides = {}) {
  return {
    version: 'vscode-mcp-bridge/v1',
    request_id: `req-${Math.random().toString(36).slice(2)}`,
    tool: 'icm',
    action: 'get-incident',
    args: { incident_id: '12345' },
    capability_proof: bridge.bridgeToken,
    ...overrides,
  };
}

// makeResult builds a valid icm/get-incident MCP tool result.
function makeIcmResult() {
  return {
    content: [
      {
        value: JSON.stringify({
          title: 'CPU spike',
          service: 'api-gateway',
          environment: 'prod',
          logical_server: 'srv-01',
          database: 'db-primary',
        }),
      },
    ],
  };
}

// makeLm returns a stub lm interface. invokeToolFn is called for each
// invocation; defaults to returning a valid icm result.
function makeLm(invokeToolFn, tools) {
  return {
    tools: tools ?? [
      { name: 'icm-get-incident' },
      { name: 'tsg-recommendation-recommend' },
    ],
    invokeTool: invokeToolFn ??
      (async (_name, _opts, _token) => makeIcmResult()),
  };
}

// ─── Pure unit tests (no network) ────────────────────────────────────────────

test('TOOL_ACTION_REGISTRY: icm/get-incident has five declared output fields', () => {
  const spec = TOOL_ACTION_REGISTRY['icm/get-incident'];
  assert.ok(spec, 'icm/get-incident must be in the registry');
  assert.equal(spec.registeredName, 'icm-get-incident');
  const fields = Object.keys(spec.outputFields);
  assert.deepEqual(fields.sort(), ['database', 'environment', 'logical_server', 'service', 'title'].sort());
});

test('TOOL_ACTION_REGISTRY: tsg-recommendation/recommend is registered', () => {
  const spec = TOOL_ACTION_REGISTRY['tsg-recommendation/recommend'];
  assert.ok(spec, 'tsg-recommendation/recommend must be in the registry');
  assert.equal(spec.registeredName, 'tsg-recommendation-recommend');
});

test('resolveSpec: returns correct spec for known pair', () => {
  const spec = resolveSpec('icm', 'get-incident');
  assert.ok(spec);
  assert.equal(spec.registeredName, 'icm-get-incident');
});

test('resolveSpec: returns undefined for unknown pair', () => {
  assert.equal(resolveSpec('no-such', 'tool'), undefined);
});

test('normalizeResult: accepts a fully-valid icm result', () => {
  const spec = resolveSpec('icm', 'get-incident');
  const result = normalizeResult(
    { title: 'T', service: 'S', environment: 'E', logical_server: 'L', database: 'D' },
    spec,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { title: 'T', service: 'S', environment: 'E', logical_server: 'L', database: 'D' });
});

test('normalizeResult: fails on missing declared field', () => {
  const spec = resolveSpec('icm', 'get-incident');
  const result = normalizeResult(
    { title: 'T', service: 'S', environment: 'E', logical_server: 'L' /* database missing */ },
    spec,
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /database/);
});

test('normalizeResult: fails on unknown extra field (fail-closed)', () => {
  const spec = resolveSpec('icm', 'get-incident');
  const result = normalizeResult(
    { title: 'T', service: 'S', environment: 'E', logical_server: 'L', database: 'D', extra: 'x' },
    spec,
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /extra/);
});

test('normalizeResult: fails on type-incompatible value', () => {
  const spec = resolveSpec('icm', 'get-incident');
  const result = normalizeResult(
    { title: 42 /* should be string */, service: 'S', environment: 'E', logical_server: 'L', database: 'D' },
    spec,
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /title/);
});

test('normalizeResult: fails on null declared field', () => {
  const spec = resolveSpec('icm', 'get-incident');
  const result = normalizeResult(
    { title: null, service: 'S', environment: 'E', logical_server: 'L', database: 'D' },
    spec,
  );
  assert.equal(result.ok, false);
});

test('normalizeResult: fails when input is not an object', () => {
  const spec = resolveSpec('icm', 'get-incident');
  assert.equal(normalizeResult('string', spec).ok, false);
  assert.equal(normalizeResult(null, spec).ok, false);
  assert.equal(normalizeResult([1, 2], spec).ok, false);
});

test('extractTextFromResult: reads value fields from content', () => {
  const text = extractTextFromResult({ content: [{ value: 'hello' }, { value: ' world' }] });
  assert.equal(text, 'hello world');
});

test('extractTextFromResult: reads text fields from content', () => {
  const text = extractTextFromResult({ content: [{ text: 'hi' }] });
  assert.equal(text, 'hi');
});

// ─── Network tests (bridge HTTP server) ──────────────────────────────────────

test('bridge starts on loopback and responds to a valid request', async (t) => {
  const bridge = await McpBridge.create(makeLm(), 0);
  t.after(() => bridge.dispose());

  assert.match(bridge.bridgeUrl, /^http:\/\/127\.0\.0\.1:/);
  const { status, body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge));
  assert.equal(status, 200);
  assert.equal(body.version, 'vscode-mcp-bridge/v1');
  assert.ok(body.result);
});

test('tool discovery: invokeTool is called with the registered tool name', async (t) => {
  let calledWith = null;
  const lm = makeLm(async (name, _opts, _token) => {
    calledWith = name;
    return makeIcmResult();
  });
  const bridge = await McpBridge.create(lm, 0);
  t.after(() => bridge.dispose());

  await postBridge(bridge.bridgeUrl, makeRequest(bridge));
  assert.equal(calledWith, 'icm-get-incident');
});

test('invocation argument shaping: args from request reach invokeTool input', async (t) => {
  let receivedInput = null;
  const lm = makeLm(async (_name, opts, _token) => {
    receivedInput = opts.input;
    return makeIcmResult();
  });
  const bridge = await McpBridge.create(lm, 0);
  t.after(() => bridge.dispose());

  const args = { incident_id: 'INC-999', region: 'us-west-2' };
  await postBridge(bridge.bridgeUrl, makeRequest(bridge, { args }));
  assert.deepEqual(receivedInput, args);
});

test('result normalization success: response contains expected fields', async (t) => {
  const bridge = await McpBridge.create(makeLm(), 0);
  t.after(() => bridge.dispose());

  const { body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge));
  assert.ok(body.result);
  assert.equal(body.result.title, 'CPU spike');
  assert.equal(body.result.service, 'api-gateway');
  assert.equal(body.result.environment, 'prod');
  assert.equal(body.result.logical_server, 'srv-01');
  assert.equal(body.result.database, 'db-primary');
  assert.equal(body.error, undefined);
});

test('missing declared output field: bridge returns normalization error', async (t) => {
  const lm = makeLm(async () => ({
    content: [{
      value: JSON.stringify(
        { title: 'T', service: 'S', environment: 'E', logical_server: 'L' /* database missing */ }
      ),
    }],
  }));
  const bridge = await McpBridge.create(lm, 0);
  t.after(() => bridge.dispose());

  const { body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge));
  assert.ok(body.error, 'expected an error response');
  assert.equal(body.error.code, 'result_normalization_error');
  assert.match(body.error.message, /database/);
  assert.equal(body.result, undefined);
});

test('type-incompatible field: bridge returns normalization error', async (t) => {
  const lm = makeLm(async () => ({
    content: [{
      value: JSON.stringify(
        { title: 999 /* number, not string */, service: 'S', environment: 'E', logical_server: 'L', database: 'D' }
      ),
    }],
  }));
  const bridge = await McpBridge.create(lm, 0);
  t.after(() => bridge.dispose());

  const { body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge));
  assert.ok(body.error);
  assert.equal(body.error.code, 'result_normalization_error');
  assert.match(body.error.message, /title/);
});

test('authorization unavailable: invokeTool throws auth error → coded response', async (t) => {
  const lm = makeLm(async () => {
    throw new Error('Unauthorized: credential not found');
  });
  const bridge = await McpBridge.create(lm, 0);
  t.after(() => bridge.dispose());

  const { body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge));
  assert.ok(body.error);
  assert.equal(body.error.code, 'authorization_unavailable');
  assert.equal(body.result, undefined);
});

test('timeout: deadline in the past returns deadline_exceeded', async (t) => {
  let invokeCount = 0;
  const lm = makeLm(async (_name, _opts, _token) => {
    invokeCount++;
    return makeIcmResult();
  });
  const bridge = await McpBridge.create(lm, 0);
  t.after(() => bridge.dispose());

  const { body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge, {
    deadline_unix_ms: Date.now() - 1000, // already past
  }));
  assert.ok(body.error);
  assert.equal(body.error.code, 'deadline_exceeded');
  assert.equal(invokeCount, 0, 'invokeTool must not be called when deadline is past');
});

test('cancellation: invokeTool cancellation token fires when deadline expires', async (t) => {
  let tokenCancelledDuringInvoke = false;
  const lm = makeLm(async (_name, _opts, token) => {
    // Simulate slow async work; wait for cancellation.
    await new Promise((resolve) => {
      token.onCancellationRequested(resolve);
      setTimeout(resolve, 2000); // safety fallback
    });
    tokenCancelledDuringInvoke = token.isCancellationRequested;
    throw new Error('cancelled');
  });
  const bridge = await McpBridge.create(lm, 0);
  t.after(() => bridge.dispose());

  const { body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge, {
    deadline_unix_ms: Date.now() + 80, // 80ms deadline
  }));
  assert.ok(body.error);
  assert.equal(body.error.code, 'deadline_exceeded');
  assert.equal(tokenCancelledDuringInvoke, true, 'cancellation token must be cancelled on deadline');
});

test('duplicate request_id: invokeTool called exactly once', async (t) => {
  let invokeCount = 0;
  const lm = makeLm(async () => {
    invokeCount++;
    // Slow enough that the second request arrives while first is in-flight.
    await new Promise((r) => setTimeout(r, 30));
    return makeIcmResult();
  });
  const bridge = await McpBridge.create(lm, 0);
  t.after(() => bridge.dispose());

  const req = makeRequest(bridge);
  // Fire two concurrent requests with the same request_id.
  const [r1, r2] = await Promise.all([
    postBridge(bridge.bridgeUrl, req),
    postBridge(bridge.bridgeUrl, req),
  ]);
  assert.equal(invokeCount, 1, 'invokeTool must be called exactly once for duplicate request_id');
  assert.equal(r1.body.request_id, req.request_id);
  assert.equal(r2.body.request_id, req.request_id);
  // Both responses must be identical success responses.
  assert.deepEqual(r1.body.result, r2.body.result);
});

test('capability rejection: wrong token → HTTP 403 capability_rejected', async (t) => {
  const bridge = await McpBridge.create(makeLm(), 0);
  t.after(() => bridge.dispose());

  const { status, body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge, {
    capability_proof: 'wrong-secret-value',
  }));
  assert.equal(status, 403);
  assert.ok(body.error);
  assert.equal(body.error.code, 'capability_rejected');
});

test('version mismatch: wrong version → coded error with our version echoed', async (t) => {
  const bridge = await McpBridge.create(makeLm(), 0);
  t.after(() => bridge.dispose());

  const { status, body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge, {
    version: 'vscode-mcp-bridge/v99',
  }));
  assert.equal(status, 400);
  assert.ok(body.error);
  assert.equal(body.error.code, 'version_mismatch');
  assert.equal(body.version, 'vscode-mcp-bridge/v1');
});

test('malformed request: non-JSON body → coded error', async (t) => {
  const bridge = await McpBridge.create(makeLm(), 0);
  t.after(() => bridge.dispose());

  const { status, body } = await postBridge(bridge.bridgeUrl, 'not json at all');
  assert.equal(status, 400);
  assert.ok(body.error);
  assert.equal(body.error.code, 'malformed_request');
});

test('malformed request: missing request_id → coded error', async (t) => {
  const bridge = await McpBridge.create(makeLm(), 0);
  t.after(() => bridge.dispose());

  const req = makeRequest(bridge);
  delete req.request_id;
  const { body } = await postBridge(bridge.bridgeUrl, req);
  assert.ok(body.error);
  assert.equal(body.error.code, 'malformed_request');
});

test('unregistered tool: tool not in registry → tool_not_found', async (t) => {
  const bridge = await McpBridge.create(makeLm(), 0);
  t.after(() => bridge.dispose());

  const { body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge, {
    tool: 'nonexistent',
    action: 'do-thing',
  }));
  assert.ok(body.error);
  assert.equal(body.error.code, 'tool_not_found');
});

test('tool unavailable in vscode.lm.tools: returns tool_unavailable', async (t) => {
  const lm = makeLm(undefined, []); // no tools registered
  const bridge = await McpBridge.create(lm, 0);
  t.after(() => bridge.dispose());

  const { body } = await postBridge(bridge.bridgeUrl, makeRequest(bridge));
  assert.ok(body.error);
  assert.equal(body.error.code, 'tool_unavailable');
});

test('redaction sweep: capability secret never appears in any output surface', async (t) => {
  const logLines = [];
  const output = { appendLine: (s) => logLines.push(s) };

  let invokeCount = 0;
  const lm = makeLm(async () => {
    invokeCount++;
    throw new Error('intentional failure');
  });
  const bridge = await McpBridge.create(lm, 0, output);
  t.after(() => bridge.dispose());

  const secret = bridge.bridgeToken;

  // Drive a failing request (wrong capability proof containing the secret).
  const { body: b1 } = await postBridge(bridge.bridgeUrl, makeRequest(bridge, {
    capability_proof: 'wrong-' + secret,
  }));
  // Drive a successful request that triggers an invocation error.
  const { body: b2 } = await postBridge(bridge.bridgeUrl, makeRequest(bridge));

  // Assert: secret does not appear in any response body string.
  for (const body of [b1, b2]) {
    const serialized = JSON.stringify(body);
    assert.equal(
      serialized.includes(secret),
      false,
      `capability secret must not appear in response: ${serialized}`,
    );
  }

  // Assert: secret does not appear in any log line.
  for (const line of logLines) {
    assert.equal(
      line.includes(secret),
      false,
      `capability secret must not appear in log: ${line}`,
    );
  }
});

// ─── Mutation-control verification comments ───────────────────────────────────
// The three mutations below are run manually as part of the delivery report.
// They are not automated here because they require source edits; the results
// are documented in the commit message / summary.
//
// Mutation 1: remove checkCapability → capability-rejection test must FAIL.
// Mutation 2: return raw parsed JSON from handle() without normalizeResult →
//             missing-declared-output test must FAIL.
// Mutation 3: remove inflight/completed maps → duplicate-request_id test
//             must FAIL (invokeCount will be > 1).
