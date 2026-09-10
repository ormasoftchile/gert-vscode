"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DISPLAY_MAX_UTF16 = void 0;
exports.decodeDisplayPresentation = decodeDisplayPresentation;
exports.selectDisplayPresentation = selectDisplayPresentation;
exports.hasDisplayPayload = hasDisplayPayload;
exports.sanitizeDisplayPayload = sanitizeDisplayPayload;
exports.mergeDisplayPayload = mergeDisplayPayload;
// Release-only containment. Paused decoration cannot authorize content or rendering.
// Legacy undecorated output and independent code-presentation protections remain unchanged.
exports.DISPLAY_MAX_UTF16 = 32768;
function decodeDisplayPresentation(_value, _snapshotDigest) {
    return undefined;
}
function selectDisplayPresentation(_metadata, _output, _snapshotDigest, _diagnostic) {
    return { status: 'unavailable', reason: 'Display decoration is paused in this release' };
}
function hasDisplayPayload(value) {
    return 'display_presentation' in value || 'display_presentation_diagnostic' in value;
}
function sanitizeDisplayPayload(payload, _snapshotDigest) {
    if (!hasDisplayPayload(payload))
        return;
    if (payload.output && typeof payload.output === 'object' && !Array.isArray(payload.output)) {
        const { content: _, ...output } = payload.output;
        payload.output = output;
    }
    delete payload.display_presentation;
    payload.display_presentation_diagnostic = 'feature-paused';
}
function mergeDisplayPayload(previous, incoming, snapshotDigest) {
    const result = { ...previous, ...incoming };
    // A paused/withheld observation cannot regain its content through a late plain preview.
    if (hasDisplayPayload(previous) || hasDisplayPayload(incoming))
        result.display_presentation_diagnostic = 'feature-paused';
    sanitizeDisplayPayload(result, snapshotDigest);
    return result;
}
//# sourceMappingURL=displayPresentation.js.map