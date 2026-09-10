import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'ormasoftchile.gert-preview';

suite('Installed VSIX production surface', () => {
  test('Workflow Markdown installed production bundle', async function () {
    this.timeout(120000);
    if (!process.env.GERT_WORKFLOW_ARTIFACTS && !process.env.GERT_TEST_GREP?.includes('Workflow Markdown')) this.skip();
    await require('../../../test/helpers/workflow-markdown-native.cjs').verify(vscode, true);
  });
  test('exposes only the direct runbook view and no test or SSE commands', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} must be installed from the VSIX`);
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('gert.previewGraph'));
    assert.ok(!commands.includes('gert.previewLive'));
    assert.ok(!commands.includes('gert.restartServer'));
    assert.ok(!commands.includes('gert.test.openDirectGraphPanel'));
    assert.ok(!commands.includes('gert.test.getRuntimeState'));
    assert.ok(!commands.includes('gert.test.openHostActionPanel'));
    assert.ok(!commands.includes('gert.test.openServedPreviewPanel'));

    const properties = extension.packageJSON.contributes.configuration.properties;
    assert.strictEqual(properties['gert.serverUrl'], undefined);
    assert.strictEqual(properties['gert.autoStartServer'], undefined);
    assert.strictEqual(properties['gert.xts.showHandoffConfirmation'], undefined);
  });
});
