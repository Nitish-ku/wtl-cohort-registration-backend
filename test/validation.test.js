const test = require('node:test');
const assert = require('node:assert/strict');
const { internals } = require('../src/routes/register');

const { validatePayload, checkAndRecordHit, isValidDocPath } = internals;

const VALID = { name: 'Asha Rao', email: 'asha@example.com', phone: '+919812345678', chronotype: 'early_bird' };

test('validatePayload accepts a fully valid payload', () => {
  const { errors, clean } = validatePayload(VALID);
  assert.deepEqual(errors, []);
  assert.equal(clean.email, 'asha@example.com');
  assert.equal(clean.phone, '+919812345678');
});

test('validatePayload lowercases and trims email', () => {
  const { errors, clean } = validatePayload({ ...VALID, email: '  Asha@Example.COM  ' });
  assert.deepEqual(errors, []);
  assert.equal(clean.email, 'asha@example.com');
});

test('validatePayload rejects missing name', () => {
  const { errors } = validatePayload({ ...VALID, name: '' });
  assert.ok(errors.includes('name is required'));
});

test('validatePayload rejects a name made only of zero-width characters', () => {
  const { errors } = validatePayload({ ...VALID, name: '​​​' });
  assert.ok(errors.includes('name is required'));
});

test('validatePayload rejects a name over 100 characters', () => {
  const { errors } = validatePayload({ ...VALID, name: 'A'.repeat(101) });
  assert.ok(errors.some((e) => e.includes('100 characters or fewer')));
});

test('validatePayload rejects an email over 254 characters', () => {
  const longLocal = 'a'.repeat(250);
  const { errors } = validatePayload({ ...VALID, email: `${longLocal}@x.com` });
  assert.ok(errors.some((e) => e.includes('valid email address')));
});

test('validatePayload rejects a malformed email', () => {
  const { errors } = validatePayload({ ...VALID, email: 'not-an-email' });
  assert.ok(errors.some((e) => e.includes('valid email address')));
});

test('validatePayload rejects phone numbers outside the +91[6-9]XXXXXXXXX shape', () => {
  for (const phone of ['+911234567890', '9812345678', '+91981234567', '+919812345678a']) {
    const { errors } = validatePayload({ ...VALID, phone });
    assert.ok(errors.some((e) => e.includes('Indian mobile number')), `expected ${phone} to be rejected`);
  }
});

test('validatePayload accepts all three chronotypes and rejects an unknown one', () => {
  for (const chronotype of ['early_bird', 'day_operator', 'night_owl']) {
    const { errors } = validatePayload({ ...VALID, chronotype });
    assert.deepEqual(errors, []);
  }
  const { errors } = validatePayload({ ...VALID, chronotype: 'vampire' });
  assert.ok(errors.some((e) => e.startsWith('chronotype must be one of')));
});

test('validatePayload reports every failing field at once, not just the first', () => {
  const { errors } = validatePayload({ name: '', email: 'bad', phone: '123', chronotype: '' });
  assert.equal(errors.length, 4);
});

test('checkAndRecordHit allows up to max hits and blocks the one after', () => {
  const map = new Map();
  for (let i = 0; i < 3; i++) {
    assert.equal(checkAndRecordHit(map, 'k', 3), false);
  }
  assert.equal(checkAndRecordHit(map, 'k', 3), true);
});

test('checkAndRecordHit tracks distinct keys independently', () => {
  const map = new Map();
  assert.equal(checkAndRecordHit(map, 'a', 1), false);
  assert.equal(checkAndRecordHit(map, 'b', 1), false);
  assert.equal(checkAndRecordHit(map, 'a', 1), true);
  assert.equal(checkAndRecordHit(map, 'b', 1), true);
});

test('checkAndRecordHit evicts the oldest key once RATE_LIMIT_MAX_TRACKED_KEYS is reached', () => {
  const map = new Map();
  const cap = internals.RATE_LIMIT_MAX_TRACKED_KEYS;
  for (let i = 0; i < cap; i++) checkAndRecordHit(map, `key${i}`, 100);
  assert.equal(map.size, cap);
  assert.ok(map.has('key0'));

  checkAndRecordHit(map, 'newKey', 100);
  assert.equal(map.size, cap); // still bounded, did not grow past the cap
  assert.ok(!map.has('key0'), 'oldest key should have been evicted');
  assert.ok(map.has('newKey'));
});

test('isValidDocPath only accepts registrations/{id} shaped paths', () => {
  assert.equal(isValidDocPath('registrations/abc123'), true);
  assert.equal(isValidDocPath('reg_uniq_email/abc123'), false);
  assert.equal(isValidDocPath('registrations'), false);
  assert.equal(isValidDocPath('registrations/a/b/c'), false);
  assert.equal(isValidDocPath(''), false);
  assert.equal(isValidDocPath(null), false);
  assert.equal(isValidDocPath('registrations//'), false);
});
