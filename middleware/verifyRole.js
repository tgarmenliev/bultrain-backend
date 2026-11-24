'use strict';

const jwt = require('jsonwebtoken');
const users = require('../services/auth/users');
const session = require('../services/auth/session');

/**
 * verifyRole(...allowedRoles) → middleware that validates the admin_token JWT
 * cookie AND checks the account's role.
 *
 * Tokens issued before roles existed carry no `role`; they were only ever the
 * single admin login, so a missing role is normalised to 'admin' — existing
 * sessions keep working. Pass no roles to require only a valid token.
 *
 * A token for an account in the users table (it carries a `uid`) is also checked against
 * the account itself — the session lasts weeks (see services/auth/session.js), so it has to
 * end when the account does: disabled, a changed password (tokens carry a fingerprint of the
 * one they were issued under) and the CURRENT role, not the one at login. Tokens from before
 * the fingerprint existed have none and are not refused for that; they expire as they always did.
 *
 * Using the panel keeps the session alive: a token older than a day is replaced.
 */
function verifyRole(...allowedRoles) {
    return (req, res, next) => {
        const token = req.cookies && req.cookies.admin_token;
        if (!token) {
            return res.status(401).json({ error: 'Unauthorized. No admin token.' });
        }
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            let role = decoded.role || 'admin';

            if (decoded.uid != null) {
                const user = users.findById(decoded.uid);
                if (!user) {
                    return res.status(401).json({ error: 'Unauthorized. This account is no longer active.' });
                }
                if (decoded.pv && decoded.pv !== session.passwordFingerprint(user.password_hash)) {
                    return res.status(401).json({ error: 'Unauthorized. The password was changed — sign in again.' });
                }
                role = user.role;
            }

            if (allowedRoles.length && !allowedRoles.includes(role)) {
                return res.status(403).json({ error: 'Forbidden. Insufficient role.' });
            }
            // A role-less legacy token is passed on as it is (the role is inferred, never written into it);
            // an account's is the current one.
            req.admin = decoded.uid != null ? { ...decoded, role } : decoded;

            if (typeof res.cookie === 'function' && session.dueForRenewal(decoded)) {
                const { iat, exp, ...claims } = decoded;
                session.issue(res, { ...claims, role });
            }
            next();
        } catch (err) {
            return res.status(401).json({ error: 'Unauthorized. Invalid or expired token.' });
        }
    };
}

module.exports = verifyRole;
