'use strict';

/**
 * metrics.js — in-process counters for the Live Activity pipeline.
 *
 * Deliberately tiny: the project has no metrics backend, and the point of these
 * numbers is to show a volume or error trend months before it hurts. Exposed
 * over an authenticated endpoint and summarised in the logs.
 */

const counters = {
    live_activity_pushes_sent: 0,
    live_activity_pushes_skipped_unchanged: 0,
    live_activity_pushes_skipped_throttled: 0,
    live_activity_tokens_pruned: 0,
    live_activity_ends_sent: 0,
    live_activity_worker_ticks: 0,
};

const apnsErrorsByReason = new Map();

// Ring buffer of recent APNs round-trip times, for a p95 without a histogram.
const LATENCY_SAMPLES = 500;
const latencies = [];

function inc(name, by = 1) {
    if (counters[name] === undefined) counters[name] = 0;
    counters[name] += by;
}

function apnsError(reason) {
    const key = reason || 'unknown';
    apnsErrorsByReason.set(key, (apnsErrorsByReason.get(key) || 0) + 1);
}

function observeLatency(ms) {
    latencies.push(ms);
    if (latencies.length > LATENCY_SAMPLES) latencies.shift();
}

function p95() {
    if (!latencies.length) return null;
    const sorted = [...latencies].sort((a, b) => a - b);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]);
}

function snapshot(extra = {}) {
    return {
        ...counters,
        ...extra,
        apns_errors_by_reason: Object.fromEntries(apnsErrorsByReason),
        apns_latency_p95_ms: p95(),
    };
}

module.exports = { inc, apnsError, observeLatency, snapshot };
