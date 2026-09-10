"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateSessionPresentationBinding = validateSessionPresentationBinding;
exports.graphPreviewArgs = graphPreviewArgs;
exports.loadGraphDocument = loadGraphDocument;
exports.parseGraphDocument = parseGraphDocument;
exports.graphMayRequireMcpBridge = graphMayRequireMcpBridge;
exports.sessionMayRequireMcpBridge = sessionMayRequireMcpBridge;
exports.createDirectGraphWebviewHtml = createDirectGraphWebviewHtml;
const stepDetails_1 = require("./stepDetails");
const displayPresentationJSON_1 = require("./displayPresentationJSON");
const presentationHistory_1 = require("./presentationHistory");
function parseInvocation(value) {
    const object = plainObject(value, 'frame invocation');
    const closed = (v, keys) => {
        if (Object.keys(v).some(key => !keys.includes(key)))
            throw new Error('unknown invocation field');
    };
    closed(object, ['bindings', 'outputs', 'results']);
    if (object.results !== undefined && typeof object.results !== 'boolean')
        throw new Error('invalid invocation results');
    if (object.bindings !== undefined) {
        if (!Array.isArray(object.bindings))
            throw new Error('invalid invocation bindings');
        const names = new Set();
        for (const raw of object.bindings) {
            const binding = plainObject(raw, 'invocation binding');
            closed(binding, ['name', 'type', 'mutable', 'value', 'value_present', 'enum']);
            const name = requiredString(binding, 'name', 'binding name');
            requiredString(binding, 'type', 'binding type');
            if (names.has(name) || !Object.hasOwn(binding, 'value') || typeof binding.value_present !== 'boolean' ||
                binding.mutable !== undefined && typeof binding.mutable !== 'boolean')
                throw new Error('invalid invocation binding');
            names.add(name);
        }
    }
    if (object.outputs !== undefined) {
        for (const [name, raw] of Object.entries(plainObject(object.outputs, 'invocation outputs'))) {
            if (!name)
                throw new Error('invalid invocation output name');
            const output = plainObject(raw, 'invocation output');
            closed(output, ['type', 'description', 'value', 'value_expr', 'value_tree', 'value_tree_present', 'optional', 'enum']);
            requiredString(output, 'type', 'output type');
            for (const key of ['description', 'value', 'value_expr'])
                optionalString(output, key, `output ${key}`);
            for (const key of ['value_tree_present', 'optional']) {
                if (output[key] !== undefined && typeof output[key] !== 'boolean')
                    throw new Error('invalid output presence');
            }
            if (Object.hasOwn(output, 'value_tree') && output.value_tree_present !== true)
                throw new Error('invalid output tree presence');
            // Go omits a nil value_tree; its presence bit still denotes authored null.
            if (output.value_tree_present === true && !Object.hasOwn(output, 'value_tree'))
                output.value_tree = null;
        }
    }
    return object;
}
function validateSessionPresentationBinding(document, snapshotDigest) {
    const envelopes = document.nodes.flatMap(node => node.data.details?.code_presentation ? [node.data.details.code_presentation] : []);
    if (document.display_plan_snapshot_digest !== undefined &&
        (typeof document.display_plan_snapshot_digest !== 'string' || document.display_plan_snapshot_digest.length !== 71 ||
            !/^sha256:[a-f0-9]{64}$/.test(document.display_plan_snapshot_digest))) {
        throw new Error('session graph display snapshot binding is invalid');
    }
    if (!envelopes.length && !document.presentation_state && document.display_plan_snapshot_digest === undefined)
        return;
    if (!snapshotDigest || !/^sha256:[a-f0-9]{64}$/.test(snapshotDigest) ||
        document.execution_plan_hash !== snapshotDigest ||
        envelopes.some(envelope => envelope.origin !== 'frozen' || envelope.plan_snapshot_digest !== snapshotDigest) ||
        (document.presentation_state !== undefined && document.presentation_state.plan_snapshot_digest !== snapshotDigest)) {
        throw new Error('session graph presentation does not match its frozen execution-plan binding');
    }
}
function graphPreviewArgs(runbookPath, packageMapPath) {
    return ['preview', '--format', 'graphjson', '--recurse',
        ...(packageMapPath ? ['--package-map', packageMapPath] : []), runbookPath];
}
async function loadGraphDocument(binary, runbookPath, execute, packageMapPath) {
    const { stdout } = await execute(binary, graphPreviewArgs(runbookPath, packageMapPath));
    return parseGraphDocument(stdout);
}
function parseGraphDocument(stdout) {
    let value;
    try {
        value = (0, displayPresentationJSON_1.parseDisplayJSON)(stdout);
    }
    catch {
        throw new Error('gert preview did not return valid JSON');
    }
    const document = plainObject(value, 'gert preview graph document');
    if (document.presentation_state !== undefined)
        document.presentation_state = (0, presentationHistory_1.decodePresentationState)(document.presentation_state);
    if (document.schema_version !== '1' && document.schema_version !== '3') {
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
    const frameIDs = new Set();
    const frames = document.frames.map((value, index) => {
        const frame = plainObject(value, `frame ${index}`);
        const id = requiredString(frame, 'id', 'frame id');
        if (frameIDs.has(id))
            throw new Error(`duplicate frame id ${JSON.stringify(id)}`);
        frameIDs.add(id);
        requiredString(frame, 'runbook_id', `frame ${id} runbook_id`);
        requiredString(frame, 'runbook_path', `frame ${id} runbook_path`);
        optionalString(frame, 'parent_include_node_id', `frame ${id} parent_include_node_id`);
        if (!Number.isInteger(frame.depth) || frame.depth < 0) {
            throw new Error(`frame ${id} depth must be a non-negative integer`);
        }
        if (frame.invocation !== undefined) {
            if (document.schema_version !== '3')
                throw new Error('invocation requires graph v3');
            frame.invocation = parseInvocation(frame.invocation);
        }
        return frame;
    });
    const nodeIDs = new Set();
    const nodes = document.nodes.map((value, index) => {
        const node = plainObject(value, `node ${index}`);
        const id = requiredString(node, 'id', 'node id');
        if (nodeIDs.has(id))
            throw new Error(`duplicate node id ${JSON.stringify(id)}`);
        nodeIDs.add(id);
        optionalString(node, 'type', `node ${id} type`);
        const data = plainObject(node.data, `node ${id} data`);
        const dataID = requiredString(data, 'id', `node ${id} data.id`);
        if (dataID !== id)
            throw new Error(`node ${id} data.id must match its node id`);
        const kind = requiredString(data, 'kind', `node ${id} data.kind`);
        optionalString(data, 'title', `node ${id} data.title`);
        optionalString(data, 'status', `node ${id} data.status`);
        optionalString(data, 'tool_name', `node ${id} data.tool_name`);
        optionalString(data, 'tool_action', `node ${id} data.tool_action`);
        if (data.details !== undefined) {
            data.details = (0, stepDetails_1.parseStepDetails)(data.details, kind, `node ${id} data`, document.schema_version === '3');
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
    const groupIDs = new Set();
    const groups = document.groups.map((value, index) => {
        const group = plainObject(value, `group ${index}`);
        const id = requiredString(group, 'id', 'group id');
        if (groupIDs.has(id))
            throw new Error(`duplicate group id ${JSON.stringify(id)}`);
        if (nodeIDs.has(id))
            throw new Error(`group id ${JSON.stringify(id)} collides with node id`);
        groupIDs.add(id);
        requiredString(group, 'kind', `group ${id} kind`);
        const parentNodeID = optionalString(group, 'parent_node_id', `group ${id} parent_node_id`);
        const frameID = requiredString(group, 'frame_id', `group ${id} frame_id`);
        optionalString(group, 'label', `group ${id} label`);
        if (group.index !== undefined && (!Number.isInteger(group.index) || group.index < 0)) {
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
        const data = node.data;
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
    const parentByGroup = new Map();
    for (const group of groups) {
        const parentNodeID = typeof group.parent_node_id === 'string' ? group.parent_node_id : '';
        const parentNode = parentNodeID ? nodeByID.get(parentNodeID) : undefined;
        const parentData = parentNode ? parentNode.data : undefined;
        parentByGroup.set(String(group.id), typeof parentData?.group_id === 'string' ? parentData.group_id : '');
    }
    for (const groupID of groupIDs) {
        const visited = new Set([groupID]);
        let parentID = parentByGroup.get(groupID) ?? '';
        while (parentID) {
            if (visited.has(parentID)) {
                throw new Error(`group ownership cycle detected at ${JSON.stringify(parentID)}`);
            }
            visited.add(parentID);
            parentID = parentByGroup.get(parentID) ?? '';
        }
    }
    const edgeIDs = new Set();
    for (const edge of document.edges) {
        const candidate = plainObject(edge, 'graph edge');
        const id = requiredString(candidate, 'id', 'edge id');
        if (edgeIDs.has(id))
            throw new Error(`duplicate edge id ${JSON.stringify(id)}`);
        edgeIDs.add(id);
        const source = requiredString(candidate, 'source', `edge ${id} source`);
        const target = requiredString(candidate, 'target', `edge ${id} target`);
        optionalString(candidate, 'type', `edge ${id} type`);
        optionalString(candidate, 'label', `edge ${id} label`);
        if (!nodeIDs.has(source))
            throw new Error(`edge ${id} references unknown source ${JSON.stringify(source)}`);
        if (!nodeIDs.has(target))
            throw new Error(`edge ${id} references unknown target ${JSON.stringify(target)}`);
    }
    if (document.execution_plan_hash !== undefined) {
        validateSessionPresentationBinding(value, document.execution_plan_hash);
    }
    return value;
}
function graphMayRequireMcpBridge(document, vscodeMcpActions) {
    return document.nodes.some((node) => {
        const kind = node.data.kind;
        if (kind === 'include' && node.data.dynamic === true)
            return true;
        if (kind !== 'tool')
            return false;
        const toolName = node.data.tool_name;
        const toolAction = node.data.tool_action;
        if (!toolName || !toolAction)
            return true;
        return `${toolName}/${toolAction}` in vscodeMcpActions;
    });
}
function sessionMayRequireMcpBridge(entryDocument, vscodeMcpActions) {
    return Object.keys(vscodeMcpActions).length > 0 ||
        graphMayRequireMcpBridge(entryDocument, vscodeMcpActions);
}
function plainObject(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value;
}
function requiredString(record, key, label) {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${label} must be a non-empty string`);
    }
    return value;
}
function optionalString(record, key, label) {
    const value = record[key];
    if (value === undefined)
        return '';
    if (typeof value !== 'string')
        throw new Error(`${label} must be a string`);
    return value;
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function createDirectGraphWebviewHtml(scriptUri, styleUri, cspSource, nonce, highlightingWorkerUri = '', highlightingEnabled = true) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource}; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ${cspSource}; worker-src blob:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>gert runbook graph</title>
</head>
<body data-highlighting-worker="${highlightingWorkerUri}" data-highlighting-enabled="${highlightingEnabled}">
  <div id="root" role="application" aria-label="Runbook graph"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
//# sourceMappingURL=directGraphPreview.js.map