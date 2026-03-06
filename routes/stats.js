const express = require('express');
const router = express.Router();
const statsController = require('../controllers/statsController');

// GET /api/stats/:language/:line/:stationNumber
router.get('/:language/:line/:stationNumber', statsController.getStats);

module.exports = router;
