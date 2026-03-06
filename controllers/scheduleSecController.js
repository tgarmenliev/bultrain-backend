const path = require('path');
const fs = require('fs');

const MOCKS_DIR = path.join(__dirname, '..', 'mocks');

/**
 * GET /api/schedule/:language/:from/:to
 * Returns schedule mock for the current date (no date param).
 */
exports.getScheduleCurrentDate = (req, res) => {
    const { language, from, to } = req.params;

    if (language !== 'bg' && language !== 'en') {
        return res.status(400).json({ error: 'Invalid language' });
    }

    try {
        const mockFile = path.join(MOCKS_DIR, `schedule_cur_date_${language}.json`);
        const data = JSON.parse(fs.readFileSync(mockFile, 'utf-8'));

        res.header('Content-Type', 'application/json');
        res.send(JSON.stringify(data, null, 4));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server Error' });
    }
};
