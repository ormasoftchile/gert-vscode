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
exports.helperIdentity = helperIdentity;
exports.presentationDiagnostic = presentationDiagnostic;
exports.diagnosticHelperBuild = diagnosticHelperBuild;
const fs = __importStar(require("fs"));
const crypto_1 = require("crypto");
function helperIdentity(binary) {
    try {
        const info = fs.statSync(binary);
        return { path: binary, realPath: fs.realpathSync(binary), bytes: info.size,
            modifiedMs: info.mtimeMs, changedMs: info.ctimeMs };
    }
    catch {
        return { path: binary };
    }
}
function presentationDiagnostic(helper, request, knownEntrypoint, code, expressions) {
    // Whitelist metadata; never retain the request, source, bindings or stderr.
    return {
        diagnosticVersion: 1, capturedAt: new Date().toISOString(), helper,
        context: { projectRoot: request.context.project_root, entrypoint: request.context.entrypoint_path ?? null,
            packageMap: request.context.package_map_path ?? null, knownEntrypoint, generation: request.context.generation },
        document: { uri: request.document.uri, version: request.document.version, utf16Count: request.document.text.length },
        overlays: { count: request.overlays.length, utf8Bytes: request.overlays.reduce((n, b) => n + Buffer.byteLength(b.text, 'utf8'), 0) },
        code: { status: code.status ?? 'unavailable', reason: code.reason ?? null, timings: code.timings },
        expressions: { status: expressions.status ?? 'unavailable', durationMs: expressions.durationMs },
    };
}
async function diagnosticHelperBuild(helper) {
    const before = helperIdentity(helper.path);
    if (JSON.stringify(before) !== JSON.stringify(helper) || !before.bytes)
        return { sha256: null, reason: 'helper-changed-or-unavailable' };
    try {
        const hash = (0, crypto_1.createHash)('sha256');
        for await (const chunk of fs.createReadStream(helper.path))
            hash.update(chunk);
        if (JSON.stringify(helperIdentity(helper.path)) !== JSON.stringify(before))
            return { sha256: null, reason: 'helper-changed' };
        return { sha256: hash.digest('hex').toUpperCase(), reason: 'ok' };
    }
    catch {
        return { sha256: null, reason: 'helper-unavailable' };
    }
}
//# sourceMappingURL=presentationDiagnostics.js.map