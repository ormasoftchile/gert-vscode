"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expressionHelperAvailable = expressionHelperAvailable;
exports.resolveExpressionPresentation = resolveExpressionPresentation;
const promises_1 = require("fs/promises");
const presentationClient_1 = require("./presentationClient");
const expressionPresentationProtocol_1 = require("./expressionPresentationProtocol");
const unsupportedCacheMs = 30_000;
const capabilities = new Map();
async function expressionHelperAvailable(binary, signal) {
    if (signal?.aborted)
        return false;
    // Claim ownership before stat: filesystem checks can also finish out of order.
    // The same bounded map tracks pending paths; eviction revokes ownership too.
    const entry = { cached: capabilities.get(binary)?.cached };
    if (!capabilities.has(binary) && capabilities.size >= 32)
        capabilities.delete(capabilities.keys().next().value);
    capabilities.set(binary, entry);
    let identity;
    try {
        const info = await (0, promises_1.stat)(binary);
        identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    }
    catch {
        return false;
    }
    const cached = entry.cached;
    if (signal?.aborted)
        return false;
    if (cached?.identity === identity && cached.expires > Date.now())
        return cached.available;
    entry.cached = undefined;
    let available = false;
    let version = 3;
    try {
        try {
            (0, expressionPresentationProtocol_1.decodeExpressionCapabilities)(await (0, presentationClient_1.finiteHelper)(binary, ['presentation', 'expressions', 'capabilities', '--v3'], '', signal), 3);
        }
        catch (error) {
            if (!(error instanceof Error) || error.message !== 'unsupported-presentation-expressions-capabilities-v3')
                throw error;
            version = 1;
            (0, expressionPresentationProtocol_1.decodeExpressionCapabilities)(await (0, presentationClient_1.finiteHelper)(binary, ['presentation', 'expressions', 'capabilities'], '', signal));
        }
        available = true;
    }
    catch (error) {
        // Transport failures and malformed replies prove nothing about support. Retry
        // only on a later caller request, through the same bounded helper queue.
        if (!(error instanceof Error) || error.message !== 'unsupported-expression-capabilities')
            return false;
    }
    if (signal?.aborted)
        return false;
    if (capabilities.get(binary) === entry) {
        entry.cached = { identity, available, version, expires: available ? Infinity : Date.now() + unsupportedCacheMs };
    }
    return available;
}
async function resolveExpressionPresentation(binary, request, signal) {
    try {
        if (request.overlays.length > 128 || !await expressionHelperAvailable(binary, signal))
            return undefined;
        const version = capabilities.get(binary)?.cached?.version;
        if (!version)
            return undefined;
        const expressionRequest = { ...request, schema_version: version === 3 ? 'expression-resolve/v3' : 'expression-resolve/v1' };
        return (0, expressionPresentationProtocol_1.decodeExpressionReply)(await (0, presentationClient_1.finiteHelper)(binary, ['presentation', 'expressions', 'resolve', '--stdio'], JSON.stringify(expressionRequest), signal), expressionRequest);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=expressionPresentationClient.js.map