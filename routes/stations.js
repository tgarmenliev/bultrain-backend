const express = require('express');
const router = express.Router();
const stationsController = require('../controllers/stationsController');

// GET /api/stations/version  — cheap version check (define before '/')
router.get('/version', stationsController.getStationsVersion);

// GET /api/stations          — full list + version (supports If-None-Match)
router.get('/', stationsController.getStations);

module.exports = router;
