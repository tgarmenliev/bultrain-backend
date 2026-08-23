const express = require('express');
const router = express.Router();

const controller = require('../controllers/liveActivityController');
const armed = require('../controllers/armedJourneyController');
const sim = require('../controllers/journeySimController');
const { createRateLimit } = require('../middleware/rateLimit');

// Registration is the only endpoint a device can call repeatedly, so it is the
// one worth a ceiling. 20/min is far above the app's real pattern (a handful
// per journey, plus one per token rotation).
const registerLimit = createRateLimit({
    windowMs: 60_000,
    max: 20,
    message: 'Too many Live Activity registrations. Try again shortly.',
});

router.post('/register', registerLimit, controller.register);
router.post('/unregister', controller.unregister);
router.post('/test-push', controller.testPush);   // 404s unless the flag is on
router.get('/metrics', controller.getMetrics);

// ── Server-driven tracking (push-to-start, delay alerts, auto-stop) ─────────
// Same rate ceiling as registration: the app calls these once per launch and
// once per journey, so 20/min leaves enormous headroom over real use.
router.post('/register-device', registerLimit, armed.registerDevice);
router.post('/arm', registerLimit, armed.arm);
router.post('/disarm', armed.disarm);
router.post('/leg-arrived', armed.legArrived);

// ── Journey simulation (only when ENABLE_JOURNEY_SIM=on) ────────────────────
// See services/liveactivity/testFeed.js — reserved TEST-prefixed train
// numbers only, entirely separate from the real GTFS-RT cache, so this can
// never affect what a real user sees. 404s unless the flag is set.
router.get('/sim/train', sim.listTrains);
router.post('/sim/train', registerLimit, sim.setTrain);
router.delete('/sim/train/:trainNumber', sim.clearTrain);

module.exports = router;
