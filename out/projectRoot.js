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
exports.pickProjectRoot = pickProjectRoot;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function hasDirectory(dir, name) {
    try {
        return fs.statSync(path.join(dir, name)).isDirectory();
    }
    catch {
        return false;
    }
}
function isGertProjectRoot(dir) {
    const hasRunbooks = hasDirectory(dir, 'runbooks');
    if (hasDirectory(dir, '.gert') && hasRunbooks)
        return true;
    if (hasDirectory(dir, 'packages') && hasRunbooks)
        return true;
    // A generic directory named "tools" (for example C:\tools) is not a Gert
    // project. Legacy Gert projects need either sibling runbooks or .gert config.
    return hasDirectory(dir, 'tools')
        && (hasRunbooks || fs.existsSync(path.join(dir, '.gert')));
}
function findGertProjectRoot(start) {
    let dir = start;
    while (true) {
        if (isGertProjectRoot(dir))
            return dir;
        const parent = path.dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
// Choose the narrowest Gert project root for the active runbook so discovery
// and package-map resolution cannot drift into unrelated workspace folders.
function pickProjectRoot(runbookPath, workspaceFolders, fallback) {
    const fromRunbook = findGertProjectRoot(path.dirname(runbookPath));
    if (fromRunbook)
        return fromRunbook;
    for (const folder of workspaceFolders) {
        const fromWorkspace = findGertProjectRoot(folder);
        if (fromWorkspace)
            return fromWorkspace;
    }
    return path.dirname(runbookPath) || workspaceFolders[0] || fallback;
}
//# sourceMappingURL=projectRoot.js.map