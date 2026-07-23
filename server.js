const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');

require('dotenv').config();

// ── Database bootstrap ──────────────────────────────────────────────────────
// Must run before any route module below, because they open the database
// readonly at require() time and readonly connections cannot set WAL mode.
require('./database/ensureWal')();

// ── Middleware ──────────────────────────────────────────────────────────────
const verifyMobileClient = require('./middleware/verifyMobileClient');

// ── Import routes ──────────────────────────────────────────────────────────
const liveRoutes = require('./routes/live');
const trainInfoRoutes = require('./routes/trainInfo');
const scheduleRoutes = require('./routes/schedule');
const scheduleSecRoutes = require('./routes/schedule-sec');
const guide = require('./routes/guide');
const guideTopics = require('./routes/guide-topics');
const translator = require('./routes/translator');
const stats = require('./routes/stats');
const stationsRoutes = require('./routes/stations');
const realtimeRoutes = require('./routes/realtime');
const liveActivityRoutes = require('./routes/liveActivity');
const adminRoutes = require('./routes/admin');

const app = express();
const port = process.env.PORT || 3000;

// ── CORS configuration ────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:5173', // За твоя Mac (Vite)
  'http://localhost:3000', // За локални тестове
  process.env.ADMIN_ORIGIN // За живия сървър (от .env файла)
];

app.use(cors({
  origin: (origin, callback) => {
    // Разрешаваме мобилното приложение и сървър-към-сървър заявки
    if (!origin) return callback(null, true);
    
    // Проверяваме дали адресът е в позволения списък
    if (allowedOrigins.includes(origin)) return callback(null, true);
    
    // Блокираме всичко останало
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// ── Body parsing & cookies ─────────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());

// ── Health check (public — for external uptime monitoring) ──────────────────
const healthController = require('./controllers/healthController');
app.get('/health', healthController.getHealth);

// ── Serve static guide images ──────────────────────────────────────────────
app.use('/guide/images', express.static(path.join(__dirname, 'guide', 'images')));

// ── Public API routes (protected by mobile client verification) ────────────
app.use('/api/live', verifyMobileClient, liveRoutes);
app.use('/api/train-info', verifyMobileClient, trainInfoRoutes);
app.use('/api/schedule', verifyMobileClient, scheduleRoutes);
app.use('/api/schedule', verifyMobileClient, scheduleSecRoutes);
app.use('/api/guide', verifyMobileClient, guide);
app.use('/api/guide', verifyMobileClient, guideTopics);
app.use('/api/translator', verifyMobileClient, translator);
app.use('/api/stats', verifyMobileClient, stats);
app.use('/api/stations', verifyMobileClient, stationsRoutes);
app.use('/api/realtime', verifyMobileClient, realtimeRoutes);
app.use('/api/live-activity', verifyMobileClient, liveActivityRoutes);

// ── Admin routes (JWT-protected via route-level middleware) ─────────────────
app.use('/api/admin', adminRoutes);

// ── Serve public files ──────────────────────────────────────────────────────
app.use(express.static('public'));

// ── Admin UI (Production) ───────────────────────────────────────────────────
// Serve the built React static files
const adminBuildPath = path.join(__dirname, 'admin-ui', 'dist');
app.use('/admin', express.static(adminBuildPath));

// Catch-all for React Router on the admin side
app.get('/admin/*splat', (req, res) => {
  res.sendFile(path.join(adminBuildPath, 'index.html'));
});

// ── Start server ───────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`Server is listening at http://localhost:${port}`);
});

// ── Realtime poller ──────────────────────────────────────────────────────────
// Gated behind REALTIME=on so the code can be deployed and verified before the
// poller starts fetching. Isolated: if it fails, the rest of the API is fine.
if (process.env.REALTIME === 'on') {
  require('./services/realtime/poller').start();
  // Quiet delay-history accumulation (independent flag).
  if (process.env.RT_HISTORY === 'on') {
    require('./services/realtime/history').start();
  }
}

// ── Live Activity push worker ────────────────────────────────────────────────
// Diffs the in-memory realtime state and pushes ActivityKit updates over APNs.
// Needs the realtime cache to be populated, so it only runs alongside the
// poller. Registration endpoints work regardless — they only touch the DB.
if (process.env.LIVE_ACTIVITY === 'on') {
  if (process.env.REALTIME !== 'on') {
    console.warn('[la] LIVE_ACTIVITY=on but REALTIME is off — there is no realtime data to push');
  }
  require('./services/liveactivity/worker').start();
}
