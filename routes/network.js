const express = require('express');
const router = express.Router();
const { createRateLimit } = require('../middleware/rateLimit');
const networkController = require('../controllers/networkController');

// Public and key-less, so it gets its own per-IP ceiling (it is mounted ahead of
// the API-wide one). A page needs a request or two a minute; this is generous.
router.use(createRateLimit({ windowMs: 60_000, max: 60, message: 'Too many requests. Slow down.' }));

router.options('/', networkController.preflight);
router.options('/radar', networkController.preflight);
router.get('/', networkController.getNetwork);
router.get('/radar', networkController.getRadar);

module.exports = router;
