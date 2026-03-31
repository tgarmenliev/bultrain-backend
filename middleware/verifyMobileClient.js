/**
 * Middleware: verifyMobileClient
 *
 * Ensures requests come from the official BulTrain mobile apps.
 *  1. Checks x-bultrain-api-key header against IOS_API_KEY / ANDROID_API_KEY env vars.
 *  2. Requires User-Agent to contain "BulTrainMobile".
 */
module.exports = (req, res, next) => {
    const apiKey = req.headers['x-bultrain-api-key'];
    const userAgent = req.headers['user-agent'] || '';

    // ── API key check ───────────────────────────────────────────────────
    if (!apiKey) {
        return res.status(401).json({ error: 'Unauthorized. Missing API key.' });
    }

    const validKeys = [
        process.env.IOS_API_KEY,
        process.env.ANDROID_API_KEY,
    ].filter(Boolean); // ignore undefined env vars

    if (!validKeys.includes(apiKey)) {
        return res.status(401).json({ error: 'Unauthorized. Invalid API key.' });
    }

    // ── User-Agent check ────────────────────────────────────────────────
    if (!userAgent.includes('BulTrainMobile')) {
        return res.status(401).json({ error: 'Unauthorized. Invalid client.' });
    }

    next();
};
