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

const fs         = require('fs');
const path       = require('path');
const nodemailer = require('nodemailer');

// Committed to the repo (unlike guide/images/, which is gitignored runtime
// upload storage) so a plain `git pull` always has it — no manual copy step
// on the server.
const LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'email', 'logo.png');

function isConfigured() {
    return !!(process.env.ALERT_EMAIL_FROM && process.env.ALERT_EMAIL_APP_PASSWORD && process.env.ALERT_EMAIL_TO);
}

let transporter = null;
function getTransporter() {
    if (!transporter) {
        transporter = nodemailer.createTransport({
            // Explicit host/port rather than the 'service: gmail' shortcut,
            // which defaults to port 465 (implicit TLS) — confirmed blocked
            // outbound on the server. 587 (STARTTLS) is open and is Gmail's
            // documented alternative.
            host: 'smtp.gmail.com',
            port: 587,
            secure: false,
            auth: {
                user: process.env.ALERT_EMAIL_FROM,
                pass: process.env.ALERT_EMAIL_APP_PASSWORD,
            },
            // Without these, a host that silently drops outbound SMTP leaves
            // sendMail() hanging indefinitely instead of failing — exactly
            // the kind of silent break this whole channel exists to avoid.
            connectionTimeout: 10_000,
            greetingTimeout: 10_000,
            socketTimeout: 10_000,
        });
    }
    return transporter;
}

// ── HTML template ────────────────────────────────────────────────────────────
// Table-based layout with only inline styles — the constraints every email
// client imposes (no <style> blocks reliably honoured, no external CSS/JS).

const THEME = {
    alert:       { color: '#dc2626', label: 'ALERT',        emoji: '🔴' },
    ok:          { color: '#16a34a', label: 'RECOVERED',    emoji: '🟢' },
    report:      { color: '#2563eb', label: '7-DAY REPORT', emoji: '📊' },
    report_warn: { color: '#d97706', label: '7-DAY REPORT', emoji: '⚠️' },
};

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildTable(rows) {
    if (!rows || !rows.length) return '';
    const trs = rows.map(([label, value]) => `
        <tr>
            <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;color:#475569;font-size:14px;">${escapeHtml(label)}</td>
            <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;color:#0f172a;font-size:14px;font-weight:700;text-align:right;">${escapeHtml(value)}</td>
        </tr>`).join('');
    return `<table role="presentation" width="100%" style="margin-top:14px;border-collapse:collapse;">${trs}</table>`;
}

function renderHtml({ kind, title, lines, tableRows }) {
    const theme = THEME[kind] || THEME.report;
    const linesHtml = (lines || [])
        .map(l => `<p style="margin:0 0 10px;font-size:15px;line-height:1.55;color:#334155;">${escapeHtml(l)}</p>`)
        .join('');
    const tableHtml = buildTable(tableRows);
    const now = new Date().toLocaleString('bg-BG', { timeZone: 'Europe/Sofia' });

    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;">
<div style="background:#eef1f5;padding:32px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e5e9f0;">
<tr><td style="padding:26px 32px 18px;text-align:center;">
<img src="cid:bultrain-logo" width="132" alt="BulTrain" style="display:inline-block;border:0;max-width:132px;" />
</td></tr>
<tr><td style="height:4px;background:${theme.color};font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:26px 32px 6px;">
<span style="display:inline-block;background:${theme.color};color:#ffffff;font-weight:700;font-size:11px;letter-spacing:0.08em;padding:5px 12px;border-radius:999px;">${theme.emoji} ${theme.label}</span>
<h1 style="margin:16px 0 14px;font-size:21px;line-height:1.3;color:#0f172a;">${escapeHtml(title)}</h1>
${linesHtml}
${tableHtml}
</td></tr>
<tr><td style="padding:18px 32px 28px;">
<p style="margin:0;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:14px;">BulTrain self-check · ${now}</p>
</td></tr>
</table>
</div>
</body></html>`;
}

/**
 * kind:      'alert' | 'ok' | 'report' | 'report_warn' — picks the accent
 *            colour/badge. Defaults to the calm 'report' blue.
 * title/lines/tableRows: content. `text`, if given, overrides the plain-text
 *            fallback part directly; otherwise it's built from `lines`.
 */
async function send({ subject, text, kind = 'report', title, lines, tableRows }) {
    if (!isConfigured()) {
        console.warn(`[alerts] ALERT_EMAIL_* not configured, would have sent: ${subject}`);
        return { sent: false, reason: 'not-configured' };
    }

    const effectiveLines = lines || (text ? [text] : []);
    const html = renderHtml({ kind, title: title || subject, lines: effectiveLines, tableRows });
    const plainText = text || effectiveLines.join('\n\n');

    const attachments = [];
    if (fs.existsSync(LOGO_PATH)) {
        attachments.push({ filename: 'logo.png', path: LOGO_PATH, cid: 'bultrain-logo' });
    }

    try {
        await getTransporter().sendMail({
            from: `"BulTrain" <${process.env.ALERT_EMAIL_FROM}>`,
            to: process.env.ALERT_EMAIL_TO,
            subject,
            text: plainText,
            html,
            attachments,
        });
        return { sent: true };
    } catch (err) {
        console.error('[alerts] email send failed:', err.message);
        return { sent: false, reason: err.message };
    }
}

module.exports = { send, isConfigured };
