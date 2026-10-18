# Workstreams

User-facing continuity containers, independent from `keeper_threads`, touchpoints,
and nightly reflection. Areas have at most one child level (applications, sales).
Statuses: active, waiting, parked, done. Completed work remains searchable.

The confirmed snapshot has where/done/blocked/next/owner fields. Automatic reports
are attributed and labelled reported; they never silently change done/status.
Philip can correct snapshots, file/move events (including inbox), change certainty,
and inspect previous text. Snapshot edits preserve the old snapshot in history.
Artifacts accept only HTTP(S). Text is escaped in the browser. No rendered HTML
from reports. Full reports are capped at 20K characters on ingestion.

Chat is still the single existing transcript. Resume adds an explicit workstream
context to the new turn and visibly shows its selection, with a general-chat exit.
Selected chat updates attach automatically. General chat uses unique title/alias
matches; ambiguous or unmatched general chat stays general. Every PC result/error
is saved under a durable job binding, a unique routing match, or the unfiled inbox.
Workers inherit their Prime's binding. Reports are deduplicated by job/event time.
Capture errors are logged and do not prevent normal chat/report delivery; this is
not a transactional outbox, so interrupted capture may need archive recovery.

Persistence: one versioned JSONB `workstreams.v1` document in existing
`keeper_settings`. Atomic revision compare-and-swap retries prevent lost writes;
snapshot form revisions reject stale saves. No new schema, migration, or client
database access. Existing RLS has no anonymous/authenticated policies. The web API
uses the existing shared web-token gate; the service-role key stays server-side.
This is a single-user MVP, not multi-user authorization. A 4MB document bound fails
explicitly rather than discarding history. Larger usage should migrate into
separate workstream/event tables with indexed search. Back up this one key before
any future migration. Storage does not contain VAPID values or other settings.

GET/POST `/api/workstreams` are token-protected, no-store, and excluded from SW
caching. `/workstreams` shell is public but contains no private records. It does
not overwrite the cached chat shell. The shell version hashes the new assets.

Local: `npm run ui` (token 1234); sample data only, no bot polling. Tests exercise
routing ambiguity, idempotency, corrections/moves, HTTP CRUD and stale snapshots.
Production bootstrap recovers only today's matching PC/crew archive reports as
reported claims; it does not claim an application was submitted or a sale listed.

Deployment should use a clean export of HEAD plus only Workstreams feature files;
the separate uncommitted shared-memory pilot must not be shipped incidentally.
