'use strict';

/**
 * boards.js — the departure boards of Sofia and Plovdiv for the public network
 * snapshot, refreshed on a timer of their own.
 *
 * This is the one part of the snapshot that costs an outbound request: the
 * boards come from БДЖ's live site (the same scrape the E-ink screen uses, via
 * liveController). Everything else is computed from memory. So the boards are
 * fetched every 5 minutes — 2 stations, ~576 requests a day — no matter how often
 * the rest of the snapshot is rebuilt or how many people visit the website.
 *
 * Honesty: a failed scrape keeps the last good board, but only for KEEP_MS. After
 * that the board is reported as unavailable (trains: null) rather than serving
 * old departures as if they were current.
 */

const liveController = require('../../controllers/liveController');

const BOARDS = [
    { key: 'sofia',   name: 'София',   stationId: 2 },
    { key: 'plovdiv', name: 'Пловдив', stationId: 3 },
];

const MAX_TRAINS       = 8;
const REFRESH_MS       = 5 * 60 * 1000;
const KEEP_MS          = 15 * 60 * 1000;
const FIRST_DELAY_MS   = 20 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;

const state = new Map(BOARDS.map(b => [b.key, { trains: null, fetchedAt: null }]));
let busy = false;
let loggedFailure = false;

/** Default fetcher: run the existing board handler and capture what it would send. */
function defaultFetch(stationId) {
    const scrape = new Promise((resolve, reject) => {
        const res = {
            code: 200,
            status(c) { this.code = c; return this; },
            json(body) {
                if (this.code === 200 && body && Array.isArray(body.trains)) resolve(body.trains);
                else reject(new Error(`board ${stationId}: HTTP ${this.code}`));
            },
        };
        Promise.resolve(liveController.getLiveBoard(
            { params: { stationNumber: String(stationId), language: 'bg', type: 'departures' } }, res,
        )).catch(reject);
    });
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`board ${stationId}: timed out`)), FETCH_TIMEOUT_MS);
    });
    return Promise.race([scrape, timeout]).finally(() => clearTimeout(timer));
}

let fetcher = defaultFetch;

/** Refresh every board once. Never throws; a failure keeps the previous board. */
async function refresh(now = Date.now()) {
    if (busy) return;
    busy = true;
    try {
        for (const b of BOARDS) {       // one after the other: be gentle with БДЖ
            try {
                const trains = await fetcher(b.stationId);
                state.set(b.key, { trains: trains.slice(0, MAX_TRAINS), fetchedAt: now });
                loggedFailure = false;
            } catch (err) {
                if (!loggedFailure) console.error('[network] board refresh failed:', err.message);
                loggedFailure = true;
            }
        }
    } finally {
        busy = false;
    }
}

/** What the snapshot publishes for the boards at `nowMs`. */
function view(nowMs = Date.now()) {
    const out = {};
    for (const b of BOARDS) {
        const s = state.get(b.key);
        const fresh = s.fetchedAt != null && nowMs - s.fetchedAt <= KEEP_MS;
        out[b.key] = {
            name: b.name,
            trains: fresh ? s.trains : null,
            fetchedAt: s.fetchedAt != null ? new Date(s.fetchedAt).toISOString() : null,
        };
    }
    return out;
}

function start() {
    if (process.env.NETWORK_BOARDS === 'off') {
        console.log('[network] departure boards disabled (NETWORK_BOARDS=off)');
        return;
    }
    const first = setTimeout(() => { refresh(); }, FIRST_DELAY_MS);
    const every = setInterval(() => { refresh(); }, REFRESH_MS);
    first.unref(); every.unref();
}

/** Tests only. */
function _setFetcher(fn) { fetcher = fn || defaultFetch; }
function _reset() {
    for (const b of BOARDS) state.set(b.key, { trains: null, fetchedAt: null });
    busy = false; loggedFailure = false;
}

module.exports = { refresh, view, start, _setFetcher, _reset, KEEP_MS, MAX_TRAINS, REFRESH_MS };
