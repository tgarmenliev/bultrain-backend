const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');

// override: true is load-bearing, not tidiness.
//
// dotenv leaves an already-set variable alone, and `pm2 restart --update-env`
// copies the CURRENT SHELL into the process. So an `export IOS_API_KEY=...`
// typed once for a curl test silently outlives the shell: every later restart
// re-injects it, dotenv declines to correct it, and the server authenticates
// against that value instead of .env — which took the whole API down with
// "Invalid API key" for every client at once, twice.
//
// On this machine .env is the single source of truth, so it wins outright.
require('dotenv').config({ override: true });

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
const articlesAppRoutes = require('./routes/articles');
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

// ── API-wide rate limiting ──────────────────────────────────────────────────
// One shared ceiling ahead of every /api/* route, so a route added later can't
// silently ship without protection the way every route except live-activity's
// register endpoints did until now. Deliberately generous — normal app usage
// (a cold-start burst of station/schedule/guide/realtime calls, then scattered
// requests while browsing) is nowhere near 120/min; this exists to stop a
// scraping loop or a runaway client, not to throttle real traffic. Per-route
// limiters (like live-activity's tighter 20/min register limit) still apply on
// top of this — both must pass, so the tighter one continues to govern there.
//
// Accurate per-IP behaviour depends on nginx forwarding X-Forwarded-For (see
// rateLimit.js); without it every request behind the proxy collapses into one
// bucket per API key, which is still a real ceiling, just a coarser one.
const { createRateLimit } = require('./middleware/rateLimit');
const apiLimiter = createRateLimit({
  windowMs: 60_000,
  max: 120,
  message: 'Too many requests. Slow down.',
});
app.use('/api', apiLimiter);

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
app.use('/api/articles', verifyMobileClient, articlesAppRoutes);

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

  // Say out loud which client keys are loaded. When authentication breaks, the
  // symptom is a blanket 401 with no clue whether the key list is wrong, short,
  // or missing entirely — this one line answers that at a glance. Only counts
  // and a fingerprint are printed; never the keys themselves.
  const fingerprint = (v) => {
    const keys = String(v || '').split(',').map(k => k.trim()).filter(Boolean);
    if (!keys.length) return 'NONE';
    return `${keys.length} key(s): ` + keys.map(k => `${k.slice(0, 4)}…${k.slice(-4)}`).join(', ');
  };
  console.log(`[auth] IOS_API_KEY     ${fingerprint(process.env.IOS_API_KEY)}`);
  console.log(`[auth] ANDROID_API_KEY ${fingerprint(process.env.ANDROID_API_KEY)}`);
  console.log(`[auth] SCREEN_API_KEY  ${fingerprint(process.env.SCREEN_API_KEY)}`);
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
