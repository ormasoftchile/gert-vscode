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
exports.configureBundledRuntime = configureBundledRuntime;
exports.resolveBinary = resolveBinary;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const binaryPaths_1 = require("./binaryPaths");
const presentationClient_1 = require("./presentationClient");
let bundledRoot;
function configureBundledRuntime(extensionPath) { bundledRoot = extensionPath; }
// resolveBinary tries deterministic local locations rather than relying on the
// Extension Host's stripped PATH. The active project is always searched first.
async function resolveBinary(configured, output, activeProjectRoot, workspaceFolders) {
    const candidates = [];
    const useDefaultDiscovery = !configured || configured === 'gert';
    if (useDefaultDiscovery && bundledRoot) {
        const helper = (0, presentationClient_1.bundledPresentationHelper)(bundledRoot);
        let present = false;
        try {
            await fs.promises.access(helper, fs.constants.X_OK);
            present = true;
        }
        catch {
            // An unpackaged development build may still use local discovery.
        }
        if (present) {
            await (0, presentationClient_1.verifyPresentationHelper)(helper);
            output.appendLine('[gert] using matching packaged runtime');
            return helper;
        }
    }
    if (path.isAbsolute(configured)) {
        candidates.push(configured);
    }
    else if (!useDefaultDiscovery) {
        candidates.push(...(0, binaryPaths_1.relativeBinaryCandidates)(configured, activeProjectRoot, workspaceFolders));
    }
    if (useDefaultDiscovery) {
        const seen = new Set();
        for (const root of (0, binaryPaths_1.binarySearchRoots)(activeProjectRoot, workspaceFolders)) {
            let dir = root;
            for (let depth = 0; depth < 6; depth++) {
                if (seen.has(dir))
                    break;
                seen.add(dir);
                candidates.push(path.join(dir, 'gert'));
                candidates.push(path.join(dir, 'bin', 'gert'));
                const parent = path.dirname(dir);
                if (parent === dir)
                    break;
                dir = parent;
            }
        }
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home)
            candidates.push(path.join(home, 'go', 'bin', 'gert'));
        if (process.env.GOPATH)
            candidates.push(path.join(process.env.GOPATH, 'bin', 'gert'));
        if (process.env.PATH) {
            for (const dir of process.env.PATH.split(path.delimiter)) {
                if (dir)
                    candidates.push(path.join(dir, 'gert'));
            }
        }
    }
    const executableCandidates = process.platform === 'win32'
        ? candidates.flatMap((candidate) => path.extname(candidate) ? [candidate] : [candidate, `${candidate}.exe`])
        : candidates;
    for (const candidate of executableCandidates) {
        try {
            const stat = await fs.promises.stat(candidate);
            if (!stat.isFile())
                continue;
            await fs.promises.access(candidate, fs.constants.X_OK);
            output.appendLine(`[gert] resolved binary: ${candidate}`);
            return candidate;
        }
        catch {
            // Try the next candidate.
        }
    }
    throw new Error(`cannot find gert binary on disk. Tried:\n  ${executableCandidates.join('\n  ')}\n` +
        'Set "gert.binaryPath" in settings to an absolute path.');
}
//# sourceMappingURL=binaryResolver.js.map