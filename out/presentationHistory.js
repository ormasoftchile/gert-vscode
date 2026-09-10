"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodePresentationState = decodePresentationState;
const presentationProtocol_1 = require("./presentationProtocol");
const presentationProjection_1 = require("./presentationProjection");
const stepDetails_1 = require("./stepDetails");
const displayPresentation_1 = require("./displayPresentation");
function decodePresentationState(value) {
    const state = (0, presentationProtocol_1.record)(value);
    // An empty Go slice is null in native frozen graphs.
    if (state.occurrences === null)
        state.occurrences = [];
    if (Object.keys(state).some(k => !['run_id', 'plan_snapshot_digest', 'checkpoint_sequence', 'occurrences'].includes(k)) ||
        typeof state.run_id !== 'string' || !state.run_id || typeof state.plan_snapshot_digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(state.plan_snapshot_digest) ||
        typeof state.checkpoint_sequence !== 'number' || !Number.isSafeInteger(state.checkpoint_sequence) || state.checkpoint_sequence < 0 ||
        !Array.isArray(state.occurrences) || state.occurrences.length > 4096)
        throw new Error('invalid-presentation-state');
    const seen = new Set();
    const snapshotDigest = state.plan_snapshot_digest;
    const occurrences = state.occurrences.map(item => {
        const occurrence = (0, presentationProtocol_1.record)(item), identity = (0, presentationProtocol_1.record)(occurrence.identity), details = (0, presentationProtocol_1.record)(occurrence.details);
        if (Object.keys(occurrence).some(k => !['identity', 'details', 'output', 'output_value_status', 'display_presentation', 'display_presentation_diagnostic'].includes(k)))
            throw new Error('invalid-retained-occurrence');
        const strings = ['qualified_node_id', 'frame_id', 'event_id', 'dispatch_occurrence_id'];
        const numbers = ['frame_step_index', 'invocation', 'retry_attempt', 'occurrence_sequence'];
        if (typeof identity.qualified_node_id !== 'string' || !identity.qualified_node_id)
            throw new Error('missing-occurrence-identity');
        for (const [key, val] of Object.entries(identity)) {
            if (strings.includes(key)) {
                if (typeof val !== 'string' || !val)
                    throw new Error('invalid-occurrence-identity');
            }
            else if (numbers.includes(key)) {
                if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0)
                    throw new Error('invalid-occurrence-identity');
            }
            else
                throw new Error('invalid-occurrence-identity');
        }
        const key = JSON.stringify(Object.keys(identity).sort().map(name => [name, identity[name]]));
        if (seen.has(key))
            throw new Error('ambiguous-occurrence-identity');
        seen.add(key);
        if (typeof details.kind !== 'string')
            throw new Error('invalid-occurrence-details');
        const parsed = (0, stepDetails_1.parseStepDetails)(details, details.kind, 'retained occurrence');
        if (details.kind === 'display') {
            const metadata = details.format === 'markdown' && Object.keys((0, presentationProtocol_1.record)(occurrence.output_value_status)).length === 0
                ? (0, displayPresentation_1.decodeDisplayPresentation)(occurrence.display_presentation, snapshotDigest) : undefined;
            const projection = {
                display_presentation: metadata, output: occurrence.output,
                ...(!metadata || occurrence.display_presentation_diagnostic !== undefined
                    ? { display_presentation_diagnostic: 'invalid-metadata' } : {}),
            };
            (0, displayPresentation_1.sanitizeDisplayPayload)(projection, snapshotDigest);
            const explicit = Object.prototype.hasOwnProperty.call(occurrence, 'display_presentation') ||
                Object.prototype.hasOwnProperty.call(occurrence, 'display_presentation_diagnostic');
            const retainedMetadata = (0, displayPresentation_1.decodeDisplayPresentation)(projection.display_presentation, snapshotDigest);
            // Metadata-only history adapters must carry explicit withdrawal through
            // normalization. This authorizes no value; absent legacy metadata remains
            // unclassified rather than becoming a withdrawal.
            const withdrawnMetadata = explicit && !retainedMetadata ? {
                version: 1, format: 'markdown', output_field: 'content', origin: 'frozen',
                plan_snapshot_digest: snapshotDigest, value_status: 'unavailable',
            } : undefined;
            return { identity: identity, details: parsed,
                output: (0, presentationProtocol_1.record)(projection.output), output_value_status: {},
                ...(retainedMetadata || withdrawnMetadata ? { display_presentation: retainedMetadata ?? withdrawnMetadata } : {}),
                ...(explicit && projection.display_presentation_diagnostic ? { display_presentation_diagnostic: 'invalid-metadata' } : {}) };
        }
        const envelope = parsed.code_presentation;
        if (!envelope || envelope.origin !== 'frozen' || envelope.plan_snapshot_digest !== state.plan_snapshot_digest)
            throw new Error('invalid-frozen-presentation');
        const output = (0, presentationProtocol_1.record)(occurrence.output);
        const output_value_status = (0, presentationProtocol_1.decodeOutputStatuses)(envelope, occurrence.output_value_status);
        const projection = { code_presentation: envelope, output, output_value_status };
        (0, presentationProjection_1.sanitizePresentationPayload)(projection);
        return { identity: identity, details: parsed, output: projection.output, output_value_status };
    });
    return { run_id: state.run_id, plan_snapshot_digest: state.plan_snapshot_digest, checkpoint_sequence: state.checkpoint_sequence, occurrences };
}
//# sourceMappingURL=presentationHistory.js.map