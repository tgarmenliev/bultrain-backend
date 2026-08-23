'use strict';

/**
 * email.js — the one outbound alert channel, deliberately independent of
 * everything it might be reporting on (APNs, FCM, the realtime feed). A
 * self-monitoring channel that shares infrastructure with the thing it
 * watches can go quiet at exactly the moment it matters.
 *
 * Gmail SMTP + an app password — no third-party account to sign up for, no
 * new app on the phone, reuses credentials the user already has.
 */

const nodemailer = require('nodemailer');

function isConfigured() {
    return !!(process.env.ALERT_EMAIL_FROM && process.env.ALERT_EMAIL_APP_PASSWORD && process.env.ALERT_EMAIL_TO);
}

let transporter = null;
function getTransporter() {
    if (!transporter) {
        transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.ALERT_EMAIL_FROM,
                pass: process.env.ALERT_EMAIL_APP_PASSWORD,
            },
        });
    }
    return transporter;
}

async function send({ subject, text }) {
    if (!isConfigured()) {
        console.warn(`[alerts] ALERT_EMAIL_* not configured, would have sent: ${subject}`);
        return { sent: false, reason: 'not-configured' };
    }
    try {
        await getTransporter().sendMail({
            from: process.env.ALERT_EMAIL_FROM,
            to: process.env.ALERT_EMAIL_TO,
            subject,
            text,
        });
        return { sent: true };
    } catch (err) {
        console.error('[alerts] email send failed:', err.message);
        return { sent: false, reason: err.message };
    }
}

module.exports = { send, isConfigured };
