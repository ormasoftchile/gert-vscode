const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'indeterminate']);
const SETTLED_STEP_STATUSES = new Set(['completed', 'failed', 'skipped', 'denied', 'indeterminate', 'cancelled']);
const ISSUE_STEP_STATUSES = new Set(['failed', 'denied', 'indeterminate', 'cancelled']);

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function isSettledStepStatus(status: string): boolean {
  return SETTLED_STEP_STATUSES.has(status);
}

export function isIssueStepStatus(status: string): boolean {
  return ISSUE_STEP_STATUSES.has(status);
}