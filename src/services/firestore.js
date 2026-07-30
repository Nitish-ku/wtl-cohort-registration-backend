const admin = require('firebase-admin');

// Same auth pattern as wtl-backend/src/services/firestore.js: applicationDefault()
// picks up GOOGLE_APPLICATION_CREDENTIALS (a service-account JSON key file path) for
// local dev, or Cloud Run's attached service account automatically in production, no
// code difference between the two, only environment.
let db;

function initFirebase() {
  if (admin.apps.length > 0) return;
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
  db = admin.firestore();
  console.log('Firebase Admin initialized');
}

function getDb() {
  if (!db) throw new Error('Firebase not initialized');
  return db;
}

module.exports = { initFirebase, getDb, admin };
