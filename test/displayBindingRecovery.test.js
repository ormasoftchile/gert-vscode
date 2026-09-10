const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { transformSync } = require('esbuild');
const { terminalPresentation } = require('../out/presentationProjection');
const metadata = require('./fixtures/workflow-markdown-contract.json').displayMetadata;
const binding = metadata.plan_snapshot_digest, wrong = 'sha256:' + 'e'.repeat(64);
const source = fs.readFileSync(path.join(__dirname, '..', 'webview', 'graph.tsx'), 'utf8');
function production(name, next) {
  const code = source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`));
  return vm.runInNewContext(transformSync(code, { loader: 'ts', target: 'es2022' }).code + `\n${name}`, {
    terminalPresentation, ...require('../out/executionProgress'), ...require('../out/runStatus'), ...require('../out/displayObservations'),
    eventNodeID: e => e.payload.qualified_node_id,
    recordValue: v => v && typeof v === 'object' && !Array.isArray(v) ? v : undefined,
  });
}
const apply = production('applyRuntimeEvent', 'applyTerminalSteps');
const summary = production('applyTerminalSteps', 'graphInputDeclarations');
const frame = (invocation, data, sequence = invocation) => ({ run_id: 'run', sequence, kind: 'step/failed',
  payload: { qualified_node_id: 'report', phase: 'execute', retry_attempt: 1, occurrence_sequence: invocation,
    invocation, error: 'original MCP failure', ...data } });
const valid = text => ({ display_presentation: metadata, output: { content: text } });
const forms = [
  ['wrong snapshot', { display_presentation: { ...metadata, plan_snapshot_digest: wrong }, output: { content: 'untrusted' } }],
  ['array status', { display_presentation: { ...metadata, value_status: ['redacted'] }, output: { content: 'untrusted' } }],
  ['missing content', { display_presentation: metadata }],
  ['redacted', { display_presentation: { ...metadata, value_status: 'redacted' } }],
  ['unavailable', { display_presentation: { ...metadata, value_status: 'unavailable' } }],
  ['null', { display_presentation: null, output: { content: 'untrusted' } }],
];
for (const route of ['terminal', 'summary']) for (const [name, incoming] of forms) {
  test(`production direct ${route} withdraws ${name} before merge, not only inspection`, () => {
    let state = apply({}, frame(1, valid('legitimate older\r\n😀')), binding);
    state = apply(state, frame(3, valid('current\r\n😀')), binding);
    assert.equal(state.report.output.content, 'current\r\n😀');
    state = route === 'terminal' ? apply(state, frame(3, structuredClone(incoming), 10), binding) :
      summary(state, [{ node_id: 'report', status: 'failed', phase: 'execute', invocation: 3,
        retry_attempt: 1, occurrence_sequence: 3, ...structuredClone(incoming) }], binding);
    for (const replay of [
      s => apply(s, frame(3, valid('STALE'), 11), binding),
      s => summary(s, [{ node_id: 'report', status: 'failed', ...valid('STALE') }], binding),
      s => summary(s, [{ node_id: 'report', status: 'failed', output: { content: 'GENERIC' } }], binding),
    ]) {
      assert.equal(state.report.output.content, undefined);
      assert.equal(state.report.occurrences[1].output.content, undefined);
      assert.equal(state.report.occurrences[0].output.content, 'legitimate older\r\n😀');
      assert.equal(state.report.error, 'original MCP failure');
      assert.equal(state.report.status, 'failed');
      state = replay(state);
    }
    assert.equal(state.report.output.content, undefined);
    state = apply(state, frame(4, valid('genuinely new')), binding);
    assert.equal(state.report.output.content, 'genuinely new');
  });
}
test('unknown graph binding fails closed and cannot be inferred from event metadata', () => {
  const state = apply({}, frame(3, valid('unproved')));
  assert.equal(state.report.output.content, undefined);
  const finished = summary({}, [{ node_id: 'report', status: 'completed', ...valid('unproved') }]);
  assert.equal(finished.report.output.content, undefined);
  const payload = valid('unproved');
  terminalPresentation(payload);
  assert.equal(payload.output.content, undefined);
});
test('different document cannot replace the authenticated binding for an existing occurrence', () => {
  let state = apply({}, frame(3, valid('approved old graph')), binding);
  state = apply(state, frame(3, valid('stale')), wrong);
  assert.equal(state.report.output.content, 'approved old graph');
  state = apply(state, frame(3, { display_presentation: { ...metadata, plan_snapshot_digest: wrong },
    output: { content: 'new graph cannot authorize old occurrence' } }), wrong);
  assert.equal(state.report.output.content, undefined);
  state = apply(state, frame(4, { display_presentation: { ...metadata, plan_snapshot_digest: wrong },
    output: { content: 'new occurrence new graph' } }), wrong);
  assert.equal(state.report.output.content, 'new occurrence new graph');
});
test('direct graph binding captured synchronously in the actual App event and summary paths', () => {
  assert.match(source, /directDocumentRef\.current = message\.document/);
  assert.match(source, /restoreDirectDisplayWithdrawals\(current, displayWithdrawalsRef\.current, frame\.event!\.run_id, binding\)/);
  assert.match(source, /frame\.steps, binding, summaryRunID/);
});
test('direct cache/event/replayed-cache withdrawal is monotonic in both directions', () => {
  const { applyDirectRetainedDocument } = require('../out/displayObservations');
  const document = { presentation_state: { run_id: 'run', plan_snapshot_digest: binding, checkpoint_sequence: 2,
    occurrences: [1, 3].map(invocation => ({ identity: { qualified_node_id: 'report', invocation,
      phase: 'execute', retry_attempt: 1, occurrence_sequence: invocation },
      details: { kind: 'display', format: 'markdown' }, display_presentation: metadata,
      output: { content: invocation === 1 ? 'legitimate older' : 'cached sensitive' } })) } };
  for (const cachedFirst of [false, true]) {
    let state = cachedFirst ? applyDirectRetainedDocument({}, document) : {};
    state = apply(state, frame(3, valid('cached sensitive')), binding);
    state = apply(state, frame(3, forms[0][1]), binding);
    state = applyDirectRetainedDocument(state, document);
    for (let replay = 0; replay < 2; replay++) {
      state = apply(state, frame(3, valid('cached sensitive')), binding);
      state = applyDirectRetainedDocument(state, { presentation_state: { ...document.presentation_state, occurrences: [] } });
      state = applyDirectRetainedDocument(state, document);
      assert.equal(state.report.output.content, undefined);
      assert.equal(state.report.occurrences.find(o => o.invocation === 3).output.content, undefined);
      assert.equal(state.report.retainedPresentations.find(o => o.identity.invocation === 3).output.content, undefined);
      assert.equal(state.report.retainedPresentations.find(o => o.identity.invocation === 1).output.content, 'legitimate older');
      assert.equal(state.report.error, 'original MCP failure');
    }
  }
  let state = applyDirectRetainedDocument({}, document);
  state = summary(state, [{ node_id: 'report', status: 'failed', ...forms[0][1] }], binding);
  assert.equal(state.report.retainedPresentations[0].output.content, undefined, 'unidentified summary quarantines its scope');
  assert.equal(state.report.retainedPresentations[1].output.content, undefined, 'summary withdraws latest retained-only occurrence');
  state = applyDirectRetainedDocument(state, document);
  assert.equal(state.report.retainedPresentations[1].output.content, undefined);
});
