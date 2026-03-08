const fs = require('fs');
const path = require('path');

// --- Config ---
const TRAIN_NUMBERS_PATH = path.join(__dirname, './extracted/train_numbers.json');
const OUTPUT_DIR = path.join(__dirname, 'raw_bdz_data');
const FAILED_PATH = path.join(__dirname, 'failed_trains.json');

// Your old server running locally
const BASE_URL = 'http://localhost:3001/api/train-info';
const LANGUAGE = 'bg';
const BATCH_SIZE = 15;

// Jitter between individual requests (ms)
const SHORT_DELAY_MIN = 3000;
const SHORT_DELAY_MAX = 6000;

// Long break after each batch (ms)
const LONG_BREAK_MIN = 60000;
const LONG_BREAK_MAX = 90000;

// --- Dates (DD.MM.YYYY for the BDZ API) ---
function getNextDayOfWeek(dayOfWeek) {
    const now = new Date();
    const diff = (dayOfWeek - now.getDay() + 7) % 7 || 7;
    const target = new Date(now);
    target.setDate(now.getDate() + diff);
    return target;
}

function formatDateBDZ(date) {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
}

const WEEKDAY_DATE = formatDateBDZ(getNextDayOfWeek(3)); // Wednesday
const WEEKEND_DATE = formatDateBDZ(getNextDayOfWeek(6)); // Saturday

// --- Helpers ---
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTrainInfo(trainNo, date) {
    // GET /api/train-info/:language/:trainNo/:date
    const url = `${BASE_URL}/${LANGUAGE}/${trainNo}/${date}`;
    const res = await fetch(url);

    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();

    // Check for error responses or empty data
    if (!json || json.error || !json.stations || json.stations.length === 0) {
        throw new Error(json?.error || 'Empty or invalid response');
    }

    return json;
}

// --- Main ---
(async () => {
    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const trainNumbers = JSON.parse(fs.readFileSync(TRAIN_NUMBERS_PATH, 'utf-8'));
    const total = trainNumbers.length;
    const failedTrains = [];

    console.log(`=== BulTrain Stealth Harvester ===`);
    console.log(`Source: ${BASE_URL}`);
    console.log(`Trains to fetch: ${total}`);
    console.log(`Weekday date: ${WEEKDAY_DATE} (Wed)`);
    console.log(`Weekend date: ${WEEKEND_DATE} (Sat)`);
    console.log(`Batch size: ${BATCH_SIZE} | Short delay: ${SHORT_DELAY_MIN / 1000}-${SHORT_DELAY_MAX / 1000}s | Long break: ${LONG_BREAK_MIN / 1000}-${LONG_BREAK_MAX / 1000}s`);
    console.log(`Estimated time: ~${Math.round((total * 2 * ((SHORT_DELAY_MIN + SHORT_DELAY_MAX) / 2) + Math.floor(total / BATCH_SIZE) * ((LONG_BREAK_MIN + LONG_BREAK_MAX) / 2)) / 60000)} minutes`);
    console.log(`-`.repeat(60));

    for (let i = 0; i < total; i++) {
        const trainNo = String(trainNumbers[i]);
        const idx = i + 1;

        // --- Fetch for both dates ---
        const fetches = [
            { date: WEEKDAY_DATE, suffix: 'wed', label: 'Weekday' },
            { date: WEEKEND_DATE, suffix: 'sat', label: 'Weekend' },
        ];

        for (const { date, suffix, label } of fetches) {
            const outFile = path.join(OUTPUT_DIR, `${trainNo}_${suffix}.json`);

            // Skip if already fetched (resume support)
            if (fs.existsSync(outFile)) {
                console.log(`[${idx}/${total}] Skipping ${trainNo} (${label}) — already exists`);
                continue;
            }

            try {
                const json = await fetchTrainInfo(trainNo, date);
                fs.writeFileSync(outFile, JSON.stringify(json, null, 2), 'utf-8');
                const delayMs = randomInt(SHORT_DELAY_MIN, SHORT_DELAY_MAX);
                console.log(`[${idx}/${total}] Fetched ${trainNo} (${label}) — Waiting ${(delayMs / 1000).toFixed(1)}s...`);
                await sleep(delayMs);
            } catch (err) {
                console.log(`[${idx}/${total}] FAILED ${trainNo} (${label}): ${err.message}`);
                failedTrains.push({ trainNumber: trainNo, date });

                // Still pause to stay stealthy
                const delayMs = randomInt(SHORT_DELAY_MIN, SHORT_DELAY_MAX);
                await sleep(delayMs);
            }
        }

        // --- Long break after every BATCH_SIZE trains ---
        if (idx % BATCH_SIZE === 0 && idx < total) {
            const breakMs = randomInt(LONG_BREAK_MIN, LONG_BREAK_MAX);
            console.log(`\n*** Taking a long break for ${Math.round(breakMs / 1000)} seconds... *** [${idx}/${total} done]\n`);
            await sleep(breakMs);
        }
    }

    // --- Save failed trains ---
    fs.writeFileSync(FAILED_PATH, JSON.stringify(failedTrains, null, 2), 'utf-8');

    console.log(`-`.repeat(60));
    console.log(`Done! ${total} trains processed.`);
    console.log(`Failed: ${failedTrains.length} (saved to ${FAILED_PATH})`);
    console.log(`Raw JSON saved to ${OUTPUT_DIR}/`);
})();
