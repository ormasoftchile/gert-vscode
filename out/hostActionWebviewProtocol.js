"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseHostActionResponse = parseHostActionResponse;
const WIRE_VERSION = 'host-action/v1';
const ACK_TYPE = 'gert.host-action.ack';
const CANCEL_TYPE = 'gert.host-action.cancel';
const MAX_ENVELOPE_STRING_LENGTH = 1024;
const ACK_FIELDS = new Set([
    'type', 'version', 'capability', 'correlationId', 'previewSessionId', 'requestId',
    'runId', 'turnId', 'status', 'result', 'error',
]);
const CANCEL_FIELDS = new Set([
    'type', 'version', 'correlationId', 'previewSessionId', 'requestId', 'status', 'reason',
]);
const ACK_STATUSES = new Set(['completed', 'failed', 'unsupported', 'timed-out', 'execution-not-started']);
const CANCEL_REASONS = new Set(['panel-disposed', 'run-replaced', 'reload']);
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactFields(value, fields) {
    const keys = Object.keys(value);
    return keys.length === fields.size && keys.every((key) => fields.has(key));
}
function isWireString(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_ENVELOPE_STRING_LENGTH;
}
function isAckError(value) {
    return isRecord(value) && hasExactFields(value, new Set(['code', 'message'])) &&
        isWireString(value.code) && isWireString(value.message);
}
function parseHostActionResponse(value) {
    if (!isRecord(value) || value.version !== WIRE_VERSION)
        return undefined;
    if (value.type === CANCEL_TYPE) {
        if (!hasExactFields(value, CANCEL_FIELDS) || value.status !== 'execution-not-started' ||
            !CANCEL_REASONS.has(String(value.reason)) || !isWireString(value.correlationId) ||
            !isWireString(value.previewSessionId) || !isWireString(value.requestId))
            return undefined;
        return value;
    }
    if (value.type !== ACK_TYPE || !hasExactFields(value, ACK_FIELDS) ||
        !ACK_STATUSES.has(String(value.status)) || !isWireString(value.capability) ||
        !isWireString(value.correlationId) || !isWireString(value.previewSessionId) ||
        !isWireString(value.requestId) || !isWireString(value.runId) || !isWireString(value.turnId))
        return undefined;
    if (value.status === 'completed') {
        if (!isRecord(value.result) || value.error !== null)
            return undefined;
    }
    else if (value.result !== null || !isAckError(value.error)) {
        return undefined;
    }
    return value;
}
//# sourceMappingURL=hostActionWebviewProtocol.js.map