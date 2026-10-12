const express = require('express');
const router = express.Router();
const realtimeController = require('../controllers/realtimeController');
const { createRateLimit } = require('../middleware/rateLimit');

// The map refreshes this every ~15 s while open (4/min per phone). Behind a carrier's shared IP
// dozens of phones can be on the map at once, so 300/min (75 of them) rather than the API-wide
// 120. It stays a real ceiling against a scraping loop; the answer is built once per feed tick.
const vehiclesLimiter = createRateLimit({ windowMs: 60_000, max: 300, message: 'Too many requests. Slow down.' });

// Order matters: specific paths before the parameterised one.
router.get('/status', realtimeController.getStatus);
router.get('/vehicles', vehiclesLimiter, realtimeController.getVehicles);
router.get('/vehicle/:trainNo', realtimeController.getVehicle);
router.get('/train/:trainNo', realtimeController.getTrain);

module.exports = router;
