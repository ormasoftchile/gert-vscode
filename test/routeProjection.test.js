'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { computeRouteProjection, projectRouteDocument } = require('../out/routeProjection');

function node(id) {
  return {
    id,
    data: { id, kind: 'noop', frame_id: 'frame:root', group_id: '' },
    position: { x: 0, y: 0 },
  };
}

function edge(id, source, target) {
  return { id, source, target };
}

function document() {
  return {
    schema_version: '1',
    runbook: { id: 'route-test' },
    frames: [],
    groups: [],
    nodes: ['load', 'inspect', 'target', 'verify', 'done', 'unrelated'].map(node),
    edges: [
      edge('load-inspect', 'load', 'inspect'),
      edge('inspect-target', 'inspect', 'target'),
      edge('target-verify', 'target', 'verify'),
      edge('verify-done', 'verify', 'done'),
      edge('done-verify', 'done', 'verify'),
    ],
  };
}

test('through projection contains every predecessor and successor of the target', () => {
  const projection = computeRouteProjection(document(), 'target', 'through');

  assert.ok(projection);
  assert.deepEqual([...projection.nodeIDs].sort(), ['done', 'inspect', 'load', 'target', 'verify']);
  assert.deepEqual([...projection.edgeIDs].sort(), [
    'done-verify',
    'inspect-target',
    'load-inspect',
    'target-verify',
    'verify-done',
  ]);
  assert.equal(projection.predecessorCount, 2);
  assert.equal(projection.successorCount, 2);
  assert.equal(projection.hiddenNodeCount, 1);
  assert.deepEqual(projection.boundaryEdges, []);
});

test('to projection retains predecessors and reports the first hidden outgoing edge', () => {
  const projection = computeRouteProjection(document(), 'target', 'to');

  assert.ok(projection);
  assert.deepEqual([...projection.nodeIDs].sort(), ['inspect', 'load', 'target']);
  assert.deepEqual([...projection.edgeIDs].sort(), ['inspect-target', 'load-inspect']);
  assert.deepEqual(projection.boundaryEdges, [
    { edgeID: 'target-verify', visibleNodeID: 'target', hiddenNodeID: 'verify', direction: 'outgoing' },
  ]);
});

test('from projection retains successors and reports the first hidden incoming edge', () => {
  const projection = computeRouteProjection(document(), 'target', 'from');

  assert.ok(projection);
  assert.deepEqual([...projection.nodeIDs].sort(), ['done', 'target', 'verify']);
  assert.deepEqual([...projection.edgeIDs].sort(), ['done-verify', 'target-verify', 'verify-done']);
  assert.deepEqual(projection.boundaryEdges, [
    { edgeID: 'inspect-target', visibleNodeID: 'target', hiddenNodeID: 'inspect', direction: 'incoming' },
  ]);
});

test('unknown targets do not produce a projection', () => {
  assert.equal(computeRouteProjection(document(), 'missing', 'through'), undefined);
});

test('projected document retains visible compound groups and removes unrelated groups', () => {
  const source = document();
  source.groups = [
    { id: 'route-arm', kind: 'branch-arm', parent_node_id: 'load', frame_id: 'frame:root' },
    { id: 'unrelated-arm', kind: 'branch-arm', parent_node_id: 'unrelated', frame_id: 'frame:root' },
  ];
  source.nodes = source.nodes.map((candidate) => candidate.id === 'inspect'
    ? { ...candidate, data: { ...candidate.data, group_id: 'route-arm' } }
    : candidate.id === 'unrelated'
      ? { ...candidate, data: { ...candidate.data, group_id: 'unrelated-arm' } }
      : candidate);
  const projection = computeRouteProjection(source, 'target', 'through');

  assert.ok(projection);
  const projected = projectRouteDocument(source, projection);
  assert.deepEqual(projected.nodes.map((candidate) => candidate.id).sort(), ['done', 'inspect', 'load', 'target', 'verify']);
  assert.deepEqual(projected.groups.map((candidate) => candidate.id), ['route-arm']);
  assert.deepEqual(projected.edges.map((candidate) => candidate.id).sort(), [
    'done-verify',
    'inspect-target',
    'load-inspect',
    'target-verify',
    'verify-done',
  ]);
});

test('projected directional view counts hidden dependencies without rendering empty connectors', () => {
  const source = document();
  const projection = computeRouteProjection(source, 'target', 'to');
  assert.ok(projection);
  assert.equal(projection.boundaryEdges.length, 1);

  const projected = projectRouteDocument(source, projection);
  assert.equal(projected.nodes.some((candidate) => candidate.data.kind === 'boundary'), false);
  assert.equal(projected.edges.some((candidate) => candidate.id.startsWith('route-boundary-edge:')), false);
});

test('projection retains required parallel siblings and their common join', () => {
  const source = {
    schema_version: '1', runbook: { id: 'parallel' }, frames: [],
    groups: [
      { id: 'arm-a', kind: 'parallel-branch', parent_node_id: 'parallel', frame_id: 'root' },
      { id: 'arm-b', kind: 'parallel-branch', parent_node_id: 'parallel', frame_id: 'root' },
    ],
    nodes: [
      { ...node('parallel'), data: { ...node('parallel').data, kind: 'parallel' } },
      { ...node('a'), parentNode: 'arm-a', data: { ...node('a').data, group_id: 'arm-a' } },
      { ...node('b'), parentNode: 'arm-b', data: { ...node('b').data, group_id: 'arm-b' } },
      node('after'),
    ],
    edges: [edge('p-a', 'parallel', 'a'), edge('p-b', 'parallel', 'b'), edge('p-after', 'parallel', 'after')],
  };
  const projection = computeRouteProjection(source, 'a', 'to');
  assert.ok(projection);
  assert.deepEqual([...projection.nodeIDs].sort(), ['a', 'after', 'b', 'parallel']);
  assert.ok(projection.edgeIDs.has('p-a'));
  assert.ok(projection.edgeIDs.has('p-b'));
  assert.ok(projection.edgeIDs.has('p-after'));

  const continuationProjection = computeRouteProjection(source, 'after', 'to');
  assert.ok(continuationProjection);
  assert.deepEqual([...continuationProjection.nodeIDs].sort(), ['a', 'after', 'b', 'parallel']);
});