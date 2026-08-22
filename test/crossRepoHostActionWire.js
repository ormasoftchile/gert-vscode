'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  HostActionBridge,
  HOST_ACTION_COMMAND,
  isHostActionWrapperMessage,
} = require('../out/hostActionBridge');

const coreRoot = process.env.GERT_CORE_ROOT;
if (!coreRoot) {
  throw new Error('GERT_CORE_ROOT must name the Gert repository for the cross-repository wire test.');
}

const wire = JSON.parse(fs.readFileSync(
  path.join(coreRoot, 'internal', 'serve', 'testdata', 'host_action_wire_v1.json'),
  'utf8',
));

function bridge(executeCommand) {
  const acknowledgments = [];
  const calls = [];
  const instance = new HostActionBridge({
    executeCommand(command, payload) {
      calls.push({ command, payload });
      return executeCommand(command, payload);
    },
    postAcknowledgment(acknowledgment) {
      acknowledgments.push(acknowledgment);
    },
  });
  return { instance, calls, acknowledgments };
}

test('canonical Gert preview request passes the strict VS Code bridge unchanged', async () => {
  const subject = bridge(async () => ({ status: 'opened' }));

  assert.equal(isHostActionWrapperMessage(wire.request), true);
  await subject.instance.receive(wire.request);

  assert.deepEqual(subject.calls, [{
    command: HOST_ACTION_COMMAND,
    payload: {
      viewPath: 'incident-details',
      environment: 'prod',
      parameters: { server: 'api-01', database: 'operations' },
      focus: true,
      correlationId: 'correlation-1',
    },
  }]);
  assert.deepEqual(subject.acknowledgments, [wire.acknowledgment]);

  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const cancelled = bridge(async () => waiting);
  const pending = cancelled.instance.receive(wire.request);
  await cancelled.instance.receive(wire.cancellation);
  release({ status: 'opened' });
  await pending;
  assert.deepEqual(cancelled.acknowledgments, [{
    ...wire.acknowledgment,
    status: 'execution-not-started',
  }]);
});
