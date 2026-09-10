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
exports.presentationProjectRoot = presentationProjectRoot;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const projectRoot_1 = require("./projectRoot");
function contains(root, file) {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function fileExists(file) {
    try {
        return fs.statSync(file).isFile();
    }
    catch {
        return false;
    }
}
function presentationProjectRoot(document, folders, fallback, configuredMap) {
    const nearest = (0, projectRoot_1.pickProjectRoot)(document, folders, fallback);
    if (!configuredMap)
        return nearest;
    const mapAt = (root) => path.resolve(root, configuredMap);
    if (contains(nearest, mapAt(nearest)) && fileExists(mapAt(nearest)))
        return nearest;
    // A package's own tools/runbooks directories are not the project that owns
    // an explicitly configured workspace map. Require both document containment
    // and the actual map file; never infer language or change caller settings.
    const candidates = folders.filter(folder => contains(folder, document))
        .map(folder => (0, projectRoot_1.pickProjectRoot)(path.join(folder, '_'), [folder], fallback))
        .filter(root => contains(root, document) && contains(root, mapAt(root)) && fileExists(mapAt(root)))
        .sort((a, b) => b.length - a.length);
    return candidates[0] ?? nearest;
}
//# sourceMappingURL=presentationContext.js.map