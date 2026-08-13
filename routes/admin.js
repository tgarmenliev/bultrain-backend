const express = require('express');
const path = require('path');
const router = express.Router();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const verifyAdmin = require('../middleware/verifyAdmin');
const verifyRole = require('../middleware/verifyRole');
const adminController = require('../controllers/adminController');
const mediaController = require('../controllers/mediaController');
const articlesController = require('../controllers/articlesController');

// ── Image uploads for the article/guide editor ──────────────────────────────
// Server-generated filename from the MIME type (no client-controlled path or
// extension); saved into guide/images/ (already served at /guide/images/).
mediaController.ensureDir();
const mediaUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, mediaController.MEDIA_DIR),
        filename:    (req, file, cb) => {
            const name = mediaController.makeFilename(file.mimetype);
            cb(name ? null : new Error('Unsupported image type. Use JPEG, PNG or WebP.'), name);
        },
    }),
    limits: { fileSize: mediaController.MAX_BYTES },
    fileFilter: (req, file, cb) => cb(null, !!mediaController.extForMime(file.mimetype)),
}).single('file');

// ── Public (no auth) ────────────────────────────────────────────────────────
router.post('/login', adminController.login);
router.post('/logout', adminController.logout);

// ── Media (admin OR author) ─────────────────────────────────────────────────
router.post('/media', verifyRole('admin', 'author'), (req, res) => {
    mediaUpload(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE'
                ? 'Image is too large (max 6 MB).'
                : err.message || 'Upload failed.';
            return res.status(400).json({ error: msg });
        }
        mediaController.uploadMedia(req, res);
    });
});

// ── Articles (admin OR author) ──────────────────────────────────────────────
const authorOrAdmin = verifyRole('admin', 'author');
router.get('/articles',              authorOrAdmin, articlesController.list);
router.get('/articles/:id',          authorOrAdmin, articlesController.getOne);
router.post('/articles',             authorOrAdmin, articlesController.create);
router.put('/articles/:id',          authorOrAdmin, articlesController.update);
router.post('/articles/:id/publish', authorOrAdmin, articlesController.publish);
router.post('/articles/:id/preview-token', authorOrAdmin, articlesController.previewToken);
router.post('/articles/:id/unpublish', authorOrAdmin, articlesController.unpublish);
router.delete('/articles/:id',       authorOrAdmin, articlesController.remove);

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
router.post('/import-all', verifyAdmin, adminController.bulkImportSchedules);
router.post('/upload-all', verifyAdmin, upload.fields([{ name: 'file', maxCount: 1 }, { name: 'failedTrains', maxCount: 1 }]), adminController.uploadAndImportSchedules);
router.delete('/validity/:validityId', verifyAdmin, adminController.deleteValidity);

// ── Schedule Exceptions (holiday / date overrides) ───────────────────────────
router.get('/exceptions',        verifyAdmin, adminController.listExceptions);
router.post('/exceptions',       verifyAdmin, adminController.createException);
router.put('/exceptions/:date',  verifyAdmin, adminController.updateException);
router.delete('/exceptions/:date', verifyAdmin, adminController.deleteException);

module.exports = router;
