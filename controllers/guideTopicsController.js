const path = require('path');
const fs = require('fs');

const MOCKS_DIR = path.join(__dirname, '..', 'mocks');

/**
 * GET /api/guide/:language
 * Returns all guide topics for a language.
 */
exports.getAllTopics = (req, res) => {
    const { language } = req.params;

    if (language !== 'bg' && language !== 'en') {
        return res.status(400).json({ error: 'Bad request! Language not provided!' });
    }

    try {
        const mockFile = path.join(MOCKS_DIR, `guide_topics_${language}.json`);
        const data = JSON.parse(fs.readFileSync(mockFile, 'utf-8'));
        res.json(data);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error with access to the guide!' });
    }
};
