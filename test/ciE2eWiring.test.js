'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('source Extension Host tests use configurable core and binary paths', () => {
  const source = fs.readFileSync(path.join(root, 'test', 'suite', 'extension.test.ts'), 'utf8');

  assert.match(source, /process\.env\.GERT_E2E_BINARY/);
  assert.match(source, /process\.env\.GERT_CORE_ROOT/);
  assert.doesNotMatch(source, /Uri\.joinPath\(workspaceFolder\.uri,\s*['"]\.\.['"],\s*['"]gert['"]\)/);
});

test('VS Code test configuration exposes source and production-surface labels', () => {
  const config = fs.readFileSync(path.join(root, '.vscode-test.mjs'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.match(config, /label:\s*['"]source['"]/);
  assert.match(config, /label:\s*['"]production-surface['"]/);
  assert.match(manifest.scripts['test:e2e'], /--label source/);
  assert.match(manifest.scripts['test:e2e:vsix'], /--label production-surface/);
});

test('CI provisions core and runs source before the packaged production surface', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const checkout = workflow.indexOf('path: gert-core');
  const setupGo = workflow.indexOf('actions/setup-go@');
  const buildCore = workflow.indexOf('go build');
  const sourceE2E = workflow.indexOf('npm run test:e2e');
  const packageVsix = workflow.indexOf('npm run package', sourceE2E);
  const productionE2E = workflow.indexOf('npm run test:e2e:vsix', packageVsix);

  assert.ok(checkout >= 0, 'CI must checkout Gert core into an explicit path');
  assert.ok(setupGo > checkout, 'CI must provision Go after checking out core');
  assert.ok(buildCore > setupGo, 'CI must build the configurable core binary');
  assert.ok(sourceE2E > buildCore, 'CI must run source Extension Host tests with the built core');
  assert.ok(packageVsix > sourceE2E, 'CI must package after source tests pass');
  assert.ok(productionE2E > packageVsix, 'CI must exercise the installed VSIX after packaging');
  assert.match(workflow, /GERT_E2E_BINARY:/);
  assert.match(workflow, /GERT_CORE_ROOT:/);
});