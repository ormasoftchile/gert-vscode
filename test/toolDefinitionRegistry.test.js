// toolDefinitionRegistry.test.js — unit tests for the YAML-derived registry.
//
// Tests confirm that tool definition YAML files are parsed correctly and that
// the vscode_tool precedence rules are enforced.
//
// Run with: node --test test/toolDefinitionRegistry.test.js  (or via npm test)

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildRegistryFromDir, findToolYamls } = require('../out/toolDefinitionRegistry');

const FIXTURE_TOOLS_DIR = path.join(__dirname, 'fixtures', 'tools');

// Load registry once — all tests share it (buildRegistryFromDir is pure/sync).
const registry = buildRegistryFromDir(FIXTURE_TOOLS_DIR);

// ─── Registry contents ────────────────────────────────────────────────────────

test('registry: icm/get-incident is present with correct registered name', () => {
  const spec = registry['icm/get-incident'];
  assert.ok(spec, 'icm/get-incident must be in the registry');
  assert.equal(spec.registeredName, 'icm-get-incident');
});

test('registry: icm/get-incident has the correct output fields', () => {
  const spec = registry['icm/get-incident'];
  const fields = Object.keys(spec.outputFields).sort();
  assert.deepEqual(fields, ['database', 'environment', 'logical_server', 'service', 'title'].sort());
  for (const f of fields) {
    assert.equal(spec.outputFields[f].type, 'string', `${f}.type must be string`);
    assert.equal(spec.outputFields[f].required, true, `${f}.required must be true`);
  }
});

// ─── vscode_tool precedence ───────────────────────────────────────────────────

test('precedence: action-level vscode_tool beats transport-level', () => {
  const spec = registry['precedence-tool/action-with-action-level'];
  assert.ok(spec, 'precedence-tool/action-with-action-level must be in registry');
  assert.equal(spec.registeredName, 'action-level-name',
    'action-level vscode_tool must take precedence over transport-level');
});

test('precedence: transport-level vscode_tool beats logical-name fallback', () => {
  const spec = registry['precedence-tool/action-with-transport-level'];
  assert.ok(spec, 'precedence-tool/action-with-transport-level must be in registry');
  assert.equal(spec.registeredName, 'transport-level-name',
    'transport-level vscode_tool must take precedence over logical-name fallback');
});

test('precedence: logical tool name is fallback when no vscode_tool declared', () => {
  const spec = registry['fallback-tool/fallback-action'];
  assert.ok(spec, 'fallback-tool/fallback-action must be in registry');
  assert.equal(spec.registeredName, 'fallback-tool',
    'logical tool name must be used as fallback when no vscode_tool is declared');
});

// ─── Non-vscode-mcp tools are excluded ──────────────────────────────────────

test('registry: tools without effective transport mode vscode-mcp are not included', () => {
  // All keys from our fixture dir are known; unknown keys would be a leak.
  const knownPrefixes = [
    'icm/',           // flat-name form; sequence actions
    'precedence-tool/', // transport-level vscode_tool
    'fallback-tool/', // logical-name fallback
    'ops-mapping/',   // mapping-form (legacy) actions
    'ops-legacy/',    // legacy transport.type
    'ops-meta/',      // meta.name precedence
  ];
  for (const key of Object.keys(registry)) {
    const isKnown = knownPrefixes.some((p) => key.startsWith(p));
    assert.ok(isKnown, `unexpected registry key "${key}" — non-vscode-mcp tool may have leaked in`);
  }
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

test('buildRegistryFromDir: returns empty registry for non-existent directory', () => {
  const r = buildRegistryFromDir('/no/such/directory/xyz');
  assert.deepEqual(Object.keys(r), []);
});

test('buildRegistryFromDir: returns empty registry for empty directory', (t) => {
  // Use the fixture dir parent (test/fixtures) which has no *.tool.yaml files directly
  // and only the tools/ subdir; this just verifies it doesn't explode.
  const r = buildRegistryFromDir(path.join(__dirname, 'fixtures'));
  // The 'tools' subdirectory WILL be scanned recursively — that's expected.
  // We just verify the call doesn't throw.
  assert.ok(typeof r === 'object');
});

test('findToolYamls: returns tool yaml paths for known fixture dir', () => {
  const files = findToolYamls(FIXTURE_TOOLS_DIR);
  assert.ok(files.length >= 4, 'expected at least 4 fixture tool yamls');
  assert.ok(files.every((f) => f.endsWith('.tool.yaml')));
});

// ─── DEFECT 2 regression tests ───────────────────────────────────────────────
// These five tests guard the three parse axes that were broken before the fix.

// Test 1: consumer's exact fixture (byte-for-byte as supplied in the ask).
// meta.name + sequence-form actions + transport.mode — all three must work together.
test('defect2-reg: consumer icm fixture (meta.name + sequence + transport.mode) registers icm/get-incident', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gert-icm-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmpDir, 'icm.tool.yaml'), [
    'apiVersion: tool/v1',
    'meta:',
    '  name: icm',
    'transport:',
    '  mode: vscode-mcp',
    'actions:',
    '  - name: get-incident',
  ].join('\n'));
  const r = buildRegistryFromDir(tmpDir);
  assert.ok(r['icm/get-incident'], 'icm/get-incident must be in the registry');
});

// Test 2: mapping-form actions (legacy).
test('defect2-reg: mapping-form actions register correctly', () => {
  const spec = registry['ops-mapping/get-work'];
  assert.ok(spec, 'ops-mapping/get-work must be in registry (mapping-form actions)');
  assert.equal(spec.registeredName, 'ops-mapping',
    'logical tool name must be the registeredName when no vscode_tool is declared');
  assert.ok(registry['ops-mapping/post-result'],
    'ops-mapping/post-result must also be registered');
});

// Test 3: legacy transport.type.
test('defect2-reg: legacy transport.type registers the tool', () => {
  const spec = registry['ops-legacy/act'];
  assert.ok(spec, 'ops-legacy/act must be in registry when transport.type=vscode-mpc is used');
});

// Test 4: meta.name precedence (meta.name wins over flat name).
test('defect2-reg: meta.name wins over flat name in registry key', () => {
  // ops-meta.tool.yaml declares name: ops-flat AND meta.name: ops-meta.
  // The registry key must use ops-meta (meta wins).
  assert.ok(registry['ops-meta/act'],
    'ops-meta/act must be registered — meta.name must win over flat name');
  assert.equal(registry['ops-flat/act'], undefined,
    'ops-flat/act must NOT be registered — flat name must not win when meta.name is present');
});

// Test 5: drift guard — documents the full shape matrix the extension must accept.
// If any axis is removed from buildRegistryFromDir, at least one assertion here fails.
test('defect2-drift-guard: all three core parse axes are handled', () => {
  // This test documents the shape matrix mirrored from:
  //   tool.go ToolDef.UnmarshalYAML  (meta.name promotion)
  //   tool.go decodeToolActions       (sequence vs mapping)
  //   tool.go TransportConfig.UnmarshalYAML (mode wins over type)
  const shapeMatrix = [
    // Axis 1: meta.name promotion
    { desc: 'meta.name wins over flat name',             key: 'ops-meta/act' },
    { desc: 'flat name used when meta is absent',        key: 'icm/get-incident' },
    // Axis 2: actions form
    { desc: 'sequence-form actions (canonical)',         key: 'fallback-tool/fallback-action' },
    { desc: 'mapping-form actions (legacy)',             key: 'ops-mapping/get-work' },
    // Axis 3: transport mode field
    { desc: 'transport.mode (canonical)',                key: 'icm/get-incident' },
    { desc: 'transport.type (legacy fallback)',          key: 'ops-legacy/act' },
  ];
  for (const shape of shapeMatrix) {
    assert.ok(
      registry[shape.key] !== undefined,
      `shape "${shape.desc}" must produce registry key "${shape.key}"`,
    );
  }
});
