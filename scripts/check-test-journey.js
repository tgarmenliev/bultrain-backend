#!/usr/bin/env node
'use strict';

/**
 * scripts/check-test-journey.js — read-only. Dumps the armed_journeys and
 * live_activity_tokens rows for TEST-prefixed trains, to answer one specific
 * question: after push-to-start fires, does the app ever call the ORDINARY
 * /register endpoint for the activity it just received?
 *
 * If live_activity_tokens has NO row for the TEST- train, the ongoing content
 * (progress, phase, delay) can never update — worker.js only pushes to rows
 * in that table, and nothing put one there. That would mean the app isn't
 * registering an update token for an activity it didn't itself request (i.e.
 * one that arrived purely via push-to-start) — an iOS-side gap, not a
 * server-side one, since /register doesn't care how the activity started.
 *
 * Usage: node scripts/check-test-journey.js
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', 'bultrain.sqlite');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const armed = db.prepare(`
    SELECT id, install_id, journey_id, leg_index, train_number, state,
           scheduled_departure, scheduled_arrival, started_at, arrived_at, stopped_at, stopped_reason
    FROM armed_journeys WHERE train_number LIKE 'TEST-%' ORDER BY id DESC LIMIT 20
`).all();

const tokens = db.prepare(`
    SELECT token, train_number, journey_id, current_leg_index, environment,
           last_pushed_at, last_phase, last_delay_min, created_at
    FROM live_activity_tokens WHERE train_number LIKE 'TEST-%' ORDER BY created_at DESC LIMIT 20
`).all();

console.log('── armed_journeys (server-side tracking state) ──────────────────────');
if (!armed.length) console.log('(none)');
for (const r of armed) {
    console.log(`#${r.id} leg=${r.leg_index} train=${r.train_number} state=${r.state} ` +
        `started=${r.started_at || '—'} arrived=${r.arrived_at || '—'} stopped=${r.stopped_at || '—'} (${r.stopped_reason || '—'})`);
}

console.log('\n── live_activity_tokens (ONGOING update registration) ───────────────');
if (!tokens.length) {
    console.log('(none) — this is the smoking gun if the card never updated after the initial push-to-start.');
    console.log('It means the app never called POST /register for this activity. worker.js only pushes to rows');
    console.log('in this table, so with none here, no ongoing content push was ever possible — not a server bug,');
    console.log('but worth telling the mobile agent: does the app register an update token for activities that');
    console.log('arrived via push-to-start (not app-requested)? Real multi-leg users would hit this too.');
} else {
    for (const t of tokens) {
        console.log(`train=${t.train_number} leg=${t.current_leg_index} env=${t.environment} ` +
            `lastPushed=${t.last_pushed_at || 'never'} lastPhase=${t.last_phase || '—'} created=${t.created_at}`);
    }
}
