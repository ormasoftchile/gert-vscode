// VS Code extension entry point.
//
// Registers two commands:
//
//   gert.preview      — runs `gert preview --format prose <activeFile>` and
//                       opens the result in a Markdown preview pane. Works
//                       fully offline; no server needed.
//
//   gert.previewGraph — opens a webview that iframes the gert server's
//                       /preview/ page. The server is auto-spawned by the
//                       extension if `gert.autoStartServer` is true (the
//                       default); otherwise the user is expected to run
//                       `gert serve` themselves and configure
//                       `gert.serverUrl`.

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { ServerManager } from './serverManager';

const pexec = promisify(execFile);

let serverManager: ServerManager | null = null;
let output: vscode.OutputChannel | null = null;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('gert');
  serverManager = new ServerManager(output);

  context.subscriptions.push(
    output,
    { dispose: () => serverManager?.dispose() },
    vscode.commands.registerCommand('gert.preview', () => previewProse()),
    vscode.commands.registerCommand('gert.previewGraph', () => previewGraph()),
    vscode.commands.registerCommand('gert.showServerLog', () => output?.show(true)),
    vscode.commands.registerCommand('gert.restartServer', async () => {
      serverManager?.dispose();
      void vscode.window.showInformationMessage('gert: server stopped. It will restart on next preview.');
    }),
  );
}

export function deactivate() {
  serverManager?.dispose();
  serverManager = null;
}

// previewProse runs the gert CLI with --format prose against the active
// runbook file and opens the rendered Markdown in a side-by-side preview.
async function previewProse() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.endsWith('.runbook.yaml')) {
    void vscode.window.showWarningMessage('Open a *.runbook.yaml file first.');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('gert');
  const bin = cfg.get<string>('binaryPath', 'gert');
  try {
    const { stdout } = await pexec(bin, ['preview', '--format', 'prose', editor.document.fileName]);
    const doc = await vscode.workspace.openTextDocument({ content: stdout, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`gert preview failed: ${msg}`);
  }
}

// previewGraph opens a webview that loads the React Flow graph from the
// gert server. Auto-starts the server if needed.
async function previewGraph() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.endsWith('.runbook.yaml')) {
    void vscode.window.showWarningMessage('Open a *.runbook.yaml file first.');
    return;
  }

  let base: string;
  try {
    base = await serverManager!.ensureRunning();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`gert: failed to start server — ${msg}`, 'Show log').then((sel) => {
      if (sel === 'Show log') output?.show(true);
    });
    return;
  }

  const runbookPath = editor.document.fileName;
  const rbPath = encodeURIComponent(runbookPath);
  const panel = vscode.window.createWebviewPanel(
    'gertPreviewGraph',
    `gert: ${path.basename(runbookPath)}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  // The wrapper HTML hosts the iframe and forwards postMessage events
  // from the extension into the iframe (cross-origin). The inner page
  // listens for {type:'reload'} and re-fetches the runbook document.
  panel.webview.html = `<!doctype html>
<html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${base}; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>html,body,iframe{margin:0;height:100vh;width:100vw;border:0}</style>
</head><body>
<iframe id="gert-frame" src="${base}/preview/?runbookPath=${rbPath}"></iframe>
<script>
  const vscodeApi = acquireVsCodeApi();
  window.addEventListener('message', (ev) => {
    const f = document.getElementById('gert-frame');
    if (f && f.contentWindow && ev.data) {
      f.contentWindow.postMessage(ev.data, '*');
    }
  });
</script>
</body></html>`;

  // Forward saves of this runbook into the webview so the inner page
  // reloads the document. The panel is tracked so we can dispose the
  // listener with the panel.
  const saveSub = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.fileName === runbookPath) {
      void panel.webview.postMessage({ type: 'reload' });
    }
  });
  panel.onDidDispose(() => saveSub.dispose());
}

