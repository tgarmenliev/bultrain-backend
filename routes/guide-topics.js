const express = require('express');
const router = express.Router();
const guideTopicsController = require('../controllers/guideTopicsController');

// GET /api/guide/:language
router.get('/:language', guideTopicsController.getAllTopics);

module.exports = router;
