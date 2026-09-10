"use strict";
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
exports.setPresentationEntrypoint = void 0;
exports.registerPresentationEditor = registerPresentationEditor;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const vscode = __importStar(require("vscode"));
const worker_threads_1 = require("worker_threads");
const presentationClient_1 = require("./presentationClient");
const presentationStatus_1 = require("./presentationStatus");
const authoringContext_1 = require("./authoringContext");
var authoringContext_2 = require("./authoringContext");
Object.defineProperty(exports, "setPresentationEntrypoint", { enumerable: true, get: function () { return authoringContext_2.setPresentationEntrypoint; } });
const presentationProtocol_1 = require("./presentationProtocol");
const expressionPresentationClient_1 = require("./expressionPresentationClient");
const presentationDiagnostics_1 = require("./presentationDiagnostics");
function registerPresentationEditor(context, output) {
    const states = new Map();
    const diagnostics = new Map();
    const failures = new Map();
    const diagnosticCommand = vscode.commands.registerCommand('gert.showHighlightingDiagnostics', async () => {
        const active = vscode.window.activeTextEditor?.document.uri.toString();
        const latest = active ? diagnostics.get(active) : [...diagnostics.values()].at(-1);
        output.show(true);
        if (!latest) {
            output.appendLine('[gert highlighting] No completed editor metadata request. Keep the runbook visible until its highlighting status settles.');
            return;
        }
        const build = await (0, presentationDiagnostics_1.diagnosticHelperBuild)(latest.helper);
        output.appendLine(`[gert highlighting] ${JSON.stringify({ ...latest, helperBuild: build,
            extension: { path: context.extensionPath, version: context.extension.packageJSON.version, diagnosticVersion: 1 } })}`);
        return latest;
    });
    let generation = 0, disposed = false;
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
    status.name = 'Gert code and expression presentation';
    status.command = 'gert.showHighlightingDiagnostics';
    // window-scoped: the feature toggle deliberately applies to editor and execution surfaces in this window.
    const enabled = () => vscode.workspace.getConfiguration('gert').get('highlighting.enabled', true);
    const eligible = (document) => document.languageId === 'yaml' &&
        !/^\.env(?:\.|$)/i.test(path.basename(document.fileName)) &&
        (document.isUntitled || /\.runbook\.ya?ml$/i.test(document.fileName));
    const updateStatus = () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !eligible(editor.document)) {
            status.hide();
            return;
        }
        const reason = states.get(editor.document.uri.toString())?.reason ?? 'Waiting for local metadata';
        status.text = `$(symbol-color) Gert: ${enabled() ? reason : 'highlighting disabled'}`;
        status.tooltip = 'Tool-declared code and core-selected authored expressions. YAML language services remain active. Click for safe helper/context/timing diagnostics in gert Output (no source or values).';
        status.show();
    };
    const clear = (state) => {
        state.controller.abort();
        clearTimeout(state.timer);
        void state.worker?.terminate();
        state.paints.forEach(paint => paint.dispose());
        state.watchers.forEach(watcher => watcher.dispose());
    };
    const refresh = () => {
        if (disposed)
            return;
        generation++;
        for (const state of states.values())
            clear(state);
        states.clear();
        if (enabled()) {
            for (const editor of vscode.window.visibleTextEditors) {
                const document = editor.document, key = document.uri.toString();
                if (!eligible(document) || states.has(key))
                    continue;
                const state = { controller: new AbortController(), paints: [], watchers: [], reason: 'resolving', version: document.version };
                states.set(key, state);
                const currentGeneration = generation;
                state.timer = setTimeout(() => { void paint(editor, state, currentGeneration); }, 150);
            }
        }
        updateStatus();
    };
    async function paint(editor, state, currentGeneration) {
        const document = editor.document;
        const current = () => !disposed && !state.controller.signal.aborted && document.version === state.version && currentGeneration === generation && enabled();
        try {
            const captured = (0, authoringContext_1.captureAuthoringContext)(document, context.extensionPath, currentGeneration);
            const { overlays, known } = captured;
            const config = vscode.workspace.getConfiguration('gert', document.uri);
            const helper = config.get('highlighting.developmentHelperPath', '') || (0, presentationClient_1.bundledPresentationHelper)(context.extensionPath);
            if (!path.isAbsolute(helper))
                throw new Error('helper-path-must-be-absolute');
            const request = { schema_version: 'presentation-resolve/v1', request_id: `${currentGeneration}:${document.version}:${document.uri}`,
                context: captured.context, document: captured.document, overlays };
            const identity = (0, presentationDiagnostics_1.helperIdentity)(helper);
            const expressionStarted = performance.now();
            let expressionDurationMs = 0;
            const [code, expressions] = await Promise.all([
                (0, presentationClient_1.resolveCodePresentation)(helper, request, state.controller.signal),
                (0, expressionPresentationClient_1.resolveExpressionPresentation)(helper, request, state.controller.signal).finally(() => { expressionDurationMs = Math.round(performance.now() - expressionStarted); }),
            ]);
            const reply = code.reply;
            if (!current() || overlays.some(b => vscode.workspace.textDocuments.find(d => d.uri.toString() === b.uri)?.version !== b.version))
                return;
            const diagnostic = (0, presentationDiagnostics_1.presentationDiagnostic)(identity, request, !!known, { status: reply?.status, reason: code.reason ?? reply?.reason, timings: code.timings }, { status: expressions?.status, durationMs: expressionDurationMs });
            const key = document.uri.toString();
            if (!diagnostics.has(key) && diagnostics.size >= 32) {
                const oldest = diagnostics.keys().next().value;
                diagnostics.delete(oldest);
                failures.delete(oldest);
            }
            diagnostics.set(key, diagnostic);
            if (code.reason || reply?.status !== 'resolved') {
                const failure = JSON.stringify([identity, diagnostic.context.projectRoot, diagnostic.context.entrypoint,
                    diagnostic.context.packageMap, diagnostic.overlays, diagnostic.code.reason]);
                if (failures.get(key) !== failure)
                    output.appendLine(`[gert highlighting] ${JSON.stringify(diagnostic)}`);
                failures.set(key, failure);
            }
            else
                failures.delete(key);
            const watchedRoots = new Set();
            for (const dep of reply?.dependencies ?? []) {
                const uri = vscode.Uri.parse(dep.uri);
                if (uri.scheme !== 'file')
                    continue;
                let directory = path.dirname(uri.fsPath);
                try {
                    if (fs.statSync(uri.fsPath).isDirectory())
                        directory = uri.fsPath;
                }
                catch { /* Missing dependencies watch their parent. */ }
                if (watchedRoots.has(directory))
                    continue;
                watchedRoots.add(directory);
                const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '**/*'));
                watcher.onDidChange(refresh, undefined, state.watchers);
                watcher.onDidCreate(refresh, undefined, state.watchers);
                watcher.onDidDelete(refresh, undefined, state.watchers);
                state.watchers.push(watcher);
            }
            if (reply?.status !== 'resolved' && expressions?.status !== 'resolved') {
                state.reason = code.reason ?? reply?.reason ?? expressions?.reason ?? 'presentation-unavailable';
                updateStatus();
                return;
            }
            state.reason = 'warming tokenizer';
            updateStatus();
            const result = await tokenizeDocument(context, request.document.text, reply, expressions, state);
            if (!current())
                return;
            const byColor = new Map();
            for (const span of result.spans) {
                if (span.start < 0 || span.end > document.getText().length || span.end <= span.start || !/^#[0-9a-f]{6}$/i.test(span.color))
                    throw new Error('invalid-token-range');
                const entries = byColor.get(span.color) ?? [];
                entries.push({ range: new vscode.Range(document.positionAt(span.start), document.positionAt(span.end)),
                    hoverMessage: span.macro ? 'Gert interpolation (authored template)' : 'Tool-declared code · Authored template' });
                byColor.set(span.color, entries);
            }
            for (const [color, entries] of byColor) {
                const decoration = vscode.window.createTextEditorDecorationType({ color, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
                state.paints.push(decoration);
                for (const visible of vscode.window.visibleTextEditors.filter(e => e.document === document))
                    visible.setDecorations(decoration, entries);
            }
            state.reason = (0, presentationStatus_1.presentationStatus)(result.spans, reply, result.reasons, code.reason);
            updateStatus();
        }
        catch (error) {
            if (current()) {
                state.reason = error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : 'presentation-unavailable';
                updateStatus();
            }
        }
    }
    const subscriptions = [
        status, diagnosticCommand, (0, authoringContext_1.onDidChangeAuthoringContext)(refresh),
        vscode.workspace.onDidChangeTextDocument(refresh),
        vscode.workspace.onDidOpenTextDocument(refresh),
        vscode.workspace.onDidCloseTextDocument(refresh),
        vscode.workspace.onDidChangeConfiguration(refresh),
        vscode.window.onDidChangeVisibleTextEditors(refresh),
        vscode.window.onDidChangeActiveTextEditor(updateStatus),
        vscode.window.onDidChangeActiveColorTheme(refresh),
    ];
    const configWatcher = vscode.workspace.createFileSystemWatcher('**/{gert-package.yaml,*.tool.yaml,*.package-map.yaml,package-map.yaml,.gert/config.yaml}');
    subscriptions.push(configWatcher, configWatcher.onDidChange(refresh), configWatcher.onDidCreate(refresh), configWatcher.onDidDelete(refresh));
    refresh();
    return { dispose() { disposed = true; for (const state of states.values())
            clear(state); states.clear(); subscriptions.forEach(s => s.dispose()); } };
}
function tokenizeDocument(context, source, reply, expressions, state) {
    return new Promise((resolve, reject) => {
        const worker = new worker_threads_1.Worker(path.join(context.extensionPath, 'out', 'highlighting-worker.cjs'));
        state.worker = worker;
        let settled = false;
        let timer = setTimeout(() => finish('tokenizer-warmup-deadline'), 5000);
        const abort = () => finish('stale-request');
        const finish = (reason, result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            state.controller.signal.removeEventListener('abort', abort);
            void worker.terminate();
            if (reason || !result)
                reject(new Error(reason));
            else
                resolve(result);
        };
        state.controller.signal.addEventListener('abort', abort, { once: true });
        worker.on('error', () => finish('tokenizer-unavailable'));
        worker.on('message', (message) => {
            try {
                const value = (0, presentationProtocol_1.record)(message);
                if (value.ready === true) {
                    clearTimeout(timer);
                    timer = setTimeout(() => finish('tokenizer-deadline'), 250);
                    const kind = vscode.window.activeColorTheme.kind;
                    const palette = kind === vscode.ColorThemeKind.Light ? 'light' : kind === vscode.ColorThemeKind.HighContrast ? 'hc'
                        : kind === vscode.ColorThemeKind.HighContrastLight ? 'hc-light' : 'dark';
                    worker.postMessage({ id: 1, source, reply, expressions, palette });
                }
                else if (value.id === 1 && Array.isArray(value.spans) && Array.isArray(value.reasons)) {
                    const spans = value.spans.map(item => {
                        const span = (0, presentationProtocol_1.record)(item);
                        if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || typeof span.start !== 'number' || typeof span.end !== 'number' || typeof span.color !== 'string')
                            throw new Error();
                        return { start: span.start, end: span.end, color: span.color, macro: span.macro === true };
                    });
                    if (!value.reasons.every(item => typeof item === 'string'))
                        throw new Error();
                    finish(undefined, { spans, reasons: value.reasons });
                }
                else
                    finish('tokenizer-unavailable');
            }
            catch {
                finish('tokenizer-unavailable');
            }
        });
    });
}
//# sourceMappingURL=presentationEditor.js.map