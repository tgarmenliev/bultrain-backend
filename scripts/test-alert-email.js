#!/usr/bin/env node
'use strict';

/**
 * scripts/test-alert-email.js — sends one real test email through
 * services/alerts/email.js so ALERT_EMAIL_* can be verified once, on demand,
 * instead of trusting it silently until the first real alert fires.
 *
 * Usage: node scripts/test-alert-email.js
 */

require('dotenv').config({ override: true });
const email = require('../services/alerts/email');

(async () => {
    if (!email.isConfigured()) {
        console.error('ALERT_EMAIL_FROM / ALERT_EMAIL_APP_PASSWORD / ALERT_EMAIL_TO are not all set in .env');
        process.exit(1);
    }
    const res = await email.send({
        subject: '[BulTrain] test alert email',
        text: `This is a test from scripts/test-alert-email.js, sent ${new Date().toISOString()}.\nIf this arrived, self-monitoring alerts are wired correctly.`,
    });
    console.log(res.sent ? 'Sent OK — check the inbox.' : `Failed: ${res.reason}`);
    process.exit(res.sent ? 0 : 1);
})();
