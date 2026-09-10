"use strict";
// toolTokenStore.ts — Extension-host-only tool invocation token store.
//
// The toolInvocationToken is obtainable ONLY from a ChatRequestHandler
// (vscode.chat.createChatParticipant). This module holds the captured token
// in extension-host memory only and exposes it to the MCP bridge.
//
// Security invariants:
//   - Never serialized, logged, or forwarded to Gert Core.
//   - Never placed in env vars, HTTP response bodies, error text, or traces.
//   - Cleared on extension deactivation.
//   - Cleared when VS Code rejects the token (stale session detection).
//   - Never reused across VS Code sessions.
//
// This module deliberately imports NOTHING from `vscode` so it can be
// exercised by plain `node --test` unit tests without a host context.
Object.defineProperty(exports, "__esModule", { value: true });
exports.setToolToken = setToolToken;
exports.getToolToken = getToolToken;
exports.clearToolToken = clearToolToken;
exports.isArmed = isArmed;
exports._resetForTest = _resetForTest;
let _token = undefined;
/** Store the token captured from a ChatRequestHandler arm-mcp command. */
function setToolToken(token) {
    _token = token;
}
/** Return the currently stored token, or undefined when unarmed. */
function getToolToken() {
    return _token;
}
/** Clear the stored token. Call on extension deactivation or token rejection. */
function clearToolToken() {
    _token = undefined;
}
/** True when a token has been captured and the bridge is armed. */
function isArmed() {
    return _token !== undefined;
}
/**
 * Reset the store to the unarmed baseline.
 * Must only be called from test code — never from production paths.
 */
function _resetForTest() {
    _token = undefined;
}
//# sourceMappingURL=toolTokenStore.js.map