const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const path = require('path');

// ── Database ────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, '..', 'bultrain.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Prepared statements ─────────────────────────────────────────────────────

// Stats
const stmtTrainCount = db.prepare('SELECT COUNT(*) AS c FROM trains');
const stmtStationCount = db.prepare('SELECT COUNT(*) AS c FROM stations');
const stmtTopicCount = db.prepare('SELECT COUNT(*) AS c FROM handbook_topics');

// Guide CRUD
const stmtAllTopics = db.prepare(`
    SELECT id, app_topic_id, language, title, subtitle, cover_image, sort_order
    FROM handbook_topics
    ORDER BY sort_order ASC, language ASC
`);

const stmtInsertTopic = db.prepare(`
    INSERT INTO handbook_topics (app_topic_id, language, title, subtitle, cover_image, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
`);

const stmtUpdateTopic = db.prepare(`
    UPDATE handbook_topics SET title = ?, subtitle = ? WHERE id = ?
`);

const stmtDeleteTopic = db.prepare(`
    DELETE FROM handbook_topics WHERE id = ?
`);

// Train listing & deletion
const stmtAllTrains = db.prepare(`
    SELECT train_number, category FROM trains ORDER BY train_number ASC
`);

const stmtDeleteTrain = db.prepare(`
    DELETE FROM trains WHERE train_number = ?
`);

const stmtInsertTrain = db.prepare(`
    INSERT INTO trains (train_number, category) VALUES (?, ?)
`);

// Train Schedule Viewing & Updating
const stmtGetValidities = db.prepare(`
    SELECT validity_id, description, runs_monday, runs_tuesday, runs_wednesday, runs_thursday, runs_friday, runs_saturday, runs_sunday
    FROM train_validity
    WHERE train_number = ?
`);

const stmtGetStopsByValidity = db.prepare(`
    SELECT s.arrival_time, s.departure_time, s.stop_sequence, st.name as station_name
    FROM schedules s
    JOIN stations st ON s.station_id = st.id
    WHERE s.validity_id = ?
    ORDER BY s.stop_sequence ASC
`);

const stmtDeleteValidity = db.prepare(`
    DELETE FROM train_validity WHERE train_number = ?
`);

const stmtDeleteValidityById = db.prepare(`
    DELETE FROM train_validity WHERE validity_id = ?
`);

// Note: If ON DELETE CASCADE is set on schedules.validity_id, this isn't strictly needed,
// but we do it explicitly just in case.
const stmtDeleteSchedules = db.prepare(`
    DELETE FROM schedules WHERE validity_id IN (SELECT validity_id FROM train_validity WHERE train_number = ?)
`);

const stmtInsertValidity = db.prepare(`
  INSERT INTO train_validity (train_number, runs_monday, runs_tuesday, runs_wednesday, runs_thursday, runs_friday, runs_saturday, runs_sunday, description)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtInsertSchedule = db.prepare(`
  INSERT INTO schedules (validity_id, station_id, arrival_time, departure_time, stop_sequence)
  VALUES (?, ?, ?, ?, ?)
`);

// Normalized station lookup helper
function normalizeStationName(name) {
    let n = name.toLowerCase().trim();
    n = n.replace(/\s{2,}/g, ' ');
    // Standardize all variations of "stop" suffix → " - спирка"
    n = n.replace(/\s*-\s*сп\.\s*$/, ' - спирка');
    n = n.replace(/\s+сп\.\s*$/, ' - спирка');
    n = n.replace(/\s*-\s*спирка\s*$/, ' - спирка');
    return n;
}

// ── Login ───────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/login
 * Body: { "password": "..." }
 */
exports.login = (req, res) => {
    try {
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({ error: 'Password is required.' });
        }

        if (password !== process.env.ADMIN_PASSWORD) {
            return res.status(401).json({ error: 'Invalid password.' });
        }

        const token = jwt.sign(
            { role: 'admin', iat: Math.floor(Date.now() / 1000) },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.cookie('admin_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 8 * 60 * 60 * 1000, // 8 hours
        });

        res.json({ message: 'Login successful.' });
    } catch (error) {
        console.error('adminController login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * POST /api/admin/logout
 */
exports.logout = (req, res) => {
    res.clearCookie('admin_token');
    res.json({ message: 'Logged out.' });
};

// ── Stats ───────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/stats
 */
exports.getStats = (req, res) => {
    try {
        const trains = stmtTrainCount.get().c;
        const stations = stmtStationCount.get().c;
        const guideTopics = stmtTopicCount.get().c;

        res.json({ trains, stations, guideTopics });
    } catch (error) {
        console.error('adminController stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// ── Guide CRUD ──────────────────────────────────────────────────────────────

/**
 * GET /api/admin/guide
 */
exports.listTopics = (req, res) => {
    try {
        const topics = stmtAllTopics.all();
        res.json(topics);
    } catch (error) {
        console.error('adminController listTopics error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * POST /api/admin/guide
 * Body: { app_topic_id, language, title, subtitle?, cover_image? }
 */
exports.createTopic = (req, res) => {
    try {
        const { app_topic_id, language, title, subtitle, cover_image } = req.body;

        if (app_topic_id === undefined || !language || !title) {
            return res.status(400).json({ error: 'app_topic_id, language, and title are required.' });
        }

        if (language !== 'bg' && language !== 'en') {
            return res.status(400).json({ error: 'Language must be bg or en.' });
        }

        const info = stmtInsertTopic.run(
            app_topic_id,
            language,
            title,
            subtitle || null,
            cover_image || null,
            app_topic_id // sort_order defaults to app_topic_id
        );

        res.status(201).json({
            message: 'Topic created.',
            id: Number(info.lastInsertRowid),
        });
    } catch (error) {
        console.error('adminController createTopic error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * PUT /api/admin/guide/:id
 * Body: { title?, subtitle? }
 */
exports.updateTopic = (req, res) => {
    try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json({ error: 'Invalid topic ID.' });
        }

        const { title, subtitle } = req.body;
        if (!title && subtitle === undefined) {
            return res.status(400).json({ error: 'Provide at least title or subtitle.' });
        }

        // Fetch current values to allow partial updates
        const existing = db.prepare('SELECT title, subtitle FROM handbook_topics WHERE id = ?').get(id);
        if (!existing) {
            return res.status(404).json({ error: 'Topic not found.' });
        }

        stmtUpdateTopic.run(
            title || existing.title,
            subtitle !== undefined ? subtitle : existing.subtitle,
            id
        );

        res.json({ message: 'Topic updated.' });
    } catch (error) {
        console.error('adminController updateTopic error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * DELETE /api/admin/guide/:id
 */
exports.deleteTopic = (req, res) => {
    try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json({ error: 'Invalid topic ID.' });
        }

        const info = stmtDeleteTopic.run(id);
        if (info.changes === 0) {
            return res.status(404).json({ error: 'Topic not found.' });
        }

        res.json({ message: 'Topic deleted.' });
    } catch (error) {
        console.error('adminController deleteTopic error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// ── Train CRUD ──────────────────────────────────────────────────────────────

/**
 * GET /api/admin/trains
 */
exports.listTrains = (req, res) => {
    try {
        const trains = stmtAllTrains.all();
        res.json(trains);
    } catch (error) {
        console.error('adminController listTrains error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * POST /api/admin/trains
 * Body: { train_number, category }
 */
exports.createTrain = (req, res) => {
    try {
        const { train_number, category } = req.body;
        if (!train_number || !category) {
            return res.status(400).json({ error: 'Train number and category are required.' });
        }

        const existing = db.prepare('SELECT train_number FROM trains WHERE train_number = ?').get(train_number);
        if (existing) {
            return res.status(409).json({ error: 'Train with this number already exists.' });
        }

        stmtInsertTrain.run(train_number, category);
        res.status(201).json({ message: `Train ${train_number} created successfully.` });
    } catch (error) {
        console.error('adminController createTrain error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * DELETE /api/admin/trains/:trainNo
 */
exports.deleteTrain = (req, res) => {
    try {
        const trainNo = req.params.trainNo;
        if (!trainNo) {
            return res.status(400).json({ error: 'Train number is required.' });
        }

        const info = stmtDeleteTrain.run(trainNo);
        if (info.changes === 0) {
            return res.status(404).json({ error: 'Train not found.' });
        }

        res.json({ message: `Train ${trainNo} deleted (cascaded validity & schedules).` });
    } catch (error) {
        console.error('adminController deleteTrain error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * GET /api/admin/trains/:trainNo/schedule
 * Returns an array of validities, each containing its stops
 */
exports.getTrainSchedule = (req, res) => {
    try {
        const trainNo = req.params.trainNo;
        if (!trainNo) return res.status(400).json({ error: 'Train number is required.' });

        const validities = stmtGetValidities.all(trainNo);
        const result = validities.map(val => {
            const stops = stmtGetStopsByValidity.all(val.validity_id);
            return {
                validity_id: val.validity_id,
                description: val.description,
                days: {
                    monday: val.runs_monday, tuesday: val.runs_tuesday, wednesday: val.runs_wednesday,
                    thursday: val.runs_thursday, friday: val.runs_friday, saturday: val.runs_saturday, sunday: val.runs_sunday
                },
                schedule: stops
            };
        });

        res.json(result);
    } catch (error) {
        console.error('adminController getTrainSchedule error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * POST /api/admin/trains/:trainNo/import
 * Body: { schedule: [ ... ], days: { monday: true, ... } }
 */
exports.importTrainSchedule = (req, res) => {
    try {
        const trainNo = req.params.trainNo;
        const { schedule: stations, days } = req.body;

        if (!trainNo) return res.status(400).json({ error: 'Train number is required.' });
        if (!stations || !Array.isArray(stations) || stations.length === 0) {
            return res.status(400).json({ error: 'Invalid JSON payload. Must contain a schedule array.' });
        }

        // Default days if not provided
        const reqDays = days || {
            monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true
        };

        // Build a station map for lookups
        const allStations = db.prepare('SELECT id, name FROM stations').all();
        const stationMap = new Map();
        for (const s of allStations) {
            stationMap.set(normalizeStationName(s.name), s.id);
        }

        // Resolve stops
        const stopsToInsert = [];
        for (const stop of stations) {
            const normalizedName = normalizeStationName(stop.station || stop.station_name);
            const stationId = stationMap.get(normalizedName);

            if (stationId === undefined) {
                return res.status(400).json({
                    error: `Unmapped station: ORIGINAL: "${stop.station || stop.station_name}" | NORMALIZED: "${normalizedName}"`
                });
            }

            stopsToInsert.push({
                stationId,
                arrive: stop.arrive || stop.arrival_time === '↦' ? null : (stop.arrive || stop.arrival_time),
                depart: stop.depart || stop.departure_time === '↤' ? null : (stop.depart || stop.departure_time),
            });
        }

        // Transaction to add new schedule variation
        const insertNewValidity = db.transaction((tNo, stops, d) => {
            // Insert single validity
            const validityInfo = stmtInsertValidity.run(
                tNo,
                d.monday ? 1 : 0, d.tuesday ? 1 : 0, d.wednesday ? 1 : 0,
                d.thursday ? 1 : 0, d.friday ? 1 : 0, d.saturday ? 1 : 0, d.sunday ? 1 : 0,
                'Въведено ръчно' // description
            );
            const validityId = validityInfo.lastInsertRowid;

            // Insert new schedules
            for (let i = 0; i < stops.length; i++) {
                stmtInsertSchedule.run(
                    validityId,
                    stops[i].stationId,
                    stops[i].arrive,
                    stops[i].depart,
                    i + 1
                );
            }
        });

        insertNewValidity(trainNo, stopsToInsert, reqDays);

        res.json({ message: `Успешно добавен нов график за влак ${trainNo}.` });
    } catch (error) {
        console.error('adminController importTrainSchedule error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * DELETE /api/admin/validity/:validityId
 * Deletes a specific schedule variation. Cascades to schedules gracefully.
 */
exports.deleteValidity = (req, res) => {
    try {
        const id = req.params.validityId;
        if (!id) return res.status(400).json({ error: 'Validity ID required.' });

        const deleteTransaction = db.transaction((valId) => {
            // Manually delete attached schedules first if no cascading constraints
            db.prepare('DELETE FROM schedules WHERE validity_id = ?').run(valId);
            stmtDeleteValidityById.run(valId);
        });

        deleteTransaction(id);
        res.json({ message: `Изтрит график с ID ${id}.` });
    } catch (e) {
        console.error('deleteValidity error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
};
