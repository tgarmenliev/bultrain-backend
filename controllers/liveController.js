const path = require('path');
const fs = require('fs');

const MOCKS_DIR = path.join(__dirname, '..', 'mocks');

/**
 * GET /api/live/:language/:stationNumber/:type
 * Returns mock live data based on the language param.
 */
exports.getLive = (req, res) => {
    const { language, stationNumber, type } = req.params;

    if (language !== 'bg' && language !== 'en') {
        return res.status(400).json({ error: 'Bad Request! Language does not exist!' });
    }

    if (type !== 'departures' && type !== 'arrivals') {
        return res.status(400).json({ error: 'Bad Request! Wrong type of live table!' });
    }

    const stationNum = parseInt(stationNumber);
    if (isNaN(stationNum)) {
        return res.status(400).json({ error: 'Bad Request! Station number is not correct!' });
    }

    try {
        const mockFile = path.join(MOCKS_DIR, `live_${language}.json`);
        const data = JSON.parse(fs.readFileSync(mockFile, 'utf-8'));
        res.json(data);
    } catch (error) {
        console.error('Error reading mock:', error);
        res.status(500).json({ error: 'Internal Server Error!' });
    }
};
