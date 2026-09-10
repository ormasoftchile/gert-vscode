"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionStdioClient = exports.SESSION_STDIO_PROTOCOL_VERSION = void 0;
exports.buildSessionStartArgs = buildSessionStartArgs;
exports.buildSessionAttachArgs = buildSessionAttachArgs;
exports.withSessionPackageMap = withSessionPackageMap;
exports.buildSessionGraphArgs = buildSessionGraphArgs;
const presentationProjection_1 = require("./presentationProjection");
const displayPresentationJSON_1 = require("./displayPresentationJSON");
const crypto_1 = require("crypto");
const directGraphPreview_1 = require("./directGraphPreview");
exports.SESSION_STDIO_PROTOCOL_VERSION = 'gert-session-stdio/v1';
const MAX_FRAME_LINE_BYTES = 8 * 1024 * 1024;
const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_SEQUENCE_FRAMES = 4_096;
const MAX_SEQUENCE_BYTES = 128 * 1024 * 1024;
const MAX_GRAPH_BYTES = 128 * 1024 * 1024;
function buildSessionStartArgs(runbookPath, sessionID, commandID, inputs, privateInputNames, toolDirectory) {
    const args = [
        'session', 'start', runbookPath,
        '--session-id', sessionID,
        '--command-id', commandID,
        '--stdio',
        '--tool-dir', toolDirectory,
    ];
    for (const name of Object.keys(inputs).sort()) {
        if (!privateInputNames.has(name))
            args.push('--var', `${name}=${inputs[name]}`);
    }
    return args;
}
function buildSessionAttachArgs(sessionID, afterSequence, toolDirectory) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        throw new Error('session attach sequence must be a non-negative integer');
    }
    return [
        'session', 'attach', sessionID,
        '--stdio', '--after-sequence', String(afterSequence),
        '--tool-dir', toolDirectory,
    ];
}
function withSessionPackageMap(args, packageMapPath) {
    return packageMapPath ? [...args, '--package-map', packageMapPath] : [...args];
}
const frameTypes = new Set([
    'session.started',
    'session.snapshot',
    'segment.added',
    'segment.graph',
    'segment.graph.available',
    'transition.prepared',
    'transition.committed',
    'attempt.started',
    'run.event',
    'interaction.pending',
    'interaction.resolved',
    'attempt.paused',
    'attempt.finished',
    'segment.finished',
    'session.finished',
    'protocol.error',
]);
class SessionStdioClient {
    buffer = '';
    pendingFrames = [];
    pendingFrameBytes = 0;
    disposed = false;
    terminal = false;
    finalized = false;
    currentWriterEpoch = 0;
    currentAcceptedSequence;
    child;
    callbacks;
    sessionID;
    maxSequenceBytes;
    maxGraphBytes;
    constructor(child, options) {
        const { sessionID, afterSequence } = options;
        if (!sessionID || !Number.isSafeInteger(afterSequence) || afterSequence < 0) {
            throw new Error('session stdio client requires a session ID and non-negative replay sequence');
        }
        this.child = child;
        this.callbacks = options;
        this.sessionID = sessionID;
        this.maxSequenceBytes = byteLimit(options.limits?.maxSequenceBytes, MAX_SEQUENCE_BYTES);
        this.maxGraphBytes = byteLimit(options.limits?.maxGraphBytes, MAX_GRAPH_BYTES);
        this.currentAcceptedSequence = afterSequence;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => this.receive(String(chunk)));
        child.stdout.on('end', () => {
            if (this.disposed)
                return;
            if (this.buffer.trim()) {
                this.protocolFailure('session stdio ended with an incomplete frame');
            }
            else if (this.pendingFrames.length > 0) {
                this.protocolFailure('session stdio ended with an incomplete sequence group');
            }
            this.buffer = '';
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => options.onStderr?.(String(chunk)));
        child.stdin.on?.('error', (error) => {
            if (!this.disposed)
                this.protocolFailure(error.message);
        });
        child.on('error', (error) => {
            if (!this.disposed)
                options.onError(error.message);
            this.finalize(null, null);
        });
        child.on('close', (code, signal) => this.finalize(code, signal));
    }
    get acceptedSequence() {
        return this.currentAcceptedSequence;
    }
    get writerEpoch() {
        return this.currentWriterEpoch;
    }
    send(request) {
        if (this.disposed || this.terminal)
            return;
        if (this.currentWriterEpoch < 1 || this.currentAcceptedSequence < 1) {
            this.protocolFailure('session command cannot be sent before the attachment handshake');
            return;
        }
        if (!uuidPattern.test(request.commandID)) {
            this.protocolFailure('session commandID must be a UUID');
            return;
        }
        const command = {
            version: exports.SESSION_STDIO_PROTOCOL_VERSION,
            type: request.type,
            commandID: request.commandID,
            sessionID: this.sessionID,
            writerEpoch: this.currentWriterEpoch,
            expectedSequence: this.currentAcceptedSequence,
            ...(request.segmentID ? { segmentID: request.segmentID } : {}),
            ...(request.runID ? { runID: request.runID } : {}),
            ...(request.turnID ? { turnID: request.turnID } : {}),
            ...(request.payload !== undefined ? { payload: request.payload } : {}),
        };
        let encoded;
        try {
            encoded = `${JSON.stringify(command)}\n`;
        }
        catch {
            this.protocolFailure('session command must be JSON serializable');
            return;
        }
        if (Buffer.byteLength(encoded, 'utf8') > MAX_COMMAND_BYTES) {
            this.protocolFailure(`session command exceeds ${MAX_COMMAND_BYTES} bytes`);
            return;
        }
        try {
            this.child.stdin.write(encoded);
        }
        catch (error) {
            this.protocolFailure(error instanceof Error ? error.message : String(error));
        }
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        if (this.child.exitCode === null && !this.child.killed)
            this.child.kill();
    }
    receive(chunk) {
        if (this.disposed || this.terminal)
            return;
        this.buffer += chunk;
        let newline = this.buffer.indexOf('\n');
        while (newline >= 0) {
            const line = this.buffer.slice(0, newline).trimEnd();
            this.buffer = this.buffer.slice(newline + 1);
            if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_LINE_BYTES) {
                this.protocolFailure(`session stdio frame exceeds ${MAX_FRAME_LINE_BYTES} bytes`);
                return;
            }
            if (line)
                this.parseLine(line);
            if (this.disposed || this.terminal)
                return;
            newline = this.buffer.indexOf('\n');
        }
        if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME_LINE_BYTES) {
            this.buffer = '';
            this.protocolFailure(`session stdio frame exceeds ${MAX_FRAME_LINE_BYTES} bytes`);
        }
    }
    parseLine(line) {
        let value;
        try {
            value = (0, displayPresentationJSON_1.parseDisplayJSON)(line);
        }
        catch {
            this.protocolFailure('session stdio emitted invalid JSON');
            return;
        }
        let frame;
        try {
            frame = parseFrame(value, this.sessionID);
        }
        catch (error) {
            this.protocolFailure(error instanceof Error ? error.message : String(error));
            return;
        }
        this.acceptFrame(frame, Buffer.byteLength(line, 'utf8'));
    }
    acceptFrame(frame, encodedBytes) {
        if (frame.type === 'protocol.error') {
            if (this.pendingFrames.length > 0 || frame.sessionSequence !== this.currentAcceptedSequence ||
                frame.sequenceIndex !== 0 || frame.sequenceCount !== 1) {
                this.protocolFailure('protocol.error does not match the contiguous session cursor');
                return;
            }
            let message;
            try {
                const payload = record(frame.payload, 'session protocol error');
                if (typeof payload.code !== 'string' || !payload.code ||
                    typeof payload.message !== 'string' || !payload.message) {
                    throw new Error('session protocol error payload is invalid');
                }
                message = `${payload.code}: ${payload.message}`;
            }
            catch (error) {
                this.protocolFailure(error instanceof Error ? error.message : String(error));
                return;
            }
            this.protocolFailure(message);
            return;
        }
        const handshake = frame.type === 'session.snapshot' && frame.sessionSequence === this.currentAcceptedSequence;
        if (handshake) {
            if (this.pendingFrames.length > 0 || frame.sequenceIndex !== 0 || frame.sequenceCount !== 1) {
                this.protocolFailure('attachment handshake must be one complete snapshot frame');
                return;
            }
            this.currentWriterEpoch = frame.writerEpoch;
            try {
                this.deliverGroup([frame], [], true);
            }
            catch (error) {
                this.protocolFailure(error instanceof Error ? error.message : String(error));
                return;
            }
            return;
        }
        const expectedSequence = this.currentAcceptedSequence + 1;
        if (frame.sessionSequence !== expectedSequence) {
            this.protocolFailure(`session sequence ${frame.sessionSequence} does not follow ${this.currentAcceptedSequence}`);
            return;
        }
        if (this.pendingFrames.length === 0) {
            if (frame.sequenceIndex !== 0) {
                this.protocolFailure('session sequence group does not start at index 0');
                return;
            }
        }
        else {
            const first = this.pendingFrames[0];
            if (frame.sessionSequence !== first.sessionSequence || frame.sequenceCount !== first.sequenceCount ||
                frame.writerEpoch !== first.writerEpoch || frame.sequenceIndex !== this.pendingFrames.length) {
                this.protocolFailure('session sequence group is not contiguous');
                return;
            }
        }
        if (this.pendingFrameBytes + encodedBytes > this.maxSequenceBytes) {
            this.protocolFailure(`session sequence exceeds ${this.maxSequenceBytes} encoded bytes`);
            return;
        }
        this.pendingFrames.push(frame);
        this.pendingFrameBytes += encodedBytes;
        if (this.pendingFrames.length !== frame.sequenceCount)
            return;
        const frames = this.pendingFrames;
        this.pendingFrames = [];
        this.pendingFrameBytes = 0;
        let graphs;
        try {
            graphs = assembleGraphs(frames, this.maxGraphBytes);
        }
        catch (error) {
            this.protocolFailure(error instanceof Error ? error.message : String(error));
            return;
        }
        try {
            this.deliverGroup(frames, graphs, false);
        }
        catch (error) {
            this.protocolFailure(error instanceof Error ? error.message : String(error));
            return;
        }
        this.currentWriterEpoch = frame.writerEpoch;
        this.currentAcceptedSequence = frame.sessionSequence;
        try {
            this.callbacks.onAcceptedSequence(this.currentAcceptedSequence);
        }
        catch (error) {
            this.protocolFailure(error instanceof Error ? error.message : String(error));
            return;
        }
        if (frames.some((candidate) => candidate.type === 'session.finished'))
            this.terminal = true;
    }
    deliverGroup(frames, graphs, handshake) {
        this.callbacks.onGroup({
            sequence: frames[0].sessionSequence,
            writerEpoch: frames[0].writerEpoch,
            frames,
            graphs,
            handshake,
        });
    }
    protocolFailure(message) {
        if (this.disposed)
            return;
        try {
            this.callbacks.onError(message);
        }
        catch {
            // A host callback cannot leave an untrusted attachment alive.
        }
        finally {
            this.dispose();
        }
    }
    finalize(code, signal) {
        if (this.finalized)
            return;
        this.finalized = true;
        this.disposed = true;
        this.callbacks.onExit(code, signal);
    }
}
exports.SessionStdioClient = SessionStdioClient;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
function parseFrame(value, sessionID) {
    const frame = record(value, 'session stdio frame');
    if (frame.version !== exports.SESSION_STDIO_PROTOCOL_VERSION) {
        throw new Error(`unsupported session protocol version ${JSON.stringify(frame.version)}`);
    }
    if (typeof frame.type !== 'string' || !frameTypes.has(frame.type)) {
        throw new Error(`unsupported session frame type ${JSON.stringify(frame.type)}`);
    }
    if (typeof frame.frameID !== 'string' || !digestPattern.test(frame.frameID)) {
        throw new Error('session frameID must be a SHA-256 digest');
    }
    if (frame.sessionID !== sessionID)
        throw new Error('session frame belongs to a different session');
    const preLeaseError = frame.type === 'protocol.error' && frame.writerEpoch === 0;
    if (preLeaseError) {
        if (!nonNegativeSafeInteger(frame.sessionSequence) || frame.sequenceIndex !== 0 || frame.sequenceCount !== 1) {
            throw new Error('pre-lease protocol.error envelope is invalid');
        }
        return frame;
    }
    if (!positiveSafeInteger(frame.sessionSequence))
        throw new Error('session frame sequence must be positive');
    if (!positiveSafeInteger(frame.sequenceCount) || frame.sequenceCount > MAX_SEQUENCE_FRAMES ||
        !nonNegativeSafeInteger(frame.sequenceIndex) || frame.sequenceIndex >= frame.sequenceCount) {
        throw new Error('session frame group index is invalid');
    }
    if (!positiveSafeInteger(frame.writerEpoch))
        throw new Error('session frame writer epoch must be positive');
    if (frame.segmentID !== undefined && (typeof frame.segmentID !== 'string' || !frame.segmentID)) {
        throw new Error('session frame segmentID must be a non-empty string');
    }
    if (frame.runID !== undefined && (typeof frame.runID !== 'string' || !frame.runID)) {
        throw new Error('session frame runID must be a non-empty string');
    }
    (0, presentationProjection_1.sanitizeEventFrame)(frame);
    return frame;
}
function assembleGraphs(frames, maxGraphBytes) {
    const graphFrames = frames.filter((frame) => frame.type === 'segment.graph');
    const groups = new Map();
    for (const frame of graphFrames) {
        if (!frame.segmentID)
            throw new Error('segment.graph frame requires segmentID');
        const payload = parseGraphChunk(frame.payload);
        const key = `${frame.segmentID}\u0000${payload.graphRevision}\u0000${payload.wholeBlobHash}`;
        groups.set(key, [...(groups.get(key) ?? []), { frame, payload }]);
    }
    const updates = [];
    for (const chunks of groups.values()) {
        chunks.sort((left, right) => left.payload.chunkIndex - right.payload.chunkIndex);
        const first = chunks[0];
        if (chunks.length !== first.payload.chunkCount)
            throw new Error('segment graph chunk set is incomplete');
        const data = [];
        let graphBytes = 0;
        for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index];
            if (chunk.payload.chunkIndex !== index || chunk.payload.chunkCount !== first.payload.chunkCount ||
                chunk.frame.segmentID !== first.frame.segmentID || chunk.frame.runID !== first.frame.runID) {
                throw new Error('segment graph chunks are inconsistent');
            }
            const decoded = decodeBase64(chunk.payload.data);
            graphBytes += decoded.length;
            if (graphBytes > maxGraphBytes)
                throw new Error(`segment graph exceeds ${maxGraphBytes} decoded bytes`);
            data.push(decoded);
        }
        const encoded = Buffer.concat(data);
        const actualDigest = `sha256:${(0, crypto_1.createHash)('sha256').update(encoded).digest('hex')}`;
        if (actualDigest !== first.payload.wholeBlobHash)
            throw new Error('segment graph digest mismatch');
        const encodedDocument = encoded.toString('utf8');
        updates.push({
            segmentID: first.frame.segmentID,
            ...(first.frame.runID ? { runID: first.frame.runID } : {}),
            revision: first.payload.graphRevision,
            wholeBlobHash: first.payload.wholeBlobHash,
            encodedDocument,
            document: (0, directGraphPreview_1.parseGraphDocument)(encodedDocument),
        });
    }
    return updates.sort((left, right) => left.segmentID.localeCompare(right.segmentID) || left.revision - right.revision);
}
function parseGraphChunk(value) {
    const chunk = record(value, 'segment graph chunk');
    if (!positiveSafeInteger(chunk.graphRevision) || !nonNegativeSafeInteger(chunk.chunkIndex) ||
        !positiveSafeInteger(chunk.chunkCount) || chunk.chunkCount > MAX_SEQUENCE_FRAMES ||
        chunk.chunkIndex >= chunk.chunkCount || typeof chunk.wholeBlobHash !== 'string' ||
        !digestPattern.test(chunk.wholeBlobHash) || typeof chunk.data !== 'string') {
        throw new Error('segment graph chunk metadata is invalid');
    }
    return chunk;
}
function decodeBase64(value) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error('segment graph chunk data is not canonical base64');
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value)
        throw new Error('segment graph chunk data is not canonical base64');
    return decoded;
}
function record(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value;
}
function positiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}
function nonNegativeSafeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}
function byteLimit(value, fallback) {
    if (value === undefined)
        return fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > fallback) {
        throw new Error('session stdio byte limit is invalid');
    }
    return value;
}
function buildSessionGraphArgs(sessionID, segmentID, revision) {
    if (!sessionID || !segmentID || !Number.isSafeInteger(revision) || revision < 1) {
        throw new Error('session graph request identity is invalid');
    }
    return [
        'session', 'graph', sessionID,
        '--segment-id', segmentID,
        '--revision', String(revision),
    ];
}
//# sourceMappingURL=sessionStdioClient.js.map