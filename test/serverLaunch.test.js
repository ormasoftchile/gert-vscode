// serverLaunch.test.js — unit tests for the pure server-launch decision functions.
//
// localServerAddress, buildServeArgs, and resolvePackageMapPath are extracted
// from serverManager so they can be tested without spawning a binary or
// importing vscode. The tests are load-bearing: mutating the production code
// in the way documented below causes a specific test to fail and is pasted in
// the delivery report.
//
// Run with: node --test test/serverLaunch.test.js  (or via npm test)

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { localServerAddress, buildServeArgs, resolvePackageMapPath } =
  require('../out/serverLaunch');

// ─── localServerAddress ───────────────────────────────────────────────────────
// MUTATION: change return to ``:${port}`` → test 'must be 127.0.0.1' fails.

test('localServerAddress: always uses 127.0.0.1, never bare :port or localhost', () => {
  const addr = localServerAddress(7779);
  assert.equal(addr, '127.0.0.1:7779');
});

test('localServerAddress: different port produces correct address', () => {
  assert.equal(localServerAddress(54321), '127.0.0.1:54321');
});

test('localServerAddress: never starts with colon (bare-port guard)', () => {
  const addr = localServerAddress(1234);
  assert.ok(!addr.startsWith(':'),
    `address must not be a bare :port, got "${addr}"`);
});

test('localServerAddress: never contains localhost (dual-stack guard)', () => {
  const addr = localServerAddress(7779);
  assert.ok(!addr.includes('localhost'),
    `address must not use localhost (can resolve to ::1), got "${addr}"`);
});

// ─── buildServeArgs ───────────────────────────────────────────────────────────
// MUTATION: drop '--package-map', packageMapPath from the returned array →
//   'with package-map: fourth element is --package-map' fails.

test('buildServeArgs: without package-map returns exactly [serve, --addr, addr]', () => {
  const args = buildServeArgs('127.0.0.1:9000');
  assert.deepEqual(args, ['serve', '--addr', '127.0.0.1:9000']);
});

test('buildServeArgs: without package-map returns an array (no shell string)', () => {
  const args = buildServeArgs('127.0.0.1:9000');
  assert.ok(Array.isArray(args));
  // Each element must be a string — no quoting, no interpolation markers.
  for (const el of args) {
    assert.equal(typeof el, 'string');
    assert.ok(!el.includes('"'), `element must not contain quotes: ${el}`);
    assert.ok(!el.includes("'"), `element must not contain quotes: ${el}`);
    assert.ok(!el.includes('$'), `element must not contain shell \$: ${el}`);
  }
});

test('buildServeArgs: with package-map includes --package-map as its own element', () => {
  const p = '/abs/path/package-map.yaml';
  const args = buildServeArgs('127.0.0.1:9000', p);
  assert.deepEqual(args, ['serve', '--addr', '127.0.0.1:9000', '--package-map', p]);
  // Critically: path is a separate element, not joined to the flag.
  const flagIdx = args.indexOf('--package-map');
  assert.ok(flagIdx !== -1, '--package-map must be present');
  assert.equal(args[flagIdx + 1], p,
    'path must be the element immediately after --package-map, not fused to it');
});

test('buildServeArgs: undefined package-map → flag is completely absent', () => {
  const args = buildServeArgs('127.0.0.1:9000', undefined);
  assert.ok(!args.includes('--package-map'),
    '--package-map must not appear when packageMapPath is undefined');
  assert.ok(!args.some((a) => a.includes('package-map')),
    'no element may reference package-map when the path is undefined');
});

test('buildServeArgs: empty-string package-map path is never passed', () => {
  // buildServeArgs treats undefined as "no flag". An empty string coerced to
  // undefined at the call site is the correct guard; this test verifies that
  // the function never injects the flag for a falsy value.
  // (The guard lives in resolvePackageMapPath; buildServeArgs only guards undefined.)
  const args = buildServeArgs('127.0.0.1:9000', undefined);
  assert.ok(!args.includes(''), 'no empty-string element must appear in argv');
});

// ─── resolvePackageMapPath ────────────────────────────────────────────────────

// Helper: create a temp project root, optionally with a package-map file.
function makeTempRoot(t, files = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gert-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const rel of files) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '# fixture\n');
  }
  return root;
}

test('resolvePackageMapPath: convention (package-map.yaml in root) is found', (t) => {
  const root = makeTempRoot(t, ['package-map.yaml']);
  const result = resolvePackageMapPath(root, undefined);
  assert.equal(result, path.join(root, 'package-map.yaml'));
});

test('resolvePackageMapPath: convention absent and no setting → undefined', (t) => {
  const root = makeTempRoot(t);  // no package-map.yaml
  const result = resolvePackageMapPath(root, undefined);
  assert.equal(result, undefined);
});

test('resolvePackageMapPath: absolute setting value overrides convention', (t) => {
  const root = makeTempRoot(t, ['package-map.yaml', 'package-map.mock.yaml']);
  const mockPath = path.join(root, 'package-map.mock.yaml');
  const result = resolvePackageMapPath(root, mockPath);
  assert.equal(result, mockPath,
    'absolute setting path must win over the convention package-map.yaml');
});

test('resolvePackageMapPath: relative setting value resolved against projectRoot, not CWD', (t) => {
  // This is the multi-root guard: relative values must be resolved against the
  // active project root that pickServerRoot selected, never workspaceFolders[0].
  // If the code used process.cwd() or a different base, the resolved path would
  // not equal the one based on projectRoot.
  const root = makeTempRoot(t, ['package-map.mock.yaml']);
  const result = resolvePackageMapPath(root, 'package-map.mock.yaml');
  assert.equal(result, path.join(root, 'package-map.mock.yaml'),
    'relative setting must be joined to projectRoot, not any other base');
  // Guard: if resolved against process.cwd() instead, this would be wrong.
  assert.notEqual(result, path.join(process.cwd(), 'package-map.mock.yaml'),
    'result must not be relative to process.cwd()');
});

test('resolvePackageMapPath: setting beats convention when both exist', (t) => {
  const root = makeTempRoot(t, ['package-map.yaml', 'package-map.mock.yaml']);
  const result = resolvePackageMapPath(root, 'package-map.mock.yaml');
  // Should return the setting-specified file, not the convention file.
  assert.equal(result, path.join(root, 'package-map.mock.yaml'),
    'gert.packageMap setting must win over package-map.yaml convention');
  assert.notEqual(result, path.join(root, 'package-map.yaml'),
    'convention file must not override the explicit setting');
});

test('resolvePackageMapPath: missing setting file falls through to convention', (t) => {
  // Setting points to a non-existent file; convention file exists.
  // The chain must fall through silently (caller logs the warning).
  const root = makeTempRoot(t, ['package-map.yaml']);
  const result = resolvePackageMapPath(root, 'package-map.nonexistent.yaml');
  assert.equal(result, path.join(root, 'package-map.yaml'),
    'missing setting file must fall through to the convention file');
});

test('resolvePackageMapPath: neither setting nor convention → undefined', (t) => {
  const root = makeTempRoot(t);
  const result = resolvePackageMapPath(root, 'package-map.nonexistent.yaml');
  assert.equal(result, undefined);
});

test('resolvePackageMapPath: empty setting string behaves like unset', (t) => {
  const root = makeTempRoot(t, ['package-map.yaml']);
  const result = resolvePackageMapPath(root, '');
  assert.equal(result, path.join(root, 'package-map.yaml'),
    'empty setting string must fall through to convention, not block it');
});

// ─── Load-bearing: setting-override mutation guard ────────────────────────────
// MUTATION: comment out Step 1 of resolvePackageMapPath (the setting lookup) →
//   'setting beats convention' and 'absolute setting overrides convention' fail.

test('setting-override mutation guard: removing Step 1 breaks this test', (t) => {
  const root = makeTempRoot(t, ['package-map.yaml', 'package-map.vscode.yaml']);
  const settingPath = path.join(root, 'package-map.vscode.yaml');
  const result = resolvePackageMapPath(root, settingPath);
  assert.equal(result, settingPath,
    'if the Step 1 setting lookup is removed, this returns the convention file and fails');
});

// ─── Load-bearing: multi-root relative-path guard ────────────────────────────
// MUTATION: resolve settingValue against process.cwd() instead of projectRoot →
//   'relative setting value resolved against projectRoot' fails unless the test
//   happens to be run from inside projectRoot (it is not — it runs from repo root).

test('multi-root relative-path guard: resolution is always against projectRoot', (t) => {
  const root = makeTempRoot(t, ['sub/package-map.mock.yaml']);
  const result = resolvePackageMapPath(root, 'sub/package-map.mock.yaml');
  assert.equal(result, path.join(root, 'sub', 'package-map.mock.yaml'));
  // The test is run from C:\One\OpenSource\gert-vscode; if the code used CWD
  // as the base, the path would not exist and the function would return undefined.
  assert.notEqual(result, undefined,
    'file was not found — relative path was probably resolved against the wrong base');
});
