"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionGraphCacheStore = exports.CoalescedAsyncWriter = exports.SESSION_GRAPH_CACHE_SCHEMA = exports.STORED_SESSION_SCHEMA = exports.SESSION_WORKSPACE_STATE_KEY = void 0;
exports.parseStoredSessionDescriptor = parseStoredSessionDescriptor;
exports.recoverySequence = recoverySequence;
exports.parseSessionGraphRevisionResponse = parseSessionGraphRevisionResponse;
const promises_1 = require("fs/promises");
const displayPresentationJSON_1 = require("./displayPresentationJSON");
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const displayPresentation_1 = require("./displayPresentation");
const displayObservations_1 = require("./displayObservations");
const directGraphPreview_1 = require("./directGraphPreview");
const sessionCompositeGraph_1 = require("./sessionCompositeGraph");
exports.SESSION_WORKSPACE_STATE_KEY = 'gert.investigationSession.v1';
exports.STORED_SESSION_SCHEMA = 'gert-vscode-session/v1';
exports.SESSION_GRAPH_CACHE_SCHEMA = 'gert-vscode-session-graph-cache/v2';
const MAX_SESSION_GRAPH_CACHE_BYTES = 128 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
function parseStoredSessionDescriptor(value) {
    const source = objectValue(value, 'stored session');
    if (source.schemaVersion !== exports.STORED_SESSION_SCHEMA || !uuidPattern.test(stringValue(source.sessionID, 'session ID')) ||
        !uuidPattern.test(stringValue(source.creationCommandID, 'creation command ID'))) {
        throw new Error('stored session identity is invalid');
    }
    const acceptedSequence = nonNegativeInteger(source.acceptedSequence, 'stored session sequence');
    const configurationCommandID = source.configurationCommandID === undefined
        ? undefined
        : stringValue(source.configurationCommandID, 'configuration command ID');
    if (configurationCommandID !== undefined && !uuidPattern.test(configurationCommandID)) {
        throw new Error('stored session configuration identity is invalid');
    }
    return {
        schemaVersion: exports.STORED_SESSION_SCHEMA,
        sessionID: source.sessionID,
        creationCommandID: source.creationCommandID,
        ...(configurationCommandID ? { configurationCommandID } : {}),
        runbookPath: stringValue(source.runbookPath, 'stored runbook path'),
        projectRoot: stringValue(source.projectRoot, 'stored project root'),
        acceptedSequence,
    };
}
function recoverySequence(_descriptor, cache) {
    if (!cache)
        return 0;
    return Math.min(cache.sequence, cache.manifest.session.sequence);
}
class CoalescedAsyncWriter {
    write;
    onError;
    pending;
    draining;
    constructor(write, onError = () => undefined) {
        this.write = write;
        this.onError = onError;
    }
    enqueue(value) {
        this.pending = value;
        if (!this.draining)
            this.draining = this.drain();
    }
    async flush() {
        while (this.draining)
            await this.draining;
    }
    async drain() {
        try {
            while (this.pending !== undefined) {
                const value = this.pending;
                this.pending = undefined;
                try {
                    await this.write(value);
                }
                catch (error) {
                    this.onError(error);
                }
            }
        }
        finally {
            this.draining = undefined;
            if (this.pending !== undefined)
                this.draining = this.drain();
        }
    }
}
exports.CoalescedAsyncWriter = CoalescedAsyncWriter;
class SessionGraphCacheStore {
    directory;
    constructor(directory) {
        this.directory = directory;
    }
    pathFor(sessionID) {
        if (!uuidPattern.test(sessionID))
            throw new Error('session cache ID must be a UUID');
        return path.join(this.directory, `${sessionID}.json`);
    }
    async load(sessionID) {
        let info;
        try {
            info = await (0, promises_1.stat)(this.pathFor(sessionID));
        }
        catch {
            return undefined;
        }
        if (!info.isFile() || info.size < 2 || info.size > MAX_SESSION_GRAPH_CACHE_BYTES)
            return undefined;
        try {
            const encoded = await (0, promises_1.readFile)(this.pathFor(sessionID), 'utf8');
            return parseSessionGraphCache((0, displayPresentationJSON_1.parseDisplayJSON)(encoded), sessionID, true);
        }
        catch {
            return undefined;
        }
    }
    async save(cache) {
        const validated = parseSessionGraphCache(cache, cache.sessionID);
        const encoded = JSON.stringify({
            ...validated,
            integrityDigest: cacheIntegrityDigest(validated),
        });
        if (Buffer.byteLength(encoded, 'utf8') > MAX_SESSION_GRAPH_CACHE_BYTES) {
            throw new Error('session graph cache exceeds 128 MiB');
        }
        await (0, promises_1.mkdir)(this.directory, { recursive: true });
        const destination = this.pathFor(cache.sessionID);
        const temporary = `${destination}.${process.pid}.${(0, crypto_1.randomUUID)()}.tmp`;
        try {
            await (0, promises_1.writeFile)(temporary, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            await (0, promises_1.rm)(destination, { force: true });
            await (0, promises_1.rename)(temporary, destination);
        }
        finally {
            await (0, promises_1.rm)(temporary, { force: true }).catch(() => undefined);
        }
    }
    async delete(sessionID) {
        await (0, promises_1.rm)(this.pathFor(sessionID), { force: true });
    }
}
exports.SessionGraphCacheStore = SessionGraphCacheStore;
function parseSessionGraphCache(value, expectedSessionID, verifyIntegrity = false) {
    const source = objectValue(value, 'session graph cache');
    if (source.schemaVersion !== exports.SESSION_GRAPH_CACHE_SCHEMA || source.sessionID !== expectedSessionID) {
        throw new Error('session graph cache identity is invalid');
    }
    const sequence = nonNegativeInteger(source.sequence, 'session graph cache sequence');
    const manifest = (0, sessionCompositeGraph_1.parseSessionManifest)(source.manifest, expectedSessionID);
    if (manifest.session.sequence < sequence)
        throw new Error('session graph cache is ahead of its manifest');
    const graphs = objectValue(source.segmentGraphs, 'cached segment graphs');
    const segmentGraphs = {};
    for (const [segmentID, raw] of Object.entries(graphs)) {
        if (!manifest.segments[segmentID])
            throw new Error('cached graph does not belong to a session segment');
        segmentGraphs[segmentID] = parseCachedSegmentGraph(raw);
    }
    const historySource = objectValue(source.segmentGraphHistory, 'cached segment graph history');
    const segmentGraphHistory = {};
    for (const [segmentID, rawRevisions] of Object.entries(historySource)) {
        if (!manifest.segments[segmentID])
            throw new Error('cached graph history does not belong to a session segment');
        const revisions = objectValue(rawRevisions, 'cached segment graph revisions');
        const parsedRevisions = {};
        for (const [revisionKey, raw] of Object.entries(revisions)) {
            const graph = parseCachedSegmentGraph(raw);
            if (revisionKey !== String(graph.revision))
                throw new Error('cached graph revision key does not match its identity');
            parsedRevisions[revisionKey] = graph;
        }
        segmentGraphHistory[segmentID] = parsedRevisions;
    }
    for (const [segmentID, latest] of Object.entries(segmentGraphs)) {
        const archived = segmentGraphHistory[segmentID]?.[String(latest.revision)];
        const current = manifest.segments[segmentID];
        if (!archived || archived.wholeBlobHash !== latest.wholeBlobHash ||
            current.graph_revision !== latest.revision || current.graph_hash !== latest.wholeBlobHash) {
            throw new Error('cached latest graph is missing from revision history');
        }
    }
    const availabilitySource = objectValue(source.segmentGraphAvailability, 'cached graph availability');
    const segmentGraphAvailability = {};
    for (const [segmentID, rawRevisions] of Object.entries(availabilitySource)) {
        const current = manifest.segments[segmentID];
        if (!current)
            throw new Error('cached graph availability has an unknown segment');
        const revisions = objectValue(rawRevisions, 'cached available graph revisions');
        const available = {};
        for (const [revisionKey, raw] of Object.entries(revisions)) {
            const segment = (0, sessionCompositeGraph_1.parseSessionSegment)(raw);
            if (segment.segment_id !== segmentID || revisionKey !== String(segment.graph_revision) ||
                !segment.graph_revision || segment.graph_revision > (current.graph_revision ?? 0) || !segment.graph_hash) {
                throw new Error('cached graph availability metadata is invalid');
            }
            available[revisionKey] = segment;
        }
        segmentGraphAvailability[segmentID] = available;
    }
    const preparedSource = objectValue(source.preparedTransitionTargets, 'cached prepared transition targets');
    const preparedTransitionTargets = {};
    for (const [transitionID, raw] of Object.entries(preparedSource)) {
        if (!manifest.transitions[transitionID])
            throw new Error('cached prepared target has no manifest transition');
        const target = objectValue(raw, 'cached prepared transition target');
        preparedTransitionTargets[transitionID] = {
            segment: (0, sessionCompositeGraph_1.parseSessionSegment)(target.segment),
            attempt: (0, sessionCompositeGraph_1.parseSessionAttempt)(target.attempt),
        };
    }
    const cache = {
        schemaVersion: exports.SESSION_GRAPH_CACHE_SCHEMA,
        sessionID: expectedSessionID,
        sequence,
        manifest,
        segmentGraphs,
        segmentGraphHistory,
        segmentGraphAvailability,
        preparedTransitionTargets,
        runtimeNodes: parseRuntimeNodes(source.runtimeNodes ?? {}, (nodeID, occurrence) => {
            const segmentID = occurrence.segmentID, localID = occurrence.qualifiedNodeID, revision = occurrence.graphRevision;
            if (typeof segmentID !== 'string' || typeof localID !== 'string' || typeof revision !== 'number' ||
                nodeID !== (0, sessionCompositeGraph_1.sessionGraphNodeID)(expectedSessionID, segmentID, localID))
                return undefined;
            const graph = segmentGraphHistory[segmentID]?.[String(revision)] ??
                (segmentGraphs[segmentID]?.revision === revision ? segmentGraphs[segmentID] : undefined);
            return graph?.document.display_plan_snapshot_digest;
        }),
        ...(typeof source.executionNodeID === 'string' && source.executionNodeID
            ? { executionNodeID: source.executionNodeID }
            : {}),
        ...(source.pending === undefined ? {} : { pending: parsePendingInteraction(source.pending) }),
    };
    if (verifyIntegrity) {
        const integrityDigest = stringValue(source.integrityDigest, 'session graph cache integrity digest');
        if (!digestPattern.test(integrityDigest) || cacheIntegrityDigest(cache) !== integrityDigest) {
            throw new Error('session graph cache integrity digest does not match its content');
        }
    }
    return cache;
}
function cacheIntegrityDigest(cache) {
    return `sha256:${(0, crypto_1.createHash)('sha256').update(JSON.stringify(cache), 'utf8').digest('hex')}`;
}
function parseRuntimeNodes(value, snapshotFor) {
    const source = objectValue(value, 'cached runtime nodes');
    const result = {};
    for (const [nodeID, raw] of Object.entries(source)) {
        const state = objectValue(raw, 'cached runtime node');
        const displayScope = state.displayPresentation !== undefined || state.displayPresentationDiagnostic !== undefined ||
            state.displayObservations !== undefined || (Array.isArray(state.occurrences) && state.occurrences.some(value => value && typeof value === 'object' && ('displayPresentation' in value || 'displayPresentationDiagnostic' in value)));
        const sanitize = (value) => {
            const directDisplaySnapshot = snapshotFor(nodeID, value) ?? 'missing-binding';
            if (value.displayPresentation === undefined && value.displayPresentationDiagnostic === undefined)
                return { ...value, ...(displayScope ? { directDisplaySnapshot } : {}) };
            const payload = { display_presentation: value.displayPresentation, output: value.output,
                display_presentation_diagnostic: value.displayPresentationDiagnostic };
            (0, displayPresentation_1.sanitizeDisplayPayload)(payload, snapshotFor(nodeID, value) ?? 'missing-binding');
            return { ...value, directDisplaySnapshot, output: payload.output, displayPresentation: (0, displayPresentation_1.decodeDisplayPresentation)(payload.display_presentation),
                displayPresentationDiagnostic: payload.display_presentation_diagnostic };
        };
        result[nodeID] = (0, displayObservations_1.reconcileRuntimeDisplayState)({
            ...sanitize(state),
            ...(Array.isArray(state.occurrences) ? {
                occurrences: state.occurrences.map(value => sanitize(objectValue(value, 'cached occurrence'))),
            } : {}),
            status: stringValue(state.status, 'cached runtime status'),
        });
    }
    return result;
}
function parsePendingInteraction(value) {
    const pending = objectValue(value, 'cached pending interaction');
    return {
        ...pending,
        type: 'pending',
        turnID: stringValue(pending.turnID, 'cached pending turn'),
        runID: stringValue(pending.runID, 'cached pending run'),
        stepID: stringValue(pending.stepID, 'cached pending step'),
        nodeID: stringValue(pending.nodeID, 'cached pending node'),
        kind: stringValue(pending.kind, 'cached pending kind'),
    };
}
function objectValue(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value;
}
function stringValue(value, label) {
    if (typeof value !== 'string' || !value)
        throw new Error(`${label} must be a non-empty string`);
    return value;
}
function nonNegativeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative integer`);
    }
    return value;
}
function positiveInteger(value, label) {
    const result = nonNegativeInteger(value, label);
    if (result < 1)
        throw new Error(`${label} must be positive`);
    return result;
}
function parseCachedSegmentGraph(value) {
    const graph = objectValue(value, 'cached segment graph');
    const revision = positiveInteger(graph.revision, 'cached graph revision');
    const wholeBlobHash = stringValue(graph.wholeBlobHash, 'cached graph digest');
    if (!digestPattern.test(wholeBlobHash))
        throw new Error('cached graph digest is invalid');
    const encodedDocument = stringValue(graph.encodedDocument, 'cached graph document');
    const actualDigest = `sha256:${(0, crypto_1.createHash)('sha256').update(encodedDocument, 'utf8').digest('hex')}`;
    if (actualDigest !== wholeBlobHash)
        throw new Error('cached graph digest does not match its document');
    const document = (0, directGraphPreview_1.parseGraphDocument)(encodedDocument);
    if (graph.document !== undefined && JSON.stringify(graph.document) !== JSON.stringify(document)) {
        throw new Error('cached parsed graph does not match its verified document');
    }
    const segmentSnapshot = (0, sessionCompositeGraph_1.parseSessionSegment)(graph.segmentSnapshot);
    (0, sessionCompositeGraph_1.validateSessionSegmentGraphBinding)(segmentSnapshot, revision, wholeBlobHash);
    (0, directGraphPreview_1.validateSessionPresentationBinding)(document, segmentSnapshot.executable_snapshot_hash);
    return { revision, wholeBlobHash, encodedDocument, document, segmentSnapshot };
}
function parseSessionGraphRevisionResponse(encoded, expectedSessionID, expectedSegmentID, expectedRevision) {
    if (Buffer.byteLength(encoded, 'utf8') > MAX_SESSION_GRAPH_CACHE_BYTES * 2) {
        throw new Error('session graph response exceeds limits');
    }
    const source = objectValue((0, displayPresentationJSON_1.parseDisplayJSON)(encoded), 'session graph response');
    if (source.schema_version !== 'session-graph-revision/v1' || source.session_id !== expectedSessionID ||
        source.graph_revision !== expectedRevision || typeof source.data !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.data)) {
        throw new Error('session graph response identity is invalid');
    }
    const segmentSnapshot = (0, sessionCompositeGraph_1.parseSessionSegment)(source.segment);
    const wholeBlobHash = stringValue(source.graph_hash, 'session graph response digest');
    if (segmentSnapshot.segment_id !== expectedSegmentID || segmentSnapshot.graph_revision !== expectedRevision ||
        segmentSnapshot.graph_hash !== wholeBlobHash || !digestPattern.test(wholeBlobHash)) {
        throw new Error('session graph response metadata does not match its request');
    }
    (0, sessionCompositeGraph_1.validateSessionSegmentGraphBinding)(segmentSnapshot, expectedRevision, wholeBlobHash);
    const graphBytes = Buffer.from(source.data, 'base64');
    if (graphBytes.toString('base64') !== source.data || graphBytes.length > MAX_SESSION_GRAPH_CACHE_BYTES) {
        throw new Error('session graph response data is invalid');
    }
    const encodedDocument = graphBytes.toString('utf8');
    const actualDigest = `sha256:${(0, crypto_1.createHash)('sha256').update(graphBytes).digest('hex')}`;
    if (actualDigest !== wholeBlobHash)
        throw new Error('session graph response digest mismatch');
    const document = (0, directGraphPreview_1.parseGraphDocument)(encodedDocument);
    (0, directGraphPreview_1.validateSessionPresentationBinding)(document, segmentSnapshot.executable_snapshot_hash);
    return {
        revision: expectedRevision,
        wholeBlobHash,
        encodedDocument,
        document,
        segmentSnapshot,
    };
}
//# sourceMappingURL=sessionPanelState.js.map