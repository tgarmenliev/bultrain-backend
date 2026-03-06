const express = require('express');
const router = express.Router();
const scheduleSecController = require('../controllers/scheduleSecController');

// GET /api/schedule/:language/:from/:to  (current date, no date param)
router.get('/:language/:from/:to', scheduleSecController.getScheduleCurrentDate);

module.exports = router;
