const test = require('node:test');
const assert = require('node:assert/strict');
const { selectDisplayPresentation, decodeDisplayPresentation, sanitizeDisplayPayload } = require('../out/displayPresentation');
const { sanitizePresentationPayload, terminalPresentation } = require('../out/presentationProjection');
const { decodePresentationState } = require('../out/presentationHistory');
const { markdownLink } = require('../out/markdownNavigation');
const vectors = require('./fixtures/workflow-markdown-contract.json');
for (const item of vectors.markdownCases) test(`contract Markdown ${item.name}`, () => {
  const metadata = item.hasMetadata === false ? undefined : { ...vectors.displayMetadata, value_status: item.value_status };
  const selected = selectDisplayPresentation(metadata, { content: item.retained });
  if (item.expectCopyEquals || item.copyEnabled) assert.equal(selected.text, item.retained);
  if (item.copyEnabled === false) assert.equal(selected.text, undefined);
  if (item.notice) assert.match(selected.reason, new RegExp(item.notice));
});
test('invalid metadata/value/binding fails closed atomically and idempotently', () => {
  for (const patch of [{ version: 2 }, { origin: 'authored' }, { format: 'sql' }, { output_field: 'template' },
    { plan_snapshot_digest: 'sha256:bad' }, { extra: true }, { value_status: 'invented' }]) {
    const metadata = { ...vectors.displayMetadata, ...patch };
    assert.equal(decodeDisplayPresentation(metadata), undefined);
    const payload = { display_presentation: metadata, output: { content: 'must not leak', outcome_category: 'blocked' } };
    sanitizePresentationPayload(payload);
    assert.equal(payload.output.content, undefined);
    assert.equal(payload.output.outcome_category, 'blocked');
    const copy = JSON.stringify(payload); sanitizePresentationPayload(payload); assert.equal(JSON.stringify(payload), copy);
  }
  assert.equal(selectDisplayPresentation(vectors.displayMetadata, { content: 'bound' }, 'sha256:' + 'b'.repeat(64)).text, undefined);
  for (const text of [null, 123, 'a'.repeat(32769), '\ud800', '\udc00']) {
    assert.equal(selectDisplayPresentation(vectors.displayMetadata, { content: text }).text, undefined);
  }
  const prefix = 'a'.repeat(32767);
  const payload = { display_presentation: { ...vectors.displayMetadata, value_status: 'truncated' }, output: { content: prefix } };
  sanitizeDisplayPayload(payload);
  assert.equal(payload.output.content, prefix);
  assert.equal(selectDisplayPresentation(vectors.displayMetadata, { content: 'a'.repeat(32766) + '😀' }).text.length, 32768);
});
test('declared reports only; legacy outputs are not automatically Markdown', () => {
  const payload = { output: { content: '# looks like Markdown' } };
  const value = terminalPresentation(payload);
  assert.equal(value.displayPresentation, undefined);
  assert.equal(payload.output.content, '# looks like Markdown');
});
test('retained history uses each frozen occurrence, unavailable metadata never authored template', () => {
  const metadata = vectors.displayMetadata;
  const history = { run_id: 'saved', plan_snapshot_digest: metadata.plan_snapshot_digest, checkpoint_sequence: 2,
    occurrences: ['first\r\n😀 ', '', 'legacy'].map((text, index) => ({
      identity: { qualified_node_id: 'iteration/report', invocation: index + 1 },
      details: { kind: 'display', format: 'markdown', content: '# changed ${template}' },
      output: { content: text }, output_value_status: {},
      ...(index < 2 ? { display_presentation: metadata } : {}),
    })) };
  const decoded = decodePresentationState(history);
  assert.equal(decoded.occurrences[0].output.content, 'first\r\n😀 ');
  assert.equal(decoded.occurrences[1].output.content, '');
  assert.equal(decoded.occurrences[2].output.content, undefined);
  history.occurrences[0].display_presentation = { ...metadata, plan_snapshot_digest: 'sha256:' + 'b'.repeat(64) };
  assert.equal(decodePresentationState(history).occurrences[0].output.content, undefined);
});
test('navigation accepts explicit HTTP(S) user-clicks and local fragments only', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'command:run', 'vscode:run', 'file:///C:/secret',
    '//example.org/pixel', 'relative', ' https://example.org', 'https://user:password@example.org', 'https:\n//example.org']) {
    assert.equal(markdownLink(url), undefined);
  }
  assert.equal(markdownLink('https://example.org/path'), 'external');
  assert.equal(markdownLink('http://example.org/path'), 'external');
  assert.equal(markdownLink('#local'), 'fragment');
});
test('session Markdown keeps exact qualified frame occurrences and rejects mismatched snapshot output', () => {
  const { SessionGraphModel, sessionGraphNodeID } = require('../out/sessionCompositeGraph');
  const { workflowIssueIndex } = require('../out/workflowProjection');
  const sessionID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', segmentID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const runID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', snapshot = vectors.displayMetadata.plan_snapshot_digest;
  const graph = { schema_version: '1', execution_plan_hash: snapshot, display_plan_snapshot_digest: snapshot,
    runbook: { id: 'entry', name: 'Entry' }, frames: [], groups: [], edges: [], nodes: [] };
  const graphHash = 'sha256:' + require('node:crypto').createHash('sha256').update(JSON.stringify(graph)).digest('hex');
  const manifest = { schema_version: 'investigation-session-manifest/v1',
    session: { session_id: sessionID, status: 'active', root_segment_id: segmentID, active_segment_id: segmentID, active_run_id: runID, sequence: 1 },
    segments: { [segmentID]: { segment_id: segmentID, ordinal: 1, runbook_id: 'entry', runbook_name: 'Entry', status: 'active',
      attempt_run_ids: [runID], graph_revision: 1, graph_hash: graphHash, executable_revision: 1, plan_hash: snapshot, executable_snapshot_hash: snapshot } },
    attempts: { [runID]: { run_id: runID, segment_id: segmentID, ordinal: 1, mode: 'real', status: 'running' } },
    transitions: {}, occurrences: {}, accepted_commands: {} };
  const model = new SessionGraphModel(sessionID);
  const apply = (sequence, type, payload) => model.applyGroup({ sequence, writerEpoch: 1, handshake: false, graphs: [], frames: [{
    version: 'gert-session-stdio/v1', type, frameID: `sha256:test-${sequence}`, sessionID, segmentID, runID,
    sessionSequence: sequence, sequenceIndex: 0, sequenceCount: 1, writerEpoch: 1, payload,
  }] });
  apply(1, 'session.snapshot', manifest);
  model.loadGraphRevision(manifest.segments[segmentID], 1, graphHash, graph);
  for (const [sequence, frame, text] of [[2, 'frame/a', 'first\r\n😀 '], [3, 'frame/b', 'second'], [4, 'frame/c', 'UNBOUND_DO_NOT_RETAIN']]) {
    apply(sequence, 'run.event', { run_id: runID, sequence, kind: sequence === 2 ? 'step/failed' : 'step/completed',
      payload: { qualified_node_id: 'wrapper/report', node_id: 'wrong', step_id: 'report', frame_id: frame, frame_step_index: 0,
        phase: 'execute', invocation: 1, retry_attempt: 1, occurrence_sequence: 1,
        display_presentation: { ...vectors.displayMetadata, ...(sequence === 4 ? { plan_snapshot_digest: 'sha256:' + 'b'.repeat(64) } : {}) },
        output: { content: text } } });
  }
  const nodes = model.snapshot().runtimeNodes, id = sessionGraphNodeID(sessionID, segmentID, 'wrapper/report');
  assert.equal(nodes[sessionGraphNodeID(sessionID, segmentID, 'wrong')], undefined);
  assert.deepEqual(nodes[id].occurrences.map(value => value.output.content), ['first\r\n😀 ', 'second', undefined]);
  assert.equal(nodes[id].status, 'completed');
  const issues = workflowIssueIndex(nodes);
  assert.equal(issues[0].nodeID, id);
  assert.equal(issues[0].occurrenceID, nodes[id].occurrences[0].occurrenceID);
  assert.equal(issues[0].graphRevision, 1);
  assert.ok(!JSON.stringify(nodes).includes('UNBOUND_DO_NOT_RETAIN'));
});
