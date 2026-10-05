const express = require('express');
const router = express.Router();
const routeShapesController = require('../controllers/routeShapesController');

// Order matters: the specific path before the bare one.
router.get('/version', routeShapesController.getVersion);
router.get('/', routeShapesController.getBundle);

module.exports = router;
