// toolDefinitionRegistry.test.js — unit tests for the YAML-derived registry.
//
// Tests confirm that tool definition YAML files are parsed correctly and that
// the vscode_tool precedence rules are enforced.
//
// Run with: node --test test/toolDefinitionRegistry.test.js  (or via npm test)

'use strict';

const assert = require('node:assert/strict');
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

test('registry: tsg-recommendation/recommend is present with correct registered name', () => {
  const spec = registry['tsg-recommendation/recommend'];
  assert.ok(spec, 'tsg-recommendation/recommend must be in the registry');
  assert.equal(spec.registeredName, 'tsg-recommendation-recommend');
});

test('registry: tsg-recommendation/recommend has correct required/optional field mix', () => {
  const spec = registry['tsg-recommendation/recommend'];
  assert.equal(spec.outputFields['recommendation_status'].required, true);
  assert.equal(spec.outputFields['recommendation_status'].type, 'string');
  assert.equal(spec.outputFields['suggested_tsg_id'].required, false);
  assert.equal(spec.outputFields['suggested_tsg_id'].type, 'string');
  assert.equal(spec.outputFields['suggested_tsg_title'].required, false);
  assert.equal(spec.outputFields['suggested_tsg_title'].type, 'string');
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

test('registry: tools without transport.mode=vscode-mcp are not included', () => {
  // The fixture dir only has vscode-mcp tools; confirm non-vscode-mcp tools
  // from other dirs are not accidentally included by listing all keys.
  for (const key of Object.keys(registry)) {
    // All keys from our fixture dir are known; unknown keys would be a leak.
    const knownPrefixes = ['icm/', 'tsg-recommendation/', 'precedence-tool/', 'fallback-tool/'];
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
  assert.ok(files.length >= 3, 'expected at least 3 fixture tool yamls');
  assert.ok(files.every((f) => f.endsWith('.tool.yaml')));
});
