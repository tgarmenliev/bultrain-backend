const path = require('path');
const fs = require('fs');

const MOCKS_DIR = path.join(__dirname, '..', 'mocks');

/**
 * GET /api/schedule/:language/:from/:to/:date
 * Returns schedule mock for a specific date.
 */
exports.getSchedule = (req, res) => {
    const { language, from, to, date } = req.params;

    if (language !== 'bg' && language !== 'en') {
        return res.status(400).json({ error: 'Bad request! Language does not exist!' });
    }

    const fromStation = parseInt(from);
    const toStation = parseInt(to);
    if (isNaN(fromStation) || isNaN(toStation)) {
        return res.status(400).json({ error: 'Bad Request! Stations numbers not correct!' });
    }

    // Validate date format YYYY-MM-DD
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
        return res.status(400).json({ error: 'Bad Request! Wrong date!' });
    }

    try {
        const mockFile = path.join(MOCKS_DIR, `schedule_rnd_date_${language}.json`);
        const data = JSON.parse(fs.readFileSync(mockFile, 'utf-8'));
        res.json(data);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};
