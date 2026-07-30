// Ported verbatim from wtl-cohort-landing-v3/src/lib/countdown.ts's nextCohortStart(), which
// is the proven-correct client-side math for "the next Friday 9:00 AM IST, forever". This
// backend needs the exact same computation as a fallback for GET /api/cohort-config, used only
// when config/cohort is missing from Firestore or has a malformed field, so a fresh deploy (or a
// corrupted doc) never breaks the countdown the frontend shows.
const IST_OFFSET_MINUTES = 5 * 60 + 30; // UTC+5:30, no DST

/** Returns the next Friday 09:00 IST strictly after `from`, as a UTC Date. */
function nextCohortStart(from = new Date()) {
  const istNow = new Date(from.getTime() + IST_OFFSET_MINUTES * 60_000);

  const candidate = new Date(
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 9, 0, 0, 0),
  );
  const currentDay = istNow.getUTCDay(); // 0 = Sun ... 5 = Fri
  const daysUntilFriday = (5 - currentDay + 7) % 7;

  candidate.setUTCDate(candidate.getUTCDate() + daysUntilFriday);

  // If "today" is Friday but 9 AM IST has already passed, or the computed instant otherwise
  // isn't strictly in the future, roll forward a full week.
  const candidateUtc = new Date(candidate.getTime() - IST_OFFSET_MINUTES * 60_000);
  if (candidateUtc.getTime() <= from.getTime()) {
    candidateUtc.setUTCDate(candidateUtc.getUTCDate() + 7);
  }
  return candidateUtc;
}

/** The hardcoded weekly-recurring schedule always assumes a cohort runs, so `active` has no
 * "off" state to compute here, only Firestore can turn a week off (see config/cohort's
 * `active` field, documented in README.md). */
function computeFallbackCohortConfig(from = new Date()) {
  return {
    nextCohortStart: nextCohortStart(from).toISOString(),
    active: true,
  };
}

module.exports = { nextCohortStart, computeFallbackCohortConfig };
