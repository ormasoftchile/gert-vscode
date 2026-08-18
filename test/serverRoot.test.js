const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { pickServerRoot } = require('../out/serverRoot');

test('selects the active runbook project over a broad workspace', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gert-server-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const project = path.join(root, 'sql-livesite');
  const runbooks = path.join(project, 'runbooks');
  fs.mkdirSync(path.join(project, 'packages'), { recursive: true });
  fs.mkdirSync(runbooks, { recursive: true });
  const runbook = path.join(runbooks, 'proof.runbook.yaml');
  fs.writeFileSync(runbook, 'apiVersion: runbook/v1\n');

  assert.equal(pickServerRoot(runbook, [root], root), project);
});

test('falls back to a matching workspace project when the runbook is external', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gert-server-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(project, 'runbooks'), { recursive: true });
  const externalRunbook = path.join(root, 'external.runbook.yaml');
  fs.writeFileSync(externalRunbook, 'apiVersion: runbook/v1\n');

  assert.equal(pickServerRoot(externalRunbook, [project], root), project);
});
