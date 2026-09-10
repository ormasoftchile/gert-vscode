"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthoringClient = void 0;
exports.authoringBinaryIdentity = authoringBinaryIdentity;
const promises_1 = require("fs/promises");
const presentationClient_1 = require("./presentationClient");
const authoringProtocol_1 = require("./authoringProtocol");
async function authoringBinaryIdentity(binary, signal) {
    if (signal?.aborted)
        throw new Error('stale-request');
    let abort;
    try {
        const info = await Promise.race([(0, promises_1.stat)(binary), new Promise((_, reject) => {
                abort = () => reject(new Error('stale-request'));
                signal?.addEventListener('abort', abort, { once: true });
            })]);
        return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    }
    catch {
        throw new Error(signal?.aborted ? 'stale-request' : 'helper-unavailable');
    }
    finally {
        if (abort)
            signal?.removeEventListener('abort', abort);
    }
}
class AuthoringClient {
    capabilities = new Map();
    pending = new Map();
    disposed = false;
    cancel() { for (const controller of this.pending.values())
        controller.abort(); this.pending.clear(); }
    dispose() { this.disposed = true; this.cancel(); this.capabilities.clear(); }
    async resolve(binary, request, signal) {
        if (this.disposed || signal?.aborted)
            throw new Error('stale-request');
        const key = `${request.document.uri}\0${request.operation}`;
        this.pending.get(key)?.abort();
        this.pending.delete(key);
        if (this.pending.size >= 16) {
            const oldest = this.pending.keys().next().value;
            this.pending.get(oldest).abort();
            this.pending.delete(oldest);
        }
        const controller = new AbortController(), abort = () => controller.abort();
        this.pending.set(key, controller);
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, 5000);
        const capabilityEntry = { ...this.capabilities.get(binary) };
        if (!this.capabilities.has(binary) && this.capabilities.size >= 32)
            this.capabilities.delete(this.capabilities.keys().next().value);
        this.capabilities.set(binary, capabilityEntry);
        const current = () => {
            if (controller.signal.aborted || this.pending.get(key) !== controller || this.disposed)
                throw new Error('stale-request');
        };
        try {
            let input = JSON.stringify(request);
            if (request.overlays.length > 128 || Buffer.byteLength(input, 'utf8') > authoringProtocol_1.AUTHORING_MAX_BYTES)
                throw new Error('limit-exceeded');
            if (!(0, authoringProtocol_1.validBoundary)(request.document.text, request.position) ||
                [request.document, ...request.overlays].some(b => !(0, authoringProtocol_1.validUnicode)(b.text)))
                throw new Error('invalid-request');
            const identity = await authoringBinaryIdentity(binary, controller.signal);
            current();
            if (capabilityEntry.identity !== identity) {
                capabilityEntry.identity = undefined;
                capabilityEntry.includeVersion = undefined;
                capabilityEntry.typedVersion = undefined;
                if (request.schema_version !== 'authoring-request/v3') {
                    (0, authoringProtocol_1.decodeAuthoringCapabilities)(await (0, presentationClient_1.finiteHelper)(binary, ['authoring', 'capabilities'], '', controller.signal, undefined, authoringProtocol_1.parseAuthoringJSON));
                }
                current();
                if (await authoringBinaryIdentity(binary, controller.signal) !== identity)
                    throw new Error('stale-request');
                current();
                if (this.capabilities.get(binary) === capabilityEntry)
                    capabilityEntry.identity = identity;
            }
            let wireRequest = request;
            if (request.schema_version === 'authoring-request/v3') {
                if (capabilityEntry.typedVersion === undefined) {
                    try {
                        (0, authoringProtocol_1.decodeAuthoringCapabilities)(await (0, presentationClient_1.finiteHelper)(binary, ['authoring', 'capabilities', '--v3'], '', controller.signal, undefined, authoringProtocol_1.parseAuthoringJSON), 3);
                        current();
                        if (await authoringBinaryIdentity(binary, controller.signal) !== identity)
                            throw new Error('stale-request');
                        current();
                        capabilityEntry.typedVersion = 3;
                    }
                    catch (error) {
                        current();
                        if (!(error instanceof Error) || error.message !== 'unsupported-authoring-v3')
                            throw error;
                        capabilityEntry.typedVersion = 2;
                    }
                }
                if (capabilityEntry.typedVersion === 2)
                    wireRequest = { ...request, schema_version: 'authoring-request/v2' };
            }
            if (wireRequest.schema_version === 'authoring-request/v2') {
                if (capabilityEntry.includeVersion === undefined) {
                    let capabilities;
                    try {
                        capabilities = await (0, presentationClient_1.finiteHelper)(binary, ['authoring', 'capabilities', '--v2'], '', controller.signal, undefined, authoringProtocol_1.parseAuthoringJSON);
                    }
                    catch (error) {
                        current();
                        // Only the transport's exact historical CLI rejection proves that
                        // this opt-in is unsupported. Other failures must remain retryable.
                        if (!(error instanceof Error) || error.message !== 'unsupported-authoring-v2')
                            throw error;
                    }
                    current();
                    if (capabilities !== undefined)
                        (0, authoringProtocol_1.decodeAuthoringCapabilities)(capabilities, 2);
                    if (await authoringBinaryIdentity(binary, controller.signal) !== identity)
                        throw new Error('stale-request');
                    current();
                    capabilityEntry.includeVersion = capabilities === undefined ? 1 : 2;
                }
                if (capabilityEntry.includeVersion === 1) {
                    wireRequest = { ...request, schema_version: 'authoring-request/v1' };
                }
            }
            input = JSON.stringify(wireRequest);
            current();
            const reply = (0, authoringProtocol_1.decodeAuthoringReply)(await (0, presentationClient_1.finiteHelper)(binary, ['authoring', request.operation, '--stdio'], input, controller.signal, undefined, authoringProtocol_1.parseAuthoringJSON), wireRequest);
            if (await authoringBinaryIdentity(binary, controller.signal) !== identity) {
                if (this.capabilities.get(binary) === capabilityEntry)
                    capabilityEntry.identity = undefined;
                throw new Error('stale-request');
            }
            current();
            return reply;
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (this.pending.get(key) === controller)
                this.pending.delete(key);
        }
    }
}
exports.AuthoringClient = AuthoringClient;
//# sourceMappingURL=authoringClient.js.map