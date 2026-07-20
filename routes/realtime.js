const express = require('express');
const router = express.Router();
const realtimeController = require('../controllers/realtimeController');

// Order matters: specific paths before the parameterised one.
router.get('/status', realtimeController.getStatus);
router.get('/vehicles', realtimeController.getVehicles);
router.get('/vehicle/:trainNo', realtimeController.getVehicle);
router.get('/train/:trainNo', realtimeController.getTrain);

module.exports = router;
