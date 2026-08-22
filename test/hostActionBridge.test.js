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
    version: 1,
    runID: 'run-1',
    turnID: 'turn-1',
    correlationID: 'correlation-1',
    previewSessionID: 'preview-session-1',
    requestID: 'preview-session-1:correlation-1',
    request: {
      capability: 'xts.open-view',
      view_path: 'incident-details',
      environment: 'prod',
      parameters: { server: 'api-01', database: 'operations' },
      focus: true,
    },
    ...overrides,
  };
}

function cancellation(overrides = {}) {
  const message = request();
  return {
    type: 'gert.host-action.cancel',
    version: 1,
    correlationID: message.correlationID,
    previewSessionID: message.previewSessionID,
    requestID: message.requestID,
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

function identity(message) {
  const { type: _type, version: _version, request: _request, ...result } = message;
  return result;
}

function tuple(message) {
  const { capability: _capability, status: _status, ...result } = identity(message);
  return result;
}

test('host action registry is static and translates only validated XTS fields', async () => {
  assert.deepEqual(HOST_ACTION_REGISTRY, { 'xts.open-view': HOST_ACTION_COMMAND });
  const subject = bridge(async () => ({ status: 'opened' }));

  await subject.instance.receive(request());

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
    type: 'gert.host-action.ack',
    version: 1,
    ...identity(request()),
    capability: 'xts.open-view',
    status: 'opened',
  }]);
});

test('strictly rejects malformed final-wire messages with a correlated status', async () => {
  const malformed = [
    (message) => { delete message.request.parameters.database; },
    (message) => { message.request.focus = 'yes'; },
    (message) => { message.request.view_path = ''; },
    (message) => { message.request.command = 'workbench.action.openSettings'; },
    (message) => { message.request.capability = 'workbench.action.openSettings'; },
    (message) => { message.request.extra = true; },
    (message) => { message.extra = true; },
    (message) => { message.version = 2; },
  ];

  for (const mutate of malformed) {
    const subject = bridge(async () => ({ status: 'opened' }));
    const message = request();
    mutate(message);
    await subject.instance.receive(message);
    assert.equal(subject.calls.length, 0);
    assert.equal(subject.acknowledgments.length, 1);
    assert.equal(subject.acknowledgments[0].status, 'invalid-parameters');
    assert.deepEqual(tuple(subject.acknowledgments[0]), tuple(request()));
  }
});

test('wrapper envelope and iframe source/origin gates fail closed', () => {
  const iframe = {};
  const data = request();
  assert.equal(isHostActionWrapperMessage(data), true);
  assert.equal(isHostActionWrapperMessage({ ...data, extra: true }), true);
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
  test(`returns the ${status} outcome with the full tuple`, async () => {
    const subject = bridge(async () => ({ status }));
    await subject.instance.receive(request());
    assert.equal(subject.calls.length, 1);
    assert.deepEqual(subject.acknowledgments[0], {
      type: 'gert.host-action.ack',
      version: 1,
      ...identity(request()),
      capability: 'xts.open-view',
      status,
    });
  });
}

test('undefined, null, malformed, thrown, and rejected commands never report opened', async () => {
  for (const execute of [
    async () => undefined,
    async () => null,
    async () => ({}),
    () => { throw new Error('not started'); },
    async () => Promise.reject(new Error('rejected')),
  ]) {
    const subject = bridge(execute);
    await subject.instance.receive(request());
    assert.equal(subject.calls.length, 1);
    assert.equal(subject.acknowledgments[0].status, 'execution-not-started');
  }
});

test('duplicate requests invoke the host exactly once', async () => {
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

test('cancellation and invalidation emit execution-not-started and ignore late results', async () => {
  for (const action of ['cancel', 'reload', 'dispose', 'replacement']) {
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const subject = bridge(async () => waiting);
    const pending = subject.instance.receive(request());
    if (action === 'cancel') {
      await subject.instance.receive(cancellation());
    } else {
      subject.instance.invalidate();
    }
    release({ status: 'opened' });
    await pending;
    assert.equal(subject.calls.length, 1, action);
    assert.deepEqual(subject.acknowledgments, [{
      type: 'gert.host-action.ack',
      version: 1,
      ...identity(request()),
      capability: 'xts.open-view',
      status: 'execution-not-started',
    }], action);
  }
});

test('malformed cancellation cannot cancel a matching pending request', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const subject = bridge(async () => waiting);
  const pending = subject.instance.receive(request());

  await subject.instance.receive({ ...cancellation(), unexpected: true });
  assert.equal(subject.acknowledgments.length, 0);

  release({ status: 'opened' });
  await pending;
  assert.equal(subject.acknowledgments[0].status, 'opened');
});
