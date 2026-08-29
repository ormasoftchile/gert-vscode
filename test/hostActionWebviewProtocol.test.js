'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseHostActionResponse } = require('../out/hostActionWebviewProtocol');

const correlation = {
  correlationId: 'correlation-1',
  previewSessionId: 'preview-1',
  requestId: 'request-1',
};

test('parseHostActionResponse accepts a canonical acknowledgment envelope', () => {
  const envelope = {
    type: 'gert.host-action.ack',
    version: 'host-action/v1',
    capability: 'xts.open-view',
    ...correlation,
    runId: 'run-1',
    turnId: 'turn-1',
    status: 'completed',
    result: { status: 'opened' },
    error: null,
  };

  assert.deepEqual(parseHostActionResponse(envelope), envelope);
});

test('parseHostActionResponse accepts canonical cancel without ack-only fields', () => {
  const envelope = {
    type: 'gert.host-action.cancel',
    version: 'host-action/v1',
    ...correlation,
    status: 'execution-not-started',
    reason: 'reload',
  };

  assert.deepEqual(parseHostActionResponse(envelope), envelope);
});

test('parseHostActionResponse rejects a cancel carrying acknowledgment fields', () => {
  assert.equal(parseHostActionResponse({
    type: 'gert.host-action.cancel',
    version: 'host-action/v1',
    ...correlation,
    runId: 'run-1',
    status: 'execution-not-started',
    reason: 'reload',
  }), undefined);
});