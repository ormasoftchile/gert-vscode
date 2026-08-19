// runHandoff.ts — pure, vscode-free implementation of the Run Authenticated
// handoff sequence (steps 3-5 of runAuthenticated in extension.ts).
//
// Extracted so the security-critical path — collect inputs, stash them,
// build a chat query containing ONLY the nonce, open chat — is testable
// without a VS Code runtime.
//
// Security contract: collectedInputs may contain secret values. They are
// stashed via the injected stashPendingRun collaborator and MUST NOT appear
// in the query string or any log line.  The returned RunHandoffResult exposes
// the query and nonce so tests can assert this invariant on the real
// production path.
//
// No vscode imports — fully testable with plain node --test.

import { CANCELLED, UNSET, InputDecl } from './enumInputs';

export { CANCELLED, UNSET } from './enumInputs';

/** Injected collaborators — all production implementations live in extension.ts. */
export interface RunHandoffDeps {
  /** Prompt the operator for a single required input. */
  promptForInput(decl: InputDecl): Promise<string | typeof CANCELLED | typeof UNSET>;
  /** Stash inputs in extension-host memory; returns the single-use nonce. */
  stashPendingRun(runbookPath: string, inputs: Record<string, string>): string;
  /** Build the chat query string (nonce + optional runbookPath). */
  buildRunChatQuery(nonce: string, runbookPath: string): string;
  /** Execute a VS Code command (e.g. workbench.action.chat.open). */
  executeCommand(command: string, opts: { query: string; isPartialQuery: boolean }): Promise<unknown>;
}

/** What performRunHandoff returns on success. */
export interface RunHandoffResult {
  /** The exact query string passed to the chat-open command. */
  query: string;
  /** The nonce used to key the pending-run entry. */
  nonce: string;
  /** The inputs that were stashed (shadow copy for test assertion). */
  collectedInputs: Record<string, string>;
}

/**
 * Execute the handoff sequence for a Run Authenticated command.
 *
 * 1. Prompt for each required input (via deps.promptForInput).
 * 2. Stash inputs → obtain nonce (via deps.stashPendingRun).
 * 3. Build the chat query (via deps.buildRunChatQuery).
 * 4. Open chat (via deps.executeCommand).
 *
 * Returns undefined if the operator cancelled any input prompt.
 * Returns RunHandoffResult on success — callers may assert on query/nonce.
 */
export async function performRunHandoff(
  runbookPath: string,
  requiredDecls: InputDecl[],
  deps: RunHandoffDeps,
): Promise<RunHandoffResult | undefined> {
  const collectedInputs: Record<string, string> = {};

  for (const decl of requiredDecls) {
    const result = await deps.promptForInput(decl);
    if (result === CANCELLED) return undefined;
    if (result !== UNSET) collectedInputs[decl.name] = result;
  }

  const nonce = deps.stashPendingRun(runbookPath, collectedInputs);
  const query = deps.buildRunChatQuery(nonce, runbookPath);

  await deps.executeCommand('workbench.action.chat.open', {
    query,
    isPartialQuery: false,
  });

  return { query, nonce, collectedInputs };
}
