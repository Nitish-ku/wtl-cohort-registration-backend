# wtl-cohort-registration-backend

Standalone registration backend for Wired To Launch's **72-Hour Founder Sprint** cohort
landing page (`wtl-cohort-landing-v3`). This service does exactly one thing: `POST
/api/register`, plus a `/health` check. It intentionally does **not** contain any of
`wtl-backend`'s sprint-tool routes (`/api/ai`, `/api/scores`, `/api/reveals`,
`/api/admin`), Firebase Auth middleware, Vertex AI/Gemini, or AiSensy — mixing a
high-volume public endpoint with low-volume authenticated admin/AI routes in one service
was the wrong shape, so this cohort page gets its own dedicated backend.

It writes to the **same** `wiredtolaunch` Firestore project/database as `wtl-backend`,
into the same `registrations` collection with the same document shape, just from a
separate Cloud Run service. No Firestore rules or other project data are touched by this
service.

## What's here

- `src/index.js` — Express app: helmet, CORS, JSON body limit, `/health`, mounts the
  register router, graceful `SIGTERM` shutdown for Cloud Run.
- `src/routes/register.js` — validation, per-IP + per-identity rate limiting (with
  bounded tracked-key eviction), the atomic Firestore-transaction duplicate guard, and
  referral code generation. Ported from `wtl-backend/src/routes/register.js` line-for-line
  where the logic is genuinely load-bearing; see "Deviations from `wtl-backend`" below for
  what was intentionally simplified.
- `src/routes/cohortConfig.js` — `GET /api/cohort-config`, public and unauthenticated like
  `/api/register`. Reads the `config/cohort` Firestore doc so Nitish can move the next
  cohort's date (or turn a week off entirely) without a code change or redeploy. Falls back
  to `src/lib/cohortSchedule.js`'s hardcoded weekly-recurring math if the doc is missing or
  malformed. See "Changing the next cohort date" below.
- `src/lib/cohortSchedule.js` — the hardcoded "next Friday 9:00 AM IST" fallback math,
  ported verbatim from `wtl-cohort-landing-v3/src/lib/countdown.ts`'s `nextCohortStart()`,
  used only when `config/cohort` is absent or malformed.
- `src/services/firestore.js` — Firebase Admin init (`applicationDefault()` credential
  resolution, same pattern as `wtl-backend`), minimal: only `initFirebase`, `getDb`, `admin`.
- `test/` — unit tests for validation, the rate limiter's key-eviction logic, the
  duplicate-guard transaction's branches (fresh registration, genuine duplicate, orphaned
  guard recovery, malformed guard, and a simulated concurrent-write race), the cohort
  fallback schedule math, and the cohort-config endpoint's Firestore-present /
  missing-field / doc-absent / read-failure branches, using Node's built-in test runner
  (`node:test`) against an in-memory fake Firestore, no real project or emulator required.
- `Dockerfile` — same shape as `wtl-backend`'s, adapted (no other routes to copy).

## Changing the next cohort date

The next cohort's start date/time, and whether a cohort is scheduled at all that week, is
controlled by a single Firestore document, editable directly from the Firebase Console, no
code change or redeploy needed. `GET /api/cohort-config` (called once by the frontend on
page load) reads this doc and falls back automatically to the hardcoded Friday-recurring
schedule if it's ever missing or malformed, so it's always safe to leave alone if you don't
need an override that week.

**Where:** Firebase Console → project **`wiredtolaunch`** → **Firestore Database** (the
same database `wtl-backend` and this service both already write `registrations` into) →
collection **`config`** → document **`cohort`**.

If the `config` collection or `cohort` document doesn't exist yet, create it: in Firestore
Database, click **Start collection**, collection ID `config`, document ID `cohort`, then
add the two fields below.

**Fields:**

| Field | Type | Meaning |
|---|---|---|
| `nextCohortStart` | **Timestamp** | The exact instant (Firestore stores this as UTC) the next/current cohort window begins. |
| `active` | **boolean** | Whether a cohort is actually scheduled this week. Set `false` for an episode-series week with no standard cohort. |

**Worked example — schedule the next cohort for Friday, August 7th 2026, 9:00 AM IST:**

Firestore's Timestamp field type stores and displays in UTC, so IST times need converting
first. IST is UTC+5:30, so subtract 5 hours 30 minutes from the IST time to get UTC:

```
Friday, August 7th 2026, 9:00 AM IST  →  Friday, August 7th 2026, 3:30 AM UTC
```

In the Firebase Console, set the `nextCohortStart` field's type to **Timestamp** and enter
`2026-08-07T03:30:00Z` (or use the console's date/time picker set to `2026-08-07 03:30:00`
UTC — check which timezone the picker itself is displaying before typing the time in). Set
`active` to `true` (boolean, not the string `"true"`).

**To show "no cohort scheduled" for an episode-series week:** set `active` to `false`
(boolean). You can leave `nextCohortStart` pointing at whatever date it already has, it's
ignored while `active` is `false`.

**How fast does an edit take effect?** The endpoint sends
`Cache-Control: public, max-age=300`, so a browser or CDN may serve a cached response for up
to 5 minutes after you save the edit. Since the frontend only fetches this once per page
load, a visitor who already has the page open won't see the change until they reload.

## Deviations from `wtl-backend`'s `register.js` — and why

1. **CORS origin list is a placeholder.** `wtl-cohort-landing-v3` has not been deployed
   yet (its own `.env.production` has a matching `VITE_API_BASE_URL` placeholder), so its
   real Cloudflare Pages / custom domain isn't known. `src/index.js` has
   `ALLOWED_ORIGINS = ['https://REPLACE_WITH_REAL_COHORT_V3_DEPLOY_DOMAIN.invalid', ...]`
   with a comment. **You must replace this before deploying to production**, or every
   registration request from the real frontend will be rejected by CORS.
2. **No `.pages.dev` wildcard subdomain matching.** `wtl-backend` special-cases
   `*.wiredtolaunch.pages.dev` because that's a real, already-in-use Cloudflare Pages
   project. Once you know this cohort page's actual Pages project name, add the same
   kind of `origin.endsWith('.<project>.pages.dev')` check if you want preview-deploy
   URLs to work too — not added speculatively since the project name isn't known yet.
3. **Single global JSON body limit (32kb), not a two-tier limit.** `wtl-backend` mounts a
   tighter `32kb` limit on `/api/register` specifically and a looser app-wide `10mb`
   limit for its other (AI-facing) routes. This service has no other routes, so the
   `32kb` limit is simply applied globally — there's nothing else that would ever need more.
4. **`firestore.js` drops `getStorage`, `getAuth`, `getFounderScore`, `addScoreEvent`,
   `getLeaderboard`, `saveRevealSnapshot`, `getRevealSnapshot`, and the `storageBucket`
   init option.** All of that exists in `wtl-backend` to support the sprint-tool routes
   this service intentionally does not have. Only `initFirebase`, `getDb`, and the
   `admin` export (needed for `admin.firestore.FieldValue.serverTimestamp()`) remain.
5. **The AiSensy-welcome-message comment was dropped**, not the behavior — the original
   `register.js` never actually sends that message either (it's a documented gap, not
   ported logic), and this service has no `services/aisensy.js` at all, so the comment
   would have been a dangling reference to a file that doesn't exist here.
6. Everything else — validation rules and limits, the rate limiter (including the
   bounded-key-count eviction fix), the atomic transactional duplicate guard, referral
   code generation with collision retry, `trust proxy`, helmet, and the `/health` shape —
   is ported as-is, because it's genuinely load-bearing and specific to this exact bug
   history (see the in-code comments, carried over verbatim).

## Environment variables

See `.env.example`. Locally, `GOOGLE_APPLICATION_CREDENTIALS` must point at a downloaded
service-account JSON key with Firestore access on the `wiredtolaunch` project. On Cloud
Run, do **not** set that variable — `firebase-admin`'s `applicationDefault()` credential
automatically uses whichever service account is attached to the Cloud Run service itself.

## Local development

```
npm install
cp .env.example .env
# edit .env: point GOOGLE_APPLICATION_CREDENTIALS at a real service-account key file
npm run dev
curl http://localhost:8080/health
```

## Tests

```
npm test
```

Runs `node --test`, which auto-discovers `test/*.test.js`. No network access, no GCP
project, and no Firestore emulator required — Firestore itself is stood in for by
`test/fakeFirestore.js`, a small in-memory model of just the surface this service uses
(`collection().doc()/.where().limit().get()`, `doc(path)`, `runTransaction`), including a
`simulateConcurrentWriteAfterSnapshot()` hook used to exercise the genuine
`ALREADY_EXISTS` race-handling branch in `registerWithGuards`.

## Before this ever serves real traffic

1. Replace the `ALLOWED_ORIGINS` placeholder in `src/index.js` with the real
   `wtl-cohort-landing-v3` deploy domain(s).
2. Deploy this service (see below), note the resulting Cloud Run URL.
3. Update `wtl-cohort-landing-v3/.env.production`'s `VITE_API_BASE_URL` to that URL, and
   rebuild/redeploy the frontend.

## Deploying to Cloud Run

Prerequisites: the [`gcloud` CLI](https://cloud.google.com/sdk/docs/install) installed
and authenticated (`gcloud auth login`), with access to the `wiredtolaunch` GCP project.
Run all of the following from this project's root (`D:\wtl-cohort-registration-backend`).

```bash
# 1. Point gcloud at the right project (same project wtl-backend already runs in).
gcloud config set project wiredtolaunch

# 2. One-time: make sure the required APIs are enabled on this project (no-op if they
#    already are, since wtl-backend already runs here).
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

# 3. Find the service account wtl-backend's Cloud Run service already runs as, so this
#    new service uses the SAME account (already has Firestore access on this project,
#    no new IAM grant needed). Copy the printed email for step 4.
gcloud run services describe wtl-backend \
  --region asia-south1 \
  --format="value(spec.template.spec.serviceAccountName)"

# 4. Deploy. --source . builds directly from this project's Dockerfile via Cloud Build,
#    no local Docker install required. --allow-unauthenticated is required: /api/register
#    is a deliberately public, unauthenticated endpoint (same as wtl-backend's).
#    Replace SERVICE_ACCOUNT_EMAIL_FROM_STEP_3 with the value step 3 printed.
gcloud run deploy wtl-cohort-registration-backend \
  --source . \
  --project wiredtolaunch \
  --region asia-south1 \
  --platform managed \
  --allow-unauthenticated \
  --service-account SERVICE_ACCOUNT_EMAIL_FROM_STEP_3 \
  --set-env-vars NODE_ENV=production \
  --memory=256Mi \
  --min-instances=0 \
  --max-instances=10

# 5. gcloud prints the service URL when the deploy finishes, something like:
#      https://wtl-cohort-registration-backend-XXXXXXXXXX.asia-south1.run.app
#    Verify it's actually up:
curl https://wtl-cohort-registration-backend-XXXXXXXXXX.asia-south1.run.app/health

# 6. Use that URL as VITE_API_BASE_URL in wtl-cohort-landing-v3/.env.production, then
#    rebuild and redeploy that frontend so it actually points at this backend.
```

If step 3 comes back empty (no explicit service account set, meaning `wtl-backend` runs
as the project's default compute service account), you can omit `--service-account`
entirely in step 4 — Cloud Run will use that same default compute service account, which
already has Firestore access if `wtl-backend` does.

### Redeploying after a code change

Re-run the same `gcloud run deploy` command from step 4 — Cloud Run creates a new
revision and shifts traffic to it automatically, with zero downtime.
