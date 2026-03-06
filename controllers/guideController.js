const path = require('path');
const fs = require('fs');

const MOCKS_DIR = path.join(__dirname, '..', 'mocks');

/**
 * GET /api/guide/:language/:topic
 * Returns a single guide topic mock.
 */
exports.getGuideTopic = (req, res) => {
    const { language, topic } = req.params;

    if (language !== 'bg' && language !== 'en') {
        return res.status(400).json({ error: 'Language not provided' });
    }

    const topicNum = parseInt(topic);
    if (isNaN(topicNum)) {
        return res.status(400).json({ error: 'Bad Request! Please provide valid number for topic!' });
    }

    try {
        const mockFile = path.join(MOCKS_DIR, `guide_${language}.json`);
        const data = JSON.parse(fs.readFileSync(mockFile, 'utf-8'));
        res.json(data);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error with access to guide topic!' });
    }
};
