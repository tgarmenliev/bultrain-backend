const express = require('express');
const router = express.Router();
const trainInfoController = require('../controllers/trainInfoController');

// GET /api/train-info/:language/:trainNo       (no date)
// GET /api/train-info/:language/:trainNo/:date  (with date)
router.get('/:language/:trainNo', trainInfoController.getTrainInfo);
router.get('/:language/:trainNo/:date', trainInfoController.getTrainInfo);

module.exports = router;
