const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { transformSync } = require('esbuild');
const { decodeDisplayPresentation, selectDisplayPresentation, sanitizeDisplayPayload } = require('../out/displayPresentation');
const { parseDisplayJSON } = require('../out/displayPresentationJSON');
const { terminalPresentation } = require('../out/presentationProjection');
const { decodePresentationState } = require('../out/presentationHistory');
const metadata = require('./fixtures/workflow-markdown-contract.json').displayMetadata;
const marker = 'SYNTHETIC_WITHHELD_REPORT';
const error = 'original synthetic MCP failure';
function payload(value) {
  return { display_presentation: value, output: { content: marker, outcome_category: 'blocked' }, error };
}
function retained(value) {
  return { run_id: 'run', plan_snapshot_digest: metadata.plan_snapshot_digest, checkpoint_sequence: 1,
    occurrences: [{ identity: { qualified_node_id: 'report', invocation: 1 },
      details: { kind: 'display', format: 'markdown' }, display_presentation: value,
      output: { content: marker }, output_value_status: {} }] };
}
const malformed = [];
for (const key of Object.keys(metadata)) {
  for (const value of [undefined, null, false, true, 0, 2, 'unknown', [], [metadata[key]], {}, { toString: () => metadata[key] }]) {
    malformed.push([`${key}/${JSON.stringify(value)}`, { ...metadata, [key]: value }]);
  }
  const missing = { ...metadata }; delete missing[key];
  malformed.push([`${key}/missing`, missing]);
  malformed.push([`${key}/inherited`, Object.assign(Object.create({ [key]: metadata[key] }), missing)]);
  const getter = { ...metadata };
  Object.defineProperty(getter, key, { enumerable: true, get() { throw new Error('must not invoke metadata getter'); } });
  malformed.push([`${key}/accessor`, getter]);
}
for (const key of ['constructor', 'toString', '__proto__', 'legacy', Symbol('unknown')]) {
  const extra = { ...metadata };
  Object.defineProperty(extra, key, { enumerable: true, value: 'unexpected' });
  malformed.push([String(key), extra]);
}
for (const value of ['available', 'truncated', 'redacted', 'unavailable', 'constructor', 'toString', '__proto__']) {
  malformed.push([`coercible-status-${value}`, { ...metadata, value_status: [value] }]);
}
for (const value of [null, false, true, 1, 'markdown', [], [metadata], {}, Object.create(metadata),
  Object.assign(Object.create({ inherited: true }), metadata)]) malformed.push(['non-record', value]);
for (const suffix of ['\n', '\r\n', '\r', ' ', '\u2028', '\u2029']) {
  malformed.push(['digest exact length', { ...metadata, plan_snapshot_digest: metadata.plan_snapshot_digest + suffix }]);
}
for (const [name, value] of malformed) test(`closed Markdown metadata ${name}`, () => {
  assert.equal(decodeDisplayPresentation(value), undefined);
  assert.equal(selectDisplayPresentation(value, { content: marker }).text, undefined);
  const item = payload(value);
  assert.doesNotThrow(() => terminalPresentation(item));
  assert.ok(!Object.hasOwn(item.output, 'content'));
  assert.equal(item.error, error);
  assert.equal(item.output.outcome_category, 'blocked');
  assert.equal(item.display_presentation_diagnostic, 'invalid-metadata');
  const once = JSON.stringify(item); sanitizeDisplayPayload(item); assert.equal(JSON.stringify(item), once);
  const history = decodePresentationState(retained(value));
  assert.ok(!JSON.stringify(history).includes(marker));
});
test('own data-only output and detached metadata; no inherited authorization or coercion', () => {
  const valid = Object.assign(Object.create(null), metadata);
  assert.deepEqual(decodeDisplayPresentation(valid), metadata);
  const decoded = decodeDisplayPresentation(metadata);
  assert.notEqual(decoded, metadata);
  for (const output of [Object.create({ content: marker }), Object.assign(Object.create({}), { content: marker }),
    Object.defineProperty({}, 'content', { get() { throw new Error('output getter'); } }), [], null]) {
    assert.equal(selectDisplayPresentation(metadata, output).text, undefined);
    const item = { display_presentation: metadata, output, error };
    assert.doesNotThrow(() => sanitizeDisplayPayload(item));
    assert.equal(item.output.content, undefined);
    assert.equal(item.error, error);
  }
  const inherited = Object.assign(Object.create({ display_presentation: metadata }), { output: { content: marker }, error });
  sanitizeDisplayPayload(inherited);
  assert.equal(inherited.output.content, undefined);
  assert.equal(inherited.error, error);
  for (const value of [undefined, null, [], {}]) {
    const item = { display_presentation: value, output: { content: marker }, error };
    sanitizeDisplayPayload(item);
    assert.ok(!JSON.stringify(item).includes(marker));
  }
  const legacy = { output: { content: marker, constructor: 'raw legacy policy' }, error };
  const before = JSON.stringify(legacy); terminalPresentation(legacy); assert.equal(JSON.stringify(legacy), before);
});
test('all legitimate exact full/empty/truncated boundaries and Unicode remain unchanged', () => {
  for (const value_status of ['available', 'truncated']) for (const text of ['', '  \r\n😀\t', 'a'.repeat(32766) + '😀']) {
    const item = { display_presentation: { ...metadata, value_status }, output: { content: text } };
    sanitizeDisplayPayload(item);
    assert.equal(item.output.content, text);
    assert.equal(selectDisplayPresentation(item.display_presentation, item.output).text, text);
    if (value_status === 'truncated') assert.match(selectDisplayPresentation(item.display_presentation, item.output).reason, /prefix/);
  }
  for (const value_status of ['redacted', 'unavailable']) {
    const item = payload({ ...metadata, value_status }); sanitizeDisplayPayload(item);
    assert.equal(item.output.content, undefined);
    assert.equal(item.display_presentation.value_status, value_status);
  }
});
test('raw wire duplicates are optional-decoration failures, including escaped names and enclosing duplicates', () => {
  for (const key of Object.keys(metadata)) for (const alias of [key, key.replace(key[0], '\\u' + key.charCodeAt(0).toString(16).padStart(4, '0'))]) {
    const wire = JSON.stringify(payload(metadata)).replace('"display_presentation":{',
      `"display_presentation":{"${alias}":${JSON.stringify(metadata[key])},`);
    const item = parseDisplayJSON(wire); terminalPresentation(item);
    assert.equal(item.error, error); assert.equal(item.output.content, undefined);
  }
  for (const value of [metadata, null, [], {}]) {
    const wire = JSON.stringify(payload(metadata)).replace('"display_presentation":',
      `"display_presentation":${JSON.stringify(value)},"display_presentation":`);
    const item = parseDisplayJSON(wire); terminalPresentation(item);
    assert.equal(item.output.content, undefined); assert.equal(item.error, error);
  }
  const wire = JSON.stringify(retained(metadata)).replace('"value_status":"available"', '"value_status":"redacted","value_status":"available"');
  assert.ok(!JSON.stringify(decodePresentationState(parseDisplayJSON(wire))).includes(marker));
  const legacy = '{"output":{"content":"a","content":"b","nested":[{"text":"{}: \\"display_presentation\\""}]},"error":"original"}';
  assert.deepEqual(parseDisplayJSON(legacy), JSON.parse(legacy));
  const rawLegacy = '{"output":{"display_presentation":{"version":1,"version":2},"nested":[{"displayPresentation":1,"displayPresentation":2}]}}';
  assert.deepEqual(parseDisplayJSON(rawLegacy), JSON.parse(rawLegacy));
  assert.throws(() => parseDisplayJSON('{"broken":'), SyntaxError);
});
test('session wire duplicate metadata remains a forwarded failed tool event, not a protocol failure', () => {
  const { SessionStdioClient } = require('../out/sessionStdioClient');
  const { createHash } = require('node:crypto');
  const sessionID = '11111111-1111-4111-8111-111111111111';
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() {}, killed: false, exitCode: null });
  const groups = [], errors = [];
  new SessionStdioClient(child, { sessionID, afterSequence: 0, onGroup: group => groups.push(group),
    onAcceptedSequence() {}, onError: message => errors.push(message), onExit() {} });
  const frame = { version: 'gert-session-stdio/v1', type: 'run.event', sessionID,
    segmentID: '22222222-2222-4222-8222-222222222222', runID: '33333333-3333-4333-8333-333333333333',
    frameID: 'sha256:' + createHash('sha256').update('revision').digest('hex'),
    sessionSequence: 1, sequenceIndex: 0, sequenceCount: 1, writerEpoch: 1,
    payload: { kind: 'step/failed', payload: payload(metadata) } };
  const wire = JSON.stringify(frame).replace('"value_status":"available"', '"value_status":"redacted","value_status":"available"');
  child.stdout.write(wire + '\n');
  assert.deepEqual(errors, []); assert.equal(groups.length, 1);
  const forwarded = groups[0].frames[0].payload;
  assert.equal(forwarded.kind, 'step/failed'); assert.equal(forwarded.payload.error, error);
  assert.ok(!JSON.stringify(groups).includes(marker));
});
function production(name, next, dependencies) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'webview', 'graph.tsx'), 'utf8');
  const fn = source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`));
  const value = vm.runInNewContext(transformSync(fn, { loader: 'ts', target: 'es2022' }).code + `\n${name}`, {
    ...require('../out/executionProgress'), ...require('../out/runStatus'), ...require('../out/displayObservations'), ...dependencies,
  });
  return (current, update) => value(current, update, metadata.plan_snapshot_digest);
}
test('actual direct current/terminal/history recurrence removes withdrawn slots and preserves original failures', () => {
  const apply = production('applyRuntimeEvent', 'applyTerminalSteps', { terminalPresentation,
    eventNodeID: event => event.payload.qualified_node_id, recordValue: value => value });
  const summarize = production('applyTerminalSteps', 'graphInputDeclarations', { terminalPresentation });
  for (const value of malformed.map(([, value]) => value)) {
    let state = apply({}, { kind: 'step/completed', run_id: 'run', sequence: 1, payload: {
      qualified_node_id: 'report', phase: 'execute', retry_attempt: 1, occurrence_sequence: 1,
      invocation: 1, ...payload(metadata), output: { content: 'earlier approved occurrence' },
    } });
    state = apply(state, { kind: 'step/failed', run_id: 'run', sequence: 2, payload: {
      qualified_node_id: 'report', phase: 'execute', retry_attempt: 1, occurrence_sequence: 2,
      invocation: 2, ...payload(value),
    } });
    assert.ok(!JSON.stringify(state).includes(marker));
    assert.equal(state.report.error, error); assert.equal(state.report.status, 'failed');
    assert.equal(state.report.occurrences[0].output.content, 'earlier approved occurrence');
    const classified = apply({}, { kind: 'step/completed', run_id: 'run', sequence: 3, payload: {
      qualified_node_id: 'report', phase: 'execute', retry_attempt: 1, occurrence_sequence: 1,
      invocation: 1, ...payload(metadata),
    } });
    const final = summarize(classified, [{ node_id: 'report', status: 'failed', phase: 'execute',
      invocation: 1, retry_attempt: 1, occurrence_sequence: 1, ...payload(value) }]);
    assert.ok(!JSON.stringify(final).includes(marker), 'invalid summary must withdraw prior classified content');
    assert.equal(final.report.error, error);
  }
});
test('production stdio parser forwards original failed event after malformed metadata and raw duplicates', () => {
  const { DirectRunSession } = require('../out/directRunSession');
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() {}, killed: false, exitCode: null });
  const frames = [], errors = [];
  new DirectRunSession(child, { onFrame: frame => frames.push(frame), onError: error => errors.push(error), onExit() {} });
  child.stdout.write('{"type":"run.started","version":"gert-stdio/v1","runID":"run"}\n');
  for (const item of [payload({ ...metadata, value_status: ['redacted'] }), payload(metadata)]) {
    let wire = JSON.stringify({ type: 'run.event', version: 'gert-stdio/v1', runID: 'run',
      event: { kind: 'step/failed', payload: item } });
    if (item.display_presentation.value_status === 'available') wire = wire.replace('"value_status":"available"', '"value_status":"redacted","value_status":"available"');
    child.stdout.write(wire + '\n');
  }
  assert.deepEqual(errors, []); assert.equal(frames.length, 3);
  for (const frame of frames.slice(1)) {
    assert.equal(frame.event.kind, 'step/failed'); assert.equal(frame.event.payload.error, error);
    assert.ok(!JSON.stringify(frame).includes(marker));
  }
});
test('session current/recurring occurrences and persisted cache sanitize invalid metadata before writing', async () => {
  const { SessionGraphModel, sessionGraphNodeID } = require('../out/sessionCompositeGraph');
  const { SessionGraphCacheStore } = require('../out/sessionPanelState');
  const sessionID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', segmentID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const runID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', snapshot = metadata.plan_snapshot_digest;
  const manifest = { schema_version: 'investigation-session-manifest/v1',
    session: { session_id: sessionID, status: 'active', root_segment_id: segmentID, active_segment_id: segmentID, active_run_id: runID, sequence: 1 },
    segments: { [segmentID]: { segment_id: segmentID, ordinal: 1, runbook_id: 'entry', runbook_name: 'Entry', status: 'active',
      attempt_run_ids: [runID], graph_revision: 1, graph_hash: snapshot, executable_revision: 1, plan_hash: snapshot, executable_snapshot_hash: snapshot } },
    attempts: { [runID]: { run_id: runID, segment_id: segmentID, ordinal: 1, mode: 'real', status: 'running' } },
    transitions: {}, occurrences: {}, accepted_commands: {} };
  const model = new SessionGraphModel(sessionID);
  const apply = (sequence, type, payload) => model.applyGroup({ sequence, writerEpoch: 1, handshake: false, graphs: [], frames: [{
    version: 'gert-session-stdio/v1', type, frameID: `sha256:revision-${sequence}`, sessionID, segmentID, runID,
    sessionSequence: sequence, sequenceIndex: 0, sequenceCount: 1, writerEpoch: 1, payload,
  }] });
  apply(1, 'session.snapshot', manifest);
  let sequence = 1;
  for (const [, value] of malformed) {
    sequence++;
    apply(sequence, 'run.event', { run_id: runID, sequence, kind: 'step/failed', payload: {
      qualified_node_id: 'report', invocation: sequence, retry_attempt: 1, occurrence_sequence: sequence,
      ...payload(value),
    } });
  }
  const id = sessionGraphNodeID(sessionID, segmentID, 'report');
  const nodes = model.snapshot().runtimeNodes;
  assert.ok(!JSON.stringify(nodes).includes(marker));
  assert.equal(nodes[id].error, error);
  assert.equal(nodes[id].status, 'failed');
  assert.equal(nodes[id].occurrences.length, malformed.length);
  const directory = path.join(__dirname, '..', '.vscode-test', 'workflow-markdown-revision', 'cache');
  const store = new SessionGraphCacheStore(directory);
  try {
    for (const value of [{ ...metadata, value_status: ['redacted'] }, { ...metadata, constructor: 'invalid' }, null]) {
      const current = { ...nodes[id], displayPresentation: value, output: { content: marker },
        occurrences: [{ ...nodes[id].occurrences[0], displayPresentation: value, output: { content: marker } }] };
      await store.save({ schemaVersion: 'gert-vscode-session-graph-cache/v2', sessionID, sequence: 1, manifest,
        segmentGraphs: {}, segmentGraphHistory: {}, segmentGraphAvailability: {}, preparedTransitionTargets: {}, runtimeNodes: { [id]: current } });
      const raw = fs.readFileSync(store.pathFor(sessionID), 'utf8');
      assert.ok(!raw.includes(marker), 'persisted bytes must omit protected content');
      const restored = await store.load(sessionID);
      assert.ok(restored); assert.ok(!JSON.stringify(restored).includes(marker));
      assert.equal(restored.runtimeNodes[id].error, error);
      assert.equal(restored.runtimeNodes[id].occurrences[0].error, error);
    }
  } finally { await store.delete(sessionID); fs.rmSync(directory, { recursive: true, force: true }); }
});
