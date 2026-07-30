const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const { initFirebase } = require('./services/firestore');
const registerRoutes = require('./routes/register');

const app = express();
const PORT = process.env.PORT || 8080;

// Cloud Run sits behind Google's front-end proxy, which sets X-Forwarded-For.
// Trust that one hop so req.ip reflects the real client IP (used by the
// register route's per-IP rate limiter) instead of the proxy's address.
app.set('trust proxy', 1);

// PLACEHOLDER — wtl-cohort-landing-v3 (this service's only client) has not been deployed
// yet, so its real Cloudflare Pages / custom domain is not known at the time this backend
// was built (see D:\wtl-cohort-landing-v3\.env.production, which has the matching
// VITE_API_BASE_URL placeholder). Replace the entry below with the real deploy domain(s)
// (and its https://*.pages.dev preview domain, if used) before this ever serves real traffic.
// Do NOT add wiredtolaunch.in or any of the existing .live cohort domains here — those are
// served by the separate wtl-backend service, not this one.
const ALLOWED_ORIGINS = [
  'https://REPLACE_WITH_REAL_COHORT_V3_DEPLOY_DOMAIN.invalid',
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000', 'http://localhost:5173'] : []),
];

app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      const err = new Error('Not allowed by CORS');
      err.status = 403;
      callback(err);
    }
  },
  credentials: true,
}));
// This service only ever accepts one small JSON object (the registration payload), so a
// single tight body-size limit applies app-wide, unlike wtl-backend which has to carve out
// a tighter /api/register-only limit alongside its own app-wide 10mb default for other routes.
app.use(express.json({ limit: '32kb' }));

initFirebase();

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/register', registerRoutes);

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  console.error(err.stack);
  res.status(status).json({ error: status < 500 ? err.message : 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`WTL cohort registration backend running on port ${PORT}`);
});

// Cloud Run sends SIGTERM before terminating an instance (new revision deploys, scale-down).
// Node's default action is to exit immediately, which would drop any in-flight request (like a
// registration mid-write). Stop accepting new connections and let existing ones finish first.
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server gracefully');
  server.close(() => process.exit(0));
});

module.exports = app;
