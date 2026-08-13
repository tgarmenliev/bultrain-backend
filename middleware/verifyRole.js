'use strict';

const jwt = require('jsonwebtoken');

/**
 * verifyRole(...allowedRoles) → middleware that validates the admin_token JWT
 * cookie AND checks the account's role.
 *
 * Tokens issued before roles existed carry no `role`; they were only ever the
 * single admin login, so a missing role is normalised to 'admin' — existing
 * sessions keep working. Pass no roles to require only a valid token.
 */
function verifyRole(...allowedRoles) {
    return (req, res, next) => {
        const token = req.cookies && req.cookies.admin_token;
        if (!token) {
            return res.status(401).json({ error: 'Unauthorized. No admin token.' });
        }
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const role = decoded.role || 'admin';
            if (allowedRoles.length && !allowedRoles.includes(role)) {
                return res.status(403).json({ error: 'Forbidden. Insufficient role.' });
            }
            req.admin = decoded;
            next();
        } catch (err) {
            return res.status(401).json({ error: 'Unauthorized. Invalid or expired token.' });
        }
    };
}

module.exports = verifyRole;
