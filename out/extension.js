"use strict";
// VS Code extension entry point.
//
// Registers three commands:
//
//   gert.preview        — runs `gert preview --format prose <activeFile>`
//                         and opens the result in a Markdown preview pane.
//                         Works fully offline; no server needed.
//
//   gert.previewGraph   — runs `gert preview --format graphjson` and renders
//                         the static structure in a bundled React Flow webview.
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const binaryResolver_1 = require("./binaryResolver");
const presentationEditor_1 = require("./presentationEditor");
const authoringEditor_1 = require("./authoringEditor");
const presentationContext_1 = require("./presentationContext");
const presentationClient_1 = require("./presentationClient");
const mcpBridge_1 = require("./mcpBridge");
const toolDefinitionRegistry_1 = require("./toolDefinitionRegistry");
const projectRoot_1 = require("./projectRoot");
const toolTokenStore_1 = require("./toolTokenStore");
const chatParticipantGate_1 = require("./chatParticipantGate");
const runHandoff_1 = require("./runHandoff");
const runHandoff_2 = require("./runHandoff");
const directRunSession_1 = require("./directRunSession");
const sessionStdioClient_1 = require("./sessionStdioClient");
const sessionCompositeGraph_1 = require("./sessionCompositeGraph");
const sessionPanelState_1 = require("./sessionPanelState");
const directDebug_1 = require("./directDebug");
const hostActionBridge_1 = require("./hostActionBridge");
const directGraphPreview_1 = require("./directGraphPreview");
const graphSourceChanged_1 = require("./graphSourceChanged");
const panelRecovery_1 = require("./panelRecovery");
const previewPlacement_1 = require("./previewPlacement");
const routeTestArtifacts_1 = require("./routeTestArtifacts");
const xtsHandoff_1 = require("./xtsHandoff");
const enumInputs_1 = require("./enumInputs");
const pexec = (0, util_1.promisify)(child_process_1.execFile);
async function requireRunbookCompatibility(binary, document, runbookPath, projectRoot, packageMapPath) {
    if (/^\.env(?:\.|$)/i.test(path.basename(runbookPath)))
        throw new Error('A runbook path is required for compatibility verification.');
    const uri = vscode.Uri.file(runbookPath);
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > 8 * 1024 * 1024)
        throw new Error('Runbook metadata exceeds the local compatibility-check limit.');
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    const helper = (0, presentationClient_1.bundledPresentationHelper)(extensionContext.extensionPath);
    const metadata = await (0, presentationClient_1.resolvePresentation)(helper, {
        schema_version: 'presentation-resolve/v1', request_id: `execution-preflight:${(0, crypto_1.randomUUID)()}`,
        context: { project_root: projectRoot, generation: 0, ...(packageMapPath ? { package_map_path: packageMapPath } : {}) },
        document: { uri: uri.toString(), path: runbookPath, version: 0, text }, overlays: [],
    });
    await (0, presentationClient_1.requireCompatibleExecution)(binary, document, metadata);
}
let output = null;
// ExtensionContext is stored at module scope so workspace state can be
// accessed from previewGraph without threading
// context through every call site.
let extensionContext = null;
let directGraphPanel;
let mcpBridge = null;
let mcpBridgeStarting = null;
function parseDirectRouteTestOutcome(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const outcome = value;
    const statuses = new Set(['reached', 'route-changed', 'runtime-failed', 'safety-failed', 'stopped']);
    if (typeof outcome.passed !== 'boolean' || typeof outcome.targetReached !== 'boolean' ||
        !Number.isInteger(outcome.externalDispatches) || outcome.externalDispatches < 0 ||
        typeof outcome.status !== 'string' || !statuses.has(outcome.status))
        return undefined;
    return {
        passed: outcome.passed,
        targetReached: outcome.targetReached,
        externalDispatches: outcome.externalDispatches,
        status: outcome.status,
        ...(typeof outcome.message === 'string' && outcome.message ? { message: outcome.message } : {}),
    };
}
function ensureMcpBridge() {
    if (mcpBridge)
        return Promise.resolve(mcpBridge);
    if (mcpBridgeStarting)
        return mcpBridgeStarting;
    if (!output || !extensionContext) {
        return Promise.reject(new Error('gert extension is not active'));
    }
    mcpBridgeStarting = createMcpBridge({}, undefined).then((bridge) => {
        mcpBridge = bridge;
        return bridge;
    }).finally(() => {
        mcpBridgeStarting = null;
    });
    return mcpBridgeStarting;
}
function createMcpBridge(registry, resource) {
    if (!output || !extensionContext) {
        return Promise.reject(new Error('gert extension is not active'));
    }
    const outputChannel = output;
    return mcpBridge_1.McpBridge.create({
        get tools() { return vscode.lm.tools; },
        getToolInvocationToken() { return (0, toolTokenStore_1.getToolToken)(); },
        onTokenRejected() { (0, toolTokenStore_1.clearToolToken)(); },
        invokeTool(name, options, token) {
            return vscode.lm.invokeTool(name, { input: options.input, toolInvocationToken: options.toolInvocationToken }, token);
        },
    }, 0, outputChannel, {
        registry,
        overrides: vscode.workspace.getConfiguration('gert', resource).get('mcpBridge.toolNameOverrides') ?? {},
    }).then((bridge) => {
        if (!extensionContext) {
            bridge.dispose();
            throw new Error('gert extension was deactivated during MCP bridge startup');
        }
        outputChannel.appendLine(`[gert] MCP bridge listening at ${bridge.bridgeUrl}`);
        return bridge;
    }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`[gert] WARNING: MCP bridge failed to start — ${message}`);
        throw error;
    });
}
function activate(context) {
    extensionContext = context;
    (0, binaryResolver_1.configureBundledRuntime)(context.extensionPath);
    output = vscode.window.createOutputChannel('gert');
    context.subscriptions.push((0, presentationEditor_1.registerPresentationEditor)(context, output));
    context.subscriptions.push((0, authoringEditor_1.registerAuthoringEditor)(context));
    // Chat participant — drives runbooks or captures token for MCP discovery.
    // /run   — runs a runbook in-handler, keeping the handler open until terminal.
    //          Accesses request.toolInvocationToken (causes VS Code to discover
    //          MCP servers, ~60s on first use) and uses it live inside the handler.
    // /arm-mcp — diagnostic only: captures the token to trigger MCP server
    //          discovery, but the token does NOT authorize deferred runs.
    const participant = vscode.chat.createChatParticipant('gert.chat', async (request, _ctx, response, _token) => {
        if ((0, chatParticipantGate_1.isArmCommand)(request.command)) {
            (0, toolTokenStore_1.setToolToken)(request.toolInvocationToken);
            try {
                await ensureMcpBridge();
            }
            catch (error) {
                response.markdown(`❌ **MCP bridge failed to start:** ${(0, enumInputs_1.firstLine)((0, enumInputs_1.deriveFailureMessage)(error))}`);
                return {};
            }
            // Diagnostic: list tools visible in vscode.lm.tools right now.
            // Accessing toolInvocationToken triggers MCP server discovery, so this
            // snapshot reflects the state immediately after the discovery signal.
            // Zero invoke budget — no invokeTool calls.
            const visibleTools = vscode.lm.tools
                .map((t) => t.name)
                .sort();
            const toolsSummary = visibleTools.length === 0
                ? '_No tools visible yet — VS Code may still be starting MCP servers (~60s on ' +
                    'first use). Run `/arm-mcp` again after ~60s to see them._'
                : visibleTools.map((n) => `- \`${n}\``).join('\n');
            response.markdown('ℹ️ **Token armed — MCP dialog suppression enabled.**\n\n' +
                'Accessing `request.toolInvocationToken` causes VS Code to auto-discover ' +
                'and start MCP servers (~60s on first use).\n\n' +
                'The cached token is passed as `toolInvocationToken` on MCP tool calls. ' +
                'If VS Code rejects or cancels that token path, the bridge fails closed ' +
                'instead of retrying without a token. This token is NEVER an authorization credential.\n\n' +
                '**Re-arm when needed:** The token is cleared on rejection. ' +
                'Run `/arm-mcp` again if calls fail with `invocation_token_unavailable`.\n\n' +
                '**VS Code MCP tools visible right now:**\n\n' +
                toolsSummary);
            return {};
        }
        if (request.command === 'run') {
            // Access toolInvocationToken first — triggers VS Code to start MCP servers
            // (~60s on first use) and caches the token for bridge invocation consent.
            // Store unconditionally; the bridge fails closed if VS Code rejects it.
            (0, toolTokenStore_1.setToolToken)(request.toolInvocationToken);
            const prompt = request.prompt.trim();
            if (!prompt) {
                response.markdown('**gert /run**: runbook path required.\n\n' +
                    'Usage: `@gert /run <path/to/runbook.yaml> [key=val ...]`');
                return {};
            }
            // First token is the runbook path; remainder are key=val pairs for --var.
            const [runbookArg, ...varPairArgs] = prompt.split(/\s+/);
            const runbookPath = path.isAbsolute(runbookArg)
                ? runbookArg
                : path.resolve(vscode.window.activeTextEditor?.document.uri.fsPath
                    ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)
                    : process.cwd(), runbookArg);
            const cfg = vscode.workspace.getConfiguration('gert', vscode.Uri.file(runbookPath));
            const packageMapSetting = cfg.get('packageMap', '');
            const folders = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
            const projectRoot = (0, projectRoot_1.pickProjectRoot)(runbookPath, folders, path.dirname(runbookPath));
            let bin;
            try {
                bin = await (0, binaryResolver_1.resolveBinary)(cfg.get('binaryPath', 'gert'), output, projectRoot, folders);
                const presentationBinary = (0, presentationClient_1.bundledPresentationHelper)(context.extensionPath);
                await (0, presentationClient_1.verifyPresentationHelper)(presentationBinary);
                const graph = await (0, directGraphPreview_1.loadGraphDocument)(presentationBinary, runbookPath, (command, args) => pexec(command, args, { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 }), (0, runHandoff_2.resolveRunPackageMapPath)(projectRoot, packageMapSetting).path);
                await requireRunbookCompatibility(bin, graph, runbookPath, projectRoot, (0, runHandoff_2.resolveRunPackageMapPath)(projectRoot, packageMapSetting).path);
                await ensureMcpBridge();
            }
            catch (error) {
                reportEngineFailure('Runtime compatibility or MCP bridge startup', error);
                response.markdown('❌ **gert run could not start: check runtime compatibility and bridge availability in the run log.**');
                return {};
            }
            // Refresh registry so the bridge dispatches against this runbook's tools.
            refreshBridgeRegistry(runbookPath);
            const bridgeVars = mcpBridge
                ? {
                    GERT_VSCODE_BRIDGE_URL: mcpBridge.bridgeUrl,
                    GERT_VSCODE_BRIDGE_TOKEN: mcpBridge.bridgeToken,
                }
                : {};
            try {
                const result = await (0, runHandoff_1.executeRunHandoff)({
                    bin,
                    runbookPath,
                    varPairArgs,
                    projectRoot,
                    packageMapSetting,
                    bridgeVars,
                    baseEnv: process.env,
                    execFile: child_process_1.execFile,
                });
                if (result.packageMap.warning)
                    output?.appendLine(`[gert run] WARNING: ${result.packageMap.warning}`);
                if (result.stderr.trim())
                    output?.appendLine(`[gert run] ${result.stderr.trim()}`);
                response.markdown(result.stdout.trim() || '✅ Runbook completed.');
            }
            catch (err) {
                const withOutput = err;
                if (withOutput.packageMap?.warning)
                    output?.appendLine(`[gert run] WARNING: ${withOutput.packageMap.warning}`);
                if (withOutput.stderr?.trim())
                    output?.appendLine(`[gert run] ${withOutput.stderr.trim()}`);
                reportEngineFailure('gert run', err);
                response.markdown('❌ **gert run failed** — see the `gert` output channel for details.');
            }
            return {};
        }
        response.markdown('**gert**: Unknown command.\n\n' +
            'Commands:\n' +
            '- `/arm-mcp` — optional: capture a token for MCP dialog suppression\n' +
            '- `/run <runbook.yaml> [key=val ...]` — run a runbook live\n');
        return {};
    });
    participant.iconPath = new vscode.ThemeIcon('run');
    context.subscriptions.push(output, { dispose: () => { mcpBridge?.dispose(); mcpBridge = null; } }, participant, vscode.commands.registerCommand('gert.preview', () => previewProse()), vscode.commands.registerCommand('gert.previewGraph', () => previewGraph()), ...(context.extensionMode === vscode.ExtensionMode.Test
        ? [
            vscode.commands.registerCommand('gert.test.openDirectGraphPanel', (runbookPath, hooks) => openDirectGraphPanelForRunbook(runbookPath, hooks)),
            vscode.commands.registerCommand('gert.test.clearInvestigationSession', async () => {
                const stored = extensionContext?.workspaceState.get(sessionPanelState_1.SESSION_WORKSPACE_STATE_KEY);
                await extensionContext?.workspaceState.update(sessionPanelState_1.SESSION_WORKSPACE_STATE_KEY, undefined);
                try {
                    const descriptor = (0, sessionPanelState_1.parseStoredSessionDescriptor)(stored);
                    const cache = new sessionPanelState_1.SessionGraphCacheStore(vscode.Uri.joinPath(extensionContext.globalStorageUri, 'investigation-sessions').fsPath);
                    await cache.delete(descriptor.sessionID);
                }
                catch {
                    // Missing or invalid test state requires no cache cleanup.
                }
            }),
            vscode.commands.registerCommand('gert.test.getRuntimeState', () => ({
                mcpBridgeStarted: mcpBridge !== null || mcpBridgeStarting !== null,
            })),
        ]
        : []), vscode.commands.registerCommand('gert.validateInputs', () => validateInputs()), vscode.commands.registerCommand('gert.showServerLog', () => output?.show(true)), ...(context.extensionMode === vscode.ExtensionMode.Test
        ? [vscode.commands.registerCommand('gert.test.openHostActionPanel', async () => {
                let disposed = false;
                const panel = vscode.window.createWebviewPanel('gertTestHostAction', 'gert: host-action test harness', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
                panel.webview.html = HOST_ACTION_TEST_HTML;
                // Production capability registry — identical to the one in previewGraph().
                const testRegistry = new Map([
                    ['test.echo', { handler: hostActionBridge_1.testEchoHandler }],
                    ['xts.open-view', { handler: makeXtsOpenViewHandler(panel), timeoutMs: XTS_HOST_ACTION_TIMEOUT_MS }],
                ]);
                const testBridge = (0, hostActionBridge_1.createHostActionBridge)(testRegistry, (0, hostActionBridge_1.webviewPanelTransport)(panel, () => !disposed));
                panel.onDidDispose(() => { disposed = true; testBridge.dispose(); });
                // Production onDidReceiveMessage wiring — same pattern as previewGraph().
                panel.webview.onDidReceiveMessage((message) => { void testBridge.receive(message); });
                // Wait for the webview harness to signal it is ready before returning
                // the panel to the test. This prevents a race where postMessage is called
                // before the webview script is loaded.
                await new Promise((resolve, reject) => {
                    const t = setTimeout(() => reject(new Error('gert.test.openHostActionPanel: webview not ready within 10 s')), 10_000);
                    const sub = panel.webview.onDidReceiveMessage((msg) => {
                        if (msg && msg.type === 'gert.test.ready') {
                            clearTimeout(t);
                            sub.dispose();
                            resolve();
                        }
                    });
                    panel.onDidDispose(() => {
                        clearTimeout(t);
                        sub.dispose();
                        reject(new Error('panel disposed before gert.test.ready'));
                    });
                });
                return panel;
            })]
        : []));
}
// HOST_ACTION_TEST_HTML is the webview content for the test-only
// gert.test.openHostActionPanel command. It provides two services:
//
//  1. Signals gert.test.ready when the script loads (so the command can
//     await the webview before returning the panel to the test).
//
//  2. Forwards gert.test.inject payloads as vscode.postMessage() calls,
//     which triggers the production onDidReceiveMessage handler.
//     This is the key boundary: the webview calls vscode.postMessage(),
//     NOT the test calling bridge.receive() directly.
//
//  3. Echoes any gert.host-action.ack/cancel received from the bridge
//     back to the extension as gert.test.ackCaptured so the test can
//     assert on it and then POST it to the Go broker.
const HOST_ACTION_TEST_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'unsafe-inline';">
</head>
<body>
<script>
  (function () {
    var vscode = acquireVsCodeApi();
    vscode.postMessage({ type: 'gert.test.ready' });
    window.addEventListener('message', function (event) {
      var msg = event.data;
      if (!msg || typeof msg !== 'object') { return; }
      if (msg.type === 'gert.test.inject') {
        vscode.postMessage(msg.payload);
      } else if (msg.type === 'gert.host-action.ack' || msg.type === 'gert.host-action.cancel') {
        vscode.postMessage({ type: 'gert.test.ackCaptured', ack: msg });
      }
    });
  }());
</script>
</body>
</html>`;
function deactivate() {
    (0, toolTokenStore_1.clearToolToken)();
    mcpBridge?.dispose();
    mcpBridge = null;
    extensionContext = null;
}
// refreshBridgeRegistry rebuilds the MCP bridge registry from the active
// runbook's resolved project so the bridge always dispatches against the
// correct set of tool definitions, regardless of workspace folder order.
// Multi-root: a runbook in the second folder correctly selects that folder's
// project rather than workspaceFolders[0].
function refreshBridgeRegistry(runbookPath) {
    if (!mcpBridge)
        return;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const projectRoot = (0, projectRoot_1.pickProjectRoot)(runbookPath, folders, path.dirname(runbookPath));
    const registry = (0, toolDefinitionRegistry_1.buildRegistryFromDir)(projectRoot);
    mcpBridge.updateRegistry(registry);
    output?.appendLine(`[gert] MCP bridge registry refreshed from ${projectRoot}`);
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
    const bin = vscode.workspace.getConfiguration('gert', vscode.Uri.file(runbookPath)).get('binaryPath', 'gert');
    try {
        const { stdout } = await pexec(bin, ['preview', '--format', 'prose', runbookPath]);
        const doc = await vscode.workspace.openTextDocument({ content: stdout, language: 'markdown' });
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
        await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    }
    catch (err) {
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
    const bin = vscode.workspace.getConfiguration('gert', vscode.Uri.file(file)).get('binaryPath', 'gert');
    refreshBridgeRegistry(file);
    let doc;
    try {
        const { stdout } = await pexec(bin, ['preview', '--format', 'graphjson', file]);
        doc = JSON.parse(stdout);
    }
    catch (err) {
        reportEngineFailure('gert preview', err);
        return;
    }
    const vars = await collectInputs(doc);
    if (vars === undefined)
        return; // operator cancelled a prompt
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
        if (stdout.trim())
            output?.appendLine(stdout.trim());
        void vscode.window.showInformationMessage('gert: runbook inputs are valid.');
    }
    catch (err) {
        surfaceWarnings((0, enumInputs_1.stderrOf)(err));
        reportEngineFailure('gert dry-run', err);
    }
}
// collectInputs prompts for a value per declared input (selector for
// non-redacted enum, free text otherwise) or, if no declaration metadata
// is available at all, a single free-text `-var` overrides fallback.
// Returns undefined if the operator cancelled.
async function collectInputs(doc) {
    const decls = (0, enumInputs_1.extractInputDecls)(doc);
    if (!decls || decls.length === 0) {
        const raw = await vscode.window.showInputBox({
            prompt: 'Variable overrides for gert dry-run (key=value, comma-separated). Leave empty for none.',
            placeHolder: 'env=prod,region=us-east-1',
            ignoreFocusOut: true,
        });
        if (raw === undefined)
            return undefined;
        return (0, enumInputs_1.parseVarPairs)(raw);
    }
    const vars = {};
    for (const decl of decls) {
        const result = await promptForInput(decl);
        if (result === enumInputs_1.CANCELLED)
            return undefined;
        if (result !== enumInputs_1.UNSET)
            vars[decl.name] = result;
    }
    return vars;
}
// promptForInput renders exactly one of: a redacted free-text box, a
// closed QuickPick selector over declared enum members (in declared
// order), or a plain free-text box. The selected/typed value is returned
// verbatim — no trim, case-fold, or NFC-normalisation (AR-CE-5 §1/§2).
async function promptForInput(decl) {
    const affordance = (0, enumInputs_1.chooseAffordance)(decl);
    const requiredLabel = decl.required ? ' (required)' : ' (optional)';
    if (affordance.kind === 'redacted-freetext') {
        const value = await vscode.window.showInputBox({
            prompt: `${decl.name}${requiredLabel} — ${affordance.hint}`,
            ignoreFocusOut: true,
        });
        return value === undefined ? enumInputs_1.CANCELLED : value;
    }
    if (affordance.kind === 'selector') {
        const items = affordance.members.map((m) => ({
            label: m,
            description: affordance.preselect !== undefined && (0, enumInputs_1.nfcEquals)(m, affordance.preselect) ? '(default)' : undefined,
            value: m,
        }));
        if (affordance.allowUnset) {
            items.push({ label: '$(circle-slash) Leave unset', value: undefined });
        }
        const qp = vscode.window.createQuickPick();
        qp.title = `${decl.name}${requiredLabel}`;
        qp.placeholder = decl.description ?? 'Select a declared value';
        qp.ignoreFocusOut = true;
        qp.items = items;
        // Preselecting only highlights the default item (cursor position);
        // it does not choose it. A required input with no default opens with
        // nothing highlighted, and in all cases the operator must still press
        // Enter — nothing here auto-submits (AR-CE-3 §5).
        if (affordance.preselect !== undefined) {
            const active = items.find((it) => it.value !== undefined && (0, enumInputs_1.nfcEquals)(it.value, affordance.preselect));
            if (active)
                qp.activeItems = [active];
        }
        const picked = await new Promise((resolve) => {
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
        if (!picked)
            return enumInputs_1.CANCELLED;
        return picked.value === undefined ? enumInputs_1.UNSET : picked.value;
    }
    const value = await vscode.window.showInputBox({
        prompt: `${decl.name}${requiredLabel}${decl.description ? ' — ' + decl.description : ''}`,
        value: affordance.defaultValue,
        ignoreFocusOut: true,
    });
    return value === undefined ? enumInputs_1.CANCELLED : value;
}
// surfaceWarnings relays every `gert: warning: ...` stderr line (e.g.
// ENUM-W001, AR-CE-4 §6) to the user and the output channel, verbatim and
// with its code intact. Warnings are always non-fatal; this never blocks
// or fails the calling command.
function surfaceWarnings(stderrText) {
    for (const line of (0, enumInputs_1.warningLines)(stderrText)) {
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
function reportEngineFailure(step, err) {
    const verbatim = (0, enumInputs_1.deriveFailureMessage)(err);
    output?.appendLine(`[gert] ${step} failed:\n${verbatim}`);
    void vscode.window.showErrorMessage(`${step}: ${(0, enumInputs_1.firstLine)(verbatim)}`, 'Show log').then((sel) => {
        if (sel === 'Show log')
            output?.show(true);
    });
}
// XTS capability handler factory. The host validates and forwards an arbitrary
// view request; product-owned view paths and parameters stay in runbooks.
const XTS_HOST_ACTION_TIMEOUT_MS = 310_000;
const XTS_LAUNCH_STATUSES = new Set([
    'opened',
    'view-not-found',
    'environment-not-found',
    'invalid-parameters',
    'execution-not-started',
]);
function isXtsLaunchAcknowledgment(value) {
    return typeof value === 'object' && value !== null &&
        'status' in value && typeof value.status === 'string' &&
        XTS_LAUNCH_STATUSES.has(value.status);
}
function makeXtsOpenViewHandler(panel, consumePanelConfirmation = () => false, showReminder = () => {
    void vscode.window.showInformationMessage('XTS is open. Review the view, then return to the Gert preview to record your finding.');
}) {
    void panel;
    return async (args) => {
        const req = args.request;
        if (typeof req !== 'object' || req === null || Array.isArray(req)) {
            return { status: 'failed', error: { code: 'INVALID_REQUEST', message: 'request must be an object' } };
        }
        const r = req;
        const viewPath = typeof r.view_path === 'string' && r.view_path.length > 0 ? r.view_path : undefined;
        const environment = typeof r.environment === 'string' && r.environment.length > 0 ? r.environment : undefined;
        const focus = typeof r.focus === 'boolean' ? r.focus : undefined;
        const params = typeof r.parameters === 'object' && r.parameters !== null && !Array.isArray(r.parameters)
            ? r.parameters : undefined;
        if (viewPath === undefined || environment === undefined || focus === undefined || params === undefined) {
            return { status: 'failed', error: { code: 'INVALID_REQUEST', message: 'Missing required view_path, environment, focus, or parameters fields.' } };
        }
        const panelConfirmed = consumePanelConfirmation(args.requestId);
        if (!panelConfirmed) {
            return {
                status: 'execution-not-started',
                error: { code: 'CONFIRMATION_REQUIRED', message: 'Confirm the XTS launch in the Gert preview.' },
            };
        }
        return (0, xtsHandoff_1.launchXtsWithHandoff)(focus, args.cancellationToken, {
            dispatch: () => vscode.commands.executeCommand('xts.openViewWithParameters', {
                viewPath,
                environment,
                parameters: params,
                focus,
                correlationId: args.correlationId,
            }),
            parseAcknowledgment: (value) => isXtsLaunchAcknowledgment(value) ? value : undefined,
            showDispatchError: (message) => {
                void vscode.window.showErrorMessage(`Gert could not open the XTS view: ${message}`);
            },
            showReminder,
        });
    };
}
// previewGraph renders graphjson directly in a bundled webview. It does not
// start a background service or load a remote document.
async function previewGraph() {
    const activeEditor = vscode.window.activeTextEditor;
    const runbookPath = (0, panelRecovery_1.resolveRunbookPath)(activeEditor?.document.fileName, extensionContext?.workspaceState.get(panelRecovery_1.WORKSPACE_RUNBOOK_KEY));
    if (!runbookPath) {
        void vscode.window.showWarningMessage('Open a *.runbook.yaml file first.');
        return;
    }
    await openDirectGraphPanelForRunbook(runbookPath);
}
function findRunbookViewColumn(runbookPath) {
    const runbookUri = vscode.Uri.file(runbookPath).toString();
    const activeGroup = vscode.window.tabGroups.activeTabGroup;
    const groups = [
        activeGroup,
        ...vscode.window.tabGroups.all.filter((group) => group !== activeGroup),
    ];
    return groups.find((group) => group.tabs.some((tab) => (tab.input instanceof vscode.TabInputText
        && tab.input.uri.toString() === runbookUri)))?.viewColumn;
}
function directRunInputs(value) {
    if (value === undefined || value === null)
        return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Run inputs must be an object.');
    }
    const entries = Object.entries(value);
    if (entries.length > 64)
        throw new Error('Run inputs exceed the 64-field limit.');
    const inputs = {};
    for (const [name, raw] of entries) {
        if (!name || Buffer.byteLength(name, 'utf8') > 256) {
            throw new Error('Run input names must be between 1 and 256 UTF-8 bytes.');
        }
        if (typeof raw !== 'string') {
            throw new Error(`Run input ${name} must be a string.`);
        }
        if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) {
            throw new Error(`Run input ${name} exceeds 64 KiB.`);
        }
        inputs[name] = raw;
    }
    return inputs;
}
function directSecretInputNames(document) {
    if (!Array.isArray(document.inputs))
        return new Set();
    return new Set(document.inputs.flatMap((value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            return [];
        const input = value;
        return typeof input.name === 'string' && input.type === 'secret' ? [input.name] : [];
    }));
}
function parseRouteTestPlanHash(stdout) {
    let value;
    try {
        value = JSON.parse(stdout);
    }
    catch {
        throw new Error('gert plan did not return valid JSON');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('gert plan result must be an object');
    const hash = value.route_test_hash;
    if (typeof hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(hash))
        throw new Error('gert plan did not return a valid route_test_hash');
    return hash;
}
async function openDirectGraphPanelForRunbook(runbookPath, testHooks) {
    const config = vscode.workspace.getConfiguration('gert', vscode.Uri.file(runbookPath));
    const runbookViewColumn = findRunbookViewColumn(runbookPath);
    const panelTarget = (0, previewPlacement_1.resolvePreviewPanelTarget)(config.get('preview.openLocation', 'sameGroup'), runbookViewColumn);
    const panelColumn = panelTarget === 'beside'
        ? vscode.ViewColumn.Beside
        : panelTarget === 'active'
            ? vscode.ViewColumn.Active
            : panelTarget;
    const mediaRoot = vscode.Uri.joinPath(extensionContext.extensionUri, 'media');
    directGraphPanel?.dispose();
    const panel = vscode.window.createWebviewPanel('gertPreviewGraph', `gert: ${path.basename(runbookPath)}`, panelColumn, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaRoot],
    });
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'graph.js')).toString();
    const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'graph.css')).toString();
    panel.webview.html = (0, directGraphPreview_1.createDirectGraphWebviewHtml)(scriptUri, styleUri, panel.webview.cspSource, (0, crypto_1.randomBytes)(16).toString('hex'), panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'highlighting-worker.js')).toString(), config.get('highlighting.enabled', true));
    let disposed = false;
    let ready = false;
    let loadRevision = 0;
    let loadController;
    let currentStyle = config.get('preview.nodeStyle', 'smooth-curves');
    let currentDocument;
    let currentProjectRoot;
    let currentRunbookRelative;
    let currentPlanHash;
    let runSession;
    let investigationClient;
    let investigationModel;
    let investigationDescriptor;
    let investigationState;
    let investigationGraphs = {};
    let investigationGraphHistory = {};
    let investigationRevision = 0;
    let investigationStarting = false;
    const investigationGraphLoads = new Map();
    let runBridge;
    let runStarting = false;
    let runStartRevision = 0;
    let activeHostActionRunID;
    let reloadPending = false;
    let activeRouteTest;
    let latestMessage = { type: 'loading' };
    const sessionCache = new sessionPanelState_1.SessionGraphCacheStore(vscode.Uri.joinPath(extensionContext.globalStorageUri, 'investigation-sessions').fsPath);
    const publish = (message) => {
        latestMessage = message;
        if (ready && !disposed) {
            void panel.webview.postMessage(message);
        }
    };
    const publishReloadState = (active) => {
        if (ready && !disposed) {
            void panel.webview.postMessage({ type: 'graph.reload-state', active });
        }
    };
    const reportInvestigationError = (message) => {
        output?.appendLine(`[gert session] ${message}`);
        if (ready && !disposed)
            void panel.webview.postMessage({ type: 'session.error', message });
    };
    const closedInvestigationStatus = (status) => (status === 'resolved' || status === 'escalated' || status === 'cancelled' || status === 'abandoned');
    const checkpointWriter = new sessionPanelState_1.CoalescedAsyncWriter(async ({ cache, descriptor }) => {
        await sessionCache.save(cache);
        if (disposed || investigationDescriptor?.sessionID !== descriptor.sessionID)
            return;
        await extensionContext.workspaceState.update(sessionPanelState_1.SESSION_WORKSPACE_STATE_KEY, descriptor);
        if (investigationDescriptor?.sessionID === descriptor.sessionID)
            investigationDescriptor = descriptor;
    }, (error) => reportInvestigationError(`Could not persist session checkpoint: ${(0, enumInputs_1.deriveFailureMessage)(error)}`));
    const persistInvestigationCheckpoint = (state, acceptedSequence) => {
        if (!state.manifest || !investigationDescriptor || state.sequence !== acceptedSequence) {
            reportInvestigationError('Accepted session cursor does not match the projected checkpoint.');
            return;
        }
        const descriptor = { ...investigationDescriptor, acceptedSequence };
        const cache = {
            schemaVersion: sessionPanelState_1.SESSION_GRAPH_CACHE_SCHEMA,
            sessionID: descriptor.sessionID,
            sequence: acceptedSequence,
            manifest: state.manifest,
            segmentGraphs: { ...investigationGraphs },
            segmentGraphHistory: Object.fromEntries(Object.entries(investigationGraphHistory).map(([segmentID, revisions]) => [segmentID, { ...revisions }])),
            segmentGraphAvailability: state.segmentGraphAvailability,
            preparedTransitionTargets: state.preparedTransitionTargets,
            runtimeNodes: state.runtimeNodes,
            ...(state.executionNodeID ? { executionNodeID: state.executionNodeID } : {}),
            ...(state.pending ? { pending: state.pending } : {}),
        };
        checkpointWriter.enqueue({ cache, descriptor });
    };
    const publishInvestigationState = (state) => {
        const previousDocument = investigationState?.document;
        investigationState = state;
        if (state.document)
            currentDocument = state.document;
        activeHostActionRunID = state.activeRunID;
        if (ready && !disposed) {
            const publishedState = state.document && state.document === previousDocument
                ? { ...state, document: undefined }
                : state;
            void panel.webview.postMessage({ type: 'session.update', state: publishedState, style: currentStyle });
        }
    };
    const ensureInvestigationGraph = (segmentID, revision) => {
        const key = `${segmentID}\u0000${revision}`;
        const existing = investigationGraphLoads.get(key);
        if (existing)
            return existing;
        const load = (async () => {
            if (!investigationDescriptor || !investigationModel)
                return undefined;
            if (investigationModel.graphRevision(segmentID, revision))
                return investigationModel.snapshot();
            const descriptor = investigationDescriptor;
            const requestRevision = investigationRevision;
            const scopedConfig = vscode.workspace.getConfiguration('gert', vscode.Uri.file(runbookPath));
            const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
            const configuredBinary = scopedConfig.get('binaryPath', 'gert');
            const binary = await (0, binaryResolver_1.resolveBinary)(configuredBinary, output, descriptor.projectRoot, workspaceFolders);
            if (disposed || requestRevision !== investigationRevision || investigationDescriptor?.sessionID !== descriptor.sessionID) {
                return undefined;
            }
            const { stdout } = await pexec(binary, (0, sessionStdioClient_1.buildSessionGraphArgs)(descriptor.sessionID, segmentID, revision), {
                cwd: descriptor.projectRoot,
                maxBuffer: 192 * 1024 * 1024,
                windowsHide: true,
            });
            const graph = (0, sessionPanelState_1.parseSessionGraphRevisionResponse)(stdout, descriptor.sessionID, segmentID, revision);
            if (disposed || requestRevision !== investigationRevision || investigationDescriptor?.sessionID !== descriptor.sessionID) {
                return undefined;
            }
            const state = investigationModel.loadGraphRevision(graph.segmentSnapshot, graph.revision, graph.wholeBlobHash, graph.document);
            investigationGraphHistory[segmentID] = {
                ...(investigationGraphHistory[segmentID] ?? {}),
                [String(revision)]: graph,
            };
            if (state.manifest?.segments[segmentID]?.graph_revision === revision) {
                investigationGraphs[segmentID] = graph;
            }
            publishInvestigationState(state);
            persistInvestigationCheckpoint(state, state.sequence);
            return state;
        })().catch((error) => {
            reportInvestigationError(`Could not load historical graph: ${(0, enumInputs_1.deriveFailureMessage)(error)}`);
            return undefined;
        }).finally(() => {
            investigationGraphLoads.delete(key);
        });
        investigationGraphLoads.set(key, load);
        return load;
    };
    const configureInvestigationClient = (child, descriptor, afterSequence, restored, bridge, revision, startupConfiguration) => {
        const model = new sessionCompositeGraph_1.SessionGraphModel(descriptor.sessionID);
        investigationGraphs = {};
        investigationGraphHistory = {};
        if (restored && restored.sequence === afterSequence) {
            investigationGraphs = { ...restored.segmentGraphs };
            investigationGraphHistory = Object.fromEntries(Object.entries(restored.segmentGraphHistory).map(([segmentID, revisions]) => [segmentID, { ...revisions }]));
            publishInvestigationState(model.restore(afterSequence, restored.manifest, restored.segmentGraphs, restored.runtimeNodes, restored.executionNodeID, restored.pending, restored.segmentGraphHistory, restored.preparedTransitionTargets, restored.segmentGraphAvailability));
        }
        investigationModel = model;
        let client;
        let startupConfigurationSent = false;
        client = new sessionStdioClient_1.SessionStdioClient(child, {
            sessionID: descriptor.sessionID,
            afterSequence,
            onGroup: (group) => {
                if (disposed || revision !== investigationRevision)
                    return;
                const state = model.applyGroup(group);
                for (const segmentID of state.unloadedSegmentIDs)
                    delete investigationGraphs[segmentID];
                for (const graph of group.graphs) {
                    const segmentSnapshot = state.manifest?.segments[graph.segmentID];
                    if (!segmentSnapshot)
                        throw new Error('Accepted graph revision has no segment snapshot.');
                    investigationGraphs[graph.segmentID] = {
                        revision: graph.revision,
                        wholeBlobHash: graph.wholeBlobHash,
                        encodedDocument: graph.encodedDocument,
                        document: graph.document,
                        segmentSnapshot: {
                            ...segmentSnapshot,
                            attempt_run_ids: [...segmentSnapshot.attempt_run_ids],
                        },
                    };
                    investigationGraphHistory[graph.segmentID] = {
                        ...(investigationGraphHistory[graph.segmentID] ?? {}),
                        [String(graph.revision)]: investigationGraphs[graph.segmentID],
                    };
                }
                publishInvestigationState(state);
                if (group.handshake && startupConfiguration && !startupConfigurationSent) {
                    startupConfigurationSent = true;
                    client.send({
                        type: 'session.configure',
                        commandID: startupConfiguration.commandID,
                        payload: { inputs: startupConfiguration.inputs },
                    });
                }
            },
            onAcceptedSequence: (acceptedSequence) => {
                if (disposed || revision !== investigationRevision || !investigationDescriptor)
                    return;
                if (investigationState)
                    persistInvestigationCheckpoint(investigationState, acceptedSequence);
            },
            onError: (message) => {
                if (revision === investigationRevision)
                    reportInvestigationError(message);
            },
            onStderr: (text) => {
                if (revision !== investigationRevision)
                    return;
                output?.append(text);
                if (ready && !disposed)
                    void panel.webview.postMessage({ type: 'session.stderr', text });
            },
            onExit: (code, signal) => {
                if (revision !== investigationRevision)
                    return;
                if (investigationClient === client)
                    investigationClient = undefined;
                if (bridge && runBridge === bridge) {
                    runBridge.dispose();
                    runBridge = undefined;
                }
                if (ready && !disposed)
                    void panel.webview.postMessage({ type: 'session.exit', code, signal });
                applyDeferredReload();
            },
        });
        investigationClient = client;
    };
    const spawnInvestigation = async (descriptor, args, afterSequence, restored, startupConfiguration) => {
        const revision = ++investigationRevision;
        const isCurrent = () => !disposed && revision === investigationRevision;
        let bridge;
        let child;
        let ownershipTransferred = false;
        const scopedConfig = vscode.workspace.getConfiguration('gert', vscode.Uri.file(runbookPath));
        const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
        const packageMap = (0, runHandoff_2.resolveRunPackageMapPath)(descriptor.projectRoot, scopedConfig.get('packageMap', ''));
        if (packageMap.warning)
            output?.appendLine(`[gert session] WARNING: ${packageMap.warning}`);
        const vscodeMcpActions = currentDocument
            ? (0, toolDefinitionRegistry_1.buildRegistryForRun)(descriptor.projectRoot, packageMap.path)
            : {};
        try {
            const configuredBinary = scopedConfig.get('binaryPath', 'gert');
            const binary = testHooks?.spawnSession
                ? configuredBinary
                : await (0, binaryResolver_1.resolveBinary)(configuredBinary, output, descriptor.projectRoot, workspaceFolders);
            if (!testHooks?.spawnSession && currentDocument)
                await (0, presentationClient_1.requireCompatibleExecution)(binary, currentDocument);
            bridge = currentDocument && (0, directGraphPreview_1.sessionMayRequireMcpBridge)(currentDocument, vscodeMcpActions)
                ? await createMcpBridge(vscodeMcpActions, vscode.Uri.file(runbookPath))
                : undefined;
            if (!isCurrent())
                return;
            if (!isCurrent())
                return;
            const launchArgs = (0, sessionStdioClient_1.withSessionPackageMap)(args, packageMap.path);
            const spawnOptions = {
                cwd: descriptor.projectRoot,
                env: {
                    ...process.env,
                    ...(bridge ? {
                        GERT_VSCODE_BRIDGE_URL: bridge.bridgeUrl,
                        GERT_VSCODE_BRIDGE_TOKEN: bridge.bridgeToken,
                    } : {}),
                },
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            };
            child = testHooks?.spawnSession
                ? testHooks.spawnSession(binary, launchArgs, spawnOptions)
                : (0, child_process_1.spawn)(binary, launchArgs, spawnOptions);
            if (!isCurrent())
                return;
            if (!child.stdin || !child.stdout || !child.stderr) {
                throw new Error('gert session process did not expose stdin, stdout, and stderr pipes');
            }
            configureInvestigationClient(child, descriptor, afterSequence, restored, bridge, revision, startupConfiguration);
            runBridge = bridge;
            ownershipTransferred = true;
        }
        finally {
            if (!ownershipTransferred) {
                if (child && child.exitCode === null && !child.killed)
                    child.kill();
                bridge?.dispose();
                if (runBridge === bridge)
                    runBridge = undefined;
            }
        }
    };
    const startInvestigation = async (rawInputs) => {
        if (disposed || runStarting || runSession || investigationClient || investigationDescriptor || investigationStarting) {
            reportInvestigationError('Another run or session is already active.');
            return;
        }
        if (!currentDocument) {
            reportInvestigationError('The runbook graph is not loaded.');
            return;
        }
        const inputs = directRunInputs(rawInputs);
        const privateInputNames = directSecretInputNames(currentDocument);
        const privateInputs = Object.fromEntries([...privateInputNames].filter((name) => inputs[name] !== undefined).map((name) => [name, inputs[name]]));
        const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
        const projectRoot = (0, projectRoot_1.pickProjectRoot)(runbookPath, workspaceFolders, path.dirname(runbookPath));
        const descriptor = {
            schemaVersion: sessionPanelState_1.STORED_SESSION_SCHEMA,
            sessionID: (0, crypto_1.randomUUID)(),
            creationCommandID: (0, crypto_1.randomUUID)(),
            configurationCommandID: (0, crypto_1.randomUUID)(),
            runbookPath,
            projectRoot,
            acceptedSequence: 0,
        };
        investigationStarting = true;
        const startRevision = ++investigationRevision;
        try {
            await checkpointWriter.flush();
            await extensionContext.workspaceState.update(sessionPanelState_1.SESSION_WORKSPACE_STATE_KEY, descriptor);
        }
        catch (error) {
            investigationStarting = false;
            reportInvestigationError((0, enumInputs_1.deriveFailureMessage)(error));
            return;
        }
        if (disposed || startRevision !== investigationRevision) {
            investigationStarting = false;
            return;
        }
        investigationDescriptor = descriptor;
        investigationState = undefined;
        investigationGraphs = {};
        investigationGraphHistory = {};
        if (ready && !disposed)
            void panel.webview.postMessage({ type: 'session.starting', sessionID: descriptor.sessionID });
        try {
            await spawnInvestigation(descriptor, (0, sessionStdioClient_1.buildSessionStartArgs)(runbookPath, descriptor.sessionID, descriptor.creationCommandID, inputs, privateInputNames, projectRoot), 0, undefined, { commandID: descriptor.configurationCommandID, inputs: privateInputs });
        }
        catch (error) {
            reportInvestigationError((0, enumInputs_1.deriveFailureMessage)(error));
        }
        finally {
            investigationStarting = false;
        }
    };
    const reconnectInvestigation = async () => {
        if (disposed || investigationClient || runSession || !currentDocument)
            return;
        let descriptor;
        try {
            descriptor = (0, sessionPanelState_1.parseStoredSessionDescriptor)(extensionContext.workspaceState.get(sessionPanelState_1.SESSION_WORKSPACE_STATE_KEY));
        }
        catch {
            return;
        }
        if (path.resolve(descriptor.runbookPath) !== path.resolve(runbookPath))
            return;
        investigationDescriptor = descriptor;
        const cache = await sessionCache.load(descriptor.sessionID);
        const afterSequence = (0, sessionPanelState_1.recoverySequence)(descriptor, cache);
        if (cache && cache.sequence === afterSequence && closedInvestigationStatus(cache.manifest.session.status)) {
            investigationGraphs = { ...cache.segmentGraphs };
            investigationGraphHistory = Object.fromEntries(Object.entries(cache.segmentGraphHistory).map(([segmentID, revisions]) => [segmentID, { ...revisions }]));
            const model = new sessionCompositeGraph_1.SessionGraphModel(descriptor.sessionID);
            investigationModel = model;
            publishInvestigationState(model.restore(afterSequence, cache.manifest, cache.segmentGraphs, cache.runtimeNodes, cache.executionNodeID, cache.pending, cache.segmentGraphHistory, cache.preparedTransitionTargets, cache.segmentGraphAvailability));
            return;
        }
        if (ready && !disposed)
            void panel.webview.postMessage({ type: 'session.reconnecting', sessionID: descriptor.sessionID });
        try {
            await spawnInvestigation(descriptor, (0, sessionStdioClient_1.buildSessionAttachArgs)(descriptor.sessionID, afterSequence, descriptor.projectRoot), afterSequence, cache);
        }
        catch (error) {
            reportInvestigationError((0, enumInputs_1.deriveFailureMessage)(error));
        }
    };
    const loadSavedRouteTests = async (projectRoot, runbookRelative, planHash) => {
        const loaded = await (0, routeTestArtifacts_1.loadRouteTestArtifacts)(projectRoot, runbookRelative);
        return {
            routeTests: loaded.artifacts.map(({ artifact }) => ({
                artifact,
                needsReview: artifact.plan_hash !== planHash,
            })),
            warnings: loaded.warnings,
        };
    };
    const publishSavedRouteTests = async () => {
        if (disposed || !currentProjectRoot || !currentRunbookRelative || !currentPlanHash)
            return;
        const projectRoot = currentProjectRoot;
        const runbookRelative = currentRunbookRelative;
        const planHash = currentPlanHash;
        const loaded = await loadSavedRouteTests(projectRoot, runbookRelative, planHash);
        if (disposed || projectRoot !== currentProjectRoot || runbookRelative !== currentRunbookRelative || planHash !== currentPlanHash)
            return;
        for (const warning of loaded.warnings)
            output?.appendLine(`[gert route test] WARNING: ${warning}`);
        void panel.webview.postMessage({ type: 'route-tests', routeTests: loaded.routeTests });
    };
    const reload = async () => {
        const revision = ++loadRevision;
        loadController?.abort();
        const controller = new AbortController();
        loadController = controller;
        publish({ type: 'loading' });
        publishReloadState(true);
        const scopedConfig = vscode.workspace.getConfiguration('gert', vscode.Uri.file(runbookPath));
        const style = scopedConfig.get('preview.nodeStyle', 'smooth-curves');
        const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
        const projectRoot = (0, projectRoot_1.pickProjectRoot)(runbookPath, workspaceFolders, path.dirname(runbookPath));
        const isCurrentRevision = () => !disposed && revision === loadRevision;
        const authoringRoot = (0, presentationContext_1.presentationProjectRoot)(runbookPath, workspaceFolders, path.dirname(runbookPath), scopedConfig.get('packageMap', ''));
        try {
            let document;
            if (testHooks?.documentLoader) {
                document = await testHooks.documentLoader();
                if (!isCurrentRevision())
                    return;
            }
            else {
                const configuredBinary = scopedConfig.get('binaryPath', 'gert');
                let binary = scopedConfig.get('highlighting.developmentHelperPath', '') || (0, presentationClient_1.bundledPresentationHelper)(extensionContext.extensionPath);
                if (!path.isAbsolute(binary))
                    throw new Error('Presentation helper path must be absolute.');
                try {
                    await (0, presentationClient_1.verifyPresentationHelper)(binary, controller.signal);
                }
                catch {
                    binary = await (0, binaryResolver_1.resolveBinary)(configuredBinary, output, projectRoot, workspaceFolders);
                }
                if (!isCurrentRevision())
                    return;
                document = await (0, directGraphPreview_1.loadGraphDocument)(binary, runbookPath, async (command, args) => {
                    const { stdout } = await pexec(command, args, {
                        cwd: authoringRoot,
                        signal: controller.signal,
                        maxBuffer: 16 * 1024 * 1024,
                    });
                    if (!isCurrentRevision())
                        throw new Error('Graph reload was superseded.');
                    return { stdout };
                }, (0, runHandoff_2.resolveRunPackageMapPath)(authoringRoot, scopedConfig.get('packageMap', '')).path);
                if (!isCurrentRevision())
                    return;
            }
            let planHash = document.hash;
            (0, presentationEditor_1.setPresentationEntrypoint)(authoringRoot, runbookPath, document.frames.map(frame => frame.runbook_path));
            let planWarning;
            if (!testHooks?.documentLoader) {
                try {
                    const configuredBinary = scopedConfig.get('binaryPath', 'gert');
                    const binary = await (0, binaryResolver_1.resolveBinary)(configuredBinary, output, projectRoot, workspaceFolders);
                    if (!isCurrentRevision())
                        return;
                    const packageMap = (0, runHandoff_2.resolveRunPackageMapPath)(projectRoot, scopedConfig.get('packageMap', ''));
                    const planArgs = ['plan', '--output', 'json', '--expand', 'eager'];
                    if (packageMap.path)
                        planArgs.push('--package-map', packageMap.path);
                    planArgs.push(runbookPath);
                    const { stdout } = await pexec(binary, planArgs, { cwd: projectRoot, signal: controller.signal, maxBuffer: 16 * 1024 * 1024 });
                    if (!isCurrentRevision())
                        return;
                    planHash = parseRouteTestPlanHash(stdout);
                }
                catch (planError) {
                    if (!isCurrentRevision())
                        return;
                    planHash = undefined;
                    planWarning = `[gert route test] unavailable for ${runbookPath}: ${(0, enumInputs_1.deriveFailureMessage)(planError)}`;
                }
            }
            const runbookRelative = path.relative(projectRoot, runbookPath).replaceAll(path.sep, '/');
            const loadedRouteTests = planHash
                ? await loadSavedRouteTests(projectRoot, runbookRelative, planHash)
                : { routeTests: [], warnings: [] };
            if (!isCurrentRevision())
                return;
            currentStyle = style;
            currentProjectRoot = projectRoot;
            currentRunbookRelative = runbookRelative;
            currentPlanHash = planHash;
            currentDocument = document;
            if (planWarning)
                output?.appendLine(planWarning);
            for (const warning of loadedRouteTests.warnings)
                output?.appendLine(`[gert route test] WARNING: ${warning}`);
            publish({
                type: 'graph',
                document,
                style,
                ...(planHash ? { routeTestContext: { runbook: runbookRelative, planHash } } : {}),
                routeTests: loadedRouteTests.routeTests,
                testMode: extensionContext?.extensionMode === vscode.ExtensionMode.Test,
            });
            output?.appendLine(`[gert] direct graph loaded for ${runbookPath}`);
        }
        catch (error) {
            if (!isCurrentRevision())
                return;
            const message = (0, enumInputs_1.deriveFailureMessage)(error);
            publish({ type: 'error', message });
            output?.appendLine(`[gert] direct graph failed for ${runbookPath}:\n${message}`);
        }
        finally {
            if (loadController === controller) {
                loadController = undefined;
                publishReloadState(false);
            }
        }
    };
    const requestReload = () => {
        if (runStarting || runSession || investigationClient || investigationDescriptor) {
            reloadPending = true;
            return;
        }
        void reload();
    };
    const applyDeferredReload = () => {
        if (!reloadPending || disposed)
            return;
        reloadPending = false;
        void reload();
    };
    const confirmedHostActionRequests = new Set();
    const consumePanelConfirmation = (requestId) => confirmedHostActionRequests.delete(requestId);
    const recordPanelConfirmation = (value) => {
        const expectedFields = [
            'type', 'version', 'capability', 'runId', 'turnId', 'correlationId', 'previewSessionId', 'requestId',
        ];
        if (Object.keys(value).length !== expectedFields.length ||
            !expectedFields.every((field) => Object.prototype.hasOwnProperty.call(value, field)) ||
            value.type !== 'gert.host-action.confirmed-request' ||
            value.version !== 'host-action/v1' ||
            value.capability !== 'xts.open-view')
            return false;
        for (const field of expectedFields.slice(3)) {
            const item = value[field];
            if (typeof item !== 'string' || item.length === 0 || item.length > 1024)
                return false;
        }
        if (confirmedHostActionRequests.size >= 32)
            return false;
        confirmedHostActionRequests.add(value.requestId);
        return true;
    };
    const hostActionRegistry = new Map([
        ['test.echo', { handler: hostActionBridge_1.testEchoHandler }],
        ['xts.open-view', { handler: makeXtsOpenViewHandler(panel, consumePanelConfirmation, testHooks?.showXtsReminder), timeoutMs: XTS_HOST_ACTION_TIMEOUT_MS }],
    ]);
    const hostActionTransport = (0, hostActionBridge_1.webviewPanelTransport)(panel, () => !disposed && directGraphPanel === panel);
    const hostActions = (0, hostActionBridge_1.createHostActionBridge)(hostActionRegistry, {
        sendAck: (ack) => {
            testHooks?.onHostActionAck?.(ack);
            hostActionTransport.sendAck(ack);
        },
        sendCancel: (cancel) => hostActionTransport.sendCancel(cancel),
    });
    const invalidateHostActionRun = () => {
        activeHostActionRunID = undefined;
        confirmedHostActionRequests.clear();
        hostActions.cancelAllPending('run-replaced');
    };
    const startRun = async (rawInputs, rawDebug, routeTestPath, reservedRevision) => {
        if (disposed)
            return;
        if (loadController !== undefined) {
            if (reservedRevision !== undefined && activeRouteTest?.revision === reservedRevision) {
                activeRouteTest = undefined;
                runStarting = false;
            }
            void panel.webview.postMessage({
                type: 'run.error',
                message: 'The runbook graph is reloading. Wait for it to finish before starting a run.',
            });
            return;
        }
        if ((runStarting || runSession || investigationClient || investigationDescriptor) && reservedRevision === undefined) {
            void panel.webview.postMessage({ type: 'run.error', message: 'A run is already active.' });
            return;
        }
        let inputs;
        let debug;
        try {
            if (!currentDocument)
                throw new Error('The runbook graph is not loaded.');
            inputs = routeTestPath ? {} : directRunInputs(rawInputs);
            debug = routeTestPath ? undefined : (0, directDebug_1.parseDirectDebugConfig)(rawDebug);
            if (!routeTestPath)
                (0, directDebug_1.validateDirectDebugTargets)(debug, currentDocument?.nodes ?? []);
        }
        catch (error) {
            void panel.webview.postMessage({ type: 'run.error', message: (0, enumInputs_1.deriveFailureMessage)(error) });
            return;
        }
        invalidateHostActionRun();
        if (reservedRevision === undefined)
            runStarting = true;
        const startRevision = reservedRevision ?? ++runStartRevision;
        const startupIsActive = () => !disposed && startRevision === runStartRevision;
        void panel.webview.postMessage({ type: 'run.starting', routeTest: routeTestPath !== undefined });
        try {
            await testHooks?.beforeSpawn?.();
            if (!startupIsActive())
                return;
            const scopedConfig = vscode.workspace.getConfiguration('gert', vscode.Uri.file(runbookPath));
            const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
            const projectRoot = (0, projectRoot_1.pickProjectRoot)(runbookPath, workspaceFolders, path.dirname(runbookPath));
            const packageMap = (0, runHandoff_2.resolveRunPackageMapPath)(projectRoot, scopedConfig.get('packageMap', ''));
            if (packageMap.warning)
                output?.appendLine(`[gert run] WARNING: ${packageMap.warning}`);
            const configuredBinary = scopedConfig.get('binaryPath', 'gert');
            const binary = testHooks?.spawnRun
                ? configuredBinary
                : await (0, binaryResolver_1.resolveBinary)(configuredBinary, output, projectRoot, workspaceFolders);
            if (!testHooks?.spawnRun)
                await requireRunbookCompatibility(binary, currentDocument, runbookPath, projectRoot, packageMap.path);
            const vscodeMcpActions = routeTestPath ? {} : (0, toolDefinitionRegistry_1.buildRegistryForRun)(projectRoot, packageMap.path);
            const bridge = !routeTestPath && (0, directGraphPreview_1.graphMayRequireMcpBridge)(currentDocument, vscodeMcpActions)
                ? await createMcpBridge(vscodeMcpActions, vscode.Uri.file(runbookPath))
                : undefined;
            runBridge = bridge;
            if (!startupIsActive()) {
                runBridge?.dispose();
                runBridge = undefined;
                return;
            }
            if (!startupIsActive())
                return;
            const privateInputNames = routeTestPath ? new Set() : directSecretInputNames(currentDocument);
            const args = (0, directRunSession_1.buildStdioRunArgs)(runbookPath, inputs, packageMap.path, debug !== undefined, privateInputNames, routeTestPath, currentDocument !== undefined && (0, presentationClient_1.usesTypedResults)(currentDocument));
            const spawnOptions = {
                cwd: projectRoot,
                env: {
                    ...process.env,
                    ...(bridge ? {
                        GERT_VSCODE_BRIDGE_URL: bridge.bridgeUrl,
                        GERT_VSCODE_BRIDGE_TOKEN: bridge.bridgeToken,
                    } : {}),
                },
                stdio: ['pipe', 'pipe', 'pipe'],
            };
            if (!startupIsActive())
                return;
            const child = testHooks?.spawnRun
                ? testHooks.spawnRun(binary, args, spawnOptions)
                : (0, child_process_1.spawn)(binary, args, spawnOptions);
            if (!startupIsActive()) {
                child.kill();
                bridge?.dispose();
                return;
            }
            if (!child.stdin || !child.stdout || !child.stderr) {
                child.kill();
                throw new Error('gert stdio process did not expose stdin, stdout, and stderr pipes');
            }
            let session;
            session = new directRunSession_1.DirectRunSession(child, {
                onFrame: (frame) => {
                    if (!startupIsActive())
                        return;
                    if (frame.type === 'run.started') {
                        invalidateHostActionRun();
                        activeHostActionRunID = frame.runID;
                    }
                    const eventKind = frame.type === 'run.event' && typeof frame.event === 'object' && frame.event !== null
                        ? frame.event.kind
                        : undefined;
                    if (frame.type === 'run.finished' || frame.type === 'protocol.error' ||
                        eventKind === 'run/completed' || eventKind === 'run/failed' ||
                        eventKind === 'run/cancelled' || eventKind === 'run/indeterminate') {
                        invalidateHostActionRun();
                    }
                    if (routeTestPath && frame.type === 'run.finished') {
                        if (activeRouteTest?.revision === startRevision) {
                            activeRouteTest.outcome = parseDirectRouteTestOutcome(frame.routeTest);
                        }
                    }
                    void panel.webview.postMessage({ type: 'run.frame', frame });
                    if (bridge && frame.type === 'run.finished' && runBridge === bridge) {
                        runBridge.dispose();
                        runBridge = undefined;
                    }
                    if (frame.type === 'run.finished')
                        applyDeferredReload();
                },
                onError: (message) => {
                    if (!startupIsActive())
                        return;
                    invalidateHostActionRun();
                    output?.appendLine(`[gert] stdio protocol error: ${message}`);
                    void panel.webview.postMessage({ type: 'run.error', message });
                },
                onStderr: (text) => {
                    if (!startupIsActive())
                        return;
                    output?.append(text);
                    void panel.webview.postMessage({ type: 'run.stderr', text });
                },
                onExit: (code, signal) => {
                    if (!startupIsActive())
                        return;
                    invalidateHostActionRun();
                    if (runSession === session)
                        runSession = undefined;
                    if (bridge && runBridge === bridge) {
                        runBridge.dispose();
                        runBridge = undefined;
                    }
                    void panel.webview.postMessage({ type: 'run.exit', code, signal });
                    applyDeferredReload();
                },
            });
            runSession = session;
            if (!routeTestPath && (debug || privateInputNames.size > 0)) {
                const privateInputs = Object.fromEntries([...privateInputNames].filter((name) => inputs[name] !== undefined).map((name) => [name, inputs[name]]));
                session.send({
                    type: 'run.configure',
                    ...(Object.keys(privateInputs).length > 0 ? { inputs: privateInputs } : {}),
                    ...(debug ? { debug } : {}),
                });
            }
        }
        catch (error) {
            invalidateHostActionRun();
            runBridge?.dispose();
            runBridge = undefined;
            if (reservedRevision !== undefined && activeRouteTest?.revision === reservedRevision && !runSession) {
                activeRouteTest = undefined;
            }
            const message = (0, enumInputs_1.deriveFailureMessage)(error);
            output?.appendLine(`[gert] direct run failed to start:\n${message}`);
            if (startupIsActive())
                void panel.webview.postMessage({ type: 'run.error', message });
        }
        finally {
            if (startRevision === runStartRevision)
                runStarting = false;
            if (!runSession)
                applyDeferredReload();
            testHooks?.onStartSettled?.();
        }
    };
    const saveRouteTest = async (rawArtifact, run) => {
        try {
            if (!currentProjectRoot || !currentRunbookRelative || !currentPlanHash || !currentDocument) {
                throw new Error('The runbook graph is not loaded.');
            }
            if (typeof rawArtifact !== 'object' || rawArtifact === null || Array.isArray(rawArtifact)) {
                throw new Error('Route test must be an object.');
            }
            const requested = rawArtifact;
            if (typeof requested.plan_hash !== 'string') {
                throw new Error('The route test plan_hash must exist and be a string. Review it again before saving or running.');
            }
            if (requested.plan_hash !== currentPlanHash) {
                throw new Error('The route test plan_hash no longer matches this runbook. Review it again before saving or running.');
            }
            const savingResult = requested.last_result !== undefined;
            let candidate;
            if (savingResult) {
                if (!activeRouteTest?.outcome)
                    throw new Error('No completed route test is available to save.');
                if (currentPlanHash !== activeRouteTest.artifact.plan_hash)
                    throw new Error('The runbook changed while the route test was running. Review and run it again.');
                if (requested.id !== activeRouteTest.artifact.id)
                    throw new Error('The route-test result does not match the executed artifact.');
                candidate = (0, routeTestArtifacts_1.stampRouteTestResultDigest)({
                    ...activeRouteTest.artifact,
                    last_result: {
                        status: activeRouteTest.outcome.status,
                        target_reached: activeRouteTest.outcome.targetReached,
                        external_dispatches: activeRouteTest.outcome.externalDispatches,
                        ran_at: new Date().toISOString(),
                        conditions_digest: 'pending-extension-stamp',
                    },
                });
            }
            else {
                const { last_result: _discardedResult, ...draft } = requested;
                candidate = draft;
            }
            const artifact = (0, routeTestArtifacts_1.parseRouteTestArtifact)(candidate);
            if (artifact.runbook !== currentRunbookRelative)
                throw new Error('Route test runbook does not match this panel.');
            (0, routeTestArtifacts_1.validateRouteTestAgainstDocument)(artifact, currentDocument);
            const savedArtifact = artifact;
            const reviews = [
                ...(savedArtifact.step_responses ?? []),
                ...(savedArtifact.host_action_responses ?? []),
                ...(savedArtifact.interaction_answers ?? []),
                ...(savedArtifact.test_approvals ?? []),
            ].map((binding) => binding.review);
            if (!savedArtifact.sensitivity_reviewed || reviews.some((review) => !review.sensitivity_reviewed)) {
                throw new Error('Review saved values for sensitive data before persisting this route test.');
            }
            if (run) {
                if (reviews.some((review) => review.state !== 'reviewed')) {
                    throw new Error('Review every saved result and answer before running the route test.');
                }
            }
            let reservedRevision;
            if (run) {
                if (runStarting || runSession || investigationClient || investigationDescriptor)
                    throw new Error('A run is already active.');
                runStarting = true;
                reservedRevision = ++runStartRevision;
                activeRouteTest = {
                    revision: reservedRevision,
                    artifact: JSON.parse(JSON.stringify(savedArtifact)),
                };
            }
            let filePath;
            try {
                filePath = await (0, routeTestArtifacts_1.saveRouteTestArtifact)(currentProjectRoot, savedArtifact);
            }
            catch (error) {
                if (reservedRevision !== undefined && activeRouteTest?.revision === reservedRevision)
                    activeRouteTest = undefined;
                if (reservedRevision !== undefined)
                    runStarting = false;
                throw error;
            }
            await publishSavedRouteTests();
            void panel.webview.postMessage({ type: 'route-test.saved', artifact: savedArtifact, running: run });
            if (run)
                await startRun({}, undefined, filePath, reservedRevision);
        }
        catch (error) {
            const message = (0, enumInputs_1.deriveFailureMessage)(error);
            output?.appendLine(`[gert route test] ${message}`);
            void panel.webview.postMessage({ type: 'route-test.error', message });
        }
    };
    const messageSub = panel.webview.onDidReceiveMessage((message) => {
        if (typeof message !== 'object' || message === null || Array.isArray(message))
            return;
        const candidate = message;
        if (candidate.type === 'ready') {
            ready = true;
            void panel.webview.postMessage(latestMessage);
            if (investigationState) {
                void panel.webview.postMessage({ type: 'session.update', state: investigationState, style: currentStyle });
            }
            void panel.webview.postMessage({ type: 'graph.reload-state', active: loadController !== undefined });
            return;
        }
        if (candidate.type === 'session.start') {
            void startInvestigation(candidate.inputs);
            return;
        }
        if (candidate.type === 'session.command') {
            if (!investigationClient || typeof candidate.command !== 'object' || candidate.command === null || Array.isArray(candidate.command)) {
                reportInvestigationError('No investigation session is attached.');
                return;
            }
            const command = candidate.command;
            const supported = new Set([
                'session.configure', 'interaction.answer', 'session.cancel', 'session.detach',
                'session.resume', 'session.continue_live', 'session.close',
            ]);
            if (typeof command.type !== 'string' || !supported.has(command.type)) {
                reportInvestigationError('Unsupported investigation session command.');
                return;
            }
            const request = {
                type: command.type,
                commandID: (0, crypto_1.randomUUID)(),
                ...(typeof command.segmentID === 'string' ? { segmentID: command.segmentID } : {}),
                ...(typeof command.runID === 'string' ? { runID: command.runID } : {}),
                ...(typeof command.turnID === 'string' ? { turnID: command.turnID } : {}),
                ...(command.payload !== undefined ? { payload: command.payload } : {}),
            };
            investigationClient.send(request);
            return;
        }
        if (candidate.type === 'session.graph-revision') {
            const requestID = typeof candidate.requestID === 'string' ? candidate.requestID : '';
            const segmentID = typeof candidate.segmentID === 'string' ? candidate.segmentID : '';
            const originalNodeID = typeof candidate.originalNodeID === 'string' ? candidate.originalNodeID : '';
            const revision = candidate.revision;
            if (!requestID || requestID.length > 1024 || !segmentID || segmentID.length > 1024 ||
                !originalNodeID || originalNodeID.length > 4096 || !Number.isSafeInteger(revision) ||
                revision < 1 || !investigationModel) {
                reportInvestigationError('Historical graph revision request is invalid.');
                return;
            }
            void ensureInvestigationGraph(segmentID, revision).then(() => {
                const node = investigationModel?.graphRevisionNode(segmentID, revision, originalNodeID);
                if (ready && !disposed) {
                    void panel.webview.postMessage({
                        type: 'session.graph-revision', requestID,
                        ...(node ? { node } : { error: 'The selected node is unavailable in that graph revision.' }),
                    });
                }
            });
            return;
        }
        if (candidate.type === 'session.load-segment') {
            const segmentID = typeof candidate.segmentID === 'string' ? candidate.segmentID : '';
            const revision = candidate.revision;
            if (!segmentID || segmentID.length > 1024 || !Number.isSafeInteger(revision) || revision < 1) {
                reportInvestigationError('Historical segment request is invalid.');
                return;
            }
            void ensureInvestigationGraph(segmentID, revision);
            return;
        }
        if (candidate.type === 'session.load-route') {
            const targetSegmentID = typeof candidate.targetSegmentID === 'string' ? candidate.targetSegmentID : '';
            const manifest = investigationState?.manifest;
            const targetOrdinal = manifest?.segments[targetSegmentID]?.ordinal;
            if (!manifest || targetOrdinal === undefined) {
                reportInvestigationError('Historical route request is invalid.');
                return;
            }
            const missing = investigationState?.unloadedSegmentIDs ?? [];
            void (async () => {
                for (const segmentID of missing
                    .filter((id) => (manifest.segments[id]?.ordinal ?? Number.MAX_SAFE_INTEGER) <= targetOrdinal)
                    .sort((left, right) => manifest.segments[left].ordinal - manifest.segments[right].ordinal)) {
                    const revision = manifest.segments[segmentID].graph_revision;
                    if (revision)
                        await ensureInvestigationGraph(segmentID, revision);
                }
            })();
            return;
        }
        if (candidate.type === 'session.reset') {
            if (investigationClient && !closedInvestigationStatus(investigationState?.sessionStatus)) {
                reportInvestigationError('Close or detach the active investigation before resetting it.');
                return;
            }
            investigationClient?.dispose();
            investigationClient = undefined;
            const resetSessionID = investigationDescriptor?.sessionID;
            investigationRevision += 1;
            investigationStarting = false;
            investigationDescriptor = undefined;
            investigationModel = undefined;
            investigationState = undefined;
            investigationGraphs = {};
            investigationGraphHistory = {};
            runBridge?.dispose();
            runBridge = undefined;
            void checkpointWriter.flush()
                .then(async () => {
                await extensionContext.workspaceState.update(sessionPanelState_1.SESSION_WORKSPACE_STATE_KEY, undefined);
                if (resetSessionID)
                    await sessionCache.delete(resetSessionID);
            })
                .then(() => reload())
                .catch((error) => reportInvestigationError(`Could not reset investigation: ${(0, enumInputs_1.deriveFailureMessage)(error)}`));
            return;
        }
        if (candidate.type === 'run.start') {
            void startRun(candidate.inputs, candidate.debug);
            return;
        }
        if (candidate.type === 'run.command') {
            if (typeof candidate.command === 'object' && candidate.command !== null && !Array.isArray(candidate.command)) {
                const command = candidate.command;
                if (command.runID === activeHostActionRunID)
                    runSession?.send(command);
            }
            return;
        }
        if (candidate.type === 'run.reset') {
            invalidateHostActionRun();
            runStartRevision += 1;
            runStarting = false;
            runSession?.dispose();
            runSession = undefined;
            runBridge?.dispose();
            runBridge = undefined;
            activeRouteTest = undefined;
            applyDeferredReload();
            return;
        }
        if (candidate.type === 'route-test.save' || candidate.type === 'route-test.run') {
            void saveRouteTest(candidate.artifact, candidate.type === 'route-test.run');
            return;
        }
        if (candidate.type === 'gert.host-action.confirmed-request') {
            if (candidate.runId === activeHostActionRunID)
                recordPanelConfirmation(candidate);
            return;
        }
        if (candidate.type === 'style.change' &&
            (candidate.style === 'smooth-curves' || candidate.style === 'minimalist' || candidate.style === 'header-badges')) {
            void vscode.workspace
                .getConfiguration('gert', vscode.Uri.file(runbookPath))
                .update('preview.nodeStyle', candidate.style, vscode.ConfigurationTarget.WorkspaceFolder);
            return;
        }
        if (candidate.type !== 'gert.host-action.request' || candidate.runId === activeHostActionRunID) {
            void hostActions.receive(message);
        }
    });
    const saveSub = vscode.workspace.onDidSaveTextDocument((document) => {
        const folders = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
        const config = vscode.workspace.getConfiguration('gert', vscode.Uri.file(runbookPath));
        const projectRoot = (0, presentationContext_1.presentationProjectRoot)(runbookPath, folders, path.dirname(runbookPath), config.get('packageMap', ''));
        const packageMap = (0, runHandoff_2.resolveRunPackageMapPath)(projectRoot, config.get('packageMap', ''));
        if ((0, graphSourceChanged_1.graphSourceChanged)(document.fileName, runbookPath, projectRoot, currentDocument, packageMap.path))
            requestReload();
    });
    const configSub = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('gert.packageMap', vscode.Uri.file(runbookPath)))
            requestReload();
        if (event.affectsConfiguration('gert.highlighting.enabled')) {
            void panel.webview.postMessage({ type: 'highlighting', enabled: vscode.workspace.getConfiguration('gert', vscode.Uri.file(runbookPath)).get('highlighting.enabled', true) });
        }
        if (!event.affectsConfiguration('gert.preview.nodeStyle', vscode.Uri.file(runbookPath)))
            return;
        const updatedStyle = vscode.workspace
            .getConfiguration('gert', vscode.Uri.file(runbookPath))
            .get('preview.nodeStyle', 'smooth-curves');
        currentStyle = updatedStyle;
        if (latestMessage.type === 'graph') {
            latestMessage = { ...latestMessage, style: updatedStyle };
        }
        if (ready && !disposed) {
            void panel.webview.postMessage({ type: 'style', style: updatedStyle });
        }
    });
    void extensionContext?.workspaceState.update(panelRecovery_1.WORKSPACE_RUNBOOK_KEY, runbookPath);
    directGraphPanel = panel;
    panel.onDidDispose(() => {
        disposed = true;
        investigationRevision += 1;
        investigationStarting = false;
        runStartRevision += 1;
        loadRevision += 1;
        loadController?.abort();
        runSession?.dispose();
        const attachedInvestigation = investigationClient;
        if (attachedInvestigation) {
            attachedInvestigation.send({ type: 'session.detach', commandID: (0, crypto_1.randomUUID)() });
            const forceStop = setTimeout(() => attachedInvestigation.dispose(), 30_000);
            forceStop.unref();
        }
        runBridge?.dispose();
        hostActions.dispose();
        confirmedHostActionRequests.clear();
        messageSub.dispose();
        saveSub.dispose();
        configSub.dispose();
        if (directGraphPanel === panel) {
            directGraphPanel = undefined;
        }
    });
    void reload().then(() => reconnectInvestigation());
    return panel;
}
//# sourceMappingURL=extension.js.map