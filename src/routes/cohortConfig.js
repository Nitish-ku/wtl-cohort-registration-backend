const express = require('express');
const router = express.Router();
const { getDb } = require('../services/firestore');
const { computeFallbackCohortConfig } = require('../lib/cohortSchedule');

// Public config doc Nitish edits directly via the Firebase Console, no code change or
// redeploy required. See README.md's "Changing the next cohort date" section for the
// step-by-step. If this doc is absent (fresh deploy, nobody's touched it yet) or has a
// missing/malformed field, this endpoint falls back to the same hardcoded weekly-recurring
// math the frontend used before this endpoint existed (src/lib/cohortSchedule.js).
const CONFIG_DOC_PATH = 'config/cohort';

// This value changes rarely (a manual Firestore edit, at most a few times per cohort cycle),
// so a short cache avoids hammering Firestore on every page load, while staying short enough
// that an edit takes effect within a few minutes rather than hours.
const CACHE_CONTROL_HEADER = 'public, max-age=300';

function isFirestoreTimestamp(value) {
  return !!value && typeof value.toDate === 'function';
}

async function buildCohortConfigResponse(db) {
  try {
    const snap = await db.doc(CONFIG_DOC_PATH).get();
    if (snap.exists) {
      const data = snap.data() || {};
      if (isFirestoreTimestamp(data.nextCohortStart) && typeof data.active === 'boolean') {
        return {
          nextCohortStart: data.nextCohortStart.toDate().toISOString(),
          active: data.active,
          source: 'firestore',
        };
      }
      console.warn(`${CONFIG_DOC_PATH} exists but is missing/malformed fields, falling back to computed schedule`);
    }
  } catch (err) {
    // Any Firestore read failure (permissions, transient outage, emulator not running locally,
    // etc.) must never surface as a broken countdown on the live site, fall back instead.
    console.error(`${CONFIG_DOC_PATH}: Firestore read failed, falling back to computed schedule:`, err);
  }

  return { ...computeFallbackCohortConfig(), source: 'fallback-computed' };
}

router.get('/', async (req, res) => {
  res.set('Cache-Control', CACHE_CONTROL_HEADER);
  const payload = await buildCohortConfigResponse(getDb());
  res.json(payload);
});

module.exports = router;
// Internal functions exposed for unit tests only (test/*.test.js), same pattern as
// routes/register.js's `internals` export.
module.exports.internals = { buildCohortConfigResponse, isFirestoreTimestamp, CONFIG_DOC_PATH };
