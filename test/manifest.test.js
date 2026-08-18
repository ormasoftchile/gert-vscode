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
// `yamlValidation` contribution, and no YAML parser dependency. It forwards
// files to the real `gert` CLI/server and never re-implements structural or
// enum-membership validation of its own.
test('CE-C-02: no bundled schema, no editor schema-validation contribution, no YAML parser dependency', () => {
  assert.equal(manifest.contributes.jsonValidation, undefined, 'no jsonValidation contribution point expected');
  assert.equal(manifest.contributes.yamlValidation, undefined, 'no yamlValidation contribution point expected');

  const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
  for (const name of Object.keys(deps)) {
    assert.doesNotMatch(
      name.toLowerCase(),
      /(^|[^a-z])yaml([^a-z]|$)/,
      `unexpected YAML-parsing dependency "${name}" — this client must not decode runbook YAML itself`,
    );
  }
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
