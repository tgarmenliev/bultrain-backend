const express = require('express');
const router = express.Router();
const verifyAdmin = require('../middleware/verifyAdmin');
const adminController = require('../controllers/adminController');

// ── Public (no auth) ────────────────────────────────────────────────────────
router.post('/login', adminController.login);
router.post('/logout', adminController.logout);

// ── Protected (requires valid admin JWT) ────────────────────────────────────
router.get('/stats', verifyAdmin, adminController.getStats);

router.get('/guide', verifyAdmin, adminController.listTopics);
router.post('/guide', verifyAdmin, adminController.createTopic);
router.put('/guide/:id', verifyAdmin, adminController.updateTopic);
router.delete('/guide/:id', verifyAdmin, adminController.deleteTopic);

router.get('/trains', verifyAdmin, adminController.listTrains);
router.post('/trains', verifyAdmin, adminController.createTrain);
router.delete('/trains/:trainNo', verifyAdmin, adminController.deleteTrain);
router.get('/trains/:trainNo/schedule', verifyAdmin, adminController.getTrainSchedule);
router.post('/trains/:trainNo/import', verifyAdmin, adminController.importTrainSchedule);
router.delete('/validity/:validityId', verifyAdmin, adminController.deleteValidity);

module.exports = router;
