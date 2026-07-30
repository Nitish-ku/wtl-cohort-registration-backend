const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./fakeFirestore');
const { internals } = require('../src/routes/cohortConfig');

const { buildCohortConfigResponse, CONFIG_DOC_PATH } = internals;

function fakeTimestamp(date) {
  return { toDate: () => date };
}

test('buildCohortConfigResponse: doc exists and is valid, reads nextCohortStart/active straight from Firestore', async () => {
  const db = new FakeFirestore();
  const start = new Date('2026-08-07T03:30:00.000Z');
  db.store[CONFIG_DOC_PATH] = { nextCohortStart: fakeTimestamp(start), active: true };

  const result = await buildCohortConfigResponse(db);

  assert.equal(result.source, 'firestore');
  assert.equal(result.nextCohortStart, start.toISOString());
  assert.equal(result.active, true);
});

test('buildCohortConfigResponse: doc exists with active: false, reads it straight through (no cohort scheduled)', async () => {
  const db = new FakeFirestore();
  const start = new Date('2026-08-14T03:30:00.000Z');
  db.store[CONFIG_DOC_PATH] = { nextCohortStart: fakeTimestamp(start), active: false };

  const result = await buildCohortConfigResponse(db);

  assert.equal(result.source, 'firestore');
  assert.equal(result.active, false);
});

test('buildCohortConfigResponse: doc exists but nextCohortStart is missing, falls back to computed schedule', async () => {
  const db = new FakeFirestore();
  db.store[CONFIG_DOC_PATH] = { active: true };

  const result = await buildCohortConfigResponse(db);

  assert.equal(result.source, 'fallback-computed');
  assert.equal(result.active, true);
  assert.ok(!Number.isNaN(new Date(result.nextCohortStart).getTime()));
});

test('buildCohortConfigResponse: doc exists but nextCohortStart is a plain string, not a Firestore Timestamp, falls back', async () => {
  const db = new FakeFirestore();
  db.store[CONFIG_DOC_PATH] = { nextCohortStart: '2026-08-07T03:30:00.000Z', active: true };

  const result = await buildCohortConfigResponse(db);

  assert.equal(result.source, 'fallback-computed');
});

test('buildCohortConfigResponse: doc exists but active is not a boolean, falls back to computed schedule', async () => {
  const db = new FakeFirestore();
  db.store[CONFIG_DOC_PATH] = { nextCohortStart: fakeTimestamp(new Date()), active: 'yes' };

  const result = await buildCohortConfigResponse(db);

  assert.equal(result.source, 'fallback-computed');
});

test('buildCohortConfigResponse: doc does not exist at all, falls back to computed schedule', async () => {
  const db = new FakeFirestore();

  const result = await buildCohortConfigResponse(db);

  assert.equal(result.source, 'fallback-computed');
  assert.equal(result.active, true);
  assert.ok(!Number.isNaN(new Date(result.nextCohortStart).getTime()));
});

test('buildCohortConfigResponse: a Firestore read failure (e.g. transient outage) falls back rather than throwing', async () => {
  const db = { doc: () => ({ get: async () => { throw new Error('simulated Firestore outage'); } }) };

  const result = await buildCohortConfigResponse(db);

  assert.equal(result.source, 'fallback-computed');
  assert.equal(result.active, true);
});
