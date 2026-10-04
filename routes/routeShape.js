const express = require('express');
const router = express.Router();
const routeShapeController = require('../controllers/routeShapeController');

router.get('/:trainNo', routeShapeController.getRouteShape);

module.exports = router;
