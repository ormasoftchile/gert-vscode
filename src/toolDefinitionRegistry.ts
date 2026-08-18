// toolDefinitionRegistry.ts — builds the MCP bridge registry from workspace
// *.tool.yaml definitions at runtime, so the registered MCP tool name and the
// declared output contract come from the tool definitions rather than from
// extension source code.
//
// vscode_tool precedence (matching core):
//   1. action-level vscode_tool
//   2. transport-level vscode_tool
//   3. logical tool name (fallback)

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { FieldType, OutputFieldSpec, ToolActionSpec } from './mcpBridge';

// ─── Raw YAML shapes ─────────────────────────────────────────────────────────

interface RawOutputField {
  type?: unknown;
  required?: unknown;
  description?: unknown;
  [key: string]: unknown;
}

interface RawAction {
  name?: unknown;
  vscode_tool?: unknown;
  outputs?: unknown;
  [key: string]: unknown;
}

interface RawTransport {
  mode?: unknown;
  type?: unknown;  // legacy; falls back when mode is absent (mirrors TransportConfig.UnmarshalYAML)
  vscode_tool?: unknown;
  [key: string]: unknown;
}

interface RawToolDef {
  name?: unknown;
  meta?: unknown;  // canonical identity block { name, version, description }
  transport?: unknown;
  actions?: unknown;
  [key: string]: unknown;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_FIELD_TYPES = new Set<string>(['string', 'number', 'boolean', 'object', 'array']);

function toFieldType(v: unknown): FieldType | undefined {
  return typeof v === 'string' && VALID_FIELD_TYPES.has(v) ? (v as FieldType) : undefined;
}

function buildOutputFields(
  raw: unknown,
): Record<string, OutputFieldSpec> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const map = raw as Record<string, unknown>;
  const result: Record<string, OutputFieldSpec> = {};
  for (const [field, def] of Object.entries(map)) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
    const d = def as RawOutputField;
    const type = toFieldType(d.type);
    if (!type) continue;
    // required defaults to true when not explicitly set to false
    const required = d.required !== false;
    result[field] = { type, required };
  }
  return result;
}

/**
 * Recursively collect all *.tool.yaml file paths under dir.
 */
export function findToolYamls(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findToolYamls(full));
    } else if (entry.isFile() && entry.name.endsWith('.tool.yaml')) {
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
export function buildRegistryFromDir(dir: string): Record<string, ToolActionSpec> {
  const registry: Record<string, ToolActionSpec> = {};
  for (const file of findToolYamls(dir)) {
    let raw: unknown;
    try {
      raw = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const def = raw as RawToolDef;

    // Axis 1: meta.name wins over flat name when non-empty.
    // Mirrors: if raw.Meta.Name != "" { t.Name = raw.Meta.Name } in UnmarshalYAML.
    let toolName = typeof def.name === 'string' ? def.name : undefined;
    const meta = def.meta as { name?: unknown } | undefined;
    if (meta && typeof meta.name === 'string' && meta.name) {
      toolName = meta.name;
    }
    if (!toolName) continue;

    const transport = def.transport as RawTransport | undefined;
    if (!transport) continue;

    // Axis 3: transport.mode (canonical) wins; falls back to transport.type (legacy).
    // Mirrors: TransportConfig.UnmarshalYAML — if t.Mode != "" { t.Type = Transport(t.Mode) }
    const effectiveMode =
      (typeof transport.mode === 'string' ? transport.mode : undefined) ??
      (typeof transport.type === 'string' ? transport.type : undefined);
    if (effectiveMode !== 'vscode-mcp') continue;

    const transportVscodeTool = typeof transport.vscode_tool === 'string'
      ? transport.vscode_tool
      : undefined;

    // Axis 2: actions can be a sequence (canonical) or a mapping (legacy).
    // Mirrors: decodeToolActions SequenceNode vs MappingNode branches.
    let actionEntries: Array<[string, RawAction]>;
    if (Array.isArray(def.actions)) {
      // Canonical sequence form: each item must declare name:.
      actionEntries = (def.actions as RawAction[])
        .filter((a) => typeof a.name === 'string' && a.name)
        .map((a) => [a.name as string, a]);
    } else if (def.actions && typeof def.actions === 'object') {
      // Legacy mapping form: key IS the action name.
      actionEntries = Object.entries(def.actions as Record<string, RawAction>);
    } else {
      continue;
    }

    for (const [actionName, rawAction] of actionEntries) {
      const logicalKey = `${toolName}/${actionName}`;
      const actionVscodeTool = typeof rawAction.vscode_tool === 'string'
        ? rawAction.vscode_tool
        : undefined;

      // Precedence: action-level > transport-level > logical tool name
      const registeredName: string =
        actionVscodeTool ?? transportVscodeTool ?? toolName;

      const outputFields = buildOutputFields(rawAction.outputs);
      registry[logicalKey] = { registeredName, outputFields };
    }
  }
  return registry;
}
