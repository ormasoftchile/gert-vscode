const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { transformSync } = require('esbuild');
const observations = require('../out/displayObservations');
const storage = require('../out/displayObservationStorage');
const { terminalPresentation } = require('../out/presentationProjection');
const { decodePresentationState } = require('../out/presentationHistory');
const metadata = require('./fixtures/workflow-markdown-contract.json').displayMetadata;
const binding = metadata.plan_snapshot_digest;
const source = fs.readFileSync(path.join(__dirname, '..', 'webview', 'graph.tsx'), 'utf8');
function production(name, next) {
  return vm.runInNewContext(transformSync(source.slice(source.indexOf(`function ${name}(`),
    source.indexOf(`function ${next}(`)), { loader: 'ts', target: 'es2022' }).code + `\n${name}`, {
    terminalPresentation, ...observations, ...require('../out/executionProgress'), ...require('../out/runStatus'),
    eventNodeID: e => e.payload.qualified_node_id,
    recordValue: v => v && typeof v === 'object' && !Array.isArray(v) ? v : undefined,
  });
}
const eventReducer = production('applyRuntimeEvent', 'applyTerminalSteps');
const summaryReducer = production('applyTerminalSteps', 'graphInputDeclarations');
const valid = text => ({ display_presentation: { ...metadata, value_status: text.length === 32768 ? 'truncated' : 'available' },
  output: { content: text } });
const invalids = [
  ['wrong digest', { display_presentation: { ...metadata, plan_snapshot_digest: 'sha256:' + 'e'.repeat(64) }, output: { content: 'UNTRUSTED' } }],
  ['array', { display_presentation: { ...metadata, value_status: ['redacted'] } }],
  ['missing content', { display_presentation: metadata }],
  ['redacted', { display_presentation: { ...metadata, value_status: 'redacted' } }],
  ['unavailable', { display_presentation: { ...metadata, value_status: 'unavailable' } }],
  ['null', { display_presentation: null }],
  ['diagnostic', { display_presentation_diagnostic: 'invalid-metadata' }],
  ['conflicting diagnostic', { display_presentation: metadata, display_presentation_diagnostic: 'invalid-metadata',
    output: { content: 'UNTRUSTED' } }],
];
const frame = (data, invocation = 3, extra = {}) => ({ run_id: 'run', sequence: invocation, kind: 'step/failed',
  payload: { qualified_node_id: 'report', invocation, error: 'ORIGINAL_ERROR', ...structuredClone(data), ...extra } });
const event = (state, data, invocation = 3, extra) => eventReducer(state, frame(data, invocation, extra), binding);
const summary = (state, data) => summaryReducer(state, [{ node_id: 'report', status: 'failed',
  error: 'ORIGINAL_ERROR', ...structuredClone(data) }], binding, 'run');
const document = (data, older = true) => ({ presentation_state: { run_id: 'run', plan_snapshot_digest: binding, checkpoint_sequence: 4,
  occurrences: [...(older ? [{ invocation: 1, ...valid('legitimate older') }] : []), { invocation: 3, ...structuredClone(data) }]
    .map(({ invocation, ...payload }) => ({ identity: { qualified_node_id: 'report', invocation },
      details: { kind: 'display', format: 'markdown' }, output_value_status: {}, ...payload })) } });
function permutations(values) {
  if (!values.length) return [[]];
  return values.flatMap((value, i) => permutations(values.filter((_, j) => i !== j)).map(rest => [value, ...rest]));
}
function withdrawn(state) {
  assert.equal(state.report.output?.content, undefined);
  for (const item of state.report.occurrences ?? []) if (item.invocation === 3) assert.equal(item.output?.content, undefined);
  for (const item of state.report.retainedPresentations ?? []) {
    assert.equal(item.output?.content, undefined, 'legacy withdrawal quarantines the ambiguous scope');
  }
}
for (const [name, bad] of invalids) for (const text of ['full\r\n😀  ', '', 'x'.repeat(32766) + '😀']) {
  test(`bounded direct event/summary/history/hydration permutations: ${name}, ${text.length} units`, () => {
    for (const prior of [false, true]) for (const route of ['summary', 'event', 'history']) {
      for (const order of permutations(['event', 'summary', 'history', 'withdraw'])) {
        let state = prior ? event(event({}, valid('legitimate older'), 1), valid(text)) : {};
        let denied = false;
        for (const action of order) {
          if (action === 'withdraw') {
            state = route === 'summary' ? summary(state, bad) : route === 'event' ? event(state, bad)
              : observations.applyDirectRetainedDocument(state, document(bad));
            denied = true;
          } else if (action === 'event') state = event(state, valid(text));
          else if (action === 'summary') state = summary(state, valid(text));
          else state = observations.applyDirectRetainedDocument(state, document(valid(text)));
          state = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(state))).map(([id, node]) =>
            [id, observations.reconcileDirectDisplayState(node)]));
          if (denied) withdrawn(state);
        }
        // Actual persisted presentation-only state, followed by stale history and
        // backfill. No execution status is synthesized by cache restoration.
        const stored = JSON.parse(JSON.stringify(observations.retainDirectDisplayWithdrawals({}, state)));
        state = observations.restoreDirectDisplayWithdrawals({}, stored, 'run', binding);
        state = observations.applyDirectRetainedDocument(state, document(valid(text)));
        state = event(state, valid(text));
        state = summary(state, { output: { content: 'GENERIC FALLBACK' } });
        withdrawn(state);
        state = event(state, valid('new occurrence'), 4);
        assert.equal(state.report.output.content, undefined, 'terminal arrival cannot prove freshness');
      }
    }
  });
  test(`standalone retention/projection permutations: ${name}, ${text.length} units`, () => {
    for (const prior of [false, true]) for (const order of permutations(['event', 'summary', 'withdraw', 'history'])) {
      let ledger = prior ? observations.retainDisplayObservation({}, 'report', 'run', { invocation: 3, ...valid(text) }, binding) : {};
      let denied = false;
      for (const action of order) {
        const data = action === 'withdraw' ? bad : valid(text);
        ledger = observations.retainDisplayObservation(ledger, 'report', 'run',
          { ...(action === 'event' || action === 'history' ? { invocation: 3 } : {}), ...structuredClone(data) },
          binding, undefined, action === 'history');
        if (action === 'withdraw') denied = true;
        ledger = JSON.parse(JSON.stringify(ledger));
        if (!denied) continue;
        const projected = observations.reconcileDisplayDocument(document(valid(text)), ledger);
        assert.equal(projected.presentation_state.occurrences[0].output.content, undefined);
        assert.equal(projected.presentation_state.occurrences[1].output.content, undefined);
        const overlay = observations.reconcileDisplayOverlay({ nodes: { report: { invocation: 3, ...valid(text) } } }, ledger, 'run', binding);
        assert.equal(overlay.nodes.report.output.content, undefined);
        const unidentified = observations.reconcileDisplayOverlay({ nodes: { report: { status: 'failed', ...valid(text) } } }, ledger, 'run', binding);
        assert.equal(unidentified.nodes.report.output.content, undefined, 'node status/output fields are not occurrence identity');
      }
      ledger = observations.retainDisplayObservation(ledger, 'report', 'run', { invocation: 4, ...valid('new') }, binding);
      assert.equal(ledger.report.at(-1).output.content, 'new');
    }
  });
}
test('standalone persistent storage roundtrip, missing-identity history aliases and future starts', () => {
  const values = new Map();
  const backend = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  for (const [, bad] of invalids) {
    let ledger = observations.retainDisplayObservation({}, 'report', 'run', bad, binding);
    storage.storeDisplayWithdrawals(backend, 'run', ledger);
    ledger = storage.loadDisplayWithdrawals(backend, 'run');
    ledger = observations.retainDisplayObservation(ledger, 'report', 'run', { invocation: 3, ...valid('STALE') }, binding, undefined, true);
    const projected = observations.reconcileDisplayDocument(document(valid('STALE')), ledger);
    assert.equal(projected.presentation_state.occurrences[1].output.content, undefined);
    ledger = observations.retainDisplayObservation(ledger, 'report', 'run', { invocation: 3, ...valid('STALE') }, binding);
    assert.equal(ledger.report.length, 2, 'quarantine remains independent of replay identity');
    assert.equal(ledger.report.find(item => item.display_presentation_diagnostic).output.content, undefined);
    storage.storeDisplayWithdrawals(backend, 'run', ledger);
    assert.ok(!values.values().next().value.includes('STALE'));
    assert.deepEqual(storage.loadDisplayWithdrawals(backend, 'another-run'), {});
  }
  let ledger = observations.retainDisplayObservation({}, 'report', 'run', invalids[0][1], binding);
  ledger = observations.retainDisplayObservation(ledger, 'report', 'run', { invocation: 4 }, binding, 'running');
  ledger = observations.retainDisplayObservation(ledger, 'report', 'run', { invocation: 4, ...valid('future') }, binding);
  assert.equal(observations.reconcileDisplayOverlay({ nodes: { report: { invocation: 4, ...valid('future') } } },
    ledger, 'run', binding).nodes.report.output.content, undefined, 'a replayed start cannot prove freshness');
  ledger = observations.retainDisplayObservation(ledger, 'report', 'run', { invocation: 5, ...valid('future') }, binding);
  assert.equal(ledger.report.at(-1).output.content, 'future');
  assert.deepEqual(storage.decodeDisplayWithdrawals({ report: [null, {}, { identity: [] }] }), {});
  const corrupted = storage.decodeDisplayWithdrawals({ report: [{ runID: 'run', snapshotDigest: binding,
    identity: {}, excludedIdentities: [null, [], { invocation: {} }] }] });
  assert.equal(observations.retainDisplayObservation(corrupted, 'report', 'run',
    { invocation: 3, ...valid('STALE') }, binding).report[0].output.content, undefined);
});
test('identity-free withdrawal quarantines all same-scope replays without guessed association', () => {
  let state = summary({}, invalids[0][1]);
  state = eventReducer(state, { ...frame({}, 4), kind: 'step/started' }, binding);
  state = event(state, valid('future started'), 4);
  assert.equal(state.report.output.content, undefined, 'start replay is not an authorization reset');
  state = event(state, valid('stale old'), 3);
  assert.equal(state.report.occurrences.find(item => item.invocation === 3).output.content, undefined);
  assert.equal(state.report.occurrences.find(item => item.invocation === 4).output.content, undefined);
  state = event(state, valid('distinct future'), 5);
  assert.equal(state.report.output.content, undefined);
  const saved = observations.retainDirectDisplayWithdrawals({}, state);
  assert.deepEqual(observations.restoreDirectDisplayWithdrawals({}, saved, 'other-run', binding), {});
  assert.deepEqual(observations.restoreDirectDisplayWithdrawals({}, saved, 'run', 'sha256:' + 'c'.repeat(64)), {});
});
test('unknown binding never self-authorizes or becomes an asserted trusted snapshot', () => {
  const initial = eventReducer({}, frame(valid('unproved')));
  const stored = observations.retainDirectDisplayWithdrawals({}, initial);
  let state = observations.restoreDirectDisplayWithdrawals({}, stored, 'run', binding);
  state = observations.applyDirectRetainedDocument(state, document(valid('STALE')));
  state = event(state, valid('STALE'));
  assert.equal(state.report.output.content, 'STALE');
  state = event(state, valid('distinct'), 4);
  assert.equal(state.report.output.content, 'distinct');
});
test('unidentified withdrawal survives stale start/resume/delay and terminals with or without occurrence fields', () => {
  for (const [, bad] of invalids) for (const kind of ['step/started', 'step/resumed', 'step/delaying']) {
    for (const identified of [true, false]) {
      let state = summary({}, bad);
      const start = frame({});
      if (!identified) delete start.payload.invocation;
      state = eventReducer(state, { ...start, kind }, binding);
      const replay = frame(valid('STALE'));
      if (!identified) delete replay.payload.invocation;
      state = eventReducer(state, replay, binding);
      assert.equal(state.report.output.content, undefined);
      assert.equal(state.report.occurrences.at(-1).output.content, undefined);
      const stored = observations.retainDirectDisplayWithdrawals({}, state);
      state = observations.restoreDirectDisplayWithdrawals({}, stored, 'run', binding);
      state = eventReducer(state, structuredClone(replay), binding);
      assert.equal(state.report.output.content, undefined);
    }
  }
});
test('unidentified cached current row cannot reauthorize an unidentified withdrawal', () => {
  const doc = document(valid('STALE'), false);
  delete doc.presentation_state.occurrences[0].identity.invocation;
  const ledger = observations.retainDisplayObservation({}, 'report', 'run', invalids[0][1], binding);
  assert.equal(observations.reconcileDisplayDocument(doc, ledger).presentation_state.occurrences[0].output.content, undefined);
  let state = summary({}, invalids[0][1]);
  state = observations.applyDirectRetainedDocument(state, doc);
  assert.equal(state.report.retainedPresentations[0].output.content, undefined);
});
test('overlapping frames and lanes at identical counters are distinct observations', () => {
  let state = {};
  for (const [frame_id, execution_lane] of [['frame-a', 'lane-a'], ['frame-b', 'lane-b']]) {
    state = event(state, valid(frame_id), 3, { phase: 'execute', retry_attempt: 1, frame_step_index: 0, frame_id, execution_lane, occurrence_sequence: 1 });
  }
  state = event(state, invalids[0][1], 3, { phase: 'execute', retry_attempt: 1, frame_step_index: 0, frame_id: 'frame-a', execution_lane: 'lane-a', occurrence_sequence: 1 });
  state = event(state, valid('stale'), 3, { phase: 'execute', retry_attempt: 1, frame_step_index: 0, frame_id: 'frame-a', execution_lane: 'lane-a', occurrence_sequence: 1 });
  assert.equal(state.report.occurrences.length, 2);
  assert.equal(state.report.occurrences[0].output.content, undefined);
  assert.equal(state.report.occurrences[1].output.content, 'frame-b');
});
test('partial identities cannot refine a scoped legacy withdrawal', () => {
  const cached = document(valid('current'), false);
  cached.presentation_state.occurrences = ['event-old', 'event-current'].map(event_id => ({
    identity: { qualified_node_id: 'report', invocation: 3, event_id },
    details: { kind: 'display', format: 'markdown' },
    ...valid(event_id === 'event-old' ? 'legitimate older' : 'current'),
  }));
  let state = observations.applyDirectRetainedDocument({}, cached);
  state = summary(state, invalids[0][1]);
  state = event(state, valid('STALE'));
  assert.equal(state.report.output.content, undefined);
  assert.equal(state.report.retainedPresentations[0].output.content, undefined);
  assert.equal(state.report.retainedPresentations[1].output.content, undefined);
});
test('late Markdown decoration never rewrites the original terminal outcome or failure', () => {
  let state = event({}, valid('original'));
  state = eventReducer(state, { ...frame(invalids[0][1]), kind: 'step/completed',
    payload: { ...frame(invalids[0][1]).payload, error: 'replacement error', duration_ms: 999 } }, binding);
  state = summaryReducer(state, [{ node_id: 'report', status: 'completed', error: 'summary replacement',
    ...valid('STALE') }], binding, 'run');
  assert.equal(state.report.status, 'failed');
  assert.equal(state.report.error, 'ORIGINAL_ERROR');
  assert.equal(state.report.occurrences[0].status, 'failed');
  assert.equal(state.report.occurrences[0].error, 'ORIGINAL_ERROR');
  assert.equal(state.report.output.content, undefined);
});
test('historical decoder preserves explicit withdrawal but leaves absent legacy metadata unclassified', () => {
  for (const [, bad] of invalids) {
    const decoded = decodePresentationState(document(bad).presentation_state);
    const ledger = decoded.occurrences.reduce((result, item) => observations.retainDisplayObservation(result,
      'report', 'run', { ...item, ...item.identity }, binding), {});
    const projected = observations.reconcileDisplayDocument(document(valid('STALE')), ledger);
    assert.equal(projected.presentation_state.occurrences[1].output.content, undefined);
  }
  const legacy = decodePresentationState(document({ output: { content: 'legacy' } }).presentation_state);
  assert.equal(legacy.occurrences[1].display_presentation_diagnostic, undefined);
  const state = summary(event({}, valid('full')), { output: { content: 'ordinary summary' } });
  assert.equal(state.report.output.content, 'full');
});

test('SESSION actual cache/root/occurrence withdrawal before and after first terminal survives restore/backfill', async () => {
  const { createHash } = require('node:crypto');
  const { SessionGraphModel, sessionGraphNodeID } = require('../out/sessionCompositeGraph');
  const { SessionGraphCacheStore } = require('../out/sessionPanelState');
  const sessionID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', segmentID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const runID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', blob = 'sha256:' + 'f'.repeat(64);
  const graph = { schema_version: '1', execution_plan_hash: blob, display_plan_snapshot_digest: binding,
    runbook: { id: 'entry', name: 'Entry' }, nodes: [], edges: [], groups: [], frames: [] };
  const encodedDocument = JSON.stringify(graph), hash = 'sha256:' + createHash('sha256').update(encodedDocument).digest('hex');
  const segment = { segment_id: segmentID, ordinal: 1, runbook_id: 'entry', runbook_name: 'Entry', status: 'active',
    attempt_run_ids: [runID], graph_revision: 1, graph_hash: hash, executable_revision: 1,
    plan_hash: blob, executable_snapshot_hash: blob };
  const manifest = { schema_version: 'investigation-session-manifest/v1',
    session: { session_id: sessionID, status: 'active', root_segment_id: segmentID,
      active_segment_id: segmentID, active_run_id: runID, sequence: 1 }, segments: { [segmentID]: segment },
    attempts: { [runID]: { run_id: runID, segment_id: segmentID, ordinal: 1, mode: 'real', status: 'running' } },
    transitions: {}, occurrences: {}, accepted_commands: {} };
  const cached = { revision: 1, wholeBlobHash: hash, encodedDocument, document: graph, segmentSnapshot: segment };
  const graphs = { [segmentID]: cached }, id = sessionGraphNodeID(sessionID, segmentID, 'report');
  const directory = path.join(process.env.GERT_WORKFLOW_ARTIFACTS ?? path.join(__dirname, '..', '.vscode-test'), 'revision-2-session-ordering-cache');
  const store = new SessionGraphCacheStore(directory);
  try {
    for (const [, bad] of invalids) for (const text of ['full\r\n😀', '', 'x'.repeat(32766) + '😀']) {
      for (const prior of [false, true]) for (const target of ['active', 'occurrence']) {
        let model = new SessionGraphModel(sessionID), sequence = 1;
        model.restore(1, manifest, graphs);
        const apply = (invocation, data, kind = 'step/failed') => {
          sequence++;
          model.applyGroup({ sequence, writerEpoch: 1, handshake: false, graphs: [], frames: [{
            version: 'gert-session-stdio/v1', type: 'run.event', frameID: `sha256:ordering-${sequence}`,
            sessionID, segmentID, runID, sessionSequence: sequence, sequenceIndex: 0, sequenceCount: 1, writerEpoch: 1,
            payload: { run_id: runID, sequence, kind, payload: { qualified_node_id: 'report', invocation,
              phase: 'execute', occurrence_sequence: invocation,
              frame_id: `frame-${invocation}`, frame_step_index: 0, execution_lane: `lane-${invocation}`, retry_attempt: 1,
              error: 'ORIGINAL_ERROR', ...structuredClone(data) } },
          }] });
        };
        apply(1, valid('legitimate older'));
        apply(3, prior ? valid(text) : {}, prior ? 'step/failed' : 'step/started');
        const snapshot = model.snapshot(), nodes = structuredClone(snapshot.runtimeNodes);
        const current = target === 'active' ? nodes[id] : nodes[id].occurrences[1];
        Object.assign(current, { output: bad.output, displayPresentation: bad.display_presentation,
          displayPresentationDiagnostic: bad.display_presentation_diagnostic });
        await store.save({ schemaVersion: 'gert-vscode-session-graph-cache/v2', sessionID, sequence,
          manifest: snapshot.manifest, segmentGraphs: graphs, segmentGraphHistory: { [segmentID]: { 1: cached } },
          segmentGraphAvailability: {}, preparedTransitionTargets: {}, runtimeNodes: nodes });
        const loaded = await store.load(sessionID);
        assert.ok(loaded);
        model = new SessionGraphModel(sessionID);
        model.restore(sequence, loaded.manifest, loaded.segmentGraphs, loaded.runtimeNodes);
        apply(3, valid(text));
        const after = model.snapshot().runtimeNodes[id];
        assert.equal(after.output.content, undefined);
        assert.equal(after.occurrences[1].output.content, undefined);
        assert.equal(after.occurrences[0].output.content, 'legitimate older');
        assert.equal(after.status, 'failed');
        assert.equal(after.error, 'ORIGINAL_ERROR');
        apply(4, valid('new instance'));
        assert.equal(model.snapshot().runtimeNodes[id].output.content, 'new instance');
      }
    }
  } finally { await store.delete(sessionID); }
});
