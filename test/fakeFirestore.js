// Minimal in-memory stand-in for a Firestore Firestore() instance, just enough surface
// (collection().doc()/.where().limit().get(), doc(path).get(), runTransaction) to exercise
// registerWithGuards()'s and cohortConfig's route logic without touching a real project. Does
// NOT simulate genuine cross-transaction optimistic-concurrency retries (real Firestore's
// SDK re-runs the whole callback on a conflicting write) — the ALREADY_EXISTS-race test
// below instead simulates the *outcome* of such a race directly (store already holds the
// doc a concurrent transaction would have created), which is enough to exercise
// registerWithGuards()'s own catch-and-treat-as-duplicate handling.

class DocRef {
  // `store` is optional and, when passed, is the live FakeFirestore instance's own store object
  // (not a copy), so a plain non-transactional `.get()` below always reflects whatever the test
  // has since written into `db.store`. Existing callers that never pass `store` (or never call
  // `.get()`) are unaffected; this is purely additive for cohortConfig.test.js, which reads a
  // single config doc outside of any transaction.
  constructor(path, store) {
    this.path = path;
    this.id = path.split('/').pop();
    this._store = store;
  }

  async get() {
    const data = this._store ? this._store[this.path] : undefined;
    return {
      exists: !!data,
      id: this.id,
      ref: this,
      data: () => data,
      get: (field) => (data ? data[field] : undefined),
    };
  }
}

class FakeFirestore {
  constructor(initialDocs = {}) {
    this.store = { ...initialDocs }; // path -> plain data object
    this._counter = 0;
  }

  doc(path) {
    return new DocRef(path, this.store);
  }

  collection(name) {
    const self = this;
    return {
      doc(id) {
        const docId = id || `auto${++self._counter}`;
        return new DocRef(`${name}/${docId}`, self.store);
      },
      where(field, _op, value) {
        return {
          limit(n) {
            return {
              async get() {
                const matches = Object.entries(self.store)
                  .filter(([path, data]) => path.startsWith(`${name}/`) && data && data[field] === value)
                  .slice(0, n);
                return {
                  empty: matches.length === 0,
                  docs: matches.map(([path, data]) => ({
                    id: path.split('/').pop(),
                    data: () => data,
                    ref: new DocRef(path),
                  })),
                };
              },
            };
          },
        };
      },
    };
  }

  // Fires exactly once, right after a transaction takes its read snapshot but before its
  // writes are committed, so a test can simulate a concurrent write racing this transaction
  // (real Firestore transactions read a consistent snapshot and only detect conflicts at
  // commit time, which is what this models).
  simulateConcurrentWriteAfterSnapshot(fn) {
    this._raceHook = fn;
  }

  async runTransaction(fn) {
    // Snapshot the store BEFORE running the callback, so all tx.get() calls inside it see a
    // consistent view even if the live store mutates afterward (mirrors real Firestore
    // transaction snapshot-read semantics).
    const snapshot = { ...this.store };
    if (this._raceHook) {
      const hook = this._raceHook;
      this._raceHook = null;
      hook(this);
    }

    const pending = [];
    const tx = {
      get: async (ref) => {
        const data = snapshot[ref.path];
        return {
          exists: !!data,
          ref,
          get: (field) => (data ? data[field] : undefined),
          data: () => data,
        };
      },
      set: (ref, data) => {
        pending.push({ type: 'set', ref, data });
      },
      create: (ref, data) => {
        pending.push({ type: 'create', ref, data });
      },
    };

    const result = await fn(tx);

    // Commit: a queued create() only actually succeeds if, at commit time, the live store
    // (which may have changed since the snapshot was taken) still doesn't have that doc. This
    // is what surfaces a real ALREADY_EXISTS (code 6) failure for a genuine concurrent-write race.
    for (const write of pending) {
      if (write.type === 'create' && this.store[write.ref.path]) {
        const err = new Error('6 ALREADY_EXISTS: Document already exists');
        err.code = 6;
        throw err;
      }
    }
    for (const write of pending) {
      this.store[write.ref.path] = write.data;
    }
    return result;
  }
}

module.exports = { FakeFirestore, DocRef };
