const test = require('node:test');
const assert = require('node:assert/strict');
const { projectWorkflow, workflowIssueIndex, isWorkflowIssue } = require('../out/workflowProjection');
const { decodeWorkflowMarkdownPreference, mergeWorkflowMarkdownPreference } = require('../out/workflowMarkdownView');
const vectors = require('./fixtures/workflow-markdown-contract.json');
const options = extra => ({ mode: 'workflow', expandedNodeIDs: new Set(), pinnedNodeIDs: new Set(), collapsedGroupIDs: new Set(), ...extra });
function graph(vector) {
  return { schema_version: '1', runbook: { id: 'contract', name: 'contract' }, frames: [], groups: [],
    nodes: vector.nodes.map(([id, kind]) => ({ id, position: { x: 0, y: 0 },
      data: { id, kind, frame_id: '', group_id: vector.groups?.[id] ?? '' } })),
    edges: vector.edges.map(([id, source, target, routeKind, label, runtimeArmIndex]) =>
      ({ id, source, target, type: 'sequence', ...(routeKind ? { routeKind, label, runtimeArmIndex } : {}) })) };
}
function reversible(original, projected) {
  const edges = new Set(projected.document.edges.map(edge => edge.id));
  for (const segment of projected.segments.values()) for (const edge of segment.internalEdgeIDs) edges.add(edge);
  assert.deepEqual([...edges].sort(), original.edges.map(edge => edge.id).sort());
  const nodes = new Set(projected.document.nodes.filter(node => !projected.segments.has(node.id)).map(node => node.id));
  for (const segment of projected.segments.values()) for (const id of segment.memberNodeIDs) {
    assert.ok(!nodes.has(id), 'canonical node appears once'); nodes.add(id);
  }
  assert.deepEqual([...nodes].sort(), original.nodes.map(node => node.id).sort());
  const visible = new Set(projected.document.nodes.map(node => node.id));
  for (const edge of projected.document.edges) {
    assert.ok(visible.has(edge.source) && visible.has(edge.target), 'no dangling edge');
    const provenance = projected.edgeProvenance.get(edge.id);
    const source = original.edges.find(item => item.id === provenance.originalEdgeID);
    assert.equal(edge.runtimeNodeID, source.runtimeNodeID ?? source.target);
    for (const field of ['label', 'routeKind', 'runtimeExpectedStatus', 'runtimeArmIndex', 'runtimeArmLabel', 'runtimeFallbackNodeID']) {
      assert.equal(edge[field], source[field]);
    }
  }
}
for (const vector of vectors.graphCases) test(`contract workflow ${vector.name}`, () => {
  const input = graph(vector), runtime = vector.runtime ?? {}, before = JSON.stringify({ input, runtime });
  const projected = projectWorkflow(input, runtime, options());
  assert.deepEqual([...projected.segments.values()].map(item => item.memberNodeIDs), vector.expectedSegments);
  if (vector.expectedForced) assert.deepEqual([...projected.forcedNodeIDs].sort(), [...vector.expectedForced].sort());
  assert.equal(JSON.stringify({ input, runtime }), before);
  reversible(input, projected);
  assert.deepEqual(projectWorkflow(input, runtime, options({ mode: 'all' })).document.nodes, input.nodes);
});
for (const [index, vector] of vectors.issueCases.entries()) test(`contract issue observation ${index}`, () => {
  const issues = workflowIssueIndex({ node: vector.runtime });
  assert.equal(issues.length > 0, vector.issue);
  assert.equal(vector.runtime.status, vector.expectedStatus ?? vector.runtime.status);
  if (vector.navigateOccurrenceID) assert.equal(issues[0].occurrenceID, vector.navigateOccurrenceID);
});
test('parallel edges, self loops, control owners, scope boundaries and route structural degrees', () => {
  const input = graph({ nodes: [['a', 'tool'], ['t1', 'noop'], ['t2', 'assert'], ['b', 'display']],
    edges: [['e1', 'a', 't1'], ['e2', 't1', 't2'], ['e3', 't2', 'b'], ['duplicate', 't1', 't2']] });
  reversible(input, projectWorkflow(input, {}, options()));
  assert.equal(projectWorkflow(input, {}, options()).segments.size, 2);
  const route = { ...input, edges: input.edges.filter(edge => edge.id !== 'duplicate') };
  assert.equal(projectWorkflow(input, {}, options(), route).segments.size, 2);
  input.edges.pop(); input.edges.push({ id: 'self', source: 't1', target: 't1', type: 'sequence' });
  assert.equal(projectWorkflow(input, {}, options()).segments.size, 2);
  input.edges.pop(); input.groups = [{ id: 'g', kind: 'include', parent_node_id: 't1', frame_id: '' }];
  assert.deepEqual([...projectWorkflow(input, {}, options()).segments.values()].map(value => value.memberNodeIDs), [['t2']]);
  input.groups = []; input.nodes[2].data.frame_id = 'child';
  assert.equal(projectWorkflow(input, {}, options()).segments.size, 2);
});
test('ID collision allocation, group context, selected hidden ID and real running counts remain canonical', () => {
  const input = graph(vectors.graphCases[0]);
  const id = [...projectWorkflow(input, {}, options()).segments.keys()][0];
  input.edges[0].id = id;
  const projection = projectWorkflow(input, { t1: { status: 'running' } }, options());
  assert.ok(!projection.segments.has(id));
  for (const node of projection.document.nodes.filter(node => projection.segments.has(node.id))) assert.equal(node.data.status, undefined);
  const expanded = projectWorkflow(input, {}, options({ expandedNodeIDs: new Set(['t1', 't2']) }));
  assert.equal(expanded.segments.size, 0);
  input.groups = [{ id: 'include-group', kind: 'include', parent_node_id: 'a', frame_id: '' }];
  input.nodes[2].data.group_id = 'include-group';
  const forced = projectWorkflow(input, { t2: { status: 'completed', output: { outcome_category: 'blocked' } } },
    options({ collapsedGroupIDs: new Set(['include-group']) }), { ...input, nodes: [input.nodes[3]], edges: [] });
  assert.ok(forced.expandedGroupIDs.has('include-group'));
  assert.ok(forced.document.nodes.some(node => node.id === 't2'));
  assert.ok(forced.forcedNodeIDs.has('a'));
});
test('ten thousand node ladder and all retained lane/revision identities', () => {
  const input = graph({ nodes: Array.from({ length: 10000 }, (_, i) => [`n${i}`, 'noop']),
    edges: Array.from({ length: 9999 }, (_, i) => [`e${i}`, `n${i}`, `n${i + 1}`]) });
  const before = JSON.stringify(input);
  const projection = projectWorkflow(input, {}, options());
  assert.equal(projection.segments.size, 3, 'source and sink remain singleton pills');
  assert.equal(JSON.stringify(input), before);
  const issues = workflowIssueIndex({ 'already/qualified': { status: 'completed', occurrences: [
    { status: 'failed', occurrenceID: 'old', graphRevision: 2, segmentID: 'old-segment', qualifiedNodeID: 'local', executionLane: 'arm0' },
    { status: 'completed', occurrenceID: 'new', graphRevision: 3 },
  ] } });
  assert.equal(issues[0].nodeID, 'already/qualified');
  assert.equal(issues[0].graphRevision, 2);
  assert.equal(issues[0].occurrenceID, 'old');
  assert.equal(isWorkflowIssue({ status: 'running', output: { status: 'blocked' } }), false);
});
test('view-only validated preferences preserve inspector sizes and never retain reports', () => {
  const merged = mergeWorkflowMarkdownPreference({ inspectorRatio: .42, existing: true },
    { version: 1, workflowMode: 'all', markdownMode: 'raw', content: 'must not persist', statuses: { a: 'failed' } });
  assert.deepEqual(merged, { inspectorRatio: .42, existing: true,
    workflowMarkdownView: { version: 1, workflowMode: 'all', markdownMode: 'raw' } });
  assert.equal(decodeWorkflowMarkdownPreference({ version: 99 }).workflowMode, 'workflow');
});
module.exports = { graph, reversible, options };
