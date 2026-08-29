import { parseStepDetails, type StepDetails } from './stepDetails';

export interface GraphRunbookRef {
  id?: string;
  name?: string;
  path?: string;
}

export interface GraphNodeData {
  id?: string;
  kind?: string;
  title?: string;
  status?: string;
  tool_name?: string;
  tool_action?: string;
  details?: StepDetails;
  [key: string]: unknown;
}

export interface GraphNode {
  id: string;
  type?: string;
  data: GraphNodeData;
  parentNode?: string;
  extent?: 'parent';
  position: { x: number; y: number };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  label?: string;
  routeKind?: 'arm-entry' | 'arm-exit' | 'empty-arm' | 'no-match';
  runtimeNodeID?: string;
  runtimeExpectedStatus?: string;
  runtimeArmIndex?: number;
  runtimeArmLabel?: string;
  runtimeFallbackNodeID?: string;
}

export interface GraphFrame {
  id: string;
  runbook_id: string;
  runbook_path: string;
  parent_include_node_id?: string;
  depth: number;
}

export interface GraphGroup {
  id: string;
  kind: string;
  parent_node_id: string;
  frame_id: string;
  label?: string;
  index?: number;
  fallback?: boolean;
}

export interface GraphDocument {
  schema_version: '1';
  hash?: string;
  runbook: GraphRunbookRef;
  nodes: GraphNode[];
  edges: GraphEdge[];
  frames: GraphFrame[];
  groups: GraphGroup[];
  regions?: unknown;
  inputs?: unknown[];
}

export function graphPreviewArgs(runbookPath: string): string[] {
  return ['preview', '--format', 'graphjson', '--recurse', runbookPath];
}

export type GraphPreviewExecutor = (
  binary: string,
  args: string[],
) => Promise<{ stdout: string }>;

export async function loadGraphDocument(
  binary: string,
  runbookPath: string,
  execute: GraphPreviewExecutor,
): Promise<GraphDocument> {
  const { stdout } = await execute(binary, graphPreviewArgs(runbookPath));
  return parseGraphDocument(stdout);
}

export function parseGraphDocument(stdout: string): GraphDocument {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('gert preview did not return valid JSON');
  }
  const document = plainObject(value, 'gert preview graph document');
  if (document.schema_version !== '1') {
    throw new Error(`unsupported graph schema_version ${JSON.stringify(document.schema_version)}`);
  }
  if (!Array.isArray(document.nodes)) {
    throw new Error('gert preview graph document nodes must be an array');
  }
  if (!Array.isArray(document.edges)) {
    throw new Error('gert preview graph document edges must be an array');
  }
  if (!Array.isArray(document.frames)) {
    throw new Error('gert preview graph document frames must be an array');
  }
  if (!Array.isArray(document.groups)) {
    throw new Error('gert preview graph document groups must be an array');
  }

  const runbook = plainObject(document.runbook, 'graph runbook');
  requiredString(runbook, 'id', 'runbook.id');
  requiredString(runbook, 'name', 'runbook.name');
  optionalString(runbook, 'path', 'runbook.path');

  const frameIDs = new Set<string>();
  const frames = document.frames.map((value, index) => {
    const frame = plainObject(value, `frame ${index}`);
    const id = requiredString(frame, 'id', 'frame id');
    if (frameIDs.has(id)) throw new Error(`duplicate frame id ${JSON.stringify(id)}`);
    frameIDs.add(id);
    requiredString(frame, 'runbook_id', `frame ${id} runbook_id`);
    requiredString(frame, 'runbook_path', `frame ${id} runbook_path`);
    optionalString(frame, 'parent_include_node_id', `frame ${id} parent_include_node_id`);
    if (!Number.isInteger(frame.depth) || (frame.depth as number) < 0) {
      throw new Error(`frame ${id} depth must be a non-negative integer`);
    }
    return frame;
  });

  const nodeIDs = new Set<string>();
  const nodes = document.nodes.map((value, index) => {
    const node = plainObject(value, `node ${index}`);
    const id = requiredString(node, 'id', 'node id');
    if (nodeIDs.has(id)) throw new Error(`duplicate node id ${JSON.stringify(id)}`);
    nodeIDs.add(id);
    optionalString(node, 'type', `node ${id} type`);
    const data = plainObject(node.data, `node ${id} data`);
    const dataID = requiredString(data, 'id', `node ${id} data.id`);
    if (dataID !== id) throw new Error(`node ${id} data.id must match its node id`);
    const kind = requiredString(data, 'kind', `node ${id} data.kind`);
    optionalString(data, 'title', `node ${id} data.title`);
    optionalString(data, 'status', `node ${id} data.status`);
    optionalString(data, 'tool_name', `node ${id} data.tool_name`);
    optionalString(data, 'tool_action', `node ${id} data.tool_action`);
    if (data.details !== undefined) {
      data.details = parseStepDetails(data.details, kind, `node ${id} data`);
    }
    optionalString(data, 'group_id', `node ${id} data.group_id`);
    optionalString(data, 'frame_id', `node ${id} data.frame_id`);
    const position = plainObject(node.position, `node ${id} position`);
    if (!finiteNumber(position.x) || !finiteNumber(position.y)) {
      throw new Error(`node ${id} position x and y must be finite numbers`);
    }
    optionalString(node, 'parentNode', `node ${id} parentNode`);
    if (node.extent !== undefined && node.extent !== 'parent') {
      throw new Error(`node ${id} extent must be "parent" when present`);
    }
    return node;
  });

  const groupIDs = new Set<string>();
  const groups = document.groups.map((value, index) => {
    const group = plainObject(value, `group ${index}`);
    const id = requiredString(group, 'id', 'group id');
    if (groupIDs.has(id)) throw new Error(`duplicate group id ${JSON.stringify(id)}`);
    if (nodeIDs.has(id)) throw new Error(`group id ${JSON.stringify(id)} collides with node id`);
    groupIDs.add(id);
    requiredString(group, 'kind', `group ${id} kind`);
    const parentNodeID = optionalString(group, 'parent_node_id', `group ${id} parent_node_id`);
    const frameID = requiredString(group, 'frame_id', `group ${id} frame_id`);
    optionalString(group, 'label', `group ${id} label`);
    if (group.index !== undefined && (!Number.isInteger(group.index) || (group.index as number) < 0)) {
      throw new Error(`group ${id} index must be a non-negative integer`);
    }
    if (group.fallback !== undefined && typeof group.fallback !== 'boolean') {
      throw new Error(`group ${id} fallback must be a boolean`);
    }
    if (parentNodeID && !nodeIDs.has(parentNodeID)) {
      throw new Error(`group ${id} parent node ${JSON.stringify(parentNodeID)} is unknown`);
    }
    if (frameIDs.size > 0 && !frameIDs.has(frameID)) {
      throw new Error(`group ${id} frame ${JSON.stringify(frameID)} is unknown`);
    }
    return group;
  });

  for (const frame of frames) {
    const parent = frame.parent_include_node_id;
    if (typeof parent === 'string' && parent && !nodeIDs.has(parent)) {
      throw new Error(`frame ${String(frame.id)} parent include node ${JSON.stringify(parent)} is unknown`);
    }
  }

  for (const node of nodes) {
    const id = String(node.id);
    const data = node.data as Record<string, unknown>;
    const groupID = typeof data.group_id === 'string' ? data.group_id : '';
    const parentNode = typeof node.parentNode === 'string' ? node.parentNode : '';
    if (groupID && !groupIDs.has(groupID)) {
      throw new Error(`node ${id} references unknown group ${JSON.stringify(groupID)}`);
    }
    if (parentNode && !groupIDs.has(parentNode)) {
      throw new Error(`node ${id} parentNode references unknown group ${JSON.stringify(parentNode)}`);
    }
    if (parentNode !== groupID) {
      throw new Error(`node ${id} parentNode must match data.group_id`);
    }
    const frameID = typeof data.frame_id === 'string' ? data.frame_id : '';
    if (frameID && frameIDs.size > 0 && !frameIDs.has(frameID)) {
      throw new Error(`node ${id} references unknown frame ${JSON.stringify(frameID)}`);
    }
  }

  const nodeByID = new Map(nodes.map((node) => [String(node.id), node]));
  const parentByGroup = new Map<string, string>();
  for (const group of groups) {
    const parentNodeID = typeof group.parent_node_id === 'string' ? group.parent_node_id : '';
    const parentNode = parentNodeID ? nodeByID.get(parentNodeID) : undefined;
    const parentData = parentNode ? parentNode.data as Record<string, unknown> : undefined;
    parentByGroup.set(String(group.id), typeof parentData?.group_id === 'string' ? parentData.group_id : '');
  }
  for (const groupID of groupIDs) {
    const visited = new Set<string>([groupID]);
    let parentID = parentByGroup.get(groupID) ?? '';
    while (parentID) {
      if (visited.has(parentID)) {
        throw new Error(`group ownership cycle detected at ${JSON.stringify(parentID)}`);
      }
      visited.add(parentID);
      parentID = parentByGroup.get(parentID) ?? '';
    }
  }

  const edgeIDs = new Set<string>();
  for (const edge of document.edges) {
    const candidate = plainObject(edge, 'graph edge');
    const id = requiredString(candidate, 'id', 'edge id');
    if (edgeIDs.has(id)) throw new Error(`duplicate edge id ${JSON.stringify(id)}`);
    edgeIDs.add(id);
    const source = requiredString(candidate, 'source', `edge ${id} source`);
    const target = requiredString(candidate, 'target', `edge ${id} target`);
    optionalString(candidate, 'type', `edge ${id} type`);
    optionalString(candidate, 'label', `edge ${id} label`);
    if (!nodeIDs.has(source)) throw new Error(`edge ${id} references unknown source ${JSON.stringify(source)}`);
    if (!nodeIDs.has(target)) throw new Error(`edge ${id} references unknown target ${JSON.stringify(target)}`);
  }

  return value as GraphDocument;
}

export function graphMayRequireMcpBridge(
  document: GraphDocument,
  vscodeMcpActions: Readonly<Record<string, unknown>>,
): boolean {
  return document.nodes.some((node) => {
    const kind = node.data.kind;
    if (kind === 'include' && node.data.dynamic === true) return true;
    if (kind !== 'tool') return false;
    const toolName = node.data.tool_name;
    const toolAction = node.data.tool_action;
    if (!toolName || !toolAction) return true;
    return `${toolName}/${toolAction}` in vscodeMcpActions;
  });
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function createDirectGraphWebviewHtml(
  scriptUri: string,
  styleUri: string,
  cspSource: string,
  nonce: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource}; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>gert runbook graph</title>
</head>
<body>
  <div id="root" role="application" aria-label="Runbook graph"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}