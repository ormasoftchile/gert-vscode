"use strict";
// panelRecovery.ts — workspace-state-based runbook recovery for the preview panel.
//
// Extracted so the path-resolution logic can be unit-tested without a VS Code host.
Object.defineProperty(exports, "__esModule", { value: true });
exports.WORKSPACE_RUNBOOK_KEY = void 0;
exports.resolveRunbookPath = resolveRunbookPath;
/** Workspace-state key that persists the last successfully opened runbook path. */
exports.WORKSPACE_RUNBOOK_KEY = 'gert.workspaceRunbook';
/**
 * Resolve the runbook path to use for a panel open or recovery.
 *
 * Resolution order:
 *  1. activeEditorPath — if it ends with .runbook.yaml, use it.
 *  2. savedRunbookPath — durable workspace state from a previous open.
 *  3. undefined — caller must surface an "open a runbook first" warning.
 */
function resolveRunbookPath(activeEditorPath, savedRunbookPath) {
    if (activeEditorPath && activeEditorPath.endsWith('.runbook.yaml')) {
        return activeEditorPath;
    }
    if (savedRunbookPath) {
        return savedRunbookPath;
    }
    return undefined;
}
//# sourceMappingURL=panelRecovery.js.map