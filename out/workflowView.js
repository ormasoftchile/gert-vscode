"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeWorkflowPreference = decodeWorkflowPreference;
exports.mergeWorkflowPreference = mergeWorkflowPreference;
function decodeWorkflowPreference(value) {
    const item = value;
    return { version: 1, workflowMode: item?.version === 1 && item.workflowMode === 'all' ? 'all' : 'workflow' };
}
function mergeWorkflowPreference(state, preference) {
    return { ...(state && typeof state === 'object' && !Array.isArray(state) ? state : {}),
        workflowView: decodeWorkflowPreference(preference) };
}
//# sourceMappingURL=workflowView.js.map