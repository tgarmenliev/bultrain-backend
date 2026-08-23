#!/usr/bin/env node
'use strict';

/**
 * scripts/find-install-id.js — read-only. Lists the most recently updated
 * device_tokens rows, newest first, so "which install_id is mine" is a
 * matter of reading the top row right after you do the thing in the app that
 * registers it — not grepping pm2 logs full of every user's activity.
 *
 * Usage: do the "track this journey" action in the app, then immediately:
 *   node scripts/find-install-id.js
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', 'bultrain.sqlite');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const rows = db.prepare(`
    SELECT install_id, kind, platform, environment, updated_at,
           substr(token, 1, 8) || '…' AS token_preview
    FROM device_tokens
    ORDER BY updated_at DESC
    LIMIT 10
`).all();

if (!rows.length) {
    console.log('No device tokens registered yet.');
    process.exit(0);
}

console.log('Most recently registered/updated device tokens (newest first):\n');
for (const r of rows) {
    console.log(`${r.updated_at}  install=${r.install_id}  kind=${r.kind}  platform=${r.platform}  env=${r.environment}  token=${r.token_preview}`);
}
console.log('\nIf you just did the "track journey" action in the app, the TOP row is almost certainly yours — use its install_id.');
