/**
 * Middleware: verifyMobileClient
 *
 * Ensures requests come from the official BulTrain mobile apps OR the E-ink Screen.
 *
 * Each *_API_KEY may hold a COMMA-SEPARATED list of keys, which is what makes
 * key rotation possible without breaking anyone: put the new key alongside the
 * old one, ship an app update, wait for users to upgrade, then drop the old key.
 *   IOS_API_KEY=<new>,<old>
 *
 * Note on threat model: a key baked into a mobile binary is extractable by
 * anyone who downloads the app, so this is a casual gate, not a secret. It
 * guards free-riding on the API — there is no user data behind it.
 */

const splitKeys = (value) =>
    String(value || '')
        .split(',')
        .map(k => k.trim())
        .filter(Boolean);

module.exports = (req, res, next) => {
    const apiKey = req.headers['x-bultrain-api-key'];
    const userAgent = req.headers['user-agent'] || '';

    // ── API key check ───────────────────────────────────────────────────
    if (!apiKey) {
        return res.status(401).json({ error: 'Unauthorized. Missing API key.' });
    }

    const screenKeys = splitKeys(process.env.SCREEN_API_KEY);
    const validKeys = [
        ...splitKeys(process.env.IOS_API_KEY),
        ...splitKeys(process.env.ANDROID_API_KEY),
        ...screenKeys,
    ];

    if (!validKeys.includes(apiKey)) {
        return res.status(401).json({ error: 'Unauthorized. Invalid API key.' });
    }

    // ── User-Agent check ────────────────────────────────────────────────
    // The E-ink screen can't set a custom User-Agent, so its key is exempt.
    const isScreen = screenKeys.includes(apiKey);
    const isMobile = userAgent.includes('BulTrainMobile');

    if (!isMobile && !isScreen) {
        return res.status(401).json({ error: 'Unauthorized. Invalid client.' });
    }

    next();
};
