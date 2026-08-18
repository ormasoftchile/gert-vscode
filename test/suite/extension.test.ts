// Extension-host smoke tests — run via `npm run test:e2e` (vscode-test).
//
// These tests execute INSIDE the VS Code extension host. They cannot be run
// with plain `node --test` because they import `vscode`, which is only
// available as a built-in module inside the host process.
//
// Smoke coverage:
//   1. The extension activates without throwing.
//   2. All five declared commands are registered after activation.
//
// Phase 2 tool-discovery, invocation, result-normalisation, auth-unavailable,
// timeout, and cancellation tests belong alongside these, once the LM tools
// API integration (vscode.lm.tools / invokeTool) is implemented.

import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'ormasoftchile.gert-preview';
const EXPECTED_COMMANDS = [
  'gert.preview',
  'gert.previewGraph',
  'gert.validateInputs',
  'gert.showServerLog',
  'gert.restartServer',
];

suite('gert extension smoke tests', () => {
  test('extension is present in the host and activates without error', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(
      ext,
      `extension ${EXTENSION_ID} must be discoverable — check the extensionDevelopmentPath in .vscode-test.mjs`,
    );
    await ext.activate();
    assert.strictEqual(ext.isActive, true, 'extension must report isActive === true after activate()');
  });

  test('all five package.json commands are registered after activation', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} must be present`);
    await ext.activate();
    const registered = await vscode.commands.getCommands(true /* filterInternal */);
    for (const cmd of EXPECTED_COMMANDS) {
      assert.ok(
        registered.includes(cmd),
        `command "${cmd}" must be registered — if it is missing, the contribute.commands entry in package.json is wrong or activate() did not complete`,
      );
    }
  });
});
