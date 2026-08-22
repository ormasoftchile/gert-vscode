'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  HostActionBridge,
  HOST_ACTION_COMMAND,
  HOST_ACTION_REGISTRY,
  isHostActionWrapperMessage,
  isTrustedIframeHostActionMessage,
} = require('../out/hostActionBridge');

function request(overrides = {}) {
  return {
    type: 'gert.host-action.request',
    payload: {
      type: 'xts.host-action.request',
      capability: 'xts.open-view',
      request: {
        view_path: 'incident-details',
        environment: 'prod',
        parameters: { server: 'api-01', database: 'operations' },
        focus: true,
        correlation_id: 'correlation-1',
        interaction_id: 'interaction-1',
      },
    },
    ...overrides,
  };
}

function bridge(executeCommand) {
  const acknowledgments = [];
  const calls = [];
  const instance = new HostActionBridge({
    executeCommand(command, payload) {
      calls.push({ command, payload });
      return executeCommand(command, payload);
    },
    postAcknowledgment(ack) {
      acknowledgments.push(ack);
    },
  });
  return { instance, calls, acknowledgments };
}

test('host action registry is static and translates aliases only at the trusted boundary', async () => {
  assert.deepEqual(HOST_ACTION_REGISTRY, { 'xts.open-view': HOST_ACTION_COMMAND });
  const subject = bridge(async () => undefined);
  const message = request();
  message.payload.request.viewPath = message.payload.request.view_path;
  delete message.payload.request.view_path;
  message.payload.request.correlationId = message.payload.request.correlation_id;
  delete message.payload.request.correlation_id;
  message.payload.request.interactionId = message.payload.request.interaction_id;
  delete message.payload.request.interaction_id;

  await subject.instance.receive(message);

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
  assert.deepEqual(subject.acknowledgments, [{
    type: 'xts.host-action.ack',
    capability: 'xts.open-view',
    correlation_id: 'correlation-1',
    interaction_id: 'interaction-1',
    status: 'opened',
  }]);
});

test('rejects unallowlisted capabilities and does not accept a runbook command ID', async () => {
  const subject = bridge(async () => undefined);
  const message = request();
  message.payload.capability = 'workbench.action.openSettings';
  message.payload.request.command = 'workbench.action.openSettings';

  await subject.instance.receive(message);

  assert.equal(subject.calls.length, 0);
  assert.equal(subject.acknowledgments.length, 1);
  assert.equal(subject.acknowledgments[0].status, 'invalid-parameters');
});

test('malformed payloads are rejected with a correlated invalid-parameters acknowledgment', async () => {
  const malformed = [
    (message) => { delete message.payload.request.parameters.database; },
    (message) => { message.payload.request.focus = 'yes'; },
    (message) => { message.payload.request.view_path = ''; },
    (message) => { message.payload.request.viewPath = 'different-view'; },
    (message) => { message.payload.request.parameters.extra = 'not allowed'; },
    (message) => { message.payload.request.interaction_id = 'contains spaces'; },
    (message) => { message.payload.extra = 'not allowed'; },
  ];

  for (const mutate of malformed) {
    const subject = bridge(async () => undefined);
    const message = request();
    mutate(message);
    await subject.instance.receive(message);
    assert.equal(subject.calls.length, 0);
    if (message.payload.request.interaction_id === 'contains spaces') {
      assert.equal(subject.acknowledgments.length, 0);
    } else {
      assert.equal(subject.acknowledgments.length, 1);
      assert.equal(subject.acknowledgments[0].status, 'invalid-parameters');
    }
  }
});

test('wrapper envelope and iframe source/origin gates fail closed', () => {
  const iframe = {};
  const data = request().payload;
  assert.equal(isHostActionWrapperMessage(request()), true);
  assert.equal(isHostActionWrapperMessage({ type: 'gert.host-action.request', payload: data, extra: true }), false);
  assert.equal(isTrustedIframeHostActionMessage(
    { source: iframe, origin: 'http://127.0.0.1:7778', data },
    'http://127.0.0.1:7778',
    iframe,
  ), true);
  assert.equal(isTrustedIframeHostActionMessage(
    { source: {}, origin: 'http://127.0.0.1:7778', data },
    'http://127.0.0.1:7778',
    iframe,
  ), false);
  assert.equal(isTrustedIframeHostActionMessage(
    { source: iframe, origin: 'https://untrusted.example', data },
    'http://127.0.0.1:7778',
    iframe,
  ), false);
});

for (const status of ['opened', 'view-not-found', 'environment-not-found', 'invalid-parameters', 'execution-not-started']) {
  test(`returns the XTS ${status} outcome without exposing request data`, async () => {
    const subject = bridge(async () => ({ status }));
    await subject.instance.receive(request());
    assert.equal(subject.calls.length, 1);
    assert.equal(subject.acknowledgments[0].status, status);
    assert.deepEqual(Object.keys(subject.acknowledgments[0]).sort(), [
      'capability', 'correlation_id', 'interaction_id', 'status', 'type',
    ]);
  });
}

test('maps thrown and rejected command executions to execution-not-started', async () => {
  const thrown = bridge(() => { throw new Error('not started'); });
  await thrown.instance.receive(request());
  assert.equal(thrown.calls.length, 1);
  assert.equal(thrown.acknowledgments[0].status, 'execution-not-started');

  const rejected = bridge(async () => Promise.reject(new Error('rejected')));
  await rejected.instance.receive(request());
  assert.equal(rejected.calls.length, 1);
  assert.equal(rejected.acknowledgments[0].status, 'execution-not-started');
});

test('duplicate requests execute once and result in one acknowledgment', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const subject = bridge(async () => waiting);
  const first = subject.instance.receive(request());
  const second = subject.instance.receive(request());
  assert.equal(subject.calls.length, 1);
  release({ status: 'opened' });
  await Promise.all([first, second]);
  assert.equal(subject.acknowledgments.length, 1);
});

test('reload, dispose, and replacement invalidation suppress late command completions', async () => {
  for (const reason of ['reload', 'dispose', 'replacement']) {
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const subject = bridge(async () => waiting);
    const pending = subject.instance.receive(request());
    subject.instance.invalidate();
    release({ status: 'opened' });
    await pending;
    assert.equal(subject.calls.length, 1, reason);
    assert.equal(subject.acknowledgments.length, 0, reason);
  }
});
