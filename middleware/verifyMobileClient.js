/**
 * Middleware: verifyMobileClient (Updated for E-ink Screen)
 *
 * Ensures requests come from the official BulTrain mobile apps OR the E-ink Screen.
 */
module.exports = (req, res, next) => {
    const apiKey = req.headers['x-bultrain-api-key'];
    const userAgent = req.headers['user-agent'] || '';

    // ── API key check ───────────────────────────────────────────────────
    if (!apiKey) {
        return res.status(401).json({ error: 'Unauthorized. Missing API key.' });
    }

    // 1. ДОБАВЯМЕ КЛЮЧА ЗА ЕКРАНЧЕТО ТУК
    const validKeys = [
        process.env.IOS_API_KEY,
        process.env.ANDROID_API_KEY,
        process.env.SCREEN_API_KEY,
    ].filter(Boolean); // ignore undefined env vars

    if (!validKeys.includes(apiKey)) {
        return res.status(401).json({ error: 'Unauthorized. Invalid API key.' });
    }

    // ── User-Agent check ────────────────────────────────────────────────
    // 2. ПРОМЕНЯМЕ ЛОГИКАТА ЗА УСТРОЙСТВАТА
    const isScreen = (apiKey === process.env.SCREEN_API_KEY);
    const isMobile = userAgent.includes('BulTrainMobile');

    // Ако не е мобилното приложение и не е екранчето -> режем достъпа
    if (!isMobile && !isScreen) {
        return res.status(401).json({ error: 'Unauthorized. Invalid client.' });
    }

    next();
};
