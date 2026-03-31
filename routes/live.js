const express = require('express');
const router = express.Router();
const liveController = require('../controllers/liveController');

// GET /api/live/:language/:stationNumber/:type
router.get('/:language/:stationNumber/:type', liveController.getLiveBoard);

module.exports = router;
