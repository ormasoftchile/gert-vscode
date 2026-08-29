'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveBinary } = require('../out/binaryResolver');

function createExecutable(directory, command = 'gert') {
  const filename = process.platform === 'win32' ? `${command}.exe` : command;
  const executable = path.join(directory, filename);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, '');
  fs.chmodSync(executable, 0o755);
  return executable;
}

const output = { appendLine() {} };

test('an absent explicit absolute path does not fall back to a discovered gert binary', async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gert-binary-resolver-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  createExecutable(projectRoot);

  const configured = path.join(projectRoot, 'missing', 'configured-gert');

  await assert.rejects(resolveBinary(configured, output, projectRoot, []));
});

test('an absent explicit command does not fall back to a discovered gert binary', async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gert-binary-resolver-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  createExecutable(projectRoot);

  await assert.rejects(resolveBinary('configured-gert', output, projectRoot, []));
});

test('the default gert command still discovers a binary from the active project', async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gert-binary-resolver-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const discovered = createExecutable(projectRoot);

  assert.equal(await resolveBinary('gert', output, projectRoot, []), discovered);
});