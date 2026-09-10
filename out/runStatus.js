"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTerminalRunStatus = isTerminalRunStatus;
exports.isSettledStepStatus = isSettledStepStatus;
exports.isIssueStepStatus = isIssueStepStatus;
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'indeterminate', 'blocked', 'denied']);
const SETTLED_STEP_STATUSES = new Set(['completed', 'failed', 'skipped', 'denied', 'indeterminate', 'cancelled', 'blocked']);
const ISSUE_STEP_STATUSES = new Set(['failed', 'denied', 'indeterminate', 'cancelled', 'blocked']);
function isTerminalRunStatus(status) {
    return TERMINAL_RUN_STATUSES.has(status);
}
function isSettledStepStatus(status) {
    return SETTLED_STEP_STATUSES.has(status);
}
function isIssueStepStatus(status) {
    return ISSUE_STEP_STATUSES.has(status);
}
//# sourceMappingURL=runStatus.js.map