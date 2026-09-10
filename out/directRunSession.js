"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DirectRunSession = exports.STDIO_PROTOCOL_VERSION = void 0;
exports.buildStdioRunArgs = buildStdioRunArgs;
const presentationProjection_1 = require("./presentationProjection");
const displayPresentationJSON_1 = require("./displayPresentationJSON");
const typedResults_1 = require("./typedResults");
const authoringProtocol_1 = require("./authoringProtocol");
exports.STDIO_PROTOCOL_VERSION = 'gert-stdio/v1';
const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;
function buildStdioRunArgs(runbookPath, inputs, packageMapPath, debug = false, privateInputNames = new Set(), routeTestPath, typedResults = false) {
    const args = ['run', '--stdio'];
    if (typedResults)
        args.push('--require-capabilities', 'typed-results/v1,run-results-chunks/v1');
    if (routeTestPath) {
        // The reviewed artifact is authoritative; never mix live input or debug
        // configuration into a zero-dispatch route test.
    }
    else if (debug) {
        args.push('--debug');
    }
    else if (privateInputNames.size > 0) {
        args.push('--configure');
    }
    if (packageMapPath) {
        args.push('--package-map', packageMapPath);
    }
    if (routeTestPath) {
        args.push('--route-test', routeTestPath);
    }
    else {
        for (const name of Object.keys(inputs).sort()) {
            if (privateInputNames.has(name))
                continue;
            args.push('--var', `${name}=${inputs[name]}`);
        }
    }
    args.push(runbookPath);
    return args;
}
class DirectRunSession {
    child;
    callbacks;
    buffer = '';
    runID;
    terminal = false;
    disposed = false;
    finalized = false;
    results;
    constructor(child, callbacks) {
        this.child = child;
        this.callbacks = callbacks;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => this.receive(String(chunk)));
        child.stdout.on('end', () => {
            if (!this.terminal && this.buffer.trim())
                this.parseLine(this.buffer);
            this.buffer = '';
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => callbacks.onStderr?.(String(chunk)));
        child.stdin.on?.('error', (error) => {
            if (!this.disposed)
                this.protocolFailure(error.message);
        });
        child.on('error', (error) => {
            if (!this.disposed)
                callbacks.onError(error.message);
            this.finalize(null, null);
        });
        child.on('close', (code, signal) => this.finalize(code, signal));
    }
    setRunID(runID) {
        this.runID = runID;
    }
    send(command) {
        if (this.disposed || this.terminal)
            return;
        let encoded;
        try {
            encoded = `${JSON.stringify(command)}\n`;
        }
        catch {
            this.protocolFailure('stdio command must be JSON serializable');
            return;
        }
        if (Buffer.byteLength(encoded, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
            this.protocolFailure(`stdio command exceeds ${MAX_PROTOCOL_LINE_BYTES} bytes`);
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
        const shouldCancel = !this.terminal && this.runID && this.child.exitCode === null && !this.child.killed;
        this.disposed = true;
        if (shouldCancel) {
            const cancellation = `${JSON.stringify({
                type: 'run.cancel',
                runID: this.runID,
                reason: 'panel disposed',
            })}\n`;
            try {
                this.child.stdin.write(cancellation);
            }
            catch {
                // The child may have closed stdin before emitting close.
            }
        }
        if (this.child.exitCode === null && !this.child.killed) {
            this.child.kill();
        }
    }
    receive(chunk) {
        if (this.disposed || this.terminal)
            return;
        this.buffer += chunk;
        let newline = this.buffer.indexOf('\n');
        while (newline >= 0) {
            const line = this.buffer.slice(0, newline).trimEnd();
            this.buffer = this.buffer.slice(newline + 1);
            if (Buffer.byteLength(line, 'utf8') + 1 > MAX_PROTOCOL_LINE_BYTES) {
                this.protocolFailure(`stdio protocol line exceeds ${MAX_PROTOCOL_LINE_BYTES} bytes`);
                return;
            }
            if (line)
                this.parseLine(line);
            if (this.disposed || this.terminal)
                return;
            newline = this.buffer.indexOf('\n');
        }
        if (Buffer.byteLength(this.buffer, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
            this.buffer = '';
            this.protocolFailure(`stdio protocol line exceeds ${MAX_PROTOCOL_LINE_BYTES} bytes`);
        }
    }
    parseLine(line) {
        let value;
        const decorations = new Set(['results', 'results_ref', 'results_unavailable']);
        let typedWire = false, invalidDecoration = false, invalidIdentity = false, wireError = false;
        try {
            (0, authoringProtocol_1.visitJSONWire)(line, {
                // The terminal envelope adds one level to a canonical Results record.
                maxDepth: 129,
                onRootValue: (key, value) => {
                    if (decorations.has(key) || (key === 'type' && value === 'run.results.chunk'))
                        typedWire = true;
                },
                onDuplicate: (key, rootKey) => {
                    if (decorations.has(rootKey ?? key))
                        invalidDecoration = true;
                    else if (rootKey === undefined)
                        invalidIdentity = true;
                },
            });
        }
        catch {
            wireError = true;
        }
        try {
            value = (0, displayPresentationJSON_1.parseDisplayJSON)(line);
        }
        catch {
            this.protocolFailure('stdio protocol emitted invalid JSON');
            return;
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            this.protocolFailure('stdio protocol frame must be an object');
            return;
        }
        const frame = value;
        typedWire ||= frame.type === 'run.results.chunk' ||
            [...decorations].some(key => Object.hasOwn(frame, key));
        if (typedWire && (invalidIdentity || wireError)) {
            this.protocolFailure('invalid typed Results wire identity or JSON');
            return;
        }
        if (frame.version !== exports.STDIO_PROTOCOL_VERSION) {
            this.protocolFailure(`unsupported protocol version ${JSON.stringify(frame.version)}`);
            return;
        }
        if (typeof frame.type !== 'string' || frame.type.length === 0) {
            this.protocolFailure('stdio protocol frame type must be a non-empty string');
            return;
        }
        if (frame.type !== 'protocol.error') {
            if (typeof frame.runID !== 'string' || frame.runID.length === 0) {
                this.protocolFailure(`${frame.type} frame requires runID`);
                return;
            }
            if (frame.type === 'run.started') {
                if (this.runID && frame.runID !== this.runID) {
                    this.protocolFailure(`runID ${JSON.stringify(frame.runID)} does not match active run ${JSON.stringify(this.runID)}`);
                    return;
                }
                this.runID = frame.runID;
                this.results ??= new typedResults_1.ResultsAssembly(frame.runID);
            }
            else if (!this.runID || frame.runID !== this.runID) {
                this.protocolFailure(`runID ${JSON.stringify(frame.runID)} does not match active run ${JSON.stringify(this.runID)}`);
                return;
            }
        }
        if (frame.type === 'run.results.chunk') {
            if (invalidDecoration)
                this.results?.rejectWire();
            this.results?.acceptChunk(frame);
            return;
        }
        if (frame.type === 'run.finished') {
            if (invalidDecoration)
                this.results?.rejectWire();
            frame.resultsAvailability = this.results?.complete(frame) ?? { state: 'unavailable', reason: 'no-active-run' };
            // Only the validated canonical document crosses into the webview.
            delete frame.results;
            delete frame.results_ref;
            this.terminal = true;
            this.buffer = '';
        }
        try {
            (0, presentationProjection_1.sanitizeEventFrame)(frame);
        }
        catch {
            this.protocolFailure('invalid run event payload');
            return;
        }
        this.callbacks.onFrame(frame);
    }
    protocolFailure(message) {
        if (this.disposed)
            return;
        this.callbacks.onError(message);
        this.dispose();
    }
    finalize(code, signal) {
        if (this.finalized)
            return;
        this.finalized = true;
        this.disposed = true;
        this.callbacks.onExit(code, signal);
    }
}
exports.DirectRunSession = DirectRunSession;
//# sourceMappingURL=directRunSession.js.map