const express = require('express');
const router = express.Router();
const scheduleController = require('../controllers/scheduleController');

// GET /api/schedule/:language/:from/:to/:date
router.get('/:language/:from/:to/:date', scheduleController.getSchedule);

module.exports = router;
