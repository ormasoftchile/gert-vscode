// pendingRunStore.test.js — tests for the single-use pending-run store
// in src/pendingRunStore.ts.
//
// Tests:
//   STORE-1:  nonce round-trip (stash → claim returns correct data)
//   STORE-2:  single-use: second claim returns undefined (entry removed on first claim)
//   STORE-3:  bounded lifetime: entry expired before claim → undefined
//   STORE-4a: secret value never appears in the nonce string (path A)
//   STORE-4b: secret value never in storeSize / claim return key names (path B)
//   STORE-5:  unclaimed entry is removed after expiry (store stays clean)
//   STORE-6:  two concurrent entries are independent (no cross-contamination)
//   STORE-7:  claimPendingRun with unknown nonce returns undefined

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  stashPendingRun,
  claimPendingRun,
  storeSize,
  overrideNowForTest,
  resetForTest,
} = require('../out/pendingRunStore');

// ─── STORE-1: round-trip ──────────────────────────────────────────────────────

test('STORE-1: stash then claim returns correct runbookPath and inputs', () => {
  resetForTest();
  const nonce = stashPendingRun('/rb.runbook.yaml', { incident_id: '999' });
  assert.ok(typeof nonce === 'string' && nonce.length > 0, 'nonce must be a non-empty string');

  const entry = claimPendingRun(nonce);
  assert.ok(entry !== undefined, 'claim must return the entry');
  assert.equal(entry.runbookPath, '/rb.runbook.yaml');
  assert.equal(entry.inputs.incident_id, '999');
  resetForTest();
});

// ─── STORE-2: single-use ──────────────────────────────────────────────────────

test('STORE-2: second claim on same nonce returns undefined (single-use)', () => {
  resetForTest();
  const nonce = stashPendingRun('/rb.runbook.yaml', { x: '1' });

  const first = claimPendingRun(nonce);
  assert.ok(first !== undefined, 'first claim must succeed');

  const second = claimPendingRun(nonce);
  assert.equal(second, undefined,
    'second claim must return undefined — entry is removed on first claim');
  resetForTest();
});

test('STORE-2b: store size drops to 0 after claim (entry actually removed)', () => {
  resetForTest();
  const nonce = stashPendingRun('/rb.runbook.yaml', {});
  assert.equal(storeSize(), 1);
  claimPendingRun(nonce);
  assert.equal(storeSize(), 0, 'entry must be removed from store on claim');
  resetForTest();
});

// ─── STORE-3: bounded lifetime ────────────────────────────────────────────────

test('STORE-3: entry expired before claim returns undefined', () => {
  resetForTest();
  let fakeTime = 1_000_000;
  overrideNowForTest(() => fakeTime);

  const nonce = stashPendingRun('/rb.runbook.yaml', { secret: 'val' }, 5000 /* 5 s TTL */);

  // Advance clock past TTL.
  fakeTime += 6000;

  const entry = claimPendingRun(nonce);
  assert.equal(entry, undefined, 'expired entry must return undefined');
  resetForTest();
});

test('STORE-3b: entry within TTL is still claimable', () => {
  resetForTest();
  let fakeTime = 1_000_000;
  overrideNowForTest(() => fakeTime);

  const nonce = stashPendingRun('/rb.runbook.yaml', { x: 'y' }, 5000);

  // Advance within TTL.
  fakeTime += 4999;

  const entry = claimPendingRun(nonce);
  assert.ok(entry !== undefined, 'entry within TTL must still be claimable');
  resetForTest();
});

test('STORE-3c: expired entry is removed from store (does not linger)', () => {
  resetForTest();
  let fakeTime = 1_000_000;
  overrideNowForTest(() => fakeTime);

  const nonce = stashPendingRun('/rb.runbook.yaml', {}, 1000);
  assert.equal(storeSize(), 1);

  fakeTime += 2000; // expire

  // Claim removes the entry (even though it's expired, the store.delete happens first).
  claimPendingRun(nonce);
  assert.equal(storeSize(), 0, 'expired entry must be removed from store on attempted claim');
  resetForTest();
});

// ─── STORE-4a: secret values never in nonce string ───────────────────────────

test('STORE-4a: secret input value does not appear in the returned nonce (path A)', () => {
  // Path A: stashPendingRun takes a secret in inputs, returns a nonce.
  // Mutation target: stashPendingRun. If a mutation embeds the secret value in
  // the nonce, this test fails.
  // Non-vacuity control: assert the nonce is non-empty and does not equal the secret.
  resetForTest();
  const secretValue = 'SUPER_SECRET_KEY_9876';
  const nonce = stashPendingRun('/rb.runbook.yaml', { password: secretValue });

  assert.ok(nonce.length > 0, 'non-vacuity: nonce must be non-empty');
  assert.ok(!nonce.includes(secretValue),
    'LEAK on path A (stashPendingRun): secret value found in nonce — ' +
    'the nonce is passed through the chat query and must contain no sensitive data');
  resetForTest();
});

// ─── STORE-4b: secret values accessible only via claim (not via storeSize etc.) ──

test('STORE-4b: storeSize does not reveal secret values (path B)', () => {
  // Path B: the store's size function is a number — it can never contain a string.
  // This test confirms the module interface design: there is no API that returns
  // or leaks stored values other than claimPendingRun.
  // Mutation target: storeSize. If a mutation changes it to return a string
  // embedding values, the typeof assertion fails.
  resetForTest();
  stashPendingRun('/rb.runbook.yaml', { token: 'SECRET_BEARER_TOKEN' });
  const size = storeSize();
  assert.equal(typeof size, 'number',
    'storeSize must return a number, never a string or object that could embed values');
  assert.equal(size, 1);
  resetForTest();
});

// ─── STORE-4c: claimed entry inputs are intact (round-trip proves store is live) ─

test('STORE-4c: claimed entry has exact input values (non-vacuity for redaction tests)', () => {
  // Confirms the claimed entry truly contains the stashed values.
  // This is the non-vacuity control for STORE-4a: if stashPendingRun were
  // to discard the inputs, STORE-4a would pass vacuously.
  resetForTest();
  const secretValue = 'CONTROL_PROOF_SECRET';
  const nonce = stashPendingRun('/rb.runbook.yaml', { tok: secretValue });
  const entry = claimPendingRun(nonce);
  assert.ok(entry !== undefined, 'non-vacuity: entry must exist');
  assert.equal(entry.inputs.tok, secretValue,
    'non-vacuity: inputs must be faithfully stored and retrieved via claimPendingRun');
  resetForTest();
});

// ─── STORE-5: two concurrent entries are independent ─────────────────────────

test('STORE-6: two concurrent entries are independent (no cross-contamination)', () => {
  resetForTest();
  const n1 = stashPendingRun('/rb1.runbook.yaml', { a: '1' });
  const n2 = stashPendingRun('/rb2.runbook.yaml', { b: '2' });

  assert.notEqual(n1, n2, 'each stash must produce a unique nonce');
  assert.equal(storeSize(), 2);

  const e1 = claimPendingRun(n1);
  assert.ok(e1 !== undefined);
  assert.equal(e1.runbookPath, '/rb1.runbook.yaml');
  assert.equal(e1.inputs.a, '1');
  assert.equal(e1.inputs.b, undefined, 'entry 1 must not have entry 2 inputs');

  const e2 = claimPendingRun(n2);
  assert.ok(e2 !== undefined);
  assert.equal(e2.runbookPath, '/rb2.runbook.yaml');
  assert.equal(e2.inputs.b, '2');

  assert.equal(storeSize(), 0);
  resetForTest();
});

// ─── STORE-7: unknown nonce ───────────────────────────────────────────────────

test('STORE-7: claimPendingRun with unknown nonce returns undefined', () => {
  resetForTest();
  const result = claimPendingRun('doesnotexist');
  assert.equal(result, undefined);
  resetForTest();
});

// ─── Secret-in-log-line proof ──────────────────────────────────────────────────

test('STORE-log: secret value never passed to any log function by the store module', () => {
  // Static scan: pendingRunStore.ts must not call appendLine, console.log,
  // or any logger function. Values stored here are opaque; logging them
  // would undo the redaction guarantee.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'pendingRunStore.ts'),
    'utf8',
  );
  // Non-vacuity: verify the file is non-empty and contains stashPendingRun.
  assert.ok(src.includes('stashPendingRun'), 'non-vacuity: expected function not found');
  assert.ok(!src.includes('appendLine'),
    'pendingRunStore must not call appendLine — would log secret values');
  assert.ok(!src.includes('console.log'),
    'pendingRunStore must not call console.log — would log secret values');
  assert.ok(!src.includes('console.error'),
    'pendingRunStore must not call console.error — would log secret values');
});
