#!/usr/bin/env node
/**
 * sync-schema.js — Drift detection for the vendored runbook/v1 JSON Schema.
 *
 * ASSUMPTION: gert-private is a sibling clone of gert-vscode, i.e.:
 *   <workspace>/
 *     gert-private/   ← canonical schema lives here
 *     gert-vscode/    ← this repo, vendored copy lives under schemas/
 *
 * If gert-private is not at that relative path, set the GERT_PRIVATE_ROOT
 * environment variable to its absolute path.
 *
 * Usage:
 *   node scripts/sync-schema.js            # compare hashes, exit 0 if in sync
 *   node scripts/sync-schema.js --update   # copy canonical → vendored, exit 0
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const CANONICAL_REL = path.join(
  __dirname,
  '..',
  '..',
  'gert-private',
  'design',
  'gert',
  'schemas',
  'runbook.v1.schema.json'
);
const CANONICAL = process.env.GERT_PRIVATE_ROOT
  ? path.join(process.env.GERT_PRIVATE_ROOT, 'design', 'gert', 'schemas', 'runbook.v1.schema.json')
  : CANONICAL_REL;

const VENDORED = path.join(__dirname, '..', 'schemas', 'runbook.v1.schema.json');

function sha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const update = process.argv.includes('--update');

if (!fs.existsSync(CANONICAL)) {
  console.error(`✗ Canonical schema not found at:\n  ${CANONICAL}`);
  console.error('  Is gert-private cloned as a sibling directory? Set GERT_PRIVATE_ROOT to override.');
  process.exit(1);
}

if (!fs.existsSync(VENDORED)) {
  if (update) {
    fs.mkdirSync(path.dirname(VENDORED), { recursive: true });
  } else {
    console.error(`✗ Vendored schema not found at:\n  ${VENDORED}`);
    console.error('  Run: npm run schema:update');
    process.exit(1);
  }
}

const canonicalHash = sha256(CANONICAL);

if (update) {
  const buf = fs.readFileSync(CANONICAL);
  fs.writeFileSync(VENDORED, buf);
  console.log(`✓ schema updated`);
  console.log(`  canonical : ${canonicalHash}`);
  console.log(`  vendored  : ${sha256(VENDORED)}`);
  process.exit(0);
}

const vendoredHash = sha256(VENDORED);

if (canonicalHash === vendoredHash) {
  console.log(`✓ schema in sync`);
  console.log(`  sha256: ${canonicalHash}`);
  process.exit(0);
} else {
  console.error(`✗ schema DRIFT DETECTED`);
  console.error(`  canonical (${CANONICAL}):`);
  console.error(`    sha256: ${canonicalHash}`);
  console.error(`  vendored  (${VENDORED}):`);
  console.error(`    sha256: ${vendoredHash}`);
  console.error('');
  console.error('  To refresh: npm run schema:update');
  process.exit(1);
}
