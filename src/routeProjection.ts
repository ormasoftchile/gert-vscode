import type { GraphDocument, GraphGroup, GraphNode } from './directGraphPreview';

export type RouteProjectionScope = 'through' | 'to' | 'from';

export interface RouteBoundaryEdge {
  edgeID: string;
  visibleNodeID: string;
  hiddenNodeID: string;
  direction: 'incoming' | 'outgoing';
}

export interface RouteProjection {
  targetID: string;
  scope: RouteProjectionScope;
  nodeIDs: ReadonlySet<string>;
  edgeIDs: ReadonlySet<string>;
  predecessorCount: number;
  successorCount: number;
  hiddenNodeCount: number;
  boundaryEdges: RouteBoundaryEdge[];
}

export interface RouteProjectionIndex {
  knownNodeIDs: ReadonlySet<string>;
  outgoing: ReadonlyMap<string, readonly string[]>;
  incoming: ReadonlyMap<string, readonly string[]>;
  nodeByID: ReadonlyMap<string, GraphNode>;
  groupByID: ReadonlyMap<string, GraphGroup>;
}

export function buildRouteProjectionIndex(document: GraphDocument): RouteProjectionIndex {
  const knownNodeIDs = new Set(document.nodes.map((node) => node.id));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of document.edges) {
    if (!knownNodeIDs.has(edge.source) || !knownNodeIDs.has(edge.target)) continue;
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
  }
  return {
    knownNodeIDs,
    outgoing,
    incoming,
    nodeByID: new Map(document.nodes.map((node) => [node.id, node])),
    groupByID: new Map(document.groups.map((group) => [group.id, group])),
  };
}

function reachable(startID: string, adjacency: ReadonlyMap<string, readonly string[]>): Set<string> {
  const visited = new Set<string>();
  const pending = [...(adjacency.get(startID) ?? [])];
  while (pending.length > 0) {
    const nodeID = pending.pop()!;
    if (nodeID === startID || visited.has(nodeID)) continue;
    visited.add(nodeID);
    pending.push(...(adjacency.get(nodeID) ?? []));
  }
  return visited;
}

export function computeRouteProjection(
  document: GraphDocument,
  targetID: string,
  scope: RouteProjectionScope,
  index: RouteProjectionIndex = buildRouteProjectionIndex(document),
): RouteProjection | undefined {
  const { knownNodeIDs, outgoing, incoming, nodeByID, groupByID } = index;
  if (!knownNodeIDs.has(targetID)) return undefined;

  const predecessors = reachable(targetID, incoming);
  const successors = reachable(targetID, outgoing);
  const nodeIDs = new Set<string>([targetID]);
  if (scope !== 'from') predecessors.forEach((nodeID) => nodeIDs.add(nodeID));
  if (scope !== 'to') successors.forEach((nodeID) => nodeIDs.add(nodeID));

  const parallelBranchForNode = (nodeID: string): { ownerID: string; groupID: string } | undefined => {
    let groupID = typeof nodeByID.get(nodeID)?.data.group_id === 'string' ? String(nodeByID.get(nodeID)?.data.group_id) : '';
    const visited = new Set<string>();
    while (groupID && !visited.has(groupID)) {
      visited.add(groupID);
      const group = groupByID.get(groupID);
      if (!group) return undefined;
      if (group.kind === 'parallel-branch') return { ownerID: group.parent_node_id, groupID: group.id };
      const parent = nodeByID.get(group.parent_node_id);
      groupID = typeof parent?.data.group_id === 'string' ? parent.data.group_id : '';
    }
    return undefined;
  };
  const expandedParallelOwners = new Set<string>();
  while (true) {
    const parallelOwners = new Set<string>();
    for (const nodeID of nodeIDs) {
      if (nodeByID.get(nodeID)?.data.kind === 'parallel') parallelOwners.add(nodeID);
      const branch = parallelBranchForNode(nodeID);
      if (branch) parallelOwners.add(branch.ownerID);
    }
    const ownerID = [...parallelOwners].find((candidate) => !expandedParallelOwners.has(candidate));
    if (!ownerID) break;
    expandedParallelOwners.add(ownerID);
    nodeIDs.add(ownerID);
    const branchGroups = new Set(document.groups.filter((group) => group.kind === 'parallel-branch' && group.parent_node_id === ownerID).map((group) => group.id));
    for (const node of document.nodes) {
      const branch = parallelBranchForNode(node.id);
      if (branch?.ownerID === ownerID) nodeIDs.add(node.id);
    }
    for (const edge of document.edges) {
      if (edge.source !== ownerID) continue;
      const targetBranch = parallelBranchForNode(edge.target);
      if (targetBranch?.ownerID !== ownerID) nodeIDs.add(edge.target);
    }
    const joinSources = new Map<string, Set<string>>();
    for (const edge of document.edges) {
      const sourceBranch = parallelBranchForNode(edge.source);
      const targetBranch = parallelBranchForNode(edge.target);
      if (sourceBranch?.ownerID !== ownerID || targetBranch?.ownerID === ownerID) continue;
      const sources = joinSources.get(edge.target) ?? new Set<string>();
      sources.add(sourceBranch.groupID);
      joinSources.set(edge.target, sources);
    }
    for (const [joinID, sourceGroups] of joinSources) {
      if (sourceGroups.size === branchGroups.size && branchGroups.size > 0) nodeIDs.add(joinID);
    }
  }

  const edgeIDs = new Set<string>();
  const boundaryEdges: RouteBoundaryEdge[] = [];
  for (const edge of document.edges) {
    if (!knownNodeIDs.has(edge.source) || !knownNodeIDs.has(edge.target)) continue;
    const sourceVisible = nodeIDs.has(edge.source);
    const targetVisible = nodeIDs.has(edge.target);
    if (sourceVisible && targetVisible) {
      edgeIDs.add(edge.id);
    } else if (sourceVisible && !targetVisible) {
      boundaryEdges.push({
        edgeID: edge.id,
        visibleNodeID: edge.source,
        hiddenNodeID: edge.target,
        direction: 'outgoing',
      });
    } else if (!sourceVisible && targetVisible) {
      boundaryEdges.push({
        edgeID: edge.id,
        visibleNodeID: edge.target,
        hiddenNodeID: edge.source,
        direction: 'incoming',
      });
    }
  }

  return {
    targetID,
    scope,
    nodeIDs,
    edgeIDs,
    predecessorCount: [...predecessors].filter((nodeID) => nodeByID.get(nodeID)?.data.synthetic !== true).length,
    successorCount: [...successors].filter((nodeID) => nodeByID.get(nodeID)?.data.synthetic !== true).length,
    hiddenNodeCount: document.nodes.filter((node) => node.data.synthetic !== true && !nodeIDs.has(node.id)).length,
    boundaryEdges,
  };
}

export function projectRouteDocument(
  document: GraphDocument,
  projection: RouteProjection,
): GraphDocument {
  const nodes = document.nodes.filter((node) => projection.nodeIDs.has(node.id));
  const nodeByID = new Map(document.nodes.map((node) => [node.id, node]));
  const groupByID = new Map(document.groups.map((group) => [group.id, group]));
  const groupIDs = new Set<string>();
  const retainGroup = (groupID: string): void => {
    if (!groupID || groupIDs.has(groupID)) return;
    const group = groupByID.get(groupID);
    if (!group) return;
    groupIDs.add(groupID);
    const parentNode = nodeByID.get(group.parent_node_id);
    retainGroup(typeof parentNode?.data.group_id === 'string' ? parentNode.data.group_id : '');
  };
  for (const node of nodes) {
    retainGroup(typeof node.data.group_id === 'string' ? node.data.group_id : '');
  }

  const groups = document.groups.filter((group) => groupIDs.has(group.id));
  const frameIDs = new Set<string>();
  for (const node of nodes) {
    if (typeof node.data.frame_id === 'string' && node.data.frame_id) frameIDs.add(node.data.frame_id);
  }
  for (const group of groups) {
    if (group.frame_id) frameIDs.add(group.frame_id);
  }

  return {
    ...document,
    nodes,
    edges: document.edges.filter((edge) => projection.edgeIDs.has(edge.id)),
    groups,
    frames: document.frames.filter((frame) => frameIDs.has(frame.id)),
  };
}