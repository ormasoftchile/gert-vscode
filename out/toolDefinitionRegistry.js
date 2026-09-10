"use strict";
// toolDefinitionRegistry.ts — builds the MCP bridge registry from workspace
// *.tool.yaml definitions at runtime, so the registered MCP tool name and the
// declared output contract come from the tool definitions rather than from
// extension source code.
//
// vscode_tool precedence (matching core):
//   1. action-level vscode_tool
//   2. transport-level vscode_tool
//   3. logical tool name (fallback)
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
exports.findToolYamls = findToolYamls;
exports.buildRegistryFromDir = buildRegistryFromDir;
exports.buildRegistryForRun = buildRegistryForRun;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const yaml = __importStar(require("js-yaml"));
// ─── Helpers ─────────────────────────────────────────────────────────────────
const VALID_FIELD_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);
function toFieldType(v) {
    return typeof v === 'string' && VALID_FIELD_TYPES.has(v) ? v : undefined;
}
function buildOutputFields(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return {};
    const map = raw;
    const result = {};
    for (const [field, def] of Object.entries(map)) {
        if (!def || typeof def !== 'object' || Array.isArray(def))
            continue;
        const d = def;
        const type = toFieldType(d.type);
        if (!type)
            continue;
        // required defaults to true when not explicitly set to false
        const required = d.required !== false;
        result[field] = { type, required };
    }
    return result;
}
/**
 * Recursively collect all *.tool.yaml file paths under dir.
 */
function findToolYamls(dir) {
    const results = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return results;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findToolYamls(full));
        }
        else if (entry.isFile() && entry.name.endsWith('.tool.yaml')) {
            results.push(full);
        }
    }
    return results;
}
/**
 * Build a registry of (tool/action) → ToolActionSpec by reading all
 * *.tool.yaml files found recursively under dir.
 *
 * Only tool definitions with an effective transport mode of 'vscode-mcp' are
 * included. This mirrors three reconciliation axes in core:
 *
 *   1. meta.name wins over flat name (ToolDef.UnmarshalYAML in tool.go).
 *   2. actions: may be a sequence (canonical) or a mapping (legacy;
 *      key IS the action name) — decodeToolActions in tool.go.
 *   3. transport.mode (canonical) wins over transport.type (legacy) —
 *      TransportConfig.UnmarshalYAML in tool.go copies Mode into Type.
 *
 * registeredName resolution order (matching core):
 *   1. action-level  vscode_tool
 *   2. transport-level vscode_tool
 *   3. logical tool name (fallback)
 */
function buildRegistryFromDir(dir) {
    const registry = {};
    for (const file of findToolYamls(dir)) {
        let raw;
        try {
            raw = yaml.load(fs.readFileSync(file, 'utf8'));
        }
        catch {
            continue;
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            continue;
        const def = raw;
        // Axis 1: meta.name wins over flat name when non-empty.
        // Mirrors: if raw.Meta.Name != "" { t.Name = raw.Meta.Name } in UnmarshalYAML.
        let toolName = typeof def.name === 'string' ? def.name : undefined;
        const meta = def.meta;
        if (meta && typeof meta.name === 'string' && meta.name) {
            toolName = meta.name;
        }
        if (!toolName)
            continue;
        const transport = def.transport;
        if (!transport)
            continue;
        // Axis 3: transport.mode (canonical) wins; falls back to transport.type (legacy).
        // Mirrors: TransportConfig.UnmarshalYAML — if t.Mode != "" { t.Type = Transport(t.Mode) }
        const effectiveMode = (typeof transport.mode === 'string' ? transport.mode : undefined) ??
            (typeof transport.type === 'string' ? transport.type : undefined);
        if (effectiveMode !== 'vscode-mcp')
            continue;
        const transportVscodeTool = typeof transport.vscode_tool === 'string'
            ? transport.vscode_tool
            : undefined;
        // Axis 2: actions can be a sequence (canonical) or a mapping (legacy).
        // Mirrors: decodeToolActions SequenceNode vs MappingNode branches.
        let actionEntries;
        if (Array.isArray(def.actions)) {
            // Canonical sequence form: each item must declare name:.
            actionEntries = def.actions
                .filter((a) => typeof a.name === 'string' && a.name)
                .map((a) => [a.name, a]);
        }
        else if (def.actions && typeof def.actions === 'object') {
            // Legacy mapping form: key IS the action name.
            actionEntries = Object.entries(def.actions);
        }
        else {
            continue;
        }
        for (const [actionName, rawAction] of actionEntries) {
            const logicalKey = `${toolName}/${actionName}`;
            const actionVscodeTool = typeof rawAction.vscode_tool === 'string'
                ? rawAction.vscode_tool
                : undefined;
            // Precedence: action-level > transport-level > logical tool name
            const registeredName = actionVscodeTool ?? transportVscodeTool ?? toolName;
            const outputFields = buildOutputFields(rawAction.outputs);
            registry[logicalKey] = { registeredName, outputFields };
        }
    }
    return registry;
}
function buildRegistryForRun(projectRoot, packageMapPath) {
    const registry = buildRegistryFromDir(projectRoot);
    const project = readProjectConfig(path.join(projectRoot, '.gert', 'config.yaml'), true);
    const override = packageMapPath ? readProjectConfig(packageMapPath, false) : undefined;
    const requirements = new Map();
    for (const requirement of project?.requires ?? []) {
        requirements.set(requirement.package, requirement.path);
    }
    for (const requirement of override?.requires ?? []) {
        requirements.set(requirement.package, requirement.path);
    }
    const roots = [
        ...(project?.toolPaths ?? []),
        ...(override?.toolPaths ?? []),
        ...requirements.values(),
    ];
    for (const root of roots) {
        Object.assign(registry, buildRegistryFromDir(path.resolve(projectRoot, root)));
    }
    return registry;
}
function readProjectConfig(filePath, optional) {
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    }
    catch (error) {
        if (optional && error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    const raw = yaml.load(content);
    if (!raw || typeof raw !== 'object' || raw.apiVersion !== 'config/v1') {
        throw new Error(`${filePath}: expected apiVersion config/v1`);
    }
    const requires = Array.isArray(raw.requires)
        ? raw.requires.flatMap((value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value))
                return [];
            const requirement = value;
            return typeof requirement.package === 'string' && requirement.package &&
                typeof requirement.path === 'string' && requirement.path
                ? [{ package: requirement.package, path: requirement.path }]
                : [];
        })
        : [];
    const toolPaths = Array.isArray(raw['tool-paths'])
        ? raw['tool-paths'].filter((value) => typeof value === 'string' && value.length > 0)
        : [];
    return { requires, toolPaths };
}
//# sourceMappingURL=toolDefinitionRegistry.js.map