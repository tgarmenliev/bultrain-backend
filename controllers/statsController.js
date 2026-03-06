/**
 * GET /api/stats/:language/:line/:stationNumber
 * Returns a placeholder response (no mock file for stats yet).
 */
exports.getStats = (req, res) => {
    const { language, line, stationNumber } = req.params;

    if (language !== 'bg' && language !== 'en') {
        return res.status(400).json({ error: 'Bad Request! Language does not exist!' });
    }

    const lineNum = parseInt(line);
    const stationNum = parseInt(stationNumber);
    if (isNaN(lineNum) || isNaN(stationNum)) {
        return res.status(400).json({ error: 'Bad Request! Station number or line is not correct!' });
    }

    if (lineNum < 0 || lineNum > 100) {
        return res.status(400).json({ error: 'Bad Request! Line does not exist!' });
    }

    // No mock file for stats — return placeholder
    res.json({ message: 'Stats mock not yet available' });
};
