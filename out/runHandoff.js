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
exports.resolveRunPackageMapPath = resolveRunPackageMapPath;
exports.buildRunArgs = buildRunArgs;
exports.executeRunHandoff = executeRunHandoff;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function isFile(p) {
    try {
        return fs.statSync(p).isFile();
    }
    catch {
        return false;
    }
}
function resolveAgainstProject(projectRoot, value) {
    return path.isAbsolute(value) ? value : path.join(projectRoot, value);
}
function siblingRunMapForServeMap(serveMapPath) {
    const suffix = '.serve-package-map.yaml';
    if (!serveMapPath.endsWith(suffix))
        return undefined;
    return serveMapPath.slice(0, -suffix.length) + '.package-map.yaml';
}
function resolveRunPackageMapPath(projectRoot, settingValue) {
    if (settingValue && settingValue.trim()) {
        const configured = resolveAgainstProject(projectRoot, settingValue);
        const sibling = siblingRunMapForServeMap(configured);
        if (sibling && isFile(sibling)) {
            return { path: sibling, source: 'run-sibling' };
        }
        if (isFile(configured)) {
            return {
                path: configured,
                source: 'setting',
                warning: sibling
                    ? `gert.packageMap points at a serve map but no run package-map sibling was found: ${sibling}`
                    : undefined,
            };
        }
        return {
            source: 'absent',
            warning: `gert.packageMap "${settingValue}" not found in ${projectRoot}`,
        };
    }
    const convention = path.join(projectRoot, 'package-map.yaml');
    if (isFile(convention)) {
        return { path: convention, source: 'convention' };
    }
    return { source: 'absent' };
}
function buildRunArgs(runbookPath, varPairArgs, packageMapPath) {
    const args = ['run'];
    if (packageMapPath) {
        args.push('--package-map', packageMapPath);
    }
    args.push(...varPairArgs.flatMap((p) => ['--var', p]), runbookPath);
    return args;
}
function executeRunHandoff(options) {
    const packageMap = resolveRunPackageMapPath(options.projectRoot, options.packageMapSetting);
    const args = buildRunArgs(options.runbookPath, options.varPairArgs, packageMap.path);
    return new Promise((resolve, reject) => {
        options.execFile(options.bin, args, { env: { ...options.baseEnv, ...options.bridgeVars }, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                Object.assign(error, { stdout, stderr, packageMap });
                reject(error);
                return;
            }
            resolve({ stdout, stderr, packageMap });
        });
    });
}
//# sourceMappingURL=runHandoff.js.map