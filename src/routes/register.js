const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDb, admin } = require('../services/firestore');

// --- Validation rules -----------------------------------------------------
// Ported verbatim from wtl-backend/src/routes/register.js, mirrored from
// wtl-cohort-landing-v3's own client-side validation (src/lib/validation.ts), so this
// backend rejects exactly what the frontend would never have sent in the first place.
// This endpoint is public (no auth), so it can't rely on the frontend having run at all.
const NAME_MAX_LEN = 100;
const EMAIL_MAX_LEN = 254; // RFC 5321 max mailbox length
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+91[6-9]\d{9}$/;
const CHRONOTYPES = new Set(['early_bird', 'day_operator', 'night_owl']);

function validatePayload(body) {
  // strip control characters after trimming: defensive groundwork against a future stored-XSS
  // source once an admin panel or PDF export renders this field
  const name = typeof body.name === 'string' ? body.name.trim().replace(/[\x00-\x1F\x7F]/g, '') : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const chronotype = typeof body.chronotype === 'string' ? body.chronotype : '';

  // .trim() only strips regular whitespace, not zero-width Unicode (e.g. U+200B), so a name
  // made entirely of zero-width characters would otherwise survive as "non-empty".
  const nameHasVisibleChars = name.replace(new RegExp('[\\u200B-\\u200D\\uFEFF\\s]', 'g'), '').length > 0;

  const errors = [];
  if (!name || !nameHasVisibleChars) errors.push('name is required');
  else if (name.length > NAME_MAX_LEN) errors.push(`name must be ${NAME_MAX_LEN} characters or fewer`);

  if (!email) errors.push('email is required');
  else if (email.length > EMAIL_MAX_LEN || !EMAIL_RE.test(email)) errors.push('email must be a valid email address');

  if (!phone) errors.push('phone is required');
  else if (!PHONE_RE.test(phone)) errors.push('phone must be a valid Indian mobile number (+91 followed by 10 digits starting 6-9)');

  if (!chronotype) errors.push('chronotype is required');
  else if (!CHRONOTYPES.has(chronotype)) errors.push(`chronotype must be one of: ${[...CHRONOTYPES].join(', ')}`);

  return { errors, clean: { name, email, phone, chronotype } };
}

// --- Lightweight per-instance rate limiter --------------------------------
// Cloud Run can (and will, under a real traffic spike) run multiple instances
// of this service, and this Map is process-local memory, so it does NOT give
// a hard guarantee across instances, an attacker (or just retried requests
// during scale-up) spread across instances is only partially slowed down.
// This is a deliberate "better than nothing" tradeoff, not a real distributed
// limiter. If this endpoint sees actual abuse, replace this with a Firestore-
// or Redis-backed limiter keyed by IP/phone/email.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
// Indian mobile carriers (Jio, Airtel) run large-scale CGNAT, so thousands of real users can
// share one public IP. The duplicate-registration guard below (email+phone) is what actually
// stops real abuse, this is just a backstop, so the IP ceiling is kept loose to avoid
// false-positive-blocking legitimate cohort traffic.
const RATE_LIMIT_MAX = 60; // max submissions per IP per window, per instance
// Tighter secondary limit keyed on the submitter's own identity (email+phone), so genuine
// same-person/bot abuse is still caught even though the IP limit above had to be loosened.
const IDENTITY_RATE_LIMIT_MAX = 5; // max submissions per email+phone combo per window, per instance
const rateLimitHits = new Map(); // ip -> timestamps[]
const identityRateLimitHits = new Map(); // "email|phone" -> timestamps[]
// Hard ceiling on distinct keys tracked per Map, independent of the periodic sweep below.
// identityRateLimitHits is keyed on attacker-controlled "email|phone" strings (up to ~267
// chars each), so sustained fake-but-well-formed submissions from distinct identities could
// otherwise grow this Map's key count unbounded within a single 10-minute window.
const RATE_LIMIT_MAX_TRACKED_KEYS = 5000;

// Bounds the stored timestamp array after every check (previously unbounded, which made the
// per-request .filter() get slower and slower under sustained traffic from one key, verified
// to hit ~22s of blocking CPU at 40k hits from one IP within the window, since Node is
// single-threaded this stalled every other route too, not just registration).
function checkAndRecordHit(map, key, max) {
  const now = Date.now();
  const isNewKey = !map.has(key);
  if (isNewKey && map.size >= RATE_LIMIT_MAX_TRACKED_KEYS) {
    // Evict the oldest-inserted entries (Map iteration preserves insertion order, and re-setting
    // an existing key doesn't move it) to make room for this new key.
    const evictCount = map.size - RATE_LIMIT_MAX_TRACKED_KEYS + 1;
    const it = map.keys();
    for (let i = 0; i < evictCount; i++) {
      const oldestKey = it.next().value;
      if (oldestKey === undefined) break;
      map.delete(oldestKey);
    }
  }
  const recent = (map.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  map.set(key, recent.slice(-(max + 1)));
  return recent.length > max;
}

// periodic cleanup so these Maps can't grow unbounded over the life of an instance
setInterval(() => {
  const now = Date.now();
  for (const map of [rateLimitHits, identityRateLimitHits]) {
    for (const [key, timestamps] of map) {
      const fresh = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (fresh.length === 0) map.delete(key);
      else map.set(key, fresh);
    }
  }
}, RATE_LIMIT_WINDOW_MS).unref();

// --- Duplicate registration lookup ----------------------------------------
async function findExistingRegistration(db, email, phone) {
  const [byEmail, byPhone] = await Promise.all([
    db.collection('registrations').where('email', '==', email).limit(1).get(),
    db.collection('registrations').where('phone', '==', phone).limit(1).get(),
  ]);
  if (!byEmail.empty) return byEmail.docs[0];
  if (!byPhone.empty) return byPhone.docs[0];
  return null;
}

// --- Referral code generation ----------------------------------------------
// 6-char base36 uppercase = 36^6 (~2.18B) possible codes. At the expected
// scale here (hundreds of registrations per cohort, not millions), the
// birthday-paradox collision odds are negligible on their own (~0.02% at
// n=1000). We still check-and-retry against Firestore below because it's a
// single indexed equality query (cheap, no composite index needed) and
// removes the risk entirely rather than just judging it "probably fine".
const REF_CODE_MAX_ATTEMPTS = 5;

function randomRefCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function generateUniqueRefCode(db) {
  for (let attempt = 0; attempt < REF_CODE_MAX_ATTEMPTS; attempt++) {
    const code = randomRefCode();
    const existing = await db.collection('registrations').where('ref', '==', code).limit(1).get();
    if (existing.empty) return code;
  }
  // Extremely unlikely fallback (5 straight collisions): append a timestamp
  // slice so this never blocks a registration outright.
  return `${randomRefCode().slice(0, 4)}${Date.now().toString(36).slice(-2).toUpperCase()}`;
}

// Guards store their target registration doc's path as a plain string (regDocRef.path), written
// only by our own code, but validated defensively before feeding it back into db.doc() during
// the transactional read below, since a Firestore document path must be a non-empty, even
// number of '/'-separated segments (collection/doc/collection/doc/...).
function isValidDocPath(path) {
  if (typeof path !== 'string' || !path) return false;
  const rawSegments = path.split('/');
  const segments = rawSegments.filter(Boolean);
  // Pinned to the exact shape a guard can legitimately point at (registrations/{autoId}), not just
  // "any even-segment path", since this string gets fed back into db.doc() below.
  return segments.length === 2 && segments.length === rawSegments.length && segments[0] === 'registrations';
}

// Atomically checks-and-writes the duplicate guard as a single Firestore transaction. A
// Firestore transaction gives real optimistic-concurrency guarantees: if any doc read here (the
// guards, or the registration doc a guard points to) gets written by another transaction before
// this one commits, the SDK automatically retries this entire function body. That's what closes
// the race a plain read-then-write would have: two near-simultaneous requests can no longer both
// observe "this guard is stale" and both win, because whichever transaction commits second is
// forced to retry against the first transaction's freshly-written guard.
//
// Handles all three cases in one atomic unit: fresh registration, genuine duplicate (a guard
// whose target registration doc still exists), and orphaned-guard recovery (a guard whose target
// registration doc was deleted, e.g. during test-data cleanup, without the guard being cleaned
// up alongside it) — an orphaned guard is simply overwritten by tx.set() below rather than
// needing a separate delete-then-retry pass.
async function registerWithGuards(db, emailGuardRef, phoneGuardRef, regDocRef, registration) {
  try {
    return await db.runTransaction(async (tx) => {
      // ALL reads must happen before any writes in a Firestore transaction, the SDK enforces this.
      const [emailGuardSnap, phoneGuardSnap] = await Promise.all([tx.get(emailGuardRef), tx.get(phoneGuardRef)]);

      for (const guardSnap of [emailGuardSnap, phoneGuardSnap]) {
        if (!guardSnap.exists) continue;
        const targetPath = guardSnap.get('regDocPath');
        if (!isValidDocPath(targetPath)) {
          // Malformed/corrupt guard: falls through and gets overwritten below like an orphan
          // would, but this should never legitimately happen (only our own code writes these),
          // so it's logged rather than silently swallowed.
          console.warn('Malformed guard regDocPath, overwriting:', guardSnap.ref.path, targetPath);
          continue;
        }
        const targetSnap = await tx.get(db.doc(targetPath));
        if (targetSnap.exists) {
          // Lost the race to a concurrent request that committed first (or a genuine earlier
          // registration), that write is the real registration, this one is a no-op duplicate.
          return { duplicate: true };
        }
        // else: orphaned guard, its target registration doc is gone, falls through and gets
        // overwritten below instead of leaving this person permanently unable to register.
      }

      const guardData = { regDocPath: regDocRef.path, at: admin.firestore.FieldValue.serverTimestamp() };
      // create() (hard "doesn't exist yet" server precondition) when the guard was absent at read
      // time, that's the normal fresh-registration case and the one path where correctness must not
      // rest on undocumented missing-document lock behavior. set() (plain overwrite) only when the
      // guard existed-but-orphaned above, since that write is a deliberate replace, not a fresh create.
      if (emailGuardSnap.exists) tx.set(emailGuardRef, guardData); else tx.create(emailGuardRef, guardData);
      if (phoneGuardSnap.exists) tx.set(phoneGuardRef, guardData); else tx.create(phoneGuardRef, guardData);
      tx.create(regDocRef, registration); // fresh auto-ID, should never collide, .create() as a safety assertion
      return { duplicate: false };
    });
  } catch (err) {
    // ALREADY_EXISTS (6): a concurrent transaction's create() on a guard we read as absent won
    // the race between our read and our write. That's a genuine duplicate, not a real error.
    // (In principle this could also fire from the regDocRef create() itself, a fresh auto-ID
    // colliding, effectively impossible, but logged rather than silently swallowed either way.)
    if (err?.code === 6) {
      console.warn('registerWithGuards: ALREADY_EXISTS race, treating as duplicate:', err.message);
      return { duplicate: true };
    }
    throw err;
  }
}

router.post('/', async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (checkAndRecordHit(rateLimitHits, ip, RATE_LIMIT_MAX)) {
    return res.status(429).json({ error: 'Too many registration attempts. Please try again in a few minutes.' });
  }

  const body = req.body || {};
  const { errors, clean } = validatePayload(body);
  if (errors.length) {
    return res.status(400).json({ error: errors[0], errors });
  }

  const identityKey = `${clean.email}|${clean.phone}`;
  if (checkAndRecordHit(identityRateLimitHits, identityKey, IDENTITY_RATE_LIMIT_MAX)) {
    return res.status(429).json({ error: 'Too many registration attempts. Please try again in a few minutes.' });
  }

  // `paid` is intentionally never read from the client: payment happens out-of-band (Cosmofeed/
  // SuperProfile) with no reconciliation webhook, so this field is a manual-reconciliation input,
  // not something a POST body should be able to set to true for free.
  const { src, bumpIntent, lateSignup, consent, consentAt, userAgent } = body;

  try {
    const db = getDb();

    // Idempotent registration, fast path: catches genuine resubmissions before doing any writes.
    const existing = await findExistingRegistration(db, clean.email, clean.phone);
    if (existing) {
      return res.json({ success: true });
    }

    const ref = await generateUniqueRefCode(db);
    const registration = {
      name: clean.name,
      email: clean.email,
      phone: clean.phone,
      chronotype: clean.chronotype,
      src: typeof src === 'string' && src.trim() ? src.trim().slice(0, 50) : 'unknown',
      paid: false,
      bumpIntent: !!bumpIntent,
      lateSignup: !!lateSignup,
      consent: !!consent,
      consentAt: typeof consentAt === 'string' && consentAt.length <= 40 ? consentAt : null,
      ref,
      userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 500) : null,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Atomic duplicate guard: two near-simultaneous requests with the same email/phone can
    // both pass the findExistingRegistration() read above before either write commits. Email
    // is hashed rather than used as a raw document ID because EMAIL_RE permits "/" characters
    // (e.g. "a/b@x.com"), which would corrupt the Firestore document path. registerWithGuards()
    // runs this as a single Firestore transaction, which is what actually guarantees no
    // duplicates, regardless of what findExistingRegistration() found above, that query-based
    // check is purely a cheap early-exit optimization, not the source of correctness. Whether
    // this resolves as a fresh registration or a detected duplicate, the caller gets the same
    // { success: true } response below, only a genuine unexpected error should produce a 500.
    const emailKey = crypto.createHash('sha256').update(clean.email).digest('hex');
    const regDocRef = db.collection('registrations').doc();
    const emailGuardRef = db.collection('reg_uniq_email').doc(emailKey);
    const phoneGuardRef = db.collection('reg_uniq_phone').doc(clean.phone);

    await registerWithGuards(db, emailGuardRef, phoneGuardRef, regDocRef, registration);

    res.json({ success: true });
  } catch (err) {
    // Log full details server-side only, never leak Firestore/internal errors to the public internet.
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again in a moment.' });
  }
});

module.exports = router;
// Internal functions exposed for unit tests only (test/*.test.js). Not part of the HTTP
// surface: index.js only ever does `require('./routes/register')` and mounts the router itself.
module.exports.internals = {
  validatePayload,
  checkAndRecordHit,
  isValidDocPath,
  registerWithGuards,
  generateUniqueRefCode,
  randomRefCode,
  rateLimitHits,
  identityRateLimitHits,
  RATE_LIMIT_MAX,
  IDENTITY_RATE_LIMIT_MAX,
  RATE_LIMIT_MAX_TRACKED_KEYS,
};
