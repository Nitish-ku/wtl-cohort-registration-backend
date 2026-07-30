const test = require('node:test');
const assert = require('node:assert/strict');
const { nextCohortStart, computeFallbackCohortConfig } = require('../src/lib/cohortSchedule');

test('nextCohortStart: from a Monday, returns that same week\'s Friday 09:00 IST (03:30 UTC)', () => {
  const monday = new Date('2026-08-03T04:00:00.000Z'); // Monday
  const result = nextCohortStart(monday);
  assert.equal(result.toISOString(), '2026-08-07T03:30:00.000Z'); // Friday
});

test('nextCohortStart: on Friday before 09:00 IST, returns the same day', () => {
  const fridayMorning = new Date('2026-08-07T02:00:00.000Z'); // 07:30 IST, before 09:00
  const result = nextCohortStart(fridayMorning);
  assert.equal(result.toISOString(), '2026-08-07T03:30:00.000Z');
});

test('nextCohortStart: on Friday after 09:00 IST has passed, rolls forward a full week', () => {
  const fridayAfternoon = new Date('2026-08-07T10:00:00.000Z'); // 15:30 IST, after 09:00
  const result = nextCohortStart(fridayAfternoon);
  assert.equal(result.toISOString(), '2026-08-14T03:30:00.000Z');
});

test('nextCohortStart: exactly at the instant, rolls forward (strictly-in-the-future contract)', () => {
  const exact = new Date('2026-08-07T03:30:00.000Z');
  const result = nextCohortStart(exact);
  assert.equal(result.toISOString(), '2026-08-14T03:30:00.000Z');
});

test('computeFallbackCohortConfig: active is always true (the hardcoded schedule has no "off" state)', () => {
  const result = computeFallbackCohortConfig(new Date('2026-08-03T04:00:00.000Z'));
  assert.equal(result.active, true);
  assert.equal(result.nextCohortStart, '2026-08-07T03:30:00.000Z');
});
