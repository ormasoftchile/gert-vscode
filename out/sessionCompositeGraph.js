"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionGraphModel = void 0;
exports.sessionGraphNodeID = sessionGraphNodeID;
exports.sessionGraphEntryNodeID = sessionGraphEntryNodeID;
exports.composeSessionGraph = composeSessionGraph;
exports.sessionGraphTopologyKey = sessionGraphTopologyKey;
exports.parseSessionManifest = parseSessionManifest;
exports.parseSessionSegment = parseSessionSegment;
exports.parseSessionAttempt = parseSessionAttempt;
exports.validateSessionSegmentGraphBinding = validateSessionSegmentGraphBinding;
const presentationProjection_1 = require("./presentationProjection");
const executionProgress_1 = require("./executionProgress");
const displayPresentation_1 = require("./displayPresentation");
const displayObservations_1 = require("./displayObservations");
const directGraphPreview_1 = require("./directGraphPreview");
function scopedID(sessionID, segmentID, kind, localID) {
    return [
        `session:${encodeURIComponent(sessionID)}`,
        `segment:${encodeURIComponent(segmentID)}`,
        `${kind}:${encodeURIComponent(localID)}`,
    ].join('/');
}
function sessionGraphNodeID(sessionID, segmentID, nodeID) {
    return scopedID(sessionID, segmentID, 'node', nodeID);
}
function sessionGraphEntryNodeID(sessionID, segmentID) {
    return scopedID(sessionID, segmentID, 'entry', '$entry');
}
function sessionSegmentGroupID(sessionID, segmentID) {
    return `session:${encodeURIComponent(sessionID)}/segment:${encodeURIComponent(segmentID)}/segment-group`;
}
function segmentAttempt(manifest, segment) {
    const attempts = segment.attempt_run_ids
        .map((runID) => manifest.attempts[runID])
        .filter((attempt) => attempt !== undefined)
        .sort((left, right) => right.ordinal - left.ordinal || right.run_id.localeCompare(left.run_id));
    if (manifest.session.active_run_id) {
        const active = attempts.find((attempt) => attempt.run_id === manifest.session.active_run_id);
        if (active)
            return active;
    }
    return attempts[0];
}
function namespaceFrame(sessionID, segmentID, frame) {
    return {
        ...frame,
        id: scopedID(sessionID, segmentID, 'frame', frame.id),
        ...(frame.parent_include_node_id
            ? { parent_include_node_id: sessionGraphNodeID(sessionID, segmentID, frame.parent_include_node_id) }
            : {}),
    };
}
function namespaceGroup(sessionID, segmentID, group) {
    return {
        ...group,
        id: scopedID(sessionID, segmentID, 'group', group.id),
        parent_node_id: group.parent_node_id
            ? sessionGraphNodeID(sessionID, segmentID, group.parent_node_id)
            : '',
        frame_id: scopedID(sessionID, segmentID, 'frame', group.frame_id),
    };
}
function namespaceNode(sessionID, segment, attempt, node, graphRevisions, incomingTransitions, outgoingTransitions, graphRevision = segment.graph_revision, graphHash = segment.graph_hash, displaySnapshotDigest) {
    const id = sessionGraphNodeID(sessionID, segment.segment_id, node.id);
    const sourceGroupID = typeof node.data.group_id === 'string' ? node.data.group_id : '';
    const groupID = sourceGroupID
        ? scopedID(sessionID, segment.segment_id, 'group', sourceGroupID)
        : sessionSegmentGroupID(sessionID, segment.segment_id);
    const frameID = typeof node.data.frame_id === 'string' && node.data.frame_id
        ? scopedID(sessionID, segment.segment_id, 'frame', node.data.frame_id)
        : '';
    return {
        ...node,
        id,
        data: {
            ...node.data,
            id,
            original_node_id: node.id,
            session_id: sessionID,
            segment_id: segment.segment_id,
            segment_ordinal: segment.ordinal,
            segment_status: segment.status,
            run_id: attempt?.run_id,
            attempt_status: attempt?.status,
            execution_source: attempt?.mode === 'replay' || attempt?.mode === 'route-test' ? 'saved' : 'live',
            runbook_id: segment.runbook_id,
            runbook_name: segment.runbook_name,
            graph_revision: graphRevision,
            graph_hash: graphHash,
            executable_revision: segment.executable_revision,
            plan_hash: segment.plan_hash,
            executable_snapshot_hash: segment.executable_snapshot_hash,
            ...(displaySnapshotDigest ? { display_plan_snapshot_digest: displaySnapshotDigest } : {}),
            catalog_digest: segment.catalog_digest,
            package_lock_digest: segment.package_lock_digest,
            profile_digest: segment.profile_digest,
            available_graph_revisions: [...graphRevisions],
            incoming_transitions: incomingTransitions,
            outgoing_transitions: outgoingTransitions,
            graph_loaded: true,
            group_id: groupID,
            frame_id: frameID,
        },
        parentNode: node.parentNode
            ? scopedID(sessionID, segment.segment_id, 'group', node.parentNode)
            : sessionSegmentGroupID(sessionID, segment.segment_id),
        extent: 'parent',
    };
}
function namespaceEdge(sessionID, segmentID, edge) {
    return {
        ...edge,
        id: scopedID(sessionID, segmentID, 'edge', edge.id),
        source: sessionGraphNodeID(sessionID, segmentID, edge.source),
        target: sessionGraphNodeID(sessionID, segmentID, edge.target),
        ...(edge.runtimeNodeID
            ? { runtimeNodeID: sessionGraphNodeID(sessionID, segmentID, edge.runtimeNodeID) }
            : {}),
        ...(edge.runtimeFallbackNodeID
            ? { runtimeFallbackNodeID: sessionGraphNodeID(sessionID, segmentID, edge.runtimeFallbackNodeID) }
            : {}),
    };
}
function entryNodeIDs(segment, graph) {
    const selector = segment.entry_selector?.step;
    if (selector && selector !== '$entry') {
        const exact = graph.nodes.filter((node) => node.id === selector);
        const selected = exact.length > 0
            ? exact
            : graph.nodes.filter((node) => node.data.step_id === selector);
        if (selected.length !== 1) {
            throw new Error(`segment ${JSON.stringify(segment.segment_id)} entry selector is unresolved or ambiguous`);
        }
        return [selected[0].id];
    }
    const incoming = new Set(graph.edges.map((edge) => edge.target));
    const roots = graph.nodes
        .filter((node) => !incoming.has(node.id) && node.data.synthetic !== true)
        .map((node) => node.id)
        .sort();
    if (roots.length === 0 && graph.nodes.some((node) => node.data.synthetic !== true)) {
        throw new Error(`segment ${JSON.stringify(segment.segment_id)} has no structural entry node`);
    }
    return roots;
}
function sourceNodeID(transition, graph) {
    const qualifiedID = transition.source_occurrence.qualified_node_id;
    const exact = graph.nodes.filter((node) => node.id === qualifiedID);
    if (exact.length === 1)
        return exact[0].id;
    throw new Error(`committed transition source ${JSON.stringify(qualifiedID)} is unresolved`);
}
function composeSessionGraph(request) {
    const { sessionID, manifest, segmentGraphs, segmentGraphRevisions } = request;
    if (!sessionID || manifest.session.session_id !== sessionID) {
        throw new Error('session graph manifest does not match the requested session');
    }
    const nodes = [];
    const edges = [];
    const frames = [];
    const groups = [];
    const segments = Object.values(manifest.segments)
        .sort((left, right) => left.ordinal - right.ordinal || left.segment_id.localeCompare(right.segment_id));
    for (const segment of segments) {
        if (segment.segment_id === '')
            continue;
        const graph = segmentGraphs.get(segment.segment_id);
        const attempt = segmentAttempt(manifest, segment);
        const graphRevisions = segmentGraphRevisions?.get(segment.segment_id) ??
            (segment.graph_revision ? [segment.graph_revision] : []);
        const incomingTransitions = transitionProvenance(manifest, segment.segment_id, 'incoming');
        const outgoingTransitions = transitionProvenance(manifest, segment.segment_id, 'outgoing');
        const rootFrame = graph?.frames
            .filter((frame) => frame.depth === 0)
            .sort((left, right) => left.id.localeCompare(right.id))[0] ?? graph?.frames[0];
        groups.push({
            id: sessionSegmentGroupID(sessionID, segment.segment_id),
            kind: 'session-segment',
            parent_node_id: '',
            frame_id: rootFrame ? scopedID(sessionID, segment.segment_id, 'frame', rootFrame.id) : '',
            label: `${segment.ordinal} | ${segment.runbook_name || segment.runbook_id}`,
            index: segment.ordinal,
            segment_id: segment.segment_id,
            segment_status: segment.status,
            graph_loaded: graph !== undefined,
            ...(attempt ? { run_id: attempt.run_id } : {}),
        });
        const entryID = sessionGraphEntryNodeID(sessionID, segment.segment_id);
        nodes.push({
            id: entryID,
            type: 'sessionEntry',
            data: {
                id: entryID,
                kind: 'session-entry',
                title: `${segment.runbook_name || segment.runbook_id} entry`,
                synthetic: true,
                session_id: sessionID,
                segment_id: segment.segment_id,
                segment_ordinal: segment.ordinal,
                segment_status: segment.status,
                run_id: attempt?.run_id,
                runbook_id: segment.runbook_id,
                runbook_name: segment.runbook_name,
                graph_revision: segment.graph_revision,
                graph_hash: segment.graph_hash,
                available_graph_revisions: [...graphRevisions],
                incoming_transitions: incomingTransitions,
                outgoing_transitions: outgoingTransitions,
                graph_loaded: graph !== undefined,
                group_id: sessionSegmentGroupID(sessionID, segment.segment_id),
                frame_id: rootFrame ? scopedID(sessionID, segment.segment_id, 'frame', rootFrame.id) : '',
            },
            parentNode: sessionSegmentGroupID(sessionID, segment.segment_id),
            extent: 'parent',
            position: { x: 0, y: 0 },
        });
        for (const rootID of graph ? entryNodeIDs(segment, graph) : []) {
            edges.push({
                id: scopedID(sessionID, segment.segment_id, 'entry-edge', rootID),
                source: entryID,
                target: sessionGraphNodeID(sessionID, segment.segment_id, rootID),
                type: 'session-entry',
            });
        }
        if (graph) {
            nodes.push(...graph.nodes.map((node) => namespaceNode(sessionID, segment, attempt, node, graphRevisions, incomingTransitions, outgoingTransitions, segment.graph_revision, segment.graph_hash, graph.display_plan_snapshot_digest)));
            edges.push(...graph.edges.map((edge) => namespaceEdge(sessionID, segment.segment_id, edge)));
            frames.push(...graph.frames.map((frame) => namespaceFrame(sessionID, segment.segment_id, frame)));
            groups.push(...graph.groups.map((group) => namespaceGroup(sessionID, segment.segment_id, group)));
        }
    }
    const transitions = Object.values(manifest.transitions ?? {})
        .filter((transition) => transition.status === 'committed')
        .sort((left, right) => left.transition_id.localeCompare(right.transition_id));
    for (const transition of transitions) {
        const sourceGraph = segmentGraphs.get(transition.source_segment_id);
        const targetSegment = manifest.segments[transition.target_segment_id];
        if (!targetSegment)
            continue;
        const source = sourceGraph
            ? sourceNodeID(transition, sourceGraph)
            : transition.source_occurrence.qualified_node_id;
        const sourceCompositeID = sessionGraphNodeID(sessionID, transition.source_segment_id, source);
        if (!nodes.some((node) => node.id === sourceCompositeID)) {
            const sourceSegment = manifest.segments[transition.source_segment_id];
            if (!sourceSegment)
                throw new Error('committed transition source segment is unavailable');
            nodes.push({
                id: sourceCompositeID,
                type: 'gertStep',
                data: {
                    id: sourceCompositeID,
                    original_node_id: source,
                    step_id: transition.source_occurrence.step,
                    kind: 'session-history-placeholder',
                    title: transition.source_occurrence.step,
                    session_id: sessionID,
                    segment_id: sourceSegment.segment_id,
                    segment_ordinal: sourceSegment.ordinal,
                    segment_status: sourceSegment.status,
                    graph_loaded: false,
                    group_id: sessionSegmentGroupID(sessionID, sourceSegment.segment_id),
                    incoming_transitions: transitionProvenance(manifest, sourceSegment.segment_id, 'incoming'),
                    outgoing_transitions: transitionProvenance(manifest, sourceSegment.segment_id, 'outgoing'),
                },
                parentNode: sessionSegmentGroupID(sessionID, sourceSegment.segment_id),
                extent: 'parent',
                position: { x: 0, y: 0 },
            });
        }
        const target = sessionGraphEntryNodeID(sessionID, targetSegment.segment_id);
        edges.push({
            id: scopedID(sessionID, transition.target_segment_id, 'transition', transition.transition_id),
            source: sourceCompositeID,
            target,
            type: 'session-transition',
            label: transition.reason_summary || transition.reason_code || 'Handoff',
        });
    }
    return {
        schema_version: '1',
        hash: `session:${sessionID}:${manifest.session.sequence}`,
        runbook: {
            id: sessionID,
            name: `Investigation session`,
        },
        nodes,
        edges,
        frames,
        groups,
    };
}
function sessionGraphTopologyKey(document) {
    return JSON.stringify({
        nodes: document.nodes.map((node) => ({
            id: node.id,
            kind: node.data.kind ?? '',
            groupID: node.data.group_id ?? '',
            frameID: node.data.frame_id ?? '',
            parentNode: node.parentNode ?? '',
        })),
        edges: document.edges.map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            type: edge.type ?? '',
            routeKind: edge.routeKind ?? '',
            runtimeNodeID: edge.runtimeNodeID ?? '',
            runtimeArmIndex: edge.runtimeArmIndex ?? -1,
        })),
        groups: document.groups.map((group) => ({
            id: group.id,
            kind: group.kind,
            parentNodeID: group.parent_node_id,
            frameID: group.frame_id,
        })),
        frames: document.frames.map((frame) => ({
            id: frame.id,
            parentIncludeNodeID: frame.parent_include_node_id ?? '',
            depth: frame.depth,
        })),
    });
}
class SessionGraphModel {
    sessionID;
    manifest;
    segmentGraphs = new Map();
    graphRevisions = new Map();
    graphHistory = new Map();
    graphAvailability = new Map();
    composedDocument;
    documentDirty = true;
    runtimeNodes = {};
    currentSequence = 0;
    currentExecutionNodeID;
    currentPending;
    lastStartedNodeByLane = new Map();
    preparedTransitionTargets = new Map();
    constructor(sessionID) {
        this.sessionID = sessionID;
        if (!sessionID)
            throw new Error('session graph model requires a session ID');
    }
    restore(sequence, manifest, segmentGraphs, runtimeNodes = {}, executionNodeID, pending, graphHistory, preparedTransitionTargets = {}, graphAvailability = {}) {
        if (!Number.isSafeInteger(sequence) || sequence < 0 || manifest.session.session_id !== this.sessionID ||
            sequence > manifest.session.sequence) {
            throw new Error('session graph cache cursor is invalid');
        }
        this.manifest = cloneManifest(manifest);
        this.currentSequence = sequence;
        this.segmentGraphs.clear();
        this.graphRevisions.clear();
        this.graphHistory.clear();
        this.graphAvailability.clear();
        this.preparedTransitionTargets.clear();
        this.composedDocument = undefined;
        this.documentDirty = true;
        for (const [segmentID, cached] of Object.entries(segmentGraphs)) {
            const segmentSnapshot = parseSessionSegment(cached.segmentSnapshot);
            if (!this.manifest.segments[segmentID] || !Number.isSafeInteger(cached.revision) || cached.revision < 1 ||
                segmentSnapshot.segment_id !== segmentID || segmentSnapshot.graph_revision !== cached.revision ||
                segmentSnapshot.graph_hash !== cached.wholeBlobHash) {
                throw new Error('session graph cache contains an invalid segment revision');
            }
            validateSessionSegmentGraphBinding(segmentSnapshot, cached.revision, cached.wholeBlobHash);
            (0, directGraphPreview_1.validateSessionPresentationBinding)(cached.document, segmentSnapshot.executable_snapshot_hash);
            this.segmentGraphs.set(segmentID, cached.document);
            this.graphRevisions.set(segmentID, cached.revision);
            this.graphHistory.set(segmentID, new Map([[
                    cached.revision,
                    {
                        wholeBlobHash: cached.wholeBlobHash,
                        document: cached.document,
                        segmentSnapshot: { ...segmentSnapshot, attempt_run_ids: [...segmentSnapshot.attempt_run_ids] },
                    },
                ]]));
            this.graphAvailability.set(segmentID, new Map([[cached.revision, segmentSnapshot]]));
        }
        for (const [segmentID, revisions] of Object.entries(graphHistory ?? {})) {
            if (!this.manifest.segments[segmentID])
                throw new Error('session graph history contains an unknown segment');
            const restored = new Map();
            for (const [revisionKey, cached] of Object.entries(revisions)) {
                const segmentSnapshot = parseSessionSegment(cached.segmentSnapshot);
                if (revisionKey !== String(cached.revision) ||
                    cached.revision > (this.manifest.segments[segmentID].graph_revision ?? 0) ||
                    segmentSnapshot.segment_id !== segmentID || segmentSnapshot.graph_revision !== cached.revision ||
                    segmentSnapshot.graph_hash !== cached.wholeBlobHash) {
                    throw new Error('session graph history contains an invalid revision');
                }
                validateSessionSegmentGraphBinding(segmentSnapshot, cached.revision, cached.wholeBlobHash);
                (0, directGraphPreview_1.validateSessionPresentationBinding)(cached.document, segmentSnapshot.executable_snapshot_hash);
                restored.set(cached.revision, {
                    wholeBlobHash: cached.wholeBlobHash,
                    document: cached.document,
                    segmentSnapshot: { ...segmentSnapshot, attempt_run_ids: [...segmentSnapshot.attempt_run_ids] },
                });
            }
            const latestRevision = this.graphRevisions.get(segmentID);
            if (latestRevision !== undefined) {
                const latest = restored.get(latestRevision);
                const expected = segmentGraphs[segmentID];
                if (!latest || !expected || latest.wholeBlobHash !== expected.wholeBlobHash) {
                    throw new Error('session graph history does not contain the latest loaded revision');
                }
            }
            this.graphHistory.set(segmentID, restored);
        }
        for (const [segmentID, revisions] of Object.entries(graphAvailability)) {
            if (!this.manifest.segments[segmentID])
                throw new Error('graph availability contains an unknown segment');
            const available = this.graphAvailability.get(segmentID) ?? new Map();
            for (const [revisionKey, raw] of Object.entries(revisions)) {
                const segment = parseSessionSegment(raw);
                if (segment.segment_id !== segmentID || revisionKey !== String(segment.graph_revision) ||
                    !segment.graph_revision || !segment.graph_hash) {
                    throw new Error('graph availability metadata is invalid');
                }
                available.set(segment.graph_revision, segment);
            }
            this.graphAvailability.set(segmentID, available);
        }
        this.validateRestoredGraphAvailability();
        for (const [transitionID, target] of Object.entries(preparedTransitionTargets)) {
            const transition = this.manifest.transitions[transitionID];
            if (!transition)
                throw new Error('prepared transition cache has no manifest transition');
            const segment = parseSessionSegment(target.segment);
            const attempt = parseSessionAttempt(target.attempt);
            validatePreparedTransitionTarget(transition, segment, attempt);
            this.preparedTransitionTargets.set(transitionID, { segment, attempt });
        }
        this.runtimeNodes = (0, executionProgress_1.normalizeRuntimeStatuses)(JSON.parse(JSON.stringify(runtimeNodes)));
        this.lastStartedNodeByLane.clear();
        for (const [nodeID, state] of Object.entries(this.runtimeNodes)) {
            for (const occurrence of state.occurrences ?? []) {
                if (occurrence.startedEventSequence === undefined)
                    continue;
                const lane = occurrence.executionLane ?? this.executionLane(occurrence.segmentID, occurrence.qualifiedNodeID);
                const laneKey = `${occurrence.runID}\u0000${lane}`;
                const previous = this.lastStartedNodeByLane.get(laneKey);
                if (!previous || occurrence.startedEventSequence > previous.eventSequence) {
                    this.lastStartedNodeByLane.set(laneKey, {
                        nodeID,
                        eventSequence: occurrence.startedEventSequence,
                    });
                }
            }
        }
        this.currentExecutionNodeID = executionNodeID;
        this.currentPending = pending ? { ...pending } : undefined;
        return this.snapshot();
    }
    applyGroup(group) {
        if (group.sequence < this.currentSequence || (!group.handshake && group.sequence !== this.currentSequence + 1)) {
            throw new Error('session graph group is not contiguous');
        }
        const rollback = this.rollbackPoint();
        try {
            const previousTopology = this.manifest ? compositeManifestFingerprint(this.manifest) : '';
            for (const frame of group.frames)
                this.applyFrame(frame);
            this.validateGraphManifestTransaction(group, rollback.manifest);
            const nextTopology = this.manifest ? compositeManifestFingerprint(this.manifest) : '';
            if (previousTopology !== nextTopology)
                this.documentDirty = true;
            for (const update of group.graphs)
                this.applyGraphUpdate(update);
            if (!group.handshake)
                this.currentSequence = group.sequence;
            if (this.manifest && this.manifest.session.sequence < group.sequence) {
                this.manifest.session.sequence = group.sequence;
            }
            return this.snapshot();
        }
        catch (error) {
            this.restoreRollbackPoint(rollback);
            throw error;
        }
    }
    graphRevision(segmentID, revision) {
        return this.graphHistory.get(segmentID)?.get(revision)?.document;
    }
    loadGraphRevision(segmentSnapshot, revision, wholeBlobHash, document) {
        const manifest = this.requireManifest();
        const current = manifest.segments[segmentSnapshot.segment_id];
        if (!current || segmentSnapshot.graph_revision !== revision || segmentSnapshot.graph_hash !== wholeBlobHash ||
            revision > (current.graph_revision ?? 0)) {
            throw new Error('lazy graph revision does not match the session manifest');
        }
        validateSessionSegmentGraphBinding(segmentSnapshot, revision, wholeBlobHash);
        (0, directGraphPreview_1.validateSessionPresentationBinding)(document, segmentSnapshot.executable_snapshot_hash);
        validateSegmentRecord(segmentSnapshot, current);
        const advertised = this.graphAvailability.get(segmentSnapshot.segment_id)?.get(revision);
        if (advertised && advertised.graph_hash !== wholeBlobHash) {
            throw new Error('advertised graph revision digest conflict');
        }
        if (advertised && !sameGraphBinding(advertised, segmentSnapshot)) {
            throw new Error('advertised graph revision metadata conflict');
        }
        const history = this.graphHistory.get(segmentSnapshot.segment_id) ?? new Map();
        const existing = history.get(revision);
        if (existing && existing.wholeBlobHash !== wholeBlobHash) {
            throw new Error('lazy graph revision digest conflict');
        }
        history.set(revision, {
            wholeBlobHash,
            document,
            segmentSnapshot: { ...segmentSnapshot, attempt_run_ids: [...segmentSnapshot.attempt_run_ids] },
        });
        this.graphHistory.set(segmentSnapshot.segment_id, history);
        this.recomputeSegmentExecutionLanes(segmentSnapshot.segment_id);
        const available = this.graphAvailability.get(segmentSnapshot.segment_id) ?? new Map();
        available.set(revision, { ...segmentSnapshot, attempt_run_ids: [...segmentSnapshot.attempt_run_ids] });
        this.graphAvailability.set(segmentSnapshot.segment_id, available);
        if (revision === current.graph_revision) {
            this.segmentGraphs.set(segmentSnapshot.segment_id, document);
            this.graphRevisions.set(segmentSnapshot.segment_id, revision);
            this.documentDirty = true;
        }
        return this.snapshot();
    }
    graphRevisionNode(segmentID, revision, originalNodeID) {
        const manifest = this.requireManifest();
        const segment = manifest.segments[segmentID];
        const archived = this.graphHistory.get(segmentID)?.get(revision);
        const source = archived?.document.nodes.find((node) => node.id === originalNodeID);
        if (!segment || !archived || !source)
            return undefined;
        return namespaceNode(this.sessionID, archived.segmentSnapshot, segmentAttempt(manifest, segment), source, [...(this.graphHistory.get(segmentID)?.keys() ?? [])].sort((left, right) => left - right), transitionProvenance(manifest, segmentID, 'incoming'), transitionProvenance(manifest, segmentID, 'outgoing'), revision, archived.wholeBlobHash, archived.document.display_plan_snapshot_digest);
    }
    snapshot() {
        const manifest = this.manifest;
        const activeRunID = manifest?.session.active_run_id;
        const activeAttempt = activeRunID ? manifest?.attempts[activeRunID] : undefined;
        const pending = this.currentPending && (!activeRunID || this.currentPending.runID === activeRunID) &&
            !(0, executionProgress_1.isExecutionEnded)(activeAttempt?.status ?? '') && !(0, executionProgress_1.isExecutionEnded)(manifest?.session.status ?? '')
            ? this.currentPending : undefined;
        const segmentGraphRevisions = Object.fromEntries(Object.values(manifest?.segments ?? {}).map((segment) => {
            const revisions = new Set(this.graphAvailability.get(segment.segment_id)?.keys() ?? []);
            for (const revision of this.graphHistory.get(segment.segment_id)?.keys() ?? [])
                revisions.add(revision);
            if (segment.graph_revision)
                revisions.add(segment.graph_revision);
            return [segment.segment_id, [...revisions].sort((left, right) => left - right)];
        }));
        if (manifest && this.segmentGraphs.size > 0 && (this.documentDirty || !this.composedDocument)) {
            this.composedDocument = composeSessionGraph({
                sessionID: this.sessionID,
                manifest,
                segmentGraphs: this.segmentGraphs,
                segmentGraphRevisions: new Map(Object.entries(segmentGraphRevisions)),
            });
            this.documentDirty = false;
        }
        return {
            sessionID: this.sessionID,
            sequence: this.currentSequence,
            sessionStatus: manifest?.session.status ?? 'loading',
            runStatus: pending ? 'waiting' : activeAttempt?.status ?? manifest?.session.status ?? 'loading',
            ...(manifest?.session.active_segment_id ? { activeSegmentID: manifest.session.active_segment_id } : {}),
            ...(activeRunID ? { activeRunID } : {}),
            ...(this.composedDocument ? { document: this.composedDocument } : {}),
            runtimeNodes: { ...this.runtimeNodes },
            segmentGraphRevisions,
            preparedTransitionTargets: Object.fromEntries([...this.preparedTransitionTargets].map(([transitionID, target]) => [
                transitionID,
                clonePreparedTransitionTarget(target),
            ])),
            unloadedSegmentIDs: manifest
                ? Object.keys(manifest.segments).filter((segmentID) => !this.segmentGraphs.has(segmentID))
                : [],
            segmentGraphAvailability: Object.fromEntries([...this.graphAvailability].map(([segmentID, revisions]) => [
                segmentID,
                Object.fromEntries([...revisions].map(([revision, segment]) => [
                    String(revision),
                    { ...segment, attempt_run_ids: [...segment.attempt_run_ids] },
                ])),
            ])),
            ...(this.currentExecutionNodeID ? { executionNodeID: this.currentExecutionNodeID } : {}),
            ...(pending ? { pending: { ...pending } } : {}),
            ...(manifest ? { manifest: cloneManifest(manifest) } : {}),
        };
    }
    applyFrame(frame) {
        if (frame.sessionID !== this.sessionID)
            throw new Error('session graph frame belongs to a different session');
        switch (frame.type) {
            case 'session.snapshot':
                this.manifest = mergeSessionManifest(this.manifest, parseSessionManifest(frame.payload, this.sessionID));
                return;
            case 'segment.added':
            case 'segment.finished':
                this.applySegment(frame.payload);
                return;
            case 'segment.graph.available':
                this.applyGraphAvailable(frame);
                return;
            case 'attempt.started':
            case 'attempt.paused':
            case 'attempt.finished':
                this.applyAttempt(frame);
                return;
            case 'transition.prepared':
                this.applyPreparedTransition(frame.payload);
                return;
            case 'transition.committed':
                this.applyCommittedTransition(frame.payload);
                return;
            case 'session.finished':
                this.applyFinishedSession(frame.payload);
                return;
            case 'run.event':
                this.applyRunEvent(frame);
                return;
            case 'interaction.pending':
                this.currentPending = this.parsePendingInteraction(frame);
                this.currentExecutionNodeID = this.currentPending.nodeID;
                return;
            case 'interaction.resolved': {
                const resolved = objectValue(frame.payload, 'resolved interaction');
                const turnID = stringValue(resolved.turn_id ?? resolved.turnID, 'resolved interaction turn');
                if (this.currentPending?.turnID === turnID)
                    this.currentPending = undefined;
                return;
            }
            default:
                return;
        }
    }
    applyGraphUpdate(update) {
        const segment = this.requireManifest().segments[update.segmentID];
        if (!segment)
            throw new Error('session graph update belongs to an unknown segment');
        validateSessionSegmentGraphBinding(segment, update.revision, update.wholeBlobHash);
        (0, directGraphPreview_1.validateSessionPresentationBinding)(update.document, segment.executable_snapshot_hash);
        const previousRevision = this.graphRevisions.get(update.segmentID) ?? 0;
        const knownRevision = this.highestKnownGraphRevision(update.segmentID);
        const history = this.graphHistory.get(update.segmentID) ?? new Map();
        const existing = history.get(update.revision);
        if (existing && existing.wholeBlobHash !== update.wholeBlobHash) {
            throw new Error('session graph revision digest conflict');
        }
        if (update.revision < previousRevision) {
            if (!existing)
                throw new Error('session graph revision moved backwards');
            return;
        }
        if (!existing && update.revision > knownRevision + 1) {
            throw new Error('session graph revision is not contiguous');
        }
        if (!existing) {
            history.set(update.revision, {
                wholeBlobHash: update.wholeBlobHash,
                document: update.document,
                segmentSnapshot: { ...segment, attempt_run_ids: [...segment.attempt_run_ids] },
            });
            this.graphHistory.set(update.segmentID, history);
        }
        this.recomputeSegmentExecutionLanes(update.segmentID);
        const available = this.graphAvailability.get(update.segmentID) ?? new Map();
        available.set(update.revision, { ...segment, attempt_run_ids: [...segment.attempt_run_ids] });
        this.graphAvailability.set(update.segmentID, available);
        if (update.revision === previousRevision)
            return;
        this.segmentGraphs.set(update.segmentID, update.document);
        this.graphRevisions.set(update.segmentID, update.revision);
        this.documentDirty = true;
        this.manifest.segments[update.segmentID] = {
            ...segment,
            graph_revision: update.revision,
            graph_hash: update.wholeBlobHash,
        };
    }
    applyGraphAvailable(frame) {
        if (!frame.segmentID)
            throw new Error('deferred graph frame has no segment ID');
        const payload = objectValue(frame.payload, 'deferred graph revision');
        const revision = integerValue(payload.graphRevision, 'deferred graph revision');
        const wholeBlobHash = stringValue(payload.wholeBlobHash, 'deferred graph digest');
        if (!/^sha256:[0-9a-f]{64}$/.test(wholeBlobHash))
            throw new Error('deferred graph digest is invalid');
        const segment = this.requireManifest().segments[frame.segmentID];
        if (!segment) {
            throw new Error('deferred graph revision does not match its manifest');
        }
        validateSessionSegmentGraphBinding(segment, revision, wholeBlobHash);
        const available = this.graphAvailability.get(frame.segmentID) ?? new Map();
        const existing = available.get(revision);
        if (existing && existing.graph_hash !== wholeBlobHash) {
            throw new Error('deferred graph revision digest conflict');
        }
        if (!existing && revision > this.highestKnownGraphRevision(frame.segmentID) + 1) {
            throw new Error('deferred graph revision is not contiguous');
        }
        available.set(revision, { ...segment, attempt_run_ids: [...segment.attempt_run_ids] });
        this.graphAvailability.set(frame.segmentID, available);
        this.documentDirty = true;
        const loadedRevision = this.graphRevisions.get(frame.segmentID);
        if (loadedRevision !== undefined && loadedRevision !== revision) {
            this.segmentGraphs.delete(frame.segmentID);
            this.graphRevisions.delete(frame.segmentID);
            this.documentDirty = true;
        }
    }
    validateGraphManifestTransaction(group, previousManifest) {
        if (!previousManifest || !this.manifest)
            return;
        const updates = new Map(group.graphs.map((update) => [update.segmentID, update]));
        const available = new Map(group.frames.flatMap((frame) => {
            if (frame.type !== 'segment.graph.available' || !frame.segmentID)
                return [];
            const payload = objectValue(frame.payload, 'deferred graph revision');
            return [[frame.segmentID, {
                        revision: integerValue(payload.graphRevision, 'deferred graph revision'),
                        wholeBlobHash: stringValue(payload.wholeBlobHash, 'deferred graph digest'),
                    }]];
        }));
        const snapshots = group.frames.flatMap((frame) => (frame.type === 'session.snapshot' ? [parseSessionManifest(frame.payload, this.sessionID)] : []));
        for (const [segmentID, segment] of Object.entries(this.manifest.segments)) {
            const previous = previousManifest.segments[segmentID];
            if (!previous || previous.graph_revision === segment.graph_revision && previous.graph_hash === segment.graph_hash) {
                continue;
            }
            const update = updates.get(segmentID);
            const deferred = available.get(segmentID);
            const snapshotBound = snapshots.some((snapshot) => {
                const bound = snapshot.segments[segmentID];
                if (!bound || bound.graph_revision !== segment.graph_revision || bound.graph_hash !== segment.graph_hash ||
                    bound.executable_revision !== segment.executable_revision || bound.plan_hash !== segment.plan_hash ||
                    bound.executable_snapshot_hash !== segment.executable_snapshot_hash)
                    return false;
                try {
                    validateSessionSegmentGraphBinding(bound, segment.graph_revision, segment.graph_hash);
                    return true;
                }
                catch {
                    return false;
                }
            });
            const transmittedGraphBound = update !== undefined && update.revision === segment.graph_revision &&
                update.wholeBlobHash === segment.graph_hash;
            const deferredGraphBound = deferred !== undefined && deferred.revision === segment.graph_revision &&
                deferred.wholeBlobHash === segment.graph_hash;
            const graphBound = transmittedGraphBound || deferredGraphBound;
            if (!graphBound || !snapshotBound) {
                throw new Error('session graph revision change lacks exact graph and executable binding');
            }
        }
    }
    rollbackPoint() {
        return {
            manifest: this.manifest ? cloneManifest(this.manifest) : undefined,
            segmentGraphs: new Map(this.segmentGraphs),
            graphRevisions: new Map(this.graphRevisions),
            graphHistory: new Map([...this.graphHistory].map(([segmentID, revisions]) => ([segmentID, new Map(revisions)]))),
            graphAvailability: new Map([...this.graphAvailability].map(([segmentID, revisions]) => ([segmentID, new Map(revisions)]))),
            composedDocument: this.composedDocument,
            documentDirty: this.documentDirty,
            runtimeNodes: this.runtimeNodes,
            currentSequence: this.currentSequence,
            currentExecutionNodeID: this.currentExecutionNodeID,
            currentPending: this.currentPending,
            lastStartedNodeByLane: new Map(this.lastStartedNodeByLane),
            preparedTransitionTargets: new Map([...this.preparedTransitionTargets].map(([transitionID, target]) => [
                transitionID,
                clonePreparedTransitionTarget(target),
            ])),
        };
    }
    restoreRollbackPoint(rollback) {
        this.manifest = rollback.manifest;
        replaceMap(this.segmentGraphs, rollback.segmentGraphs);
        replaceMap(this.graphRevisions, rollback.graphRevisions);
        replaceMap(this.graphHistory, rollback.graphHistory);
        replaceMap(this.graphAvailability, rollback.graphAvailability);
        this.composedDocument = rollback.composedDocument;
        this.documentDirty = rollback.documentDirty;
        this.runtimeNodes = rollback.runtimeNodes;
        this.currentSequence = rollback.currentSequence;
        this.currentExecutionNodeID = rollback.currentExecutionNodeID;
        this.currentPending = rollback.currentPending;
        replaceMap(this.lastStartedNodeByLane, rollback.lastStartedNodeByLane);
        replaceMap(this.preparedTransitionTargets, rollback.preparedTransitionTargets);
    }
    requireManifest() {
        if (!this.manifest)
            throw new Error('session topology frame arrived before a manifest snapshot');
        return this.manifest;
    }
    applySegment(value) {
        const manifest = this.requireManifest();
        const segment = parseSessionSegment(value);
        const existing = manifest.segments[segment.segment_id];
        manifest.segments[segment.segment_id] = existing
            ? mergeSegmentRecord(existing, segment)
            : segment;
    }
    applyAttempt(frame) {
        const manifest = this.requireManifest();
        const payload = objectValue(frame.payload, 'session attempt');
        const runID = typeof payload.run_id === 'string' && payload.run_id ? payload.run_id : frame.runID;
        if (!runID)
            throw new Error('session attempt frame has no run ID');
        const existing = manifest.attempts[runID];
        if (typeof payload.segment_id === 'string') {
            const attempt = parseSessionAttempt(payload);
            manifest.attempts[runID] = existing ? mergeAttemptRecord(existing, attempt) : attempt;
        }
        else if (existing) {
            const status = typeof payload.status === 'string'
                ? payload.status
                : frame.type === 'attempt.paused'
                    ? existing.status === 'handoff_pending' ? 'handoff_pending' : 'paused_at_boundary'
                    : frame.type === 'attempt.started' ? 'running' : existing.status;
            manifest.attempts[runID] = { ...existing, status };
        }
        if (frame.type === 'attempt.started' && frame.segmentID) {
            manifest.session.active_segment_id = frame.segmentID;
            manifest.session.active_run_id = runID;
            manifest.session.status = 'active';
        }
    }
    applyPreparedTransition(value) {
        const manifest = this.requireManifest();
        const payload = objectValue(value, 'prepared transition');
        const transition = parseTransition(payload.transition);
        const targetSegment = parseSessionSegment(payload.target_segment);
        const targetAttempt = parseSessionAttempt(payload.target_attempt);
        validatePreparedTransitionTarget(transition, targetSegment, targetAttempt);
        const existing = manifest.transitions[transition.transition_id];
        if (existing) {
            validateTransitionRecord(existing, transition);
            if (existing.status !== transition.status) {
                throw new Error('session frame rewrites immutable transition status');
            }
        }
        const existingTarget = this.preparedTransitionTargets.get(transition.transition_id);
        if (existingTarget && (!jsonEqual(existingTarget.segment, targetSegment) ||
            !jsonEqual(existingTarget.attempt, targetAttempt))) {
            throw new Error('session frame rewrites immutable prepared transition target');
        }
        manifest.transitions[transition.transition_id] = transition;
        this.preparedTransitionTargets.set(transition.transition_id, {
            segment: targetSegment,
            attempt: targetAttempt,
        });
    }
    applyCommittedTransition(value) {
        const manifest = this.requireManifest();
        const payload = objectValue(value, 'committed transition');
        const transitionID = stringValue(payload.transition_id, 'committed transition id');
        const previous = manifest.transitions[transitionID];
        if (!previous)
            throw new Error('committed transition has no prepared history');
        const targetSegment = parseSessionSegment(payload.target_segment);
        const targetAttempt = parseSessionAttempt(payload.target_attempt);
        const preparedTarget = this.preparedTransitionTargets.get(transitionID);
        if (!preparedTarget || !jsonEqual(preparedTarget.segment, targetSegment) ||
            !jsonEqual(preparedTarget.attempt, targetAttempt)) {
            throw new Error('committed transition target does not match its prepared transition target');
        }
        if (previous.status !== 'prepared' && previous.status !== 'committed') {
            throw new Error('committed transition does not follow prepared history');
        }
        manifest.transitions[transitionID] = { ...previous, status: 'committed' };
        const sourceSegment = manifest.segments[previous.source_segment_id];
        if (!sourceSegment)
            throw new Error('committed transition source segment is unavailable');
        manifest.segments[sourceSegment.segment_id] = { ...sourceSegment, status: 'handed_off' };
        const sourceAttempt = manifest.attempts[previous.source_occurrence.run_id];
        if (!sourceAttempt)
            throw new Error('committed transition source attempt is unavailable');
        manifest.attempts[sourceAttempt.run_id] = { ...sourceAttempt, status: 'completed' };
        manifest.segments[targetSegment.segment_id] = manifest.segments[targetSegment.segment_id]
            ? mergeSegmentRecord(manifest.segments[targetSegment.segment_id], targetSegment)
            : targetSegment;
        manifest.attempts[targetAttempt.run_id] = manifest.attempts[targetAttempt.run_id]
            ? mergeAttemptRecord(manifest.attempts[targetAttempt.run_id], targetAttempt)
            : targetAttempt;
        manifest.session.active_segment_id = targetSegment.segment_id;
        manifest.session.active_run_id = targetAttempt.run_id;
        manifest.session.status = 'active';
    }
    applyFinishedSession(value) {
        const manifest = this.requireManifest();
        const payload = objectValue(value, 'finished session');
        const activeRunID = manifest.session.active_run_id;
        const activeAttempt = activeRunID ? manifest.attempts[activeRunID] : undefined;
        if (activeAttempt && ['waiting', 'paused_at_boundary', 'handoff_pending'].includes(activeAttempt.status)) {
            manifest.attempts[activeAttempt.run_id] = { ...activeAttempt, status: 'cancelled' };
            const segment = manifest.segments[activeAttempt.segment_id];
            if (segment)
                manifest.segments[segment.segment_id] = { ...segment, status: 'cancelled' };
        }
        manifest.session.status = stringValue(payload.status, 'finished session status');
        delete manifest.session.active_segment_id;
        delete manifest.session.active_run_id;
        this.currentPending = undefined;
    }
    applyRunEvent(frame) {
        const event = objectValue(frame.payload, 'session run event');
        const runID = stringValue(event.run_id, 'run event run id');
        if (frame.runID && frame.runID !== runID)
            throw new Error('run event does not match its frame run ID');
        const payload = objectValue(event.payload ?? {}, 'run event payload');
        const localNodeID = runtimeEventNodeID(payload);
        if (!localNodeID)
            return;
        const segmentID = frame.segmentID || this.requireManifest().attempts[runID]?.segment_id;
        if (!segmentID)
            throw new Error('run event has no owning segment');
        const nodeID = sessionGraphNodeID(this.sessionID, segmentID, localNodeID);
        let previous = this.runtimeNodes[nodeID] ?? { status: 'pending' };
        const kind = stringValue(event.kind, 'run event kind');
        const phase = typeof payload.phase === 'string' && payload.phase ? payload.phase : undefined;
        const invocation = positiveInteger(payload.invocation) ? payload.invocation : undefined;
        const retryAttempt = positiveInteger(payload.retry_attempt)
            ? payload.retry_attempt
            : payload.retry_attempt === undefined && positiveInteger(payload.attempt) ? payload.attempt : undefined;
        const suppliedOccurrenceSequence = positiveInteger(payload.occurrence_sequence)
            ? payload.occurrence_sequence
            : undefined;
        const frameID = typeof payload.frame_id === 'string' ? payload.frame_id : undefined;
        const frameStepIndex = typeof payload.frame_step_index === 'number' && Number.isSafeInteger(payload.frame_step_index) && payload.frame_step_index >= 0
            ? payload.frame_step_index : undefined;
        const dispatchOccurrenceID = typeof payload.dispatch_occurrence_id === 'string' ? payload.dispatch_occurrence_id : undefined;
        const graphRevision = this.requireManifest().segments[segmentID]?.graph_revision;
        const executionLane = typeof payload.execution_lane === 'string' ? payload.execution_lane
            : this.executionLane(segmentID, localNodeID, graphRevision);
        const occurrences = [...(previous.occurrences ?? [])];
        const progressIdentity = (0, executionProgress_1.directOccurrenceID)(runID, localNodeID, payload);
        const occurrenceIndex = occurrences.findIndex((occurrence) => ((0, executionProgress_1.validProgressIdentity)(payload) && occurrence.progressIdentity === progressIdentity));
        const existingOccurrence = occurrenceIndex >= 0 ? occurrences[occurrenceIndex] : undefined;
        const displayRevision = existingOccurrence?.graphRevision ?? graphRevision;
        const displayGraph = displayRevision === undefined ? undefined : this.graphRevision(segmentID, displayRevision);
        const expectedDisplaySnapshot = displayGraph?.display_plan_snapshot_digest ?? 'missing-binding';
        if ((kind === 'step/completed' || kind === 'step/failed') &&
            ((0, displayPresentation_1.hasDisplayPayload)(payload) || previous.displayObservations)) {
            previous = { ...previous, displayObservations: (0, displayObservations_1.retainDisplayObservation)(previous.displayObservations ?? {}, localNodeID, runID, { ...payload, execution_lane: executionLane }, expectedDisplaySnapshot) };
        }
        if (kind === 'step/output' && !existingOccurrence) {
            if (typeof payload.line !== 'string' || !payload.line)
                return;
            this.runtimeNodes = { ...this.runtimeNodes, [nodeID]: { ...previous,
                    ...(typeof event.timestamp === 'string' ? { lastActivityAt: event.timestamp } : {}),
                    logs: [...(previous.logs ?? []), {
                            stream: typeof payload.stream === 'string' ? payload.stream : 'stdout', line: payload.line,
                        }].slice(-50),
                } };
            return;
        }
        if (existingOccurrence && TERMINAL_OCCURRENCE_STATUSES.has(existingOccurrence.status) && kind !== 'step/output') {
            if (['step/started', 'step/resumed', 'step/delaying'].includes(kind))
                return;
            if ((kind === 'step/completed' || kind === 'step/failed') &&
                (existingOccurrence.displayPresentation || existingOccurrence.displayPresentationDiagnostic ||
                    'display_presentation' in payload || 'display_presentation_diagnostic' in payload)) {
                const display = (0, presentationProjection_1.terminalPresentation)(payload, existingOccurrence, expectedDisplaySnapshot);
                const update = { output: plainRecord(payload.output),
                    displayPresentation: display.displayPresentation,
                    displayPresentationDiagnostic: display.displayPresentationDiagnostic };
                occurrences[occurrenceIndex] = { ...existingOccurrence, ...update };
                this.runtimeNodes = { ...this.runtimeNodes, [nodeID]: (0, displayObservations_1.reconcileRuntimeDisplayState)({
                        ...previous, ...(previous.occurrenceID === existingOccurrence.occurrenceID ? update : {}), occurrences,
                    }) };
                return;
            }
            throw new Error('session run event rewrites a terminal occurrence');
        }
        const eventSequence = positiveInteger(event.sequence) ? event.sequence : 1;
        const laneKey = `${runID}\u0000${executionLane}`;
        const occurrenceSequence = suppliedOccurrenceSequence ?? existingOccurrence?.occurrenceSequence;
        const attempt = this.requireManifest().attempts[runID];
        const executionSource = attempt?.mode === 'replay' || attempt?.mode === 'route-test' ? 'saved' : 'live';
        const occurrenceID = existingOccurrence?.occurrenceID ??
            `${progressIdentity}${(0, executionProgress_1.validProgressIdentity)(payload) ? '' : `:uncertain:${eventSequence}`}`;
        let occurrence = existingOccurrence ?? {
            occurrenceID,
            progressIdentity,
            runID,
            segmentID,
            qualifiedNodeID: localNodeID,
            phase,
            invocation,
            retryAttempt,
            occurrenceSequence,
            executionSource,
            executionLane,
            graphRevision,
            ...(frameID === undefined ? {} : { frameID }),
            ...(frameStepIndex === undefined ? {} : { frameStepIndex }),
            ...(dispatchOccurrenceID === undefined ? {} : { dispatchOccurrenceID }),
            status: 'pending',
        };
        if ((0, displayPresentation_1.hasDisplayPayload)(payload))
            occurrence = { ...occurrence, directDisplaySnapshot: expectedDisplaySnapshot };
        if (kind === 'step/output') {
            if (typeof payload.line !== 'string' || !payload.line)
                return;
            occurrence = {
                ...occurrence,
                ...(typeof event.timestamp === 'string' ? { lastActivityAt: event.timestamp } : {}),
                logs: [...(occurrence.logs ?? []), {
                        stream: typeof payload.stream === 'string' ? payload.stream : 'stdout',
                        line: payload.line,
                    }].slice(-50),
            };
        }
        else {
            const statuses = {
                'step/started': 'running',
                'step/resumed': 'running',
                'step/delaying': 'delaying',
                'step/completed': 'completed',
                'step/failed': 'failed',
                'step/indeterminate': 'indeterminate',
                'step/skipped': 'skipped',
                'step/cancelled': 'cancelled',
                'step/denied': 'denied',
                'step/blocked': 'blocked',
            };
            const status = statuses[kind];
            if (!status)
                return;
            const timestamp = typeof event.timestamp === 'string' ? event.timestamp : undefined;
            if (kind === 'step/completed' || kind === 'step/failed') {
                (0, displayPresentation_1.sanitizeDisplayPayload)(payload, expectedDisplaySnapshot);
                (0, presentationProjection_1.sanitizePresentationPayload)(payload);
            }
            const presentation = kind === 'step/completed' || kind === 'step/failed'
                ? (0, presentationProjection_1.terminalPresentation)(payload, existingOccurrence, expectedDisplaySnapshot) : undefined;
            const output = plainRecord(payload.output);
            const captures = plainRecord(payload.captures);
            occurrence = {
                ...occurrence,
                status,
                ...(timestamp ? { lastActivityAt: timestamp } : {}),
                ...((0, executionProgress_1.producerStepKind)(payload) ? { stepKind: (0, executionProgress_1.producerStepKind)(payload) } : {}),
                ...((kind === 'step/completed' || kind === 'step/failed') ? {
                    codePresentation: undefined, outputValueStatus: undefined, presentationDiagnostic: undefined,
                    displayPresentation: undefined, displayPresentationDiagnostic: undefined,
                    output, ...presentation,
                } : {}),
                ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
                ...(typeof payload.duration_ms === 'number' ? { durationMs: payload.duration_ms } : {}),
                ...(typeof payload.attempt === 'number' ? { attempt: payload.attempt } : {}),
                ...(output ? { output } : {}),
                ...(captures ? { captures } : {}),
                ...(payload.evidence !== undefined ? { evidence: payload.evidence } : {}),
                ...((kind === 'step/started' || kind === 'step/resumed') && timestamp ? { startedAt: timestamp } : {}),
                ...((kind === 'step/started' || kind === 'step/resumed') ? {
                    startedEventSequence: occurrence.startedEventSequence ?? eventSequence,
                    executionLane,
                    graphRevision,
                    ...(occurrence.predecessorNodeID || !this.lastStartedNodeByLane.get(laneKey)
                        ? {}
                        : { predecessorNodeID: this.lastStartedNodeByLane.get(laneKey).nodeID }),
                } : {}),
                ...(['step/completed', 'step/failed', 'step/indeterminate', 'step/skipped'].includes(kind) && timestamp
                    ? { finishedAt: timestamp, finishedEventSequence: eventSequence }
                    : {}),
            };
        }
        if (occurrenceIndex >= 0)
            occurrences[occurrenceIndex] = occurrence;
        else
            occurrences.push(occurrence);
        occurrences.sort((left, right) => {
            const leftAttempt = this.requireManifest().attempts[left.runID]?.ordinal ?? 0;
            const rightAttempt = this.requireManifest().attempts[right.runID]?.ordinal ?? 0;
            return leftAttempt - rightAttempt || (0, executionProgress_1.compareOccurrences)(left, right);
        });
        const activeRunID = this.requireManifest().session.active_run_id;
        const selected = [...occurrences].reverse().find((candidate) => candidate.runID === activeRunID)
            ?? occurrences[occurrences.length - 1];
        this.runtimeNodes = {
            ...this.runtimeNodes,
            [nodeID]: (0, displayObservations_1.reconcileRuntimeDisplayState)({ ...selected, occurrences,
                displayObservations: previous.displayObservations }),
        };
        if ((kind === 'step/started' || kind === 'step/resumed') && selected.occurrenceID === occurrence.occurrenceID &&
            (!activeRunID || activeRunID === runID)) {
            this.currentExecutionNodeID = nodeID;
            this.lastStartedNodeByLane.set(laneKey, { nodeID, eventSequence });
        }
    }
    executionLane(segmentID, localNodeID, revision) {
        const graph = revision === undefined
            ? this.segmentGraphs.get(segmentID)
            : this.graphHistory.get(segmentID)?.get(revision)?.document ?? this.segmentGraphs.get(segmentID);
        return executionLaneForGraph(graph, localNodeID);
    }
    highestKnownGraphRevision(segmentID) {
        return Math.max(0, this.graphRevisions.get(segmentID) ?? 0, ...this.graphHistory.get(segmentID)?.keys() ?? [], ...this.graphAvailability.get(segmentID)?.keys() ?? []);
    }
    validateRestoredGraphAvailability() {
        const manifest = this.requireManifest();
        for (const [segmentID, segment] of Object.entries(manifest.segments)) {
            const currentRevision = segment.graph_revision;
            const available = this.graphAvailability.get(segmentID);
            const loaded = this.graphHistory.get(segmentID);
            if (currentRevision === undefined) {
                if ((available?.size ?? 0) > 0 || (loaded?.size ?? 0) > 0) {
                    throw new Error('graph availability requires a manifest revision head');
                }
                continue;
            }
            for (const revision of available?.keys() ?? []) {
                if (revision < 1 || revision > currentRevision) {
                    throw new Error('graph availability revision is outside the manifest head');
                }
            }
            for (let revision = 1; revision <= currentRevision; revision += 1) {
                if (!available?.has(revision)) {
                    throw new Error('graph availability revisions are not contiguous');
                }
            }
            for (const [revision, loadedRevision] of loaded ?? []) {
                const advertised = available?.get(revision);
                if (!advertised || loadedRevision.wholeBlobHash !== advertised.graph_hash ||
                    !sameGraphBinding(loadedRevision.segmentSnapshot, advertised)) {
                    throw new Error('graph availability conflicts with loaded history');
                }
            }
        }
    }
    recomputeSegmentExecutionLanes(segmentID) {
        const occurrences = Object.entries(this.runtimeNodes).flatMap(([nodeID, state]) => ((state.occurrences ?? []).flatMap((occurrence) => (occurrence.segmentID === segmentID
            ? [{ nodeID, occurrence }]
            : [])))).sort((left, right) => ((left.occurrence.startedEventSequence ?? Number.MAX_SAFE_INTEGER) -
            (right.occurrence.startedEventSequence ?? Number.MAX_SAFE_INTEGER)));
        const runIDs = new Set(occurrences.map(({ occurrence }) => occurrence.runID));
        for (const key of [...this.lastStartedNodeByLane.keys()]) {
            if (runIDs.has(key.slice(0, key.indexOf('\u0000'))))
                this.lastStartedNodeByLane.delete(key);
        }
        const previousByLane = new Map();
        const updated = new Map();
        for (const { nodeID, occurrence } of occurrences) {
            const graph = occurrence.graphRevision === undefined
                ? undefined
                : this.graphHistory.get(segmentID)?.get(occurrence.graphRevision)?.document;
            const lane = graph
                ? executionLaneForGraph(graph, occurrence.qualifiedNodeID)
                : occurrence.executionLane ?? 'main';
            const laneKey = `${occurrence.runID}\u0000${lane}`;
            const previous = previousByLane.get(laneKey);
            const { predecessorNodeID: _, ...withoutPredecessor } = occurrence;
            const next = {
                ...withoutPredecessor,
                executionLane: lane,
                graphRevision: occurrence.graphRevision,
                ...(previous && occurrence.startedEventSequence !== undefined
                    ? { predecessorNodeID: previous.nodeID }
                    : {}),
            };
            updated.set(occurrence.occurrenceID, next);
            if (occurrence.startedEventSequence !== undefined) {
                const cursor = { nodeID, eventSequence: occurrence.startedEventSequence };
                previousByLane.set(laneKey, cursor);
                this.lastStartedNodeByLane.set(laneKey, cursor);
            }
        }
        if (updated.size === 0)
            return;
        this.runtimeNodes = Object.fromEntries(Object.entries(this.runtimeNodes).map(([nodeID, state]) => {
            const nextOccurrences = state.occurrences?.map((occurrence) => updated.get(occurrence.occurrenceID) ?? occurrence);
            if (!nextOccurrences || nextOccurrences === state.occurrences)
                return [nodeID, state];
            const selected = selectRuntimeOccurrence(nextOccurrences, this.requireManifest().session.active_run_id);
            return [nodeID, { ...selected, occurrences: nextOccurrences }];
        }));
    }
    parsePendingInteraction(frame) {
        const state = objectValue(frame.payload, 'pending interaction');
        const request = objectValue(state.request, 'pending interaction request');
        const runID = frame.runID ?? stringValue(request.runID, 'pending interaction run ID');
        const stepID = stringValue(state.step_id, 'pending interaction step');
        const localNodeID = typeof state.node_id === 'string' && state.node_id ? state.node_id : stepID;
        const segmentID = frame.segmentID || this.requireManifest().attempts[runID]?.segment_id;
        if (!segmentID)
            throw new Error('pending interaction has no owning segment');
        return {
            ...request,
            type: 'pending',
            turnID: stringValue(state.turn_id, 'pending interaction turn'),
            runID,
            stepID,
            nodeID: sessionGraphNodeID(this.sessionID, segmentID, localNodeID),
            kind: stringValue(state.kind, 'pending interaction kind'),
        };
    }
}
exports.SessionGraphModel = SessionGraphModel;
function executionLaneForGraph(graph, localNodeID) {
    const nodeByID = new Map(graph?.nodes.map((node) => [node.id, node]) ?? []);
    const groupByID = new Map(graph?.groups.map((group) => [group.id, group]) ?? []);
    let groupID = typeof nodeByID.get(localNodeID)?.data.group_id === 'string'
        ? String(nodeByID.get(localNodeID)?.data.group_id)
        : '';
    const visited = new Set();
    while (groupID && !visited.has(groupID)) {
        visited.add(groupID);
        const group = groupByID.get(groupID);
        if (!group)
            break;
        if (group.kind === 'parallel-branch')
            return `parallel:${group.id}`;
        const parent = nodeByID.get(group.parent_node_id);
        groupID = typeof parent?.data.group_id === 'string' ? parent.data.group_id : '';
    }
    return 'main';
}
function selectRuntimeOccurrence(occurrences, activeRunID) {
    return [...occurrences].reverse().find((candidate) => candidate.runID === activeRunID)
        ?? occurrences[occurrences.length - 1];
}
function parseSessionManifest(value, sessionID) {
    const root = objectValue(value, 'session manifest');
    if (root.schema_version !== 'investigation-session-manifest/v1') {
        throw new Error('session manifest schema is unsupported');
    }
    const session = objectValue(root.session, 'session record');
    if (session.session_id !== sessionID || !positiveInteger(session.sequence)) {
        throw new Error('session manifest identity is invalid');
    }
    return {
        schema_version: 'investigation-session-manifest/v1',
        session: {
            ...session,
            session_id: sessionID,
            status: stringValue(session.status, 'session status'),
            root_segment_id: stringValue(session.root_segment_id, 'root segment id'),
            sequence: session.sequence,
        },
        segments: parseRecord(root.segments, 'session segments', parseSessionSegment, 'segment_id'),
        attempts: parseRecord(root.attempts, 'session attempts', parseSessionAttempt, 'run_id'),
        transitions: parseRecord(root.transitions ?? {}, 'session transitions', parseTransition, 'transition_id'),
        occurrences: plainRecord(root.occurrences) ?? {},
        accepted_commands: plainRecord(root.accepted_commands) ?? {},
    };
}
function compositeManifestFingerprint(manifest) {
    return JSON.stringify({
        activeSegmentID: manifest.session.active_segment_id ?? '',
        activeRunID: manifest.session.active_run_id ?? '',
        segments: Object.values(manifest.segments)
            .sort((left, right) => left.segment_id.localeCompare(right.segment_id))
            .map((segment) => ({
            id: segment.segment_id,
            ordinal: segment.ordinal,
            runbookID: segment.runbook_id,
            runbookName: segment.runbook_name,
            status: segment.status,
            entryStep: segment.entry_selector?.step ?? '',
            attemptRunIDs: segment.attempt_run_ids,
        })),
        attempts: Object.values(manifest.attempts)
            .sort((left, right) => left.run_id.localeCompare(right.run_id))
            .map((attempt) => ({
            id: attempt.run_id,
            segmentID: attempt.segment_id,
            ordinal: attempt.ordinal,
            mode: attempt.mode,
            status: attempt.status,
        })),
        transitions: Object.values(manifest.transitions)
            .sort((left, right) => left.transition_id.localeCompare(right.transition_id))
            .map((transition) => ({
            id: transition.transition_id,
            status: transition.status,
            sourceSegmentID: transition.source_segment_id,
            sourceRunID: transition.source_occurrence.run_id,
            sourceNodeID: transition.source_occurrence.qualified_node_id,
            sourceStepID: transition.source_occurrence.step,
            targetSegmentID: transition.target_segment_id,
            targetRunID: transition.target_run_id,
            reasonCode: transition.reason_code ?? '',
            reasonSummary: transition.reason_summary ?? '',
        })),
    });
}
function mergeSessionManifest(current, update) {
    if (!current)
        return update;
    if (update.session.sequence < current.session.sequence ||
        !jsonEqual(withoutKeys(current.session, SESSION_MUTABLE_FIELDS), withoutKeys(update.session, SESSION_MUTABLE_FIELDS)) || !monotonicField(current.session, update.session, 'manifest_revision') ||
        !monotonicField(current.session, update.session, 'writer_epoch')) {
        throw new Error('session snapshot rewrites immutable history');
    }
    for (const [segmentID, segment] of Object.entries(update.segments)) {
        const existing = current.segments[segmentID];
        if (existing)
            validateSegmentRecord(existing, segment);
    }
    for (const [runID, attempt] of Object.entries(update.attempts)) {
        const existing = current.attempts[runID];
        if (existing)
            validateAttemptRecord(existing, attempt);
    }
    for (const [transitionID, transition] of Object.entries(update.transitions)) {
        const existing = current.transitions[transitionID];
        if (existing)
            validateTransitionRecord(existing, transition);
    }
    for (const [occurrenceID, occurrence] of Object.entries(update.occurrences)) {
        const existing = current.occurrences[occurrenceID];
        if (existing !== undefined && !jsonEqual(existing, occurrence)) {
            throw new Error('session snapshot rewrites immutable occurrence metadata');
        }
    }
    return {
        ...update,
        segments: mergeRecordMap(current.segments, update.segments, mergeSegmentRecord),
        attempts: mergeRecordMap(current.attempts, update.attempts, mergeAttemptRecord),
        transitions: mergeRecordMap(current.transitions, update.transitions, (existing, next) => ({
            ...existing,
            ...next,
        })),
        occurrences: { ...current.occurrences, ...update.occurrences },
    };
}
const SESSION_MUTABLE_FIELDS = new Set([
    'status', 'active_segment_id', 'active_run_id', 'sequence',
    'manifest_revision', 'writer_epoch', 'updated_at',
]);
const SEGMENT_MUTABLE_FIELDS = new Set([
    'status', 'attempt_run_ids', 'plan_hash', 'graph_hash', 'executable_snapshot_hash',
    'executable_revision', 'graph_revision',
]);
const ATTEMPT_MUTABLE_FIELDS = new Set([
    'status', 'updated_at', 'completed_at', 'run_projection_hash', 'execution_mutation_hash',
    'checkpoint_sequence', 'committed_trace_sequence', 'journaled_trace_sequence',
]);
const TRANSITION_MUTABLE_FIELDS = new Set(['status', 'committed_at', 'aborted_at']);
const TERMINAL_OCCURRENCE_STATUSES = new Set(['completed', 'failed', 'skipped', 'indeterminate', 'cancelled', 'denied', 'blocked']);
function validateSegmentRecord(existing, update) {
    if (!jsonEqual(withoutKeys(existing, SEGMENT_MUTABLE_FIELDS), withoutKeys(update, SEGMENT_MUTABLE_FIELDS)) || !arrayPrefix(existing.attempt_run_ids, update.attempt_run_ids) ||
        !monotonicField(existing, update, 'graph_revision') ||
        !monotonicField(existing, update, 'executable_revision') ||
        sameRevisionChanged(existing, update, 'graph_revision', ['graph_hash']) ||
        sameRevisionChanged(existing, update, 'executable_revision', ['plan_hash', 'executable_snapshot_hash'])) {
        throw new Error('session frame rewrites immutable segment metadata');
    }
}
function mergeSegmentRecord(existing, update) {
    validateSegmentRecord(existing, update);
    return { ...existing, ...update };
}
function validateAttemptRecord(existing, update) {
    if (!jsonEqual(withoutKeys(existing, ATTEMPT_MUTABLE_FIELDS), withoutKeys(update, ATTEMPT_MUTABLE_FIELDS))) {
        throw new Error('session frame rewrites immutable attempt metadata');
    }
}
function mergeAttemptRecord(existing, update) {
    validateAttemptRecord(existing, update);
    return { ...existing, ...update };
}
function validateTransitionRecord(existing, update) {
    if (!jsonEqual(withoutKeys(existing, TRANSITION_MUTABLE_FIELDS), withoutKeys(update, TRANSITION_MUTABLE_FIELDS))) {
        throw new Error('session frame rewrites immutable transition metadata');
    }
}
function withoutKeys(value, omitted) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)));
}
function arrayPrefix(existing, update) {
    return existing.length <= update.length && existing.every((value, index) => update[index] === value);
}
function monotonicField(existing, update, key) {
    const previous = existing[key];
    const next = update[key];
    return previous === undefined || next === undefined ||
        typeof previous !== 'number' || typeof next !== 'number' || next >= previous;
}
function sameRevisionChanged(existing, update, revisionKey, valueKeys) {
    const previous = existing;
    const next = update;
    return previous[revisionKey] !== undefined && previous[revisionKey] === next[revisionKey] &&
        valueKeys.some((key) => previous[key] !== next[key]);
}
function parseSessionSegment(value) {
    const segment = objectValue(value, 'session segment');
    if (segment.graph_revision !== undefined && !positiveInteger(segment.graph_revision) ||
        segment.executable_revision !== undefined && !positiveInteger(segment.executable_revision)) {
        throw new Error('session segment revisions must be positive integers');
    }
    return {
        ...segment,
        segment_id: stringValue(segment.segment_id, 'segment id'),
        ordinal: integerValue(segment.ordinal, 'segment ordinal'),
        runbook_id: stringValue(segment.runbook_id, 'segment runbook id'),
        runbook_name: stringValue(segment.runbook_name, 'segment runbook name'),
        status: stringValue(segment.status, 'segment status'),
        attempt_run_ids: stringArray(segment.attempt_run_ids, 'segment attempt run ids'),
    };
}
function parseSessionAttempt(value) {
    const attempt = objectValue(value, 'session attempt');
    return {
        ...attempt,
        run_id: stringValue(attempt.run_id, 'attempt run id'),
        segment_id: stringValue(attempt.segment_id, 'attempt segment id'),
        ordinal: integerValue(attempt.ordinal, 'attempt ordinal'),
        mode: stringValue(attempt.mode, 'attempt mode'),
        status: stringValue(attempt.status, 'attempt status'),
    };
}
function parseTransition(value) {
    const transition = objectValue(value, 'session transition');
    const source = objectValue(transition.source_occurrence, 'transition source occurrence');
    return {
        ...transition,
        transition_id: stringValue(transition.transition_id, 'transition id'),
        status: stringValue(transition.status, 'transition status'),
        source_segment_id: stringValue(transition.source_segment_id, 'transition source segment'),
        source_occurrence: {
            ...source,
            run_id: stringValue(source.run_id, 'transition source run'),
            qualified_node_id: stringValue(source.qualified_node_id, 'transition source node'),
            step: stringValue(source.step, 'transition source step'),
        },
        target_segment_id: stringValue(transition.target_segment_id, 'transition target segment'),
        target_run_id: stringValue(transition.target_run_id, 'transition target run'),
        target_runbook_id: stringValue(transition.target_runbook_id, 'transition target runbook'),
    };
}
function parseRecord(value, label, parse, identityKey) {
    const source = objectValue(value, label);
    const result = {};
    for (const [key, item] of Object.entries(source)) {
        const parsed = parse(item);
        if (parsed[identityKey] !== key)
            throw new Error(`${label} key does not match its identity`);
        result[key] = parsed;
    }
    return result;
}
function runtimeEventNodeID(payload) {
    if (typeof payload.qualified_node_id === 'string' && payload.qualified_node_id)
        return payload.qualified_node_id;
    if (typeof payload.node_id === 'string' && payload.node_id)
        return payload.node_id;
    if (typeof payload.step_id !== 'string' || !payload.step_id)
        return undefined;
    const callPath = Array.isArray(payload.call_path)
        ? payload.call_path.flatMap((value) => {
            const frame = plainRecord(value);
            return typeof frame?.step_id === 'string' && frame.step_id ? [frame.step_id] : [];
        })
        : [];
    const escape = (part) => part.replaceAll('~', '~0').replaceAll('/', '~1');
    return [...callPath.map(escape), escape(payload.step_id)].join('/');
}
function cloneManifest(manifest) {
    return JSON.parse(JSON.stringify(manifest));
}
function replaceMap(target, source) {
    target.clear();
    for (const [key, value] of source)
        target.set(key, value);
}
function objectValue(value, label) {
    const result = plainRecord(value);
    if (!result)
        throw new Error(`${label} must be an object`);
    return result;
}
function plainRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function stringValue(value, label) {
    if (typeof value !== 'string' || !value)
        throw new Error(`${label} must be a non-empty string`);
    return value;
}
function integerValue(value, label) {
    if (!positiveInteger(value))
        throw new Error(`${label} must be a positive integer`);
    return value;
}
function positiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}
function stringArray(value, label) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
        throw new Error(`${label} must be an array of non-empty strings`);
    }
    return [...value];
}
function transitionProvenance(manifest, segmentID, direction) {
    return Object.values(manifest.transitions)
        .filter((transition) => direction === 'incoming'
        ? transition.target_segment_id === segmentID
        : transition.source_segment_id === segmentID)
        .sort((left, right) => left.transition_id.localeCompare(right.transition_id))
        .map((transition) => ({
        transition_id: transition.transition_id,
        status: transition.status,
        source_segment_id: transition.source_segment_id,
        source_run_id: transition.source_occurrence.run_id,
        source_node_id: transition.source_occurrence.qualified_node_id,
        target_segment_id: transition.target_segment_id,
        target_run_id: transition.target_run_id,
        target_runbook_id: transition.target_runbook_id,
        reason_code: transition.reason_code,
        reason_summary: transition.reason_summary,
    }));
}
function jsonEqual(left, right) {
    if (Object.is(left, right))
        return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
            left.every((value, index) => jsonEqual(value, right[index]));
    }
    const leftRecord = plainRecord(left);
    const rightRecord = plainRecord(right);
    if (!leftRecord || !rightRecord)
        return false;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => (key === rightKeys[index] && jsonEqual(leftRecord[key], rightRecord[key])));
}
function validatePreparedTransitionTarget(transition, targetSegment, targetAttempt) {
    const raw = transition;
    const checks = [
        [transition.target_segment_id, targetSegment.segment_id],
        [transition.target_run_id, targetAttempt.run_id],
        [transition.target_runbook_id, targetSegment.runbook_id],
        [targetAttempt.segment_id, targetSegment.segment_id],
        [raw.target_runbook_name, targetSegment.runbook_name],
        [raw.target_plan_hash, targetSegment.plan_hash],
        [raw.target_graph_hash, targetSegment.graph_hash],
        [raw.target_executable_snapshot_hash, targetSegment.executable_snapshot_hash],
    ];
    if (checks.some(([expected, actual]) => expected !== undefined && expected !== '' && expected !== actual) ||
        !targetSegment.attempt_run_ids.includes(targetAttempt.run_id)) {
        throw new Error('committed transition does not match its prepared transition target');
    }
}
function mergeRecordMap(current, update, merge) {
    const result = { ...current };
    for (const [key, value] of Object.entries(update)) {
        result[key] = current[key] === undefined ? value : merge(current[key], value);
    }
    return result;
}
function clonePreparedTransitionTarget(target) {
    return {
        segment: { ...target.segment, attempt_run_ids: [...target.segment.attempt_run_ids] },
        attempt: { ...target.attempt },
    };
}
function validateSessionSegmentGraphBinding(segment, revision, graphHash) {
    const sha256 = /^sha256:[0-9a-f]{64}$/;
    const planHash = /^(?:sha256:)?[0-9a-f]{64}$/;
    if (!Number.isSafeInteger(revision) || revision < 1 || segment.graph_revision !== revision ||
        segment.executable_revision !== revision || segment.graph_hash !== graphHash ||
        !sha256.test(graphHash) || typeof segment.plan_hash !== 'string' || !planHash.test(segment.plan_hash) ||
        typeof segment.executable_snapshot_hash !== 'string' || !sha256.test(segment.executable_snapshot_hash)) {
        throw new Error('session segment graph and executable binding is invalid');
    }
}
function sameGraphBinding(left, right) {
    return left.segment_id === right.segment_id &&
        left.graph_revision === right.graph_revision && left.graph_hash === right.graph_hash &&
        left.executable_revision === right.executable_revision && left.plan_hash === right.plan_hash &&
        left.executable_snapshot_hash === right.executable_snapshot_hash;
}
//# sourceMappingURL=sessionCompositeGraph.js.map