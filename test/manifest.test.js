const assert = require('node:assert/strict');
const test = require('node:test');

const manifest = require('../package.json');

test('React Flow preview is a visible editor title action for runbooks', () => {
  const command = manifest.contributes.commands.find(
    (candidate) => candidate.command === 'gert.previewGraph',
  );
  assert.ok(command, 'gert.previewGraph must be contributed');
  assert.ok(command.icon, 'gert.previewGraph needs an icon to appear in the editor title toolbar');

  const menuItem = manifest.contributes.menus['editor/title'].find(
    (candidate) => candidate.command === 'gert.previewGraph',
  );
  assert.ok(menuItem, 'gert.previewGraph must be contributed to editor/title');
  assert.match(menuItem.group, /^navigation(?:@|$)/);
  assert.match(menuItem.when, /resourceFilename/);
  assert.match(menuItem.when, /runbook/);
});

test('gert.validateInputs is contributed as a Command Palette entry', () => {
  const command = manifest.contributes.commands.find(
    (candidate) => candidate.command === 'gert.validateInputs',
  );
  assert.ok(command, 'gert.validateInputs must be contributed');
  assert.match(command.title, /gert/i);
});

// CE-C-02 (barbara-client-enum-compatibility-ruling.md, AR-CE-8): this
// extension has no `runbook/v1` JSON Schema, no `jsonValidation`/
// `yamlValidation` contribution, and no YAML parser dependency for runbook
// files. It forwards files to the real `gert` CLI/server and never
// re-implements structural or enum-membership validation of its own.
// Exception: js-yaml is allowed because it is used to parse *.tool.yaml
// *tool definition* files for the MCP bridge registry — never to validate
// runbook YAML or to substitute for the gert engine.
test('CE-C-02: no bundled schema, no editor schema-validation contribution, no YAML parser dependency', () => {
  assert.equal(manifest.contributes.jsonValidation, undefined, 'no jsonValidation contribution point expected');
  assert.equal(manifest.contributes.yamlValidation, undefined, 'no yamlValidation contribution point expected');

  const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
  // js-yaml is intentionally allowed: used for parsing .tool.yaml definitions
  // in the MCP bridge registry, not for runbook validation.
  const yamlParserAllowlist = new Set(['js-yaml', '@types/js-yaml']);
  for (const name of Object.keys(deps)) {
    if (yamlParserAllowlist.has(name)) continue;
    assert.doesNotMatch(
      name.toLowerCase(),
      /(^|[^a-z])yaml([^a-z]|$)/,
      `unexpected YAML-parsing dependency "${name}" — this client must not decode runbook YAML itself`,
    );
  }
});

// INVTOKEN-M-01: The manifest must declare the gert.chat participant so that
// vscode.chat.createChatParticipant('gert.chat', ...) is reachable. A
// participant registered in code but absent from the manifest is silently
// inert — the exact bug class that has bitten this engagement twelve times.
test('gert.chat participant is declared in contributes.chatParticipants', () => {
  const participants = manifest.contributes.chatParticipants;
  assert.ok(Array.isArray(participants) && participants.length > 0,
    'contributes.chatParticipants must be a non-empty array');

  const gert = participants.find((p) => p.id === 'gert.chat');
  assert.ok(gert, 'a participant with id "gert.chat" must be declared in contributes.chatParticipants');
  assert.equal(gert.id, 'gert.chat',
    'participant id must match the id passed to vscode.chat.createChatParticipant in extension.ts');
});

// INVTOKEN-M-02: The arm-mcp slash command must be declared so VS Code
// surfaces it in the command picker and routes /arm-mcp to the participant.
test('gert.chat participant declares the arm-mcp command', () => {
  const participants = manifest.contributes.chatParticipants ?? [];
  const gert = participants.find((p) => p.id === 'gert.chat');
  assert.ok(gert, 'gert.chat participant must be declared (see prior test)');
  assert.ok(Array.isArray(gert.commands) && gert.commands.length > 0,
    'gert.chat must declare at least one slash command');
  const armCmd = gert.commands.find((c) => c.name === 'arm-mcp');
  assert.ok(armCmd, 'gert.chat must declare the "arm-mcp" command');
});

test('CE-C-02: no vendored *.schema.json in the extension source tree', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const skipDirs = new Set(['node_modules', 'out', '.git', '.vscode', '.vscode-test']);

  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.schema.json')) {
        offenders.push(path.join(dir, entry.name));
      }
    }
  })(root);

  assert.deepEqual(offenders, [], `unexpected vendored schema file(s): ${offenders.join(', ')}`);
});
