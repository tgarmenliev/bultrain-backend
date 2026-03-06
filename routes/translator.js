const express = require('express');
const router = express.Router();
const translatorController = require('../controllers/translatorController');

// GET /api/translator/:name
router.get('/:name', translatorController.translateStation);

module.exports = router;
