const jwt = require('jsonwebtoken');

/**
 * Middleware: verifyAdmin
 *
 * Validates the admin_token HttpOnly JWT cookie.
 * Must be applied to all /api/admin/* routes (except login/logout).
 */
module.exports = (req, res, next) => {
    const token = req.cookies && req.cookies.admin_token;

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized. No admin token.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.admin = decoded; // attach decoded payload to request
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Unauthorized. Invalid or expired token.' });
    }
};
