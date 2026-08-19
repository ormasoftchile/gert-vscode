// VS Code extension entry point.
//
// Registers three commands:
//
//   gert.preview        — runs `gert preview --format prose <activeFile>`
//                         and opens the result in a Markdown preview pane.
//                         Works fully offline; no server needed.
//
//   gert.previewGraph   — opens a webview that iframes the gert server's
//                         /preview/ page. The server is auto-spawned by the
//                         extension if `gert.autoStartServer` is true (the
//                         default); otherwise the user is expected to run
//                         `gert serve` themselves and configure
//                         `gert.serverUrl`.
//
//   gert.validateInputs — collects a value for each declared runbook input
//                         (a closed selector for enum-constrained inputs, a
//                         mandatory free-text fallback otherwise — see
//                         src/enumInputs.ts) and runs `gert dry-run` against
//                         the real CLI so ENUM-0xx errors and ENUM-W001
//                         warnings are the engine's own, verbatim, never a
//                         client-side reimplementation
//                         (barbara-client-enum-compatibility-ruling.md,
//                         AR-CE-1..6).

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { ServerManager } from './serverManager';
import { McpBridge } from './mcpBridge';
import { buildRegistryFromDir } from './toolDefinitionRegistry';
import { pickServerRoot } from './serverRoot';
import { setToolToken, getToolToken, clearToolToken } from './toolTokenStore';
import { isArmCommand, isRunCommand } from './chatParticipantGate';
import { RunPump } from './runPump';
import { invokeWithTwoAttempts } from './runPump';
import { createRun, deleteRun as deleteRunHttp, waitForTerminalState } from './runClient';
import { runLoop } from './runLoop';
import {
  CANCELLED,
  UNSET,
  InputDecl,
  chooseAffordance,
  extractInputDecls,
  nfcEquals,
  parseVarPairs,
  stderrOf,
  deriveFailureMessage,
  firstLine,
  warningLines,
} from './enumInputs';

const pexec = promisify(execFile);

let serverManager: ServerManager | null = null;
let output: vscode.OutputChannel | null = null;
let graphPanel: vscode.WebviewPanel | undefined;
let mcpBridge: McpBridge | null = null;
// activePump holds the RunPump for the currently active @gert /run handler.
// Non-null only while a run handler is live; the bridge checks hasActivePump()
// before forwarding tool calls.
let activePump: RunPump | null = null;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('gert');
  serverManager = new ServerManager(output);

  // Start the loopback MCP bridge. The bridge mints its own capability
  // secret and provisions it into the ServerManager so every spawned gert
  // process sees GERT_VSCODE_BRIDGE_URL and GERT_VSCODE_BRIDGE_TOKEN.
  // We use port 0 so the OS picks a free port; the bridge reports the real
  // bound URL back to us. We don't block activation on this — the bridge
  // will be ready before any runbook preview fires a tool call.
  McpBridge.create({
    get tools() { return vscode.lm.tools as unknown as readonly import('./mcpBridge').LmToolInfo[]; },
    getToolInvocationToken() { return getToolToken(); },
    onTokenRejected() { clearToolToken(); },
    /**
     * Returns false when no @gert /run pump is active.
     * The bridge checks this before calling invokeTool and returns no_active_run
     * when false — tool calls are only valid while a /run handler is alive.
     */
    hasActivePump() { return activePump !== null && !activePump.closed; },
    invokeTool(name, options, token) {
      if (activePump && !activePump.closed) {
        // Pump path: the @gert /run handler dequeues this and calls the real
        // vscode.lm.invokeTool from its own execution context (with handler token).
        // options.toolInvocationToken is ignored — the handler provides the token.
        return activePump.enqueue(name, options.input as Record<string, unknown>) as Promise<import('./mcpBridge').LmToolResult>;
      }
      // Direct path (fallback): no active run, bridge should have gated this.
      // Included for defense-in-depth; hasActivePump() should prevent reaching here.
      return vscode.lm.invokeTool(name, { input: options.input, toolInvocationToken: options.toolInvocationToken as never }, token as vscode.CancellationToken) as Promise<import('./mcpBridge').LmToolResult>;
    },
  }, 0, output, {
    // Registry starts empty; it is refreshed from the active runbook's
    // resolved project the first time a command (previewGraph / previewProse /
    // validateInputs) is invoked. This avoids the workspaceFolders[0] bias
    // that breaks multi-root workspaces.
    registry: {},
    // window-scoped: mcpBridge.toolNameOverrides is read at extension activation
    // before any runbook is open; there is no resource to scope to at this point,
    // so window-level (unscoped) resolution is the only correct choice.
    overrides: vscode.workspace.getConfiguration('gert').get<Record<string, string>>('mcpBridge.toolNameOverrides') ?? {},
  }).then((bridge) => {
    mcpBridge = bridge;
    serverManager?.setBridgeEnv(bridge.bridgeUrl, bridge.bridgeToken);
    output?.appendLine(`[gert] MCP bridge listening at ${bridge.bridgeUrl}`);
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    output?.appendLine(`[gert] WARNING: MCP bridge failed to start — ${msg}`);
  });

  // Chat participant — drives runbooks or captures token for MCP discovery.
  // /run   — runs a runbook in-handler, keeping the handler open until terminal.
  //          Accesses request.toolInvocationToken (causes VS Code to discover
  //          MCP servers, ~60s on first use) and uses it live inside the handler.
  // /arm-mcp — diagnostic only: captures the token to trigger MCP server
  //          discovery, but the token does NOT authorize deferred runs.
  const participant = vscode.chat.createChatParticipant(
    'gert.chat',
    async (request, _ctx, response, token) => {
      if (isArmCommand(request.command)) {
        setToolToken(request.toolInvocationToken);
        response.markdown(
          'ℹ️ **Token captured (diagnostic only).**\n\n' +
          'Accessing `request.toolInvocationToken` causes VS Code to auto-discover ' +
          'and start MCP servers (~60s on first use).\n\n' +
          '**This token does NOT authorize deferred MCP calls.** ' +
          'Token capture alone does not remain valid after the chat request returns ' +
          '(proven by live-site test, 2026-08-18).\n\n' +
          'Use `@gert /run <runbook>` to run a runbook. ' +
          'The `/run` command drives tool invocations from inside the handler, ' +
          'which is the only execution context VS Code accepts.',
        );
        return {};
      }

      if (isRunCommand(request.command)) {
        return runRunbook(request, response, token);
      }

      response.markdown(
        '**gert**: Unknown command.\n\n' +
        'Commands:\n' +
        '- `/run <runbook.yaml> [key=val ...]` — run a runbook and drive MCP tool calls live\n' +
        '- `/arm-mcp` — diagnostic only; capture a token to trigger MCP server discovery\n',
      );
      return {};
    },
  );
  participant.iconPath = new vscode.ThemeIcon('run');

  context.subscriptions.push(
    output,
    { dispose: () => { serverManager?.dispose(); mcpBridge?.dispose(); mcpBridge = null; } },
    participant,
    vscode.commands.registerCommand('gert.preview', () => previewProse()),
    vscode.commands.registerCommand('gert.previewGraph', () => previewGraph()),
    vscode.commands.registerCommand('gert.validateInputs', () => validateInputs()),
    vscode.commands.registerCommand('gert.showServerLog', () => output?.show(true)),
    vscode.commands.registerCommand('gert.restartServer', async () => {
      serverManager?.dispose();
      await previewGraph();
    }),
  );
}

export function deactivate() {
  clearToolToken();
  activePump?.close('deactivated');
  activePump = null;
  serverManager?.dispose();
  serverManager = null;
  mcpBridge?.dispose();
  mcpBridge = null;
}

// refreshBridgeRegistry rebuilds the MCP bridge registry from the active
// runbook's resolved project so the bridge always dispatches against the
// correct set of tool definitions, regardless of workspace folder order.
// Multi-root: a runbook in the second folder correctly selects that folder's
// project rather than workspaceFolders[0].
function refreshBridgeRegistry(runbookPath: string): void {
  if (!mcpBridge) return;
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const projectRoot = pickServerRoot(runbookPath, folders, path.dirname(runbookPath));
  const registry = buildRegistryFromDir(projectRoot);
  mcpBridge.updateRegistry(registry);
  output?.appendLine(`[gert] MCP bridge registry refreshed from ${projectRoot}`);
}

// runRunbook runs a runbook in-handler using the @gert /run command.
//
// Architecture: keeps the handler open until the run reaches a terminal state by
// holding a RunPump that the bridge uses to dispatch tool calls back into this
// handler's execution context. Tool invocations are attempted with the live
// handler token first (suppresses VS Code consent dialog), then retried without
// the token on a Canceled response (Petals-derived two-attempt pattern).
//
// Empirically unproven: whether VS Code accepts an invokeTool call from an
// awaited continuation (pump processor) within the handler versus strictly the
// synchronous handler stack. If VS Code enforces strict call-stack context rather
// than handler lifetime, the pump items will fail with an error classified as
// invocation_error or Canceled. Only a live VS Code session can settle this.
async function runRunbook(
  request: vscode.ChatRequest,
  response: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  // Accessing request.toolInvocationToken here causes VS Code to auto-discover
  // and start MCP servers (~60s latency on first use per Petals observation).
  const handlerToken = request.toolInvocationToken;

  // Parse runbook path from prompt, falling back to the active editor.
  const parts = request.prompt.trim().split(/\s+/).filter(Boolean);
  let runbookPath: string | undefined;
  if (parts.length > 0 && !parts[0].includes('=')) {
    runbookPath = parts[0];
  } else {
    runbookPath = vscode.window.activeTextEditor?.document.fileName;
  }

  if (!runbookPath || !runbookPath.endsWith('.runbook.yaml')) {
    response.markdown('❌ Specify a `*.runbook.yaml` file: `@gert /run path/to/runbook.yaml`');
    return {};
  }

  // Parse key=value inputs from remaining args.
  const inputParts = runbookPath === parts[0] ? parts.slice(1) : parts;
  const inputs: Record<string, string> = {};
  for (const pair of inputParts) {
    const eq = pair.indexOf('=');
    if (eq > 0) inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  // Refresh registry and ensure server — preserves active-project scoping from
  // commits 1cd7542/fadc2fa/08de611.
  refreshBridgeRegistry(runbookPath);
  let base: string;
  try {
    base = await serverManager!.ensureRunning(runbookPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    response.markdown(`❌ Failed to start gert server: ${msg}`);
    return {};
  }

  // Create the run pump and register it with the bridge.
  const pump = new RunPump();
  activePump = pump;

  response.progress('Starting run…');

  let runId: string;
  try {
    runId = await createRun(base, runbookPath, inputs);
  } catch (err) {
    activePump = null;
    pump.close('create run failed');
    const msg = err instanceof Error ? err.message : String(err);
    response.markdown(`❌ Failed to create run: ${msg}`);
    clearToolToken();
    return {};
  }

  response.markdown(`🏃 Run \`${runId}\` started.`);
  output?.appendLine(`[gert run] run=${runId} runbook=${runbookPath}`);

  const cancelPromise = new Promise<void>((resolve) => {
    token.onCancellationRequested(() => resolve());
  });

  // realInvoke calls the real vscode.lm.invokeTool from inside this handler.
  // Security: tok is either handlerToken or undefined (second attempt) — never
  // logged; only the attempt index is written to the output channel.
  const realInvoke = async (name: string, input: Record<string, unknown>, tok: unknown) => {
    return vscode.lm.invokeTool(
      name,
      { input, toolInvocationToken: tok as never },
      token,
    ) as Promise<unknown>;
  };

  try {
    const result = await runLoop(
      pump,
      runId,
      {
        waitForTerminal: (id, signal) => waitForTerminalState(base, id, signal),
        deleteRun: (id) => deleteRunHttp(base, id),
        onProgress: (msg) => { response.progress(msg); },
      },
      handlerToken,
      realInvoke,
      cancelPromise,
      10 * 60 * 1000, // 10-minute bounded deadline
      output ?? undefined,
    );

    switch (result.reason) {
      case 'terminal':
        response.markdown(`✅ Run completed: \`${result.status}\``);
        break;
      case 'cancelled':
        response.markdown('⚠️ Run cancelled.');
        break;
      case 'deadline':
        response.markdown('⚠️ Run deadline exceeded (10 min).');
        break;
      case 'server_dead':
        response.markdown('⚠️ gert server became unreachable.');
        break;
    }
  } finally {
    // Clear the pump reference and the token store so the bridge gate fires
    // for any subsequent requests after this handler exits.
    activePump = null;
    pump.close('handler returning');
    clearToolToken();
  }

  return {};
}

// previewProse runs the gert CLI with --format prose against the active
// runbook file and opens the rendered Markdown in a side-by-side preview.
async function previewProse() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.endsWith('.runbook.yaml')) {
    void vscode.window.showWarningMessage('Open a *.runbook.yaml file first.');
    return;
  }
  const runbookPath = editor.document.fileName;
  refreshBridgeRegistry(runbookPath);
  // binaryPath is folder-scoped: different projects may use different local
  // gert builds. runbookPath is in scope here so there is no obstacle to
  // reading from the correct folder.
  const bin = vscode.workspace.getConfiguration('gert', vscode.Uri.file(runbookPath)).get<string>('binaryPath', 'gert');
  try {
    const { stdout } = await pexec(bin, ['preview', '--format', 'prose', runbookPath]);
    const doc = await vscode.workspace.openTextDocument({ content: stdout, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
  } catch (err) {
    reportEngineFailure('gert preview', err);
  }
}

// validateInputs runs `gert dry-run` against the active runbook so
// declared inputs (including `enum`-constrained ones) are checked through
// the real CLI/engine path — never a client-side re-implementation
// (AR-CE-1, AR-CE-4 §1). Declared-input metadata is read from the preview
// document's `inputs[]` array (AR-CE-2, pkg/preview/render/graphjson.
// Document.Inputs, F-1/F-2): a closed selector is offered for each
// enum-constrained input, in declared order, with no auto-select and no
// client-side normalisation (AR-CE-3, AR-CE-5). Whenever that metadata is
// redacted or absent for a given input, the operator gets a mandatory
// free-text fallback and the engine adjudicates the value (AR-CE-3 §3).
async function validateInputs() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.endsWith('.runbook.yaml')) {
    void vscode.window.showWarningMessage('Open a *.runbook.yaml file first.');
    return;
  }
  const file = editor.document.fileName;
  // binaryPath is folder-scoped: same reasoning as previewProse.
  const bin = vscode.workspace.getConfiguration('gert', vscode.Uri.file(file)).get<string>('binaryPath', 'gert');
  refreshBridgeRegistry(file);

  let doc: unknown;
  try {
    const { stdout } = await pexec(bin, ['preview', '--format', 'graphjson', file]);
    doc = JSON.parse(stdout);
  } catch (err) {
    reportEngineFailure('gert preview', err);
    return;
  }

  const vars = await collectInputs(doc);
  if (vars === undefined) return; // operator cancelled a prompt

  // NOTE: must be `--var`, not `-var` — `gert`'s own arg splitter
  // (`cmd/gert/run.go:splitRunArgs`) only recognises the double-dash form
  // when attaching the following token as the flag's value; `-var` silently
  // becomes a bare flag and the CLI rejects it with "flag needs an
  // argument: -var" before ever reaching validation. Verified against the
  // real `gert` binary while building this command.
  const varArgs = Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}=${v}`]);
  try {
    const { stdout, stderr } = await pexec(bin, ['dry-run', ...varArgs, file]);
    surfaceWarnings(stderr);
    if (stdout.trim()) output?.appendLine(stdout.trim());
    void vscode.window.showInformationMessage('gert: runbook inputs are valid.');
  } catch (err) {
    surfaceWarnings(stderrOf(err));
    reportEngineFailure('gert dry-run', err);
  }
}

// collectInputs prompts for a value per declared input (selector for
// non-redacted enum, free text otherwise) or, if no declaration metadata
// is available at all, a single free-text `-var` overrides fallback.
// Returns undefined if the operator cancelled.
async function collectInputs(doc: unknown): Promise<Record<string, string> | undefined> {
  const decls = extractInputDecls(doc);
  if (!decls || decls.length === 0) {
    const raw = await vscode.window.showInputBox({
      prompt: 'Variable overrides for gert dry-run (key=value, comma-separated). Leave empty for none.',
      placeHolder: 'env=prod,region=us-east-1',
      ignoreFocusOut: true,
    });
    if (raw === undefined) return undefined;
    return parseVarPairs(raw);
  }

  const vars: Record<string, string> = {};
  for (const decl of decls) {
    const result = await promptForInput(decl);
    if (result === CANCELLED) return undefined;
    if (result !== UNSET) vars[decl.name] = result;
  }
  return vars;
}

// promptForInput renders exactly one of: a redacted free-text box, a
// closed QuickPick selector over declared enum members (in declared
// order), or a plain free-text box. The selected/typed value is returned
// verbatim — no trim, case-fold, or NFC-normalisation (AR-CE-5 §1/§2).
async function promptForInput(
  decl: InputDecl,
): Promise<string | typeof UNSET | typeof CANCELLED> {
  const affordance = chooseAffordance(decl);
  const requiredLabel = decl.required ? ' (required)' : ' (optional)';

  if (affordance.kind === 'redacted-freetext') {
    const value = await vscode.window.showInputBox({
      prompt: `${decl.name}${requiredLabel} — ${affordance.hint}`,
      ignoreFocusOut: true,
    });
    return value === undefined ? CANCELLED : value;
  }

  if (affordance.kind === 'selector') {
    type Item = vscode.QuickPickItem & { value: string | undefined };
    const items: Item[] = affordance.members.map((m) => ({
      label: m,
      description:
        affordance.preselect !== undefined && nfcEquals(m, affordance.preselect) ? '(default)' : undefined,
      value: m,
    }));
    if (affordance.allowUnset) {
      items.push({ label: '$(circle-slash) Leave unset', value: undefined });
    }

    const qp = vscode.window.createQuickPick<Item>();
    qp.title = `${decl.name}${requiredLabel}`;
    qp.placeholder = decl.description ?? 'Select a declared value';
    qp.ignoreFocusOut = true;
    qp.items = items;
    // Preselecting only highlights the default item (cursor position);
    // it does not choose it. A required input with no default opens with
    // nothing highlighted, and in all cases the operator must still press
    // Enter — nothing here auto-submits (AR-CE-3 §5).
    if (affordance.preselect !== undefined) {
      const active = items.find((it) => it.value !== undefined && nfcEquals(it.value, affordance.preselect!));
      if (active) qp.activeItems = [active];
    }

    const picked = await new Promise<Item | undefined>((resolve) => {
      qp.onDidAccept(() => {
        resolve(qp.selectedItems[0]);
        qp.hide();
      });
      qp.onDidHide(() => {
        resolve(undefined);
        qp.dispose();
      });
      qp.show();
    });
    if (!picked) return CANCELLED;
    return picked.value === undefined ? UNSET : picked.value;
  }

  const value = await vscode.window.showInputBox({
    prompt: `${decl.name}${requiredLabel}${decl.description ? ' — ' + decl.description : ''}`,
    value: affordance.defaultValue,
    ignoreFocusOut: true,
  });
  return value === undefined ? CANCELLED : value;
}

// surfaceWarnings relays every `gert: warning: ...` stderr line (e.g.
// ENUM-W001, AR-CE-4 §6) to the user and the output channel, verbatim and
// with its code intact. Warnings are always non-fatal; this never blocks
// or fails the calling command.
function surfaceWarnings(stderrText: string) {
  for (const line of warningLines(stderrText)) {
    output?.appendLine(line);
    void vscode.window.showWarningMessage(line.replace(/^gert: warning:\s*/, ''));
  }
}

// reportEngineFailure surfaces the engine's own error text verbatim,
// including its ENUM-0xx (or other) code, instead of paraphrasing it into
// a generic failure string. Preferring the raw stderr capture over
// child_process's combined `err.message` keeps a coded error from being
// buried under a "Command failed: <argv>" prefix (AR-CE-4 §4/§5; D-3
// regression: an engine-coded error must never present as a bare "Parse
// error" to the operator).
function reportEngineFailure(step: string, err: unknown) {
  const verbatim = deriveFailureMessage(err);
  output?.appendLine(`[gert] ${step} failed:\n${verbatim}`);
  void vscode.window.showErrorMessage(`${step}: ${firstLine(verbatim)}`, 'Show log').then((sel) => {
    if (sel === 'Show log') output?.show(true);
  });
}

// previewGraph opens a webview that loads the React Flow graph from the
// gert server. Auto-starts the server if needed.
async function previewGraph() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.endsWith('.runbook.yaml')) {
    void vscode.window.showWarningMessage('Open a *.runbook.yaml file first.');
    return;
  }

  const runbookPath = editor.document.fileName;
  refreshBridgeRegistry(runbookPath);
  let base: string;
  try {
    base = await serverManager!.ensureRunning(runbookPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`gert: failed to start server — ${msg}`, 'Show log').then((sel) => {
      if (sel === 'Show log') output?.show(true);
    });
    return;
  }

  const rbPath = encodeURIComponent(runbookPath);
  graphPanel?.dispose();
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
  graphPanel = panel;
  panel.onDidDispose(() => {
    saveSub.dispose();
    if (graphPanel === panel) graphPanel = undefined;
  });
}
