const express = require('express');
const router = express.Router();
const guideController = require('../controllers/guideController');

// GET /api/guide/:language/:topic
router.get('/:language/:topic', guideController.getGuideTopic);

module.exports = router;
