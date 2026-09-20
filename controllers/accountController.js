'use strict';

/**
 * accountController.js — the signed-in account managing itself. For now that is
 * one thing: changing its own password.
 *
 * Only accounts in the users table can change a password here. The bootstrap
 * admin has no row: it signs in with ADMIN_PASSWORD from the server's
 * environment, so changing it means editing .env on the server — the panel
 * cannot and should not rewrite that.
 */

const users        = require('../services/auth/users');
const passwordHash = require('../services/auth/password');

// Same floor scripts/create-user.js enforces when an account is created.
const MIN_LENGTH = 8;
// Bounds the scrypt work a single request can ask for.
const MAX_LENGTH = 256;

const fail = (res, status, code, error) => res.status(status).json({ error, code });

/**
 * GET /api/admin/account — who is signed in, and whether the panel can change
 * their password (so it can explain instead of showing a form that cannot work).
 */
exports.getAccount = (req, res) => {
    const a = req.admin || {};
    res.json({
        username: a.username || null,
        role: a.role || 'admin',
        canChangePassword: a.uid != null,
    });
};

/**
 * POST /api/admin/change-password   { oldPassword, newPassword }
 * The "type it twice" check is the panel's job; the server enforces the rules
 * that protect the account: the old password must be right, the new one long
 * enough and different.
 */
exports.changePassword = (req, res) => {
    try {
        const admin = req.admin || {};
        if (admin.uid == null) {
            return fail(res, 409, 'legacy-admin',
                'This account signs in with the server password (ADMIN_PASSWORD) and cannot be changed here.');
        }

        const { oldPassword, newPassword } = req.body || {};
        if (typeof oldPassword !== 'string' || typeof newPassword !== 'string' || !oldPassword) {
            return fail(res, 400, 'invalid-input', 'oldPassword and newPassword are required.');
        }
        if (newPassword.length < MIN_LENGTH) {
            return fail(res, 400, 'too-short', `The new password must be at least ${MIN_LENGTH} characters.`);
        }
        if (newPassword.length > MAX_LENGTH || oldPassword.length > MAX_LENGTH) {
            return fail(res, 400, 'too-long', `Passwords are limited to ${MAX_LENGTH} characters.`);
        }

        const user = users.findById(admin.uid);
        if (!user) return fail(res, 401, 'account-not-found', 'This account no longer exists.');

        if (!passwordHash.verify(oldPassword, user.password_hash, user.salt)) {
            return fail(res, 403, 'wrong-old-password', 'The current password is incorrect.');
        }
        if (newPassword === oldPassword) {
            return fail(res, 400, 'same-as-old', 'The new password must be different from the current one.');
        }

        const { hash, salt } = passwordHash.hash(newPassword);
        if (!users.updatePassword(user.id, hash, salt)) {
            return fail(res, 401, 'account-not-found', 'This account no longer exists.');
        }

        console.log(`[admin] password changed for user id=${user.id}`);
        res.json({ message: 'Password changed.' });
    } catch (err) {
        console.error('[admin] change-password failed:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};
