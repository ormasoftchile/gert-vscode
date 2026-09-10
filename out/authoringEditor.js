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
exports.requiredArgumentsSnippet = requiredArgumentsSnippet;
exports.registerAuthoringEditor = registerAuthoringEditor;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const authoringClient_1 = require("./authoringClient");
const authoringContext_1 = require("./authoringContext");
const presentationClient_1 = require("./presentationClient");
const authoringProtocol_1 = require("./authoringProtocol");
function requiredArgumentsSnippet(edit) {
    const snippet = new vscode.SnippetString();
    let end = 0;
    for (const placeholder of edit.placeholders) {
        snippet.appendText(edit.edit.new_text.slice(end, placeholder.start));
        snippet.appendPlaceholder('null');
        end = placeholder.end;
    }
    snippet.appendText(edit.edit.new_text.slice(end)).appendTabstop(0);
    return snippet;
}
const nativeRange = (document, range) => new vscode.Range(document.positionAt(range.start), document.positionAt(range.end));
const safeReason = (error) => error instanceof Error &&
    /^(?:invalid-request|stale-request|limit-exceeded|helper-unavailable|helper-deadline|invalid-helper-response|invalid-authoring-response)$/.test(error.message)
    ? error.message : 'metadata-unavailable';
function registerAuthoringEditor(context) {
    const client = new authoringClient_1.AuthoringClient();
    const pending = new Map();
    const records = new Map();
    const watchers = new Map();
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 19);
    status.name = 'Gert offline autocomplete';
    let generation = 0, serial = 0, disposed = false;
    const enabled = () => vscode.workspace.getConfiguration('gert').get('autocomplete.enabled', true);
    const updateStatus = () => {
        const doc = vscode.window.activeTextEditor?.document;
        if (!doc || !(0, authoringContext_1.eligibleAuthoringDocument)(doc)) {
            status.hide();
            return;
        }
        status.text = `$(symbol-method) Gert: ${enabled() ? records.get(doc.uri.toString())?.reason ?? 'offline autocomplete' : 'autocomplete disabled'}`;
        status.tooltip = 'Offline metadata only. Tool declarations: bounded explicit local catalog; tool steps: bound current-file toolRefs. Not every installed tool. No provider calls. YAML language services remain active.';
        status.show();
    };
    const pruneWatchers = () => {
        const used = new Set([...records.values()].flatMap(r => [...r.roots]));
        for (const [root, watcher] of watchers)
            if (!used.has(root)) {
                watcher.dispose();
                watchers.delete(root);
            }
    };
    const invalidate = () => {
        generation++;
        for (const controller of pending.values())
            controller.abort();
        pending.clear();
        client.cancel();
        records.clear();
        for (const watcher of watchers.values())
            watcher.dispose();
        watchers.clear();
        updateStatus();
    };
    const within = (root, file) => {
        const relative = path.relative(root, file);
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    const watch = (roots, root, pattern = '**/*') => {
        const key = pattern === '**/*' ? root : `${root}\0${pattern}`;
        if (roots.has(key) || [...roots].some(existing => !existing.includes('\0') && within(existing, root)))
            return false;
        if (!watchers.has(key)) {
            if (watchers.size >= 128)
                throw new Error('limit-exceeded');
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, pattern));
            watcher.onDidChange(invalidate);
            watcher.onDidCreate(invalidate);
            watcher.onDidDelete(invalidate);
            watchers.set(key, watcher);
        }
        roots.add(key);
        return true;
    };
    async function resolve(document, position, operation, token) {
        if (disposed || !enabled() || !(0, authoringContext_1.eligibleAuthoringDocument)(document) || token?.isCancellationRequested)
            return undefined;
        const key = `${document.uri}\0${operation}`, uri = document.uri.toString();
        pending.get(key)?.abort();
        pending.delete(key);
        if (pending.size >= 16) {
            const oldest = pending.keys().next().value;
            pending.get(oldest).abort();
            pending.delete(oldest);
        }
        if (!records.has(uri) && records.size >= 16) {
            const oldest = records.keys().next().value;
            for (const [k, controller] of pending)
                if (k.startsWith(oldest + '\0')) {
                    controller.abort();
                    pending.delete(k);
                }
            records.delete(oldest);
            pruneWatchers();
        }
        const record = records.get(uri) ?? { reason: 'resolving', roots: new Set() };
        records.set(uri, record);
        const controller = new AbortController(), subscription = token?.onCancellationRequested(() => controller.abort());
        const timer = setTimeout(() => controller.abort(), 5000);
        pending.set(key, controller);
        const capturedGeneration = generation;
        try {
            const captured = (0, authoringContext_1.captureAuthoringContext)(document, context.extensionPath, capturedGeneration);
            const request = { schema_version: 'authoring-request/v3', request_id: `${++serial}:${generation}`,
                operation, context: captured.context, document: captured.document, overlays: captured.overlays, position: document.offsetAt(position) };
            const helper = vscode.workspace.getConfiguration('gert', document.uri).get('highlighting.developmentHelperPath', '') ||
                (0, presentationClient_1.bundledPresentationHelper)(context.extensionPath);
            if (!path.isAbsolute(helper))
                throw new Error('helper-unavailable');
            const identity = await (0, authoringClient_1.authoringBinaryIdentity)(helper, controller.signal);
            const current = () => !disposed && !controller.signal.aborted && !token?.isCancellationRequested && enabled() &&
                generation === capturedGeneration && !document.isClosed && document.version === request.document.version &&
                document.uri.toString() === request.document.uri && (0, authoringProtocol_1.sourceDigest)(document.getText()) === (0, authoringProtocol_1.sourceDigest)(request.document.text) &&
                records.get(uri) === record && captured.overlays.every(b => vscode.workspace.textDocuments.some(d => d.uri.toString() === b.uri && d.version === b.version));
            if (!current())
                return undefined;
            watch(record.roots, request.context.project_root);
            watch(record.roots, path.dirname(helper), path.basename(helper));
            let reply;
            for (let pass = 0; pass < 2; pass++) {
                reply = await client.resolve(helper, request, controller.signal);
                if (!current())
                    return undefined;
                let added = false;
                for (const dep of reply.dependencies) {
                    if (dep.version !== undefined)
                        continue;
                    const depURI = vscode.Uri.parse(dep.uri);
                    if (depURI.scheme !== 'file')
                        throw new Error('invalid-authoring-response');
                    let directory = path.dirname(depURI.fsPath);
                    try {
                        if (fs.statSync(depURI.fsPath).isDirectory())
                            directory = depURI.fsPath;
                    }
                    catch { /* Watch missing dependency's parent. */ }
                    added = watch(record.roots, directory) || added;
                }
                if (!added)
                    break;
                // Establish invalidation coverage before asking core for a fresh snapshot.
                if (pass === 1)
                    throw new Error('limit-exceeded');
            }
            if (!current() || await (0, authoringClient_1.authoringBinaryIdentity)(helper, controller.signal) !== identity || !reply)
                return undefined;
            record.reason = reply.status !== 'resolved' ? reply.reason :
                reply.discovery.status === 'limited' || reply.discovery.status === 'unavailable'
                    ? `limited catalog (${reply.discovery.reason})` : 'explicit local metadata';
            updateStatus();
            return { reply, request, current };
        }
        catch (error) {
            if (generation === capturedGeneration && !controller.signal.aborted) {
                record.reason = safeReason(error);
                updateStatus();
            }
            return undefined;
        }
        finally {
            clearTimeout(timer);
            subscription?.dispose();
            if (pending.get(key) === controller)
                pending.delete(key);
        }
    }
    const selector = [{ language: 'yaml', scheme: 'file' }, { language: 'yaml', scheme: 'untitled' }];
    const completion = vscode.languages.registerCompletionItemProvider(selector, {
        async provideCompletionItems(document, position, token) {
            const result = await resolve(document, position, 'complete', token);
            if (!result?.current() || result.reply.status !== 'resolved')
                return undefined;
            if (result.reply.items.some(item => {
                const range = nativeRange(document, item.edit.range);
                return !range.isSingleLine || !range.contains(position);
            }))
                return undefined;
            const items = result.reply.items.map((item, index) => {
                const kind = { tool: vscode.CompletionItemKind.Module, action: vscode.CompletionItemKind.Method,
                    argument: vscode.CompletionItemKind.Property, namespace: vscode.CompletionItemKind.Module, function: vscode.CompletionItemKind.Function,
                    'include-mapping': vscode.CompletionItemKind.Struct, 'include-key': vscode.CompletionItemKind.Property,
                    'include-value': vscode.CompletionItemKind.EnumMember, 'typed-key': vscode.CompletionItemKind.Property,
                    'typed-value': vscode.CompletionItemKind.EnumMember, variable: vscode.CompletionItemKind.Variable }[item.kind];
                const native = new vscode.CompletionItem(item.name, kind);
                native.detail = `Gert · ${item.kind}${item.required ? ' · required' : ''}${item.value_type ? ` · ${item.value_type}` : ''}` +
                    (item.default_info === 'declared-redacted' ? ' · default declared (redacted)' : '');
                native.documentation = item.description;
                native.range = nativeRange(document, item.edit.range);
                native.insertText = item.edit.new_text;
                native.sortText = index.toString().padStart(4, '0');
                native.keepWhitespace = true;
                return native;
            });
            return new vscode.CompletionList(items, false);
        },
    }, '.', ':');
    const signature = vscode.languages.registerSignatureHelpProvider(selector, {
        async provideSignatureHelp(document, position, token) {
            const result = await resolve(document, position, 'signature', token);
            if (!result?.current() || result.reply.status !== 'resolved' || !result.reply.signature)
                return undefined;
            const source = result.reply.signature, signature = new vscode.SignatureInformation(source.label, source.description);
            signature.parameters = source.parameters.map(parameter => new vscode.ParameterInformation([parameter.label_range.start, parameter.label_range.end], parameter.description));
            const help = new vscode.SignatureHelp();
            help.signatures = [signature];
            help.activeSignature = 0;
            // Do not falsely clamp core's null active argument to the last parameter.
            help.activeParameter = source.active_parameter ?? source.parameters.length;
            return help;
        },
    }, '(', ',');
    const command = vscode.commands.registerCommand('gert.insertRequiredArguments', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !enabled() || !(0, authoringContext_1.eligibleAuthoringDocument)(editor.document)) {
            void vscode.window.showInformationMessage('Gert: Required arguments are unavailable in this context.');
            return false;
        }
        const selection = editor.selection;
        const result = await resolve(editor.document, selection.active, 'required-arguments');
        if (!result?.current() || vscode.window.activeTextEditor !== editor || !editor.selection.isEqual(selection))
            return false;
        if (result.reply.status !== 'resolved') {
            void vscode.window.showInformationMessage(`Gert: Required arguments unavailable (${result.reply.reason}).`);
            return false;
        }
        if (!result.reply.required_edit) {
            void vscode.window.showInformationMessage(result.reply.site ? 'Gert: No missing required arguments at this site.' :
                'Gert: Required arguments are unavailable in this context.');
            return false;
        }
        return editor.insertSnippet(requiredArgumentsSnippet(result.reply.required_edit), nativeRange(editor.document, result.reply.required_edit.edit.range), { undoStopBefore: true, undoStopAfter: true });
    });
    const subscriptions = [status, completion, signature, command,
        (0, authoringContext_1.onDidChangeAuthoringContext)(invalidate),
        vscode.workspace.onDidChangeTextDocument(invalidate), vscode.workspace.onDidOpenTextDocument(invalidate),
        vscode.workspace.onDidCloseTextDocument(invalidate), vscode.workspace.onDidChangeConfiguration(invalidate),
        vscode.window.onDidChangeActiveTextEditor(() => { invalidate(); updateStatus(); }),
    ];
    updateStatus();
    return { dispose() { disposed = true; invalidate(); client.dispose(); subscriptions.forEach(s => s.dispose()); } };
}
//# sourceMappingURL=authoringEditor.js.map