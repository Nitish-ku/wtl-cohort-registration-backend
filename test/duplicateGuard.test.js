const test = require('node:test');
const assert = require('node:assert/strict');
const { internals } = require('../src/routes/register');
const { FakeFirestore } = require('./fakeFirestore');

const { registerWithGuards } = internals;

function refs(db, email, phone) {
  const regDocRef = db.collection('registrations').doc('reg1');
  const emailGuardRef = db.collection('reg_uniq_email').doc(`hash-${email}`);
  const phoneGuardRef = db.collection('reg_uniq_phone').doc(phone);
  return { regDocRef, emailGuardRef, phoneGuardRef };
}

test('registerWithGuards: fresh registration writes the reg doc and both guards', async () => {
  const db = new FakeFirestore();
  const { regDocRef, emailGuardRef, phoneGuardRef } = refs(db, 'a@x.com', '+919812345678');
  const registration = { name: 'Asha', email: 'a@x.com', phone: '+919812345678' };

  const result = await registerWithGuards(db, emailGuardRef, phoneGuardRef, regDocRef, registration);

  assert.equal(result.duplicate, false);
  assert.deepEqual(db.store[regDocRef.path], registration);
  assert.equal(db.store[emailGuardRef.path].regDocPath, regDocRef.path);
  assert.equal(db.store[phoneGuardRef.path].regDocPath, regDocRef.path);
});

test('registerWithGuards: genuine duplicate (guard points at a registration doc that still exists) is a no-op', async () => {
  const db = new FakeFirestore();
  const { regDocRef, emailGuardRef, phoneGuardRef } = refs(db, 'a@x.com', '+919812345678');
  // Simulate an already-completed prior registration: the target doc and its guards exist.
  db.store[regDocRef.path] = { name: 'Asha (already registered)' };
  db.store[emailGuardRef.path] = { regDocPath: regDocRef.path };
  db.store[phoneGuardRef.path] = { regDocPath: regDocRef.path };

  const newRegDocRef = db.collection('registrations').doc('reg2'); // a second attempt would target a fresh auto-id
  const result = await registerWithGuards(db, emailGuardRef, phoneGuardRef, newRegDocRef, { name: 'Asha (retry)' });

  assert.equal(result.duplicate, true);
  assert.equal(db.store[newRegDocRef.path], undefined, 'no second registration doc should have been written');
  assert.equal(db.store[regDocRef.path].name, 'Asha (already registered)', 'original registration untouched');
});

test('registerWithGuards: orphaned guard (target registration doc deleted) is overwritten, not treated as a duplicate', async () => {
  const db = new FakeFirestore();
  const { regDocRef, emailGuardRef, phoneGuardRef } = refs(db, 'a@x.com', '+919812345678');
  const staleTargetRef = db.collection('registrations').doc('deleted-reg');
  // Guard exists but its target registration doc does NOT (e.g. deleted during test-data cleanup
  // without the guard being cleaned up alongside it).
  db.store[emailGuardRef.path] = { regDocPath: staleTargetRef.path };
  db.store[phoneGuardRef.path] = { regDocPath: staleTargetRef.path };

  const registration = { name: 'Asha', email: 'a@x.com', phone: '+919812345678' };
  const result = await registerWithGuards(db, emailGuardRef, phoneGuardRef, regDocRef, registration);

  assert.equal(result.duplicate, false);
  assert.deepEqual(db.store[regDocRef.path], registration);
  assert.equal(db.store[emailGuardRef.path].regDocPath, regDocRef.path, 'guard should now point at the new registration');
});

test('registerWithGuards: a malformed guard.regDocPath is logged and overwritten rather than trusted', async () => {
  const db = new FakeFirestore();
  const { regDocRef, emailGuardRef, phoneGuardRef } = refs(db, 'a@x.com', '+919812345678');
  db.store[emailGuardRef.path] = { regDocPath: 'not/a/valid/registrations/path' };

  const registration = { name: 'Asha', email: 'a@x.com', phone: '+919812345678' };
  const result = await registerWithGuards(db, emailGuardRef, phoneGuardRef, regDocRef, registration);

  assert.equal(result.duplicate, false);
  assert.deepEqual(db.store[regDocRef.path], registration);
});

test('registerWithGuards: ALREADY_EXISTS thrown by tx.create() (concurrent-write race) is treated as a duplicate, not a 500', async () => {
  const db = new FakeFirestore();
  const { regDocRef, emailGuardRef, phoneGuardRef } = refs(db, 'a@x.com', '+919812345678');

  // Both guards read as absent at snapshot time (genuine fresh-registration path, about to
  // tx.create() both), but a concurrent transaction wins the race and creates the email guard
  // in the live store before this transaction's writes commit.
  db.simulateConcurrentWriteAfterSnapshot((fakeDb) => {
    fakeDb.store[emailGuardRef.path] = { regDocPath: 'registrations/some-other-reg' };
  });

  const result = await registerWithGuards(db, emailGuardRef, phoneGuardRef, regDocRef, { name: 'Asha' });

  assert.equal(result.duplicate, true);
  assert.equal(db.store[regDocRef.path], undefined, 'this transaction lost the race, its registration doc must not exist');
});
