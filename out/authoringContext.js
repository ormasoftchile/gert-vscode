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
exports.onDidChangeAuthoringContext = void 0;
exports.setPresentationEntrypoint = setPresentationEntrypoint;
exports.eligibleAuthoringDocument = eligibleAuthoringDocument;
exports.captureAuthoringContext = captureAuthoringContext;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const presentationContext_1 = require("./presentationContext");
const runHandoff_1 = require("./runHandoff");
const knownContexts = new Map();
const changes = new vscode.EventEmitter();
exports.onDidChangeAuthoringContext = changes.event;
function setPresentationEntrypoint(projectRoot, entrypointPath, includedPaths) {
    knownContexts.clear();
    for (const file of [entrypointPath, ...includedPaths]) {
        if (path.isAbsolute(file))
            knownContexts.set(vscode.Uri.file(file).toString(), { project_root: projectRoot, entrypoint_path: entrypointPath });
    }
    changes.fire();
}
function eligibleAuthoringDocument(document) {
    return document.languageId === 'yaml' && !/^\.env(?:\.|$)/i.test(path.basename(document.fileName)) &&
        (document.isUntitled || document.uri.scheme === 'file' && /\.runbook\.ya?ml$/i.test(document.fileName));
}
function captureAuthoringContext(document, extensionPath, generation) {
    const folders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
    const virtualPath = document.isUntitled
        ? path.isAbsolute(document.uri.fsPath) ? document.uri.fsPath
            : path.join(folders[0] ?? extensionPath, `.gert-untitled-${encodeURIComponent(document.uri.toString())}.runbook.yaml`) : document.uri.fsPath;
    const known = knownContexts.get(document.uri.toString()) ??
        (document.isUntitled ? knownContexts.get(vscode.Uri.file(virtualPath).toString()) : undefined);
    const configuredMap = vscode.workspace.getConfiguration('gert', document.uri).get('packageMap', '');
    const root = known?.project_root ?? (0, presentationContext_1.presentationProjectRoot)(virtualPath, folders, extensionPath, configuredMap);
    const buffer = (doc) => ({
        uri: doc.uri.toString(), path: doc === document ? virtualPath : path.isAbsolute(doc.uri.fsPath) ? doc.uri.fsPath
            : path.join(root, `.gert-untitled-${encodeURIComponent(doc.uri.toString())}.yaml`), version: doc.version, text: doc.getText(),
    });
    const overlays = vscode.workspace.textDocuments.filter(doc => doc !== document && (doc.uri.scheme === 'file' || doc.isUntitled) &&
        (doc.languageId === 'yaml' || /(?:gert-package|package-map|config)\.ya?ml$/i.test(doc.fileName)) &&
        !/^\.env(?:\.|$)/i.test(path.basename(doc.fileName))).map(buffer);
    const packageMap = (0, runHandoff_1.resolveRunPackageMapPath)(root, configuredMap).path ||
        (configuredMap ? path.resolve(root, configuredMap) :
            overlays.some(b => b.path === path.join(root, 'package-map.yaml')) ? path.join(root, 'package-map.yaml') : undefined);
    return {
        context: { project_root: root, generation, ...(known ? { entrypoint_path: known.entrypoint_path } : {}),
            ...(packageMap ? { package_map_path: packageMap } : {}) },
        document: buffer(document), overlays, known: !!known,
    };
}
//# sourceMappingURL=authoringContext.js.map