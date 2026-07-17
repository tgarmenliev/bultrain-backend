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
    INSERT OR IGNORE INTO trains (train_number, category) VALUES (?, ?)
`);

// Train Schedule Viewing & Updating
const stmtGetValidities = db.prepare(`
    SELECT validity_id, description, runs_monday, runs_tuesday, runs_wednesday, runs_thursday, runs_friday, runs_saturday, runs_sunday,
           valid_from, valid_to
    FROM train_validity
    WHERE train_number = ?
`);

const stmtGetStopsByValidity = db.prepare(`
    SELECT s.arrival_time, s.departure_time, s.stop_sequence, st.name as station_name, s.station_id
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
  INSERT INTO train_validity
    (train_number, runs_monday, runs_tuesday, runs_wednesday, runs_thursday, runs_friday, runs_saturday, runs_sunday, description, valid_from, valid_to)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
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

const TYPE_TO_ABBR = {
    'пътнически влак': 'ПВ',
    'бърз влак': 'БВ',
    'крайградски пътнически влак': 'КПВ',
    'международен бърз влак': 'МБВ',
    'бърз влак със задължителна резервация': 'БВЗР',
    'експресен влак': 'ЕВ',
    'АВТ': 'АВТ',
};

function abbreviateType(fullType) {
    if (!fullType) return 'ПВ';
    const lower = fullType.toLowerCase().trim();
    return TYPE_TO_ABBR[lower] || fullType;
}

function stationsAreIdentical(stationsA, stationsB) {
    if (!stationsA || !stationsB) return false;
    if (stationsA.length !== stationsB.length) return false;
    for (let i = 0; i < stationsA.length; i++) {
        const a = stationsA[i];
        const b = stationsB[i];
        if (
            normalizeStationName(a.station) !== normalizeStationName(b.station) ||
            a.arrive !== b.arrive ||
            a.depart !== b.depart
        ) {
            return false;
        }
    }
    return true;
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
        const result = validities.map(val => ({
            validity_id: val.validity_id,
            description: val.description,
            valid_from:  val.valid_from  || null,
            valid_to:    val.valid_to    || null,
            days: {
                monday: val.runs_monday, tuesday: val.runs_tuesday, wednesday: val.runs_wednesday,
                thursday: val.runs_thursday, friday: val.runs_friday, saturday: val.runs_saturday, sunday: val.runs_sunday
            },
            schedule: stmtGetStopsByValidity.all(val.validity_id)
        }));

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
        const { schedule: stations, days, valid_from, valid_to } = req.body;

        if (!trainNo) return res.status(400).json({ error: 'Train number is required.' });
        if (!stations || !Array.isArray(stations) || stations.length === 0) {
            return res.status(400).json({ error: 'Invalid JSON payload. Must contain a schedule array.' });
        }

        // Validate optional date range fields
        const dateRx = /^\d{4}-\d{2}-\d{2}$/;
        const validFrom = (valid_from && dateRx.test(valid_from)) ? valid_from : null;
        const validTo   = (valid_to   && dateRx.test(valid_to))   ? valid_to   : null;
        if ((validFrom && !validTo) || (!validFrom && validTo)) {
            return res.status(400).json({ error: 'Both valid_from and valid_to must be provided together.' });
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
                arrive: stop.arrive || stop.arrival_time || null,
                depart: stop.depart || stop.departure_time || null,
            });
        }

        const stmtInsertValidityWith = db.prepare(`
            INSERT INTO train_validity
                (train_number, runs_monday, runs_tuesday, runs_wednesday, runs_thursday, runs_friday, runs_saturday, runs_sunday, description, valid_from, valid_to)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertNewValidity = db.transaction((tNo, stops, d) => {
            const validityInfo = stmtInsertValidityWith.run(
                tNo,
                d.monday ? 1 : 0, d.tuesday ? 1 : 0, d.wednesday ? 1 : 0,
                d.thursday ? 1 : 0, d.friday ? 1 : 0, d.saturday ? 1 : 0, d.sunday ? 1 : 0,
                'Въведено ръчно',
                validFrom,
                validTo
            );
            const validityId = validityInfo.lastInsertRowid;
            for (let i = 0; i < stops.length; i++) {
                stmtInsertSchedule.run(validityId, stops[i].stationId, stops[i].arrive, stops[i].depart, i + 1);
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

/**
 * Internal logic for bulk importing from the filesystem.
 * Returns a summary object.
 */
function internalBulkImportLogic(db, stationMap, RAW_DIR, TRAIN_NUMBERS_PATH) {
    const fs = require('fs');
    if (!fs.existsSync(TRAIN_NUMBERS_PATH)) {
        throw new Error('Train numbers file not found.');
    }

    const trainNumbers = JSON.parse(fs.readFileSync(TRAIN_NUMBERS_PATH, 'utf-8'));
    let successCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let updatedCount = 0;
    const errorDetails = [];

    // Internal helper to resolve stops
    function resolveStops(data, trainNumber) {
        const stops = [];
        for (const stop of data.stations) {
            const normalizedName = normalizeStationName(stop.station);
            const stationId = stationMap.get(normalizedName);

            if (stationId === undefined) {
                const msg = `Влак ${trainNumber}: Непозната гара "${stop.station}"`;
                if (!errorDetails.includes(msg)) errorDetails.push(msg);
                throw new Error(msg);
            }

            stops.push({
                stationId,
                arrive: stop.arrive === '↦' ? null : stop.arrive,
                depart: stop.depart === '↤' ? null : stop.depart,
            });
        }
        return stops;
    }

    // Comparison helper for Smart Sync
    function schedulesMatch(existing, incoming) {
        if (existing.length !== incoming.length) return false;
        for (let i = 0; i < existing.length; i++) {
            const e = existing[i];
            const inc = incoming[i];
            if (e.days.monday !== inc.days.mon || e.days.tuesday !== inc.days.tue ||
                e.days.wednesday !== inc.days.wed || e.days.thursday !== inc.days.thu ||
                e.days.friday !== inc.days.fri || e.days.saturday !== inc.days.sat ||
                e.days.sunday !== inc.days.sun) return false;
            if (e.schedule.length !== inc.stops.length) return false;
            for (let j = 0; j < e.schedule.length; j++) {
                const eStop = e.schedule[j];
                const incStop = inc.stops[j];
                if (eStop.station_id !== incStop.stationId ||
                    (eStop.arrival_time || null) !== (incStop.arrive || null) ||
                    (eStop.departure_time || null) !== (incStop.depart || null)) return false;
            }
        }
        return true;
    }

    // Transaction for a single train sync
    const syncTrainTransaction = db.transaction((trainNumber, category, validityRecords, deleteOld) => {
        const trainExists = db.prepare('SELECT category FROM trains WHERE train_number = ?').get(trainNumber);
        if (!trainExists) {
            db.prepare('INSERT INTO trains (train_number, category) VALUES (?, ?)').run(trainNumber, category);
        } else if (trainExists.category !== category) {
            db.prepare('UPDATE trains SET category = ? WHERE train_number = ?').run(category, trainNumber);
        }

        if (deleteOld) {
            db.prepare('DELETE FROM schedules WHERE validity_id IN (SELECT validity_id FROM train_validity WHERE train_number = ?)').run(trainNumber);
            db.prepare('DELETE FROM train_validity WHERE train_number = ?').run(trainNumber);
        }

        for (const record of validityRecords) {
            const { days, description, stops } = record;
            const info = stmtInsertValidity.run(
                trainNumber,
                days.mon, days.tue, days.wed, days.thu, days.fri, days.sat, days.sun,
                description
            );
            const validityId = info.lastInsertRowid;
            for (let i = 0; i < stops.length; i++) {
                const stop = stops[i];
                stmtInsertSchedule.run(validityId, stop.stationId, stop.arrive, stop.depart, i + 1);
            }
        }
    });

    for (const num of trainNumbers) {
        const trainNumber = String(num);
        try {
            const tuePath = path.join(RAW_DIR, `${trainNumber}_tue.json`);
            const satPath = path.join(RAW_DIR, `${trainNumber}_sat.json`);
            const tueExists = fs.existsSync(tuePath);
            const satExists = fs.existsSync(satPath);
            if (!tueExists && !satExists) continue;

            let tueData = null;
            let satData = null;
            if (tueExists) {
                tueData = JSON.parse(fs.readFileSync(tuePath, 'utf-8'));
                if (!tueData.stations || tueData.stations.length === 0) tueData = null;
            }
            if (satExists) {
                satData = JSON.parse(fs.readFileSync(satPath, 'utf-8'));
                if (!satData.stations || satData.stations.length === 0) satData = null;
            }
            if (!tueData && !satData) continue;

            const refData = tueData || satData;
            const category = abbreviateType(refData.trainType);
            const validityRecords = [];
            if (tueData && satData) {
                const tueStops = resolveStops(tueData, trainNumber);
                const satStops = resolveStops(satData, trainNumber);
                if (stationsAreIdentical(tueData.stations, satData.stations)) {
                    validityRecords.push({ days: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1 }, description: 'Всички дни', stops: tueStops });
                } else {
                    validityRecords.push({ days: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0 }, description: 'Делник', stops: tueStops });
                    validityRecords.push({ days: { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 1, sun: 1 }, description: 'Уикенд', stops: satStops });
                }
            } else if (tueData) {
                validityRecords.push({ days: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0 }, description: 'Само делник', stops: resolveStops(tueData, trainNumber) });
            } else {
                validityRecords.push({ days: { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 1, sun: 1 }, description: 'Само уикенд', stops: resolveStops(satData, trainNumber) });
            }

            const existingValRows = stmtGetValidities.all(trainNumber);
            const existingFullRecords = existingValRows.map(val => ({
                validity_id: val.validity_id,
                description: val.description,
                days: {
                    monday: val.runs_monday, tuesday: val.runs_tuesday, wednesday: val.runs_wednesday,
                    thursday: val.runs_thursday, friday: val.runs_friday, saturday: val.runs_saturday, sunday: val.runs_sunday
                },
                schedule: stmtGetStopsByValidity.all(val.validity_id)
            }));

            const trainRow = db.prepare('SELECT category FROM trains WHERE train_number = ?').get(trainNumber);
            const categoryMismatch = trainRow && trainRow.category !== category;
            const scheduleMismatch = !schedulesMatch(existingFullRecords, validityRecords);

            if (!trainRow || categoryMismatch || scheduleMismatch) {
                syncTrainTransaction(trainNumber, category, validityRecords, !!trainRow);
                if (trainRow) updatedCount++; else successCount++;
            } else {
                skippedCount++;
            }
        } catch (err) {
            console.warn(`[Bulk Import] Error for train ${trainNumber}: ${err.message}`);
            errorCount++;
        }
    }

    return {
        added: successCount,
        updated: updatedCount,
        skipped: skippedCount,
        errors: errorCount,
        errorDetails: errorDetails.slice(0, 500), // Limit to avoid massive responses
        total: trainNumbers.length
    };
}

/**
 * POST /api/admin/import-all
 * Triggers a bulk import from stations_trains/raw_bdz_data/
 */
exports.bulkImportSchedules = (req, res) => {
    const RAW_DIR = path.join(__dirname, '..', 'stations_trains', 'raw_bdz_data');
    const TRAIN_NUMBERS_PATH = path.join(__dirname, '..', 'stations_trains', 'train_numbers.json');

    try {
        // Build a station map for lookups
        const allStations = db.prepare('SELECT id, name FROM stations').all();
        const stationMap = new Map();
        for (const s of allStations) {
            stationMap.set(normalizeStationName(s.name), s.id);
        }

        const summary = internalBulkImportLogic(db, stationMap, RAW_DIR, TRAIN_NUMBERS_PATH);

        res.json({
            message: 'Bulk import Smart Sync completed.',
            ...summary
        });
    } catch (error) {
        console.error('adminController bulkImportSchedules error:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
};

/**
 * POST /api/admin/upload-all
 * Receives a ZIP, extracts it to raw_bdz_data, and runs import.
 */
exports.uploadAndImportSchedules = (req, res) => {
    const fs = require('fs');
    const AdmZip = require('adm-zip');

    const RAW_DIR = path.join(__dirname, '..', 'stations_trains', 'raw_bdz_data');
    const TRAIN_NUMBERS_PATH = path.join(__dirname, '..', 'stations_trains', 'train_numbers.json');

    try {
        const file = req.files && req.files.file ? req.files.file[0] : (req.file ? req.file : null);
        if (!file) {
            return res.status(400).json({ error: 'No ZIP file uploaded.' });
        }

        const zip = new AdmZip(file.buffer);
        const zipEntries = zip.getEntries();

        // ── Step 1: Clear the RAW_DIR ───────────────────────────────────────────
        if (fs.existsSync(RAW_DIR)) {
            const files = fs.readdirSync(RAW_DIR);
            for (const f of files) {
                fs.unlinkSync(path.join(RAW_DIR, f));
            }
        } else {
            fs.mkdirSync(RAW_DIR, { recursive: true });
        }

        // ── Step 2: Extract JSON files ──────────────────────────────────────────
        let extractionCount = 0;
        zipEntries.forEach(entry => {
            if (entry.entryName.endsWith('.json') && !entry.isDirectory) {
                const fileName = path.basename(entry.entryName);
                fs.writeFileSync(path.join(RAW_DIR, fileName), entry.getData());
                extractionCount++;
            }
        });

        if (extractionCount === 0) {
            return res.status(400).json({ error: 'No JSON files found in ZIP.' });
        }

        // ── Parse failed trains file ────────────────────────────────────────────
        let failedTrains = [];
        const failedTrainsFile = req.files && req.files.failedTrains ? req.files.failedTrains[0] : null;
        if (failedTrainsFile) {
            const content = failedTrainsFile.buffer.toString('utf-8');
            try {
                failedTrains = JSON.parse(content);
                if (!Array.isArray(failedTrains)) {
                    failedTrains = [];
                }
            } catch (e) {
                console.warn('Could not parse failedTrains JSON');
            }
        }

        // ── Step 3: Run the DB Sync Transaction ─────────────────────────────────
        const allStations = db.prepare('SELECT id, name FROM stations').all();
        const stationMap = new Map();
        for (const s of allStations) {
            stationMap.set(normalizeStationName(s.name), s.id);
        }

        let schedulesUpdated = 0;
        let schedulesDeletedCount = 0;
        let trainsDeletedCount = 0;
        let deletedTrainNumbersList = [];

        // Prepare statements outside any loops for performance inside transaction
        const stmtGetValiditiesForTrain = db.prepare('SELECT validity_id, runs_monday, runs_saturday FROM train_validity WHERE train_number = ?');
        const stmtDeleteSchedulesById = db.prepare('DELETE FROM schedules WHERE validity_id = ?');
        const stmtDeleteValidityById = db.prepare('DELETE FROM train_validity WHERE validity_id = ?');
        const stmtGetTrainsWithNoSchedules = db.prepare('SELECT train_number FROM trains WHERE train_number NOT IN (SELECT DISTINCT train_number FROM train_validity)');
        const stmtDeleteTrainsWithNoSchedules = db.prepare('DELETE FROM trains WHERE train_number NOT IN (SELECT DISTINCT train_number FROM train_validity)');

        const dbProcess = db.transaction(() => {
            // Step A: Import schedules
            const summary = internalBulkImportLogic(db, stationMap, RAW_DIR, TRAIN_NUMBERS_PATH);
            schedulesUpdated = summary.added + summary.updated;

            // Step B: Delete existing schedules for failed trains based on targeted day type
            for (const item of failedTrains) {
                if (!item || !item.trainNumber || !item.date) continue;
                
                const tNo = String(item.trainNumber).trim();
                const dateParts = String(item.date).trim().split('.');
                
                let dayType = 'weekday';
                if (dateParts.length === 3) {
                    const year = parseInt(dateParts[2], 10);
                    const month = parseInt(dateParts[1], 10) - 1;
                    const day = parseInt(dateParts[0], 10);
                    const d = new Date(year, month, day);
                    const dayOfWeek = d.getDay(); // 0 is Sunday, 6 is Saturday
                    if (dayOfWeek === 0 || dayOfWeek === 6) {
                        dayType = 'weekend';
                    }
                }

                const validities = stmtGetValiditiesForTrain.all(tNo);
                for (const v of validities) {
                    let shouldDelete = false;
                    // For weekday fail, delete weekday matching schedule
                    if (dayType === 'weekday' && v.runs_monday === 1) {
                        shouldDelete = true;
                    }
                    // For weekend fail, delete weekend matching schedule
                    if (dayType === 'weekend' && v.runs_saturday === 1) {
                        shouldDelete = true;
                    }

                    if (shouldDelete) {
                        const res1 = stmtDeleteSchedulesById.run(v.validity_id);
                        const res2 = stmtDeleteValidityById.run(v.validity_id);
                        if (res1.changes > 0 || res2.changes > 0) {
                            schedulesDeletedCount++;
                        }
                    }
                }
            }

            // Step C: Cleanup zero-schedule trains
            const trainsToDeleteRows = stmtGetTrainsWithNoSchedules.all();
            deletedTrainNumbersList = trainsToDeleteRows.map(t => t.train_number);
            
            if (deletedTrainNumbersList.length > 0) {
                const cleanupRes = stmtDeleteTrainsWithNoSchedules.run();
                trainsDeletedCount = cleanupRes.changes;
            }
        });

        dbProcess();

        res.json({
            schedulesUpdated,
            schedulesDeleted: schedulesDeletedCount,
            trainsDeleted: trainsDeletedCount,
            deletedTrainNumbers: deletedTrainNumbersList
        });

    } catch (error) {
        console.error('adminController uploadAndImportSchedules error:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
};

// ── Schedule Exceptions (Holiday / Override) CRUD ────────────────────────────

// Valid day-type values (map directly to column suffixes in train_validity)
const VALID_OVERRIDE_TYPES = new Set([
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

const stmtAllExceptions = db.prepare(
    'SELECT exception_date, schedule_type_override FROM schedule_exceptions ORDER BY exception_date ASC'
);
const stmtInsertException = db.prepare(
    'INSERT INTO schedule_exceptions (exception_date, schedule_type_override) VALUES (?, ?)'
);
const stmtUpdateException = db.prepare(
    'UPDATE schedule_exceptions SET schedule_type_override = ? WHERE exception_date = ?'
);
const stmtDeleteException = db.prepare(
    'DELETE FROM schedule_exceptions WHERE exception_date = ?'
);

/**
 * GET /api/admin/exceptions
 * Returns all scheduled date overrides.
 */
exports.listExceptions = (req, res) => {
    try {
        res.json(stmtAllExceptions.all());
    } catch (err) {
        console.error('adminController listExceptions error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * POST /api/admin/exceptions
 * Body: { exception_date: 'YYYY-MM-DD', schedule_type_override: 'sunday' }
 * Creates a new holiday/date override entry.
 */
exports.createException = (req, res) => {
    try {
        const { exception_date, schedule_type_override } = req.body;

        if (!exception_date || !schedule_type_override) {
            return res.status(400).json({ error: 'exception_date and schedule_type_override are required.' });
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(exception_date)) {
            return res.status(400).json({ error: 'exception_date must be in YYYY-MM-DD format.' });
        }
        if (!VALID_OVERRIDE_TYPES.has(schedule_type_override.toLowerCase())) {
            return res.status(400).json({
                error: `schedule_type_override must be one of: ${[...VALID_OVERRIDE_TYPES].join(', ')}.`
            });
        }

        stmtInsertException.run(exception_date, schedule_type_override.toLowerCase());
        res.status(201).json({ message: `Exception created for ${exception_date}.` });
    } catch (err) {
        if (err.message.includes('UNIQUE constraint')) {
            return res.status(409).json({ error: 'An exception for this date already exists. Use PUT to update it.' });
        }
        console.error('adminController createException error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * PUT /api/admin/exceptions/:date
 * Body: { schedule_type_override: 'saturday' }
 * Updates the override type for an existing date exception.
 */
exports.updateException = (req, res) => {
    try {
        const date = req.params.date;
        const { schedule_type_override } = req.body;

        if (!schedule_type_override) {
            return res.status(400).json({ error: 'schedule_type_override is required.' });
        }
        if (!VALID_OVERRIDE_TYPES.has(schedule_type_override.toLowerCase())) {
            return res.status(400).json({
                error: `schedule_type_override must be one of: ${[...VALID_OVERRIDE_TYPES].join(', ')}.`
            });
        }

        const info = stmtUpdateException.run(schedule_type_override.toLowerCase(), date);
        if (info.changes === 0) {
            return res.status(404).json({ error: 'Exception not found.' });
        }

        res.json({ message: `Exception for ${date} updated.` });
    } catch (err) {
        console.error('adminController updateException error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * DELETE /api/admin/exceptions/:date
 * Removes a date override entry.
 */
exports.deleteException = (req, res) => {
    try {
        const date = req.params.date;
        const info = stmtDeleteException.run(date);

        if (info.changes === 0) {
            return res.status(404).json({ error: 'Exception not found.' });
        }

        res.json({ message: `Exception for ${date} deleted.` });
    } catch (err) {
        console.error('adminController deleteException error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};
