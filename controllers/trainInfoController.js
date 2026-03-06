const path = require('path');
const fs = require('fs');

const MOCKS_DIR = path.join(__dirname, '..', 'mocks');

/**
 * GET /api/train-info/:language/:trainNo/:date?
 * If :date is provided → train_info_date_{lang}.json
 * If :date is omitted  → train_info_{lang}.json
 */
exports.getTrainInfo = (req, res) => {
    const { language, trainNo, date } = req.params;

    if (language !== 'bg' && language !== 'en') {
        return res.status(404).json({ error: 'Bad request! Invalid language!' });
    }

    if (trainNo.length < 3 || trainNo.length > 6) {
        return res.status(404).json({ error: 'Bad request! Invalid train number!' });
    }

    try {
        const suffix = date ? 'date_' : '';
        const mockFile = path.join(MOCKS_DIR, `train_info_${suffix}${language}.json`);
        const data = JSON.parse(fs.readFileSync(mockFile, 'utf-8'));

        res.header('Content-Type', 'application/json');
        res.send(JSON.stringify(data, null, 4));
    } catch (error) {
        console.error('Error:', error);
        res.status(404).json({ error: 'Train info not found' });
    }
};
