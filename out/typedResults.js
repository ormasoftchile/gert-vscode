"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResultsAssembly = exports.MAX_RESULTS_CHUNK_BYTES = exports.MAX_RESULTS_BYTES = exports.canonicalResultsJSON = void 0;
exports.publicationDigest = publicationDigest;
exports.validateResults = validateResults;
const node_crypto_1 = require("node:crypto");
const typedResultsCanonical_1 = require("./typedResultsCanonical");
var typedResultsCanonical_2 = require("./typedResultsCanonical");
Object.defineProperty(exports, "canonicalResultsJSON", { enumerable: true, get: function () { return typedResultsCanonical_2.canonicalResultsJSON; } });
Object.defineProperty(exports, "MAX_RESULTS_BYTES", { enumerable: true, get: function () { return typedResultsCanonical_2.MAX_RESULTS_BYTES; } });
exports.MAX_RESULTS_CHUNK_BYTES = 64 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('invalid-results-object');
    return value;
}
function keys(value, required, optional = []) {
    if (required.some(key => !own(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
        throw new Error('invalid-results-fields');
    }
}
function text(value) { return typeof value === 'string' && value.length > 0 && value.length <= 32768; }
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function publicationDigest(value) {
    const { digest: _, ...body } = value;
    return `sha256:${(0, node_crypto_1.createHash)('sha256').update((0, typedResultsCanonical_1.canonicalResultsJSON)(body)).digest('hex')}`;
}
function validateResults(value) {
    const item = record(value);
    keys(item, ['schema_version', 'publication_id', 'plan_snapshot_digest', 'checkpoint_sequence', 'origin', 'outputs', 'digest']);
    if (item.schema_version !== 'run-results/v1' || !text(item.publication_id) ||
        typeof item.plan_snapshot_digest !== 'string' || !DIGEST.test(item.plan_snapshot_digest) ||
        typeof item.digest !== 'string' || !DIGEST.test(item.digest) || !positive(item.checkpoint_sequence)) {
        throw new Error('invalid-results-identity');
    }
    const origin = record(item.origin);
    keys(origin, ['node_id', 'invocation'], ['frame_id']);
    if (!text(origin.node_id) || !positive(origin.invocation) || (own(origin, 'frame_id') && !text(origin.frame_id))) {
        throw new Error('invalid-results-origin');
    }
    for (const [name, raw] of Object.entries(record(item.outputs))) {
        if (!text(name))
            throw new Error('invalid-result-name');
        const output = record(raw);
        keys(output, ['type', 'value']);
        const value = output.value;
        switch (output.type) {
            case 'any': break;
            case 'string':
                if (typeof value !== 'string')
                    throw new Error('invalid-result-type');
                break;
            case 'bool':
            case 'boolean':
                if (typeof value !== 'boolean')
                    throw new Error('invalid-result-type');
                break;
            case 'int':
            case 'integer':
                if (!Number.isInteger(value))
                    throw new Error('invalid-result-type');
                break;
            case 'number':
            case 'float':
                if (typeof value !== 'number' || !Number.isFinite(value))
                    throw new Error('invalid-result-type');
                break;
            case 'array':
                if (!Array.isArray(value))
                    throw new Error('invalid-result-type');
                break;
            case 'object':
                record(value);
                break;
            default: throw new Error('unsupported-or-protected-result-type');
        }
    }
    if (publicationDigest(item) !== item.digest)
        throw new Error('results-digest-mismatch');
    return item;
}
/** One bounded assembly for one run; transport errors never replace execution status. */
class ResultsAssembly {
    runID;
    identity;
    bytes;
    boundaries;
    received = 0;
    failure;
    finished = false;
    constructor(runID) {
        this.runID = runID;
    }
    rejectWire() {
        this.failure = 'duplicate-results-member';
        this.bytes = undefined;
        this.boundaries = undefined;
    }
    acceptChunk(value) {
        if (this.failure || this.finished)
            return;
        try {
            keys(value, ['version', 'type', 'runID', 'publicationID', 'digest', 'offset', 'totalBytes', 'data']);
            if (value.version !== 'gert-stdio/v1' || value.type !== 'run.results.chunk' || value.runID !== this.runID ||
                !text(value.publicationID) || typeof value.digest !== 'string' || !DIGEST.test(value.digest) ||
                !positive(value.totalBytes) || value.totalBytes > typedResultsCanonical_1.MAX_RESULTS_BYTES ||
                !Number.isSafeInteger(value.offset) || value.offset < 0 || typeof value.data !== 'string' ||
                value.data.length > Math.ceil(exports.MAX_RESULTS_CHUNK_BYTES / 3) * 4 ||
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) {
                throw new Error('invalid-results-chunk');
            }
            const data = Buffer.from(value.data, 'base64'), offset = value.offset;
            if (!data.length || data.length > exports.MAX_RESULTS_CHUNK_BYTES || data.toString('base64') !== value.data ||
                offset > value.totalBytes - data.length)
                throw new Error('invalid-results-chunk');
            if (!this.identity) {
                if (offset !== 0)
                    throw new Error('results-missing-chunk');
                this.identity = { publicationID: value.publicationID, digest: value.digest, totalBytes: value.totalBytes };
                this.bytes = Buffer.alloc(value.totalBytes);
                this.boundaries = new Uint8Array(Math.floor(value.totalBytes / 8) + 1);
                this.boundaries[0] = 1;
            }
            if (this.identity.publicationID !== value.publicationID || this.identity.digest !== value.digest ||
                this.identity.totalBytes !== value.totalBytes)
                throw new Error('results-chunk-identity-mismatch');
            if (offset < this.received) {
                const end = offset + data.length;
                const boundary = (index) => (this.boundaries[Math.floor(index / 8)] & (1 << (index % 8))) !== 0;
                let exactPreviousChunk = end <= this.received && boundary(offset) && boundary(end);
                for (let index = offset + 1; exactPreviousChunk && index < end; index++) {
                    if (boundary(index))
                        exactPreviousChunk = false;
                }
                if (exactPreviousChunk && this.bytes.subarray(offset, end).equals(data))
                    return;
                throw new Error('results-conflicting-chunk');
            }
            if (offset !== this.received)
                throw new Error('results-missing-chunk');
            data.copy(this.bytes, offset);
            this.received += data.length;
            this.boundaries[Math.floor(this.received / 8)] |= 1 << (this.received % 8);
        }
        catch (error) {
            this.failure = error instanceof Error ? error.message : 'results-unavailable';
            this.bytes = undefined;
            this.boundaries = undefined;
        }
    }
    complete(frame) {
        if (this.finished)
            return { state: 'unavailable', reason: 'results-already-settled' };
        this.finished = true;
        try {
            if (frame.runID !== this.runID)
                throw new Error('results-run-mismatch');
            if (frame.status !== 'completed')
                throw new Error('execution-not-completed');
            if (this.failure)
                throw new Error(this.failure);
            if (frame.results_unavailable !== undefined) {
                const unavailable = record(frame.results_unavailable);
                keys(unavailable, ['status', 'reason']);
                if (frame.results !== null || frame.results_ref !== undefined || this.identity ||
                    !['unavailable', 'redacted'].includes(unavailable.status) ||
                    !['no-publication', 'execution-not-completed', 'invalid-publication', 'protected-content', 'protection-unavailable'].includes(unavailable.reason)) {
                    throw new Error('invalid-results-unavailability');
                }
                return { state: 'unavailable', status: unavailable.status, reason: unavailable.reason };
            }
            const inline = frame.results !== null && frame.results !== undefined;
            if (inline && (frame.results_ref !== undefined || this.identity))
                throw new Error('ambiguous-results-transport');
            if (inline) {
                const publication = validateResults(frame.results);
                return { state: 'available', publication, canonicalJSON: (0, typedResultsCanonical_1.canonicalResultsJSON)(publication) };
            }
            if (!frame.results_ref)
                throw new Error('no-results-publication');
            const ref = record(frame.results_ref);
            keys(ref, ['schema_version', 'publication_id', 'digest', 'total_bytes']);
            if (!this.identity || ref.schema_version !== 'run-results/v1' ||
                ref.publication_id !== this.identity.publicationID || ref.digest !== this.identity.digest ||
                ref.total_bytes !== this.identity.totalBytes)
                throw new Error('results-reference-mismatch');
            if (!this.bytes || this.received !== this.identity.totalBytes)
                throw new Error('results-incomplete');
            const text = new TextDecoder('utf-8', { fatal: true }).decode(this.bytes);
            const publication = validateResults(JSON.parse(text));
            if ((0, typedResultsCanonical_1.canonicalResultsJSON)(publication) !== text)
                throw new Error('results-noncanonical-transport');
            if (publication.publication_id !== ref.publication_id || publication.digest !== ref.digest)
                throw new Error('results-reference-mismatch');
            return { state: 'available', publication, canonicalJSON: text };
        }
        catch (error) {
            return { state: 'unavailable', reason: error instanceof Error ? error.message : 'results-unavailable' };
        }
        finally {
            this.bytes = undefined;
            this.boundaries = undefined;
        }
    }
}
exports.ResultsAssembly = ResultsAssembly;
//# sourceMappingURL=typedResults.js.map