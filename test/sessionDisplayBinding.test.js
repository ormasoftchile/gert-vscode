const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { SessionGraphModel, sessionGraphNodeID } = require('../out/sessionCompositeGraph');
const { SessionGraphCacheStore, parseSessionGraphRevisionResponse } = require('../out/sessionPanelState');
const { validateSessionPresentationBinding } = require('../out/directGraphPreview');
const metadata = require('./fixtures/workflow-markdown-contract.json').displayMetadata;
test('SESSION display binds authenticated internal snapshot, preserving blob/code domain and persisted occurrences', async () => {
  const sessionID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', segmentID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const runID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', blobDigest = 'sha256:' + 'f'.repeat(64);
  const document = { schema_version: '1', execution_plan_hash: blobDigest,
    display_plan_snapshot_digest: metadata.plan_snapshot_digest,
    runbook: { id: 'entry', name: 'Entry' }, frames: [], groups: [], edges: [],
    nodes: [{ id: 'report', position: { x: 0, y: 0 }, data: { id: 'report', kind: 'display',
      details: { kind: 'display', format: 'markdown' } } }] };
  const encodedDocument = JSON.stringify(document);
  const graphHash = 'sha256:' + createHash('sha256').update(encodedDocument).digest('hex');
  const segment = { segment_id: segmentID, ordinal: 1, runbook_id: 'entry', runbook_name: 'Entry', status: 'active',
    attempt_run_ids: [runID], graph_revision: 1, graph_hash: graphHash, executable_revision: 1,
    plan_hash: blobDigest, executable_snapshot_hash: blobDigest };
  const manifest = { schema_version: 'investigation-session-manifest/v1',
    session: { session_id: sessionID, status: 'active', root_segment_id: segmentID,
      active_segment_id: segmentID, active_run_id: runID, sequence: 1 },
    segments: { [segmentID]: segment },
    attempts: { [runID]: { run_id: runID, segment_id: segmentID, ordinal: 1, mode: 'real', status: 'running' } },
    transitions: {}, occurrences: {}, accepted_commands: {} };
  const model = new SessionGraphModel(sessionID);
  const apply = (sequence, type, payload) => model.applyGroup({ sequence, writerEpoch: 1, handshake: false, graphs: [], frames: [{
    version: 'gert-session-stdio/v1', type, frameID: `sha256:display-${sequence}`, sessionID, segmentID, runID,
    sessionSequence: sequence, sequenceIndex: 0, sequenceCount: 1, writerEpoch: 1, payload,
  }] });
  apply(1, 'session.snapshot', manifest);
  model.loadGraphRevision(segment, 1, graphHash, document);
  for (const [sequence, digest] of [[2, metadata.plan_snapshot_digest], [3, blobDigest], [4, metadata.plan_snapshot_digest]]) {
    apply(sequence, 'run.event', { run_id: runID, sequence, kind: 'step/completed', payload: {
      qualified_node_id: 'report', phase: 'execute', invocation: sequence, retry_attempt: 1, occurrence_sequence: sequence,
      display_presentation: { ...metadata, plan_snapshot_digest: digest }, output: { content: `exact ${sequence}\r\n😀` },
    } });
  }
  const id = sessionGraphNodeID(sessionID, segmentID, 'report'), nodes = model.snapshot().runtimeNodes;
  assert.equal(nodes[id].occurrences[0].output.content, 'exact 2\r\n😀');
  assert.equal(nodes[id].occurrences[1].output.content, undefined, 'blob digest cannot authorize new Markdown');
  assert.equal(nodes[id].output.content, 'exact 4\r\n😀');
  assert.equal(model.snapshot().document.nodes.find(n => n.id === id).data.display_plan_snapshot_digest, metadata.plan_snapshot_digest);
  const graph = { revision: 1, wholeBlobHash: graphHash, encodedDocument, document, segmentSnapshot: segment };
  const cache = { schemaVersion: 'gert-vscode-session-graph-cache/v2', sessionID, sequence: 1, manifest,
    segmentGraphs: { [segmentID]: graph }, segmentGraphHistory: { [segmentID]: { 1: graph } },
    segmentGraphAvailability: {}, preparedTransitionTargets: {}, runtimeNodes: nodes };
  const directory = path.join(process.env.GERT_WORKFLOW_ARTIFACTS ?? path.join(__dirname, '..', '.vscode-test'), 'session-binding-cache');
  const store = new SessionGraphCacheStore(directory);
  try {
    await store.save(cache);
    const loaded = await store.load(sessionID);
    assert.equal(loaded.runtimeNodes[id].output.content, 'exact 4\r\n😀');
    const withdrawn = structuredClone(cache);
    withdrawn.runtimeNodes[id].displayPresentation = { ...metadata, value_status: ['redacted'] };
    await store.save(withdrawn);
    const raw = await fs.readFile(store.pathFor(sessionID), 'utf8');
    assert.ok(!raw.includes('exact 4'));
    const restored = await store.load(sessionID);
    assert.equal(restored.runtimeNodes[id].occurrences[0].output.content, 'exact 2\r\n😀');
    assert.equal(restored.runtimeNodes[id].occurrences[2].output.content, undefined);
  } finally { await store.delete(sessionID); }
  const response = { schema_version: 'session-graph-revision/v1', session_id: sessionID,
    graph_revision: 1, graph_hash: graphHash, segment, data: Buffer.from(encodedDocument).toString('base64') };
  const altered = { ...document, display_plan_snapshot_digest: blobDigest };
  assert.throws(() => parseSessionGraphRevisionResponse(JSON.stringify({ ...response,
    data: Buffer.from(JSON.stringify(altered)).toString('base64') }), sessionID, segmentID, 1), /digest mismatch/);
  assert.throws(() => validateSessionPresentationBinding({ ...document, display_plan_snapshot_digest: [metadata.plan_snapshot_digest] }, blobDigest), /display snapshot/);
  assert.throws(() => validateSessionPresentationBinding(document, metadata.plan_snapshot_digest), /frozen execution-plan binding/);
});
test('SESSION same-occurrence binding conflicts withdraw monotonically against the historical authenticated revision', () => {
  const sessionID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', segmentID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const runID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', blob = 'sha256:' + 'f'.repeat(64);
  const currentDigest = 'sha256:' + 'e'.repeat(64);
  const graph = digest => ({ schema_version: '1', execution_plan_hash: blob, display_plan_snapshot_digest: digest,
    runbook: { id: 'entry', name: 'Entry' }, nodes: [], edges: [], groups: [], frames: [] });
  const original = graph(metadata.plan_snapshot_digest), revised = graph(currentDigest);
  const hash = doc => 'sha256:' + createHash('sha256').update(JSON.stringify(doc)).digest('hex');
  const segment = { segment_id: segmentID, ordinal: 1, runbook_id: 'entry', runbook_name: 'Entry', status: 'active',
    attempt_run_ids: [runID], graph_revision: 1, graph_hash: hash(original), executable_revision: 1,
    plan_hash: blob, executable_snapshot_hash: blob };
  const manifest = { schema_version: 'investigation-session-manifest/v1',
    session: { session_id: sessionID, status: 'active', root_segment_id: segmentID,
      active_segment_id: segmentID, active_run_id: runID, sequence: 1 },
    segments: { [segmentID]: segment },
    attempts: { [runID]: { run_id: runID, segment_id: segmentID, ordinal: 1, mode: 'real', status: 'running' } },
    transitions: {}, occurrences: {}, accepted_commands: {} };
  let sequence = 1;
  const model = new SessionGraphModel(sessionID), id = sessionGraphNodeID(sessionID, segmentID, 'report');
  const apply = (invocation, display, text) => {
    sequence++;
    model.applyGroup({ sequence, writerEpoch: 1, handshake: false, graphs: [], frames: [{
      version: 'gert-session-stdio/v1', type: 'run.event', frameID: `sha256:recovery-${sequence}`, sessionID, segmentID, runID,
      sessionSequence: sequence, sequenceIndex: 0, sequenceCount: 1, writerEpoch: 1,
      payload: { run_id: runID, sequence, kind: 'step/failed', payload: { qualified_node_id: 'report',
        phase: 'execute', invocation, occurrence_sequence: invocation, retry_attempt: 1,
        display_presentation: display, output: { content: text }, error: 'original failure' } },
    }] });
    return model.snapshot().runtimeNodes[id];
  };
  const cached = (document, segmentSnapshot) => ({ document, segmentSnapshot,
    revision: segmentSnapshot.graph_revision, wholeBlobHash: segmentSnapshot.graph_hash });
  model.restore(1, manifest, { [segmentID]: cached(original, segment) });
  apply(1, metadata, 'legitimate older');
  apply(3, metadata, 'selected earlier revision');
  const before = model.snapshot();
  const updated = { ...segment, graph_revision: 2, executable_revision: 2, graph_hash: hash(revised) };
  const latestManifest = structuredClone(before.manifest);
  latestManifest.segments[segmentID] = updated;
  model.restore(sequence, latestManifest, { [segmentID]: cached(revised, updated) }, before.runtimeNodes,
    undefined, undefined, { [segmentID]: { 1: cached(original, segment), 2: cached(revised, updated) } },
    {}, { [segmentID]: { 1: segment, 2: updated } });
  assert.equal(apply(3, metadata, 'stale valid').output.content, 'selected earlier revision');
  const bad = apply(3, { ...metadata, plan_snapshot_digest: currentDigest }, 'new graph cannot authorize this occurrence');
  assert.equal(bad.output.content, undefined);
  assert.equal(bad.occurrences[0].output.content, 'legitimate older');
  assert.equal(bad.error, 'original failure');
  assert.equal(apply(3, metadata, 'stale replay').output.content, undefined);
  assert.equal(apply(4, { ...metadata, plan_snapshot_digest: currentDigest }, 'new graph new occurrence').output.content,
    'new graph new occurrence');
  const unloaded = new SessionGraphModel(sessionID);
  unloaded.restore(1, manifest, {}, {}, undefined, undefined, {}, {}, { [segmentID]: { 1: segment } });
  unloaded.applyGroup({ sequence: 2, writerEpoch: 1, handshake: false, graphs: [], frames: [{
    version: 'gert-session-stdio/v1', type: 'run.event', frameID: 'sha256:unloaded', sessionID, segmentID, runID,
    sessionSequence: 2, sequenceIndex: 0, sequenceCount: 1, writerEpoch: 1,
    payload: { run_id: runID, sequence: 2, kind: 'step/completed', payload: { qualified_node_id: 'report', invocation: 1,
      display_presentation: { ...metadata, plan_snapshot_digest: blob }, output: { content: 'manifest is not display authority' } } },
  }] });
  assert.equal(unloaded.snapshot().runtimeNodes[id].output.content, undefined);
});
