/**
 * GET /api/translator/:name
 * Returns a hard-coded station code (mock).
 * The old endpoint looked up stations.json — this mock returns a fixed value.
 */
exports.translateStation = (req, res) => {
    const { name } = req.params;

    if (!name || name.trim().length === 0) {
        return res.status(404).json({ error: 'Station not found!' });
    }

    // Mock: return a static station code
    // The old API returned a raw JSON number (e.g., "52")
    res.json("52");
};
