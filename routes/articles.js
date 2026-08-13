const express = require('express');
const router = express.Router();

const controller = require('../controllers/appArticlesController');

// App-facing, read-only. Published articles, plus draft preview via a signed
// ?preview= token. Mounted behind verifyMobileClient in server.js.
router.get('/', controller.list);
router.get('/:id', controller.getOne);

module.exports = router;
