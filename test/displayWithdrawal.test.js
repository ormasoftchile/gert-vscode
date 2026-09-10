const test = require('node:test');
const assert = require('node:assert/strict');
const { retainDisplayObservation, reconcileDisplayDocument, reconcileRuntimeDisplayState, reconcileDisplayOverlay } = require('../out/displayObservations');
const { mergeDisplayPayload, selectDisplayPresentation } = require('../out/displayPresentation');
const { terminalPresentation } = require('../out/presentationProjection');
const metadata = require('./fixtures/workflow-markdown-contract.json').displayMetadata;
const digest = metadata.plan_snapshot_digest;
const valid = (text = 'current\r\n😀', invocation = 2) => ({
  phase: 'execute', retry_attempt: 1, occurrence_sequence: invocation,
  invocation, display_presentation: metadata, output: { content: text, outcome_category: 'blocked' }, error: 'original error',
});
const retain = (state, payload, run = 'run', binding = digest) =>
  retainDisplayObservation(state, 'report', run, payload, binding, 'completed');
for (const [name, update] of [
  ['redacted omitted output', { display_presentation: { ...metadata, value_status: 'redacted' } }],
  ['unavailable omitted output', { display_presentation: { ...metadata, value_status: 'unavailable' } }],
  ['invalid array status', { display_presentation: { ...metadata, value_status: ['redacted'] } }],
  ['missing retained value', { display_presentation: metadata }],
  ['diagnostic only', { display_presentation_diagnostic: 'invalid-metadata' }],
  ['wrong snapshot', { display_presentation: { ...metadata, plan_snapshot_digest: 'sha256:' + 'e'.repeat(64) } }],
]) for (const order of ['event-state-replay', 'state-event-replay']) test(`${name}: ${order}`, () => {
  let state = retain({}, valid('older exact', 1));
  const withdrawal = { phase: 'execute', retry_attempt: 1, occurrence_sequence: 2, ...update, invocation: 2 };
  if (order === 'event-state-replay') state = retain(state, valid());
  state = retain(state, withdrawal);
  state = retain(state, valid());
  state = retain(state, { phase: 'execute', retry_attempt: 1, occurrence_sequence: 2,
    invocation: 2, output: { content: 'late unclassified summary' } });
  assert.equal(state.report[0].output.content, 'older exact');
  assert.equal(state.report[1].output.content, undefined);
  assert.equal(state.report[1].error, order === 'event-state-replay' ? 'original error' : undefined,
    'late decoration cannot rewrite an original error or original absence of error');
  assert.equal(selectDisplayPresentation(state.report[1].display_presentation, state.report[1].output, digest).text, undefined);
  assert.ok(!JSON.stringify(state).includes('current\\r'));
  const doc = { presentation_state: { run_id: 'run', plan_snapshot_digest: digest,
    occurrences: [1, 2].map(invocation => ({ identity: { qualified_node_id: 'report', invocation,
      phase: 'execute', retry_attempt: 1, occurrence_sequence: invocation },
      details: { kind: 'display', format: 'markdown' }, output: { content: invocation === 1 ? 'older exact' : 'cached stale' },
      display_presentation: metadata })) } };
  const projected = reconcileDisplayDocument(doc, state);
  assert.equal(projected.presentation_state.occurrences[0].output.content, 'older exact');
  assert.equal(projected.presentation_state.occurrences[1].output.content, undefined);
  assert.equal(doc.presentation_state.occurrences[1].output.content, 'cached stale', 'projection must not rewrite frozen graph');
});
test('unidentified state quarantines same-scope histories but not different run or snapshot', () => {
  let state = retain(retain({}, valid('old', 1)), valid('current', 2));
  state = retain(state, { display_presentation: { ...metadata, value_status: 'redacted' } });
  assert.equal(state.report[0].output.content, 'old');
  assert.equal(reconcileDisplayOverlay({ nodes: { report: valid('current', 2) } }, state, 'run', digest).nodes.report.output.content, undefined);
  state = retain(state, valid('new', 3));
  assert.equal(state.report.at(-1).output.content, 'new', 'canonical observations are not deleted');
  assert.equal(reconcileDisplayOverlay({ nodes: { report: valid('new', 3) } }, state, 'run', digest).nodes.report.output.content, undefined);
  state = retain(state, valid('other run', 2), 'another-run');
  assert.equal(state.report.at(-1).output.content, 'other run');
  const otherDigest = 'sha256:' + 'c'.repeat(64);
  state = retain(state, { ...valid('other snapshot', 2), display_presentation: { ...metadata, plan_snapshot_digest: otherDigest } }, 'run', otherDigest);
  assert.equal(state.report.at(-1).output.content, 'other snapshot');
});
test('full/empty/truncated preserve exact approved strings across unclassified summaries', () => {
  for (const value_status of ['available', 'truncated']) for (const text of ['', '  \r\n😀\t', 'x'.repeat(32766) + '😀']) {
    const prior = { ...valid(text), display_presentation: { ...metadata, value_status } };
    const merged = mergeDisplayPayload(prior, { output: { content: 'summary' } }, digest);
    assert.equal(merged.output.content, text);
    assert.equal(merged.display_presentation.value_status, value_status);
  }
});
test('React shared terminal merge is monotonic without changing status/error semantics', () => {
  const first = valid(); const approved = terminalPresentation(first, undefined, digest);
  const bad = { display_presentation: { ...metadata, value_status: ['redacted'] }, error: 'actual failed' };
  const withheld = terminalPresentation(bad, { ...approved, output: first.output }, digest);
  const replay = valid();
  terminalPresentation(replay, { ...withheld, output: bad.output }, digest);
  assert.equal(replay.output.content, undefined);
  assert.equal(bad.error, 'actual failed');
});
test('active runtime cache pointer and matching occurrence reconcile withdrawal in both directions', () => {
  for (const withdrawn of ['state', 'occurrence']) {
    const full = { displayPresentation: metadata, output: { content: 'stale active cache' } };
    const empty = { displayPresentationDiagnostic: 'invalid-metadata', output: {} };
    const state = { occurrenceID: 'current', status: 'running', ...(withdrawn === 'state' ? empty : full),
      occurrences: [
        { occurrenceID: 'older', ...full, output: { content: 'legitimate old' }, status: 'completed' },
        { occurrenceID: 'current', status: 'failed', error: 'original failure', ...(withdrawn === 'occurrence' ? empty : full) },
      ] };
    const value = reconcileRuntimeDisplayState(state);
    assert.equal(value.output.content, undefined);
    assert.equal(value.occurrences[1].output.content, undefined);
    assert.equal(value.occurrences[0].output.content, 'legitimate old');
    assert.equal(value.status, 'running'); assert.equal(value.occurrences[1].status, 'failed');
    assert.equal(value.occurrences[1].error, 'original failure');
  }
});
test('standalone current overlay storage is scrubbed, not merely hidden by selection', () => {
  let observations = retain({}, valid());
  observations = retain(observations, { invocation: 2, display_presentation: { ...metadata, value_status: 'redacted' } });
  const overlay = reconcileDisplayOverlay({ nodes: { report: { ...valid(), status: 'running' } } }, observations, 'run', digest);
  assert.equal(overlay.nodes.report.output.content, undefined);
  assert.equal(overlay.nodes.report.status, 'running');
});
test('historical event IDs and graph revision bindings cannot alias unrelated occurrences', () => {
  let state = retain({}, { invocation: 1, display_presentation: metadata, output: { content: 'first' }, event_id: 'event-1' });
  state = retain(state, { invocation: 1, display_presentation: metadata, output: { content: 'second' }, event_id: 'event-2' });
  assert.equal(state.report.length, 2);
  const result = reconcileRuntimeDisplayState({ occurrenceID: 'same-pointer', graphRevision: 2,
    displayPresentationDiagnostic: 'invalid-metadata', output: {},
    occurrences: [{ occurrenceID: 'same-pointer', graphRevision: 1, displayPresentation: metadata, output: { content: 'prior revision' } }] });
  assert.equal(result.occurrences[0].output.content, 'prior revision');
});
