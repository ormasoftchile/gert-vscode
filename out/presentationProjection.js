"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LIMITED_PRESENTATION_DIAGNOSTIC = exports.INVALID_PRESENTATION_DIAGNOSTIC = void 0;
exports.terminalPresentation = terminalPresentation;
exports.sanitizePresentationPayload = sanitizePresentationPayload;
exports.sanitizeEventFrame = sanitizeEventFrame;
const presentationProtocol_1 = require("./presentationProtocol");
const displayPresentation_1 = require("./displayPresentation");
exports.INVALID_PRESENTATION_DIAGNOSTIC = 'Code presentation unavailable: invalid metadata; output omitted.';
exports.LIMITED_PRESENTATION_DIAGNOSTIC = 'Code presentation unavailable: preview limit exceeded; output omitted.';
function terminalPresentation(payload, previous, expectedDisplaySnapshot = 'missing-binding') {
    if (previous?.displayPresentation || previous?.displayPresentationDiagnostic) {
        const old = { output: previous.output,
            ...(previous.displayPresentation ? { display_presentation: previous.displayPresentation } : {}),
            ...(previous.displayPresentationDiagnostic ? { display_presentation_diagnostic: previous.displayPresentationDiagnostic } : {}) };
        const merged = (0, displayPresentation_1.mergeDisplayPayload)(old, payload, expectedDisplaySnapshot);
        delete payload.display_presentation;
        delete payload.display_presentation_diagnostic;
        Object.assign(payload, merged);
    }
    (0, displayPresentation_1.sanitizeDisplayPayload)(payload, expectedDisplaySnapshot);
    sanitizePresentationPayload(payload);
    const display = {
        displayPresentation: (0, displayPresentation_1.decodeDisplayPresentation)(payload.display_presentation),
        ...(payload.display_presentation_diagnostic ? { displayPresentationDiagnostic: 'Unavailable — invalid frozen Markdown metadata' } : {}),
    };
    if (payload.presentation_diagnostic === 'invalid-metadata' || payload.presentation_diagnostic === 'limit-exceeded') {
        return { ...display, presentationDiagnostic: payload.presentation_diagnostic === 'invalid-metadata'
                ? exports.INVALID_PRESENTATION_DIAGNOSTIC : exports.LIMITED_PRESENTATION_DIAGNOSTIC };
    }
    if (payload.code_presentation === undefined)
        return display;
    const codePresentation = (0, presentationProtocol_1.decodeEnvelope)(payload.code_presentation);
    const outputValueStatus = (0, presentationProtocol_1.decodeOutputStatuses)(codePresentation, payload.output_value_status);
    return { ...display, codePresentation, outputValueStatus };
}
// Sanitize declared slots before event forwarding, caches or tokenization. The
// metadata itself is not permission; missing classifications omit code values.
function sanitizePresentationPayload(payload) {
    (0, displayPresentation_1.sanitizeDisplayPayload)(payload);
    if (payload.presentation_diagnostic === 'invalid-metadata' || payload.presentation_diagnostic === 'limit-exceeded') {
        omitPresentation(payload, payload.presentation_diagnostic);
        return;
    }
    if (payload.code_presentation === undefined)
        return;
    let envelope;
    let statuses;
    try {
        envelope = (0, presentationProtocol_1.decodeEnvelope)(payload.code_presentation);
        statuses = (0, presentationProtocol_1.decodeOutputStatuses)(envelope, payload.output_value_status);
    }
    catch {
        // Only optional decoration decoding is recoverable. Without a trustworthy
        // field list, none of the output can safely fall back to a plaintext view.
        omitPresentation(payload, 'invalid-metadata');
        return;
    }
    payload.code_presentation = envelope;
    payload.output_value_status = statuses;
    if (!payload.output || typeof payload.output !== 'object' || Array.isArray(payload.output))
        return;
    const output = { ...(0, presentationProtocol_1.record)(payload.output) };
    for (const value of (0, presentationProtocol_1.safeOutputs)(envelope, output, payload.output_value_status)) {
        if (value.text === undefined)
            delete output[value.name];
    }
    payload.output = output;
}
function omitPresentation(payload, reason) {
    delete payload.code_presentation;
    delete payload.output_value_status;
    delete payload.output;
    payload.presentation_diagnostic = reason;
}
function sanitizeEventFrame(frame) {
    if (Array.isArray(frame.steps))
        for (const step of frame.steps)
            (0, displayPresentation_1.sanitizeDisplayPayload)((0, presentationProtocol_1.record)(step));
    if (frame.type !== 'run.event')
        return;
    const event = (0, presentationProtocol_1.record)(frame.event ?? frame.payload);
    if (event.kind !== 'step/completed' && event.kind !== 'step/failed')
        return;
    const payload = (0, presentationProtocol_1.record)(event.payload);
    sanitizePresentationPayload(payload);
}
//# sourceMappingURL=presentationProjection.js.map