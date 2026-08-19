# Meetings — Backend

**Status: built** (manual-entry path, plus a real Zoom/Google Meet sync integration — see below). Lives in `server/src/routes/meetings.ts` and `server/src/routes/integrations.ts`.

## Data model (as built)

```
meetings
  id            TEXT pk
  org_id        TEXT -> organizations.id
  project_id    TEXT -> projects.id, nullable
  title         TEXT
  summary       TEXT
  participants  TEXT        -- JSON; two shapes coexist, see "Participants" below
  scheduled_at  TEXT
  duration_min  INTEGER
  sync_status   TEXT CHECK IN ('synced','processing','failed'), default 'synced'
  source        TEXT CHECK IN ('zoom','google_meet','manual_upload','other','email_sync'), default 'manual_upload'  -- 'google_meet' added later, 'email_sync' added even later, see below
  external_id   TEXT, nullable        -- provider's meeting/event id, for dedup on re-sync — added later, see below
  created_at    TEXT, default datetime('now')  -- added later, see below

oauth_connections   -- new table, one row per (user, provider)
  id            TEXT pk
  org_id        TEXT -> organizations.id
  user_id       TEXT -> users.id
  provider      TEXT CHECK IN ('zoom','google')
  access_token  TEXT
  refresh_token TEXT, default ''
  expires_at    TEXT
  connected_at  TEXT, default datetime('now')
  UNIQUE(user_id, provider)

meeting_assets   -- new table, real uploaded files (e.g. recordings) attached to a meeting
  id            TEXT pk
  meeting_id    TEXT -> meetings.id
  org_id        TEXT -> organizations.id
  filename      TEXT        -- original upload name, shown in the UI and used on download
  mime_type     TEXT
  size_bytes    INTEGER
  storage_path  TEXT        -- relative path under server/uploads/<meeting_id>/<uuid>-<filename>
  uploaded_by   TEXT -> users.id
  external_id   TEXT, nullable  -- Zoom cloud recording file id, for dedup on re-sync — added later, see below
  created_at    TEXT, default datetime('now')

meeting_tasks    -- new table, per-meeting action items with assignee + due date
  id            TEXT pk
  meeting_id    TEXT -> meetings.id
  org_id        TEXT -> organizations.id
  title         TEXT
  assignee_id   TEXT -> users.id, nullable
  due_date      TEXT, nullable        -- plain date string, e.g. '2026-08-05'
  done          INTEGER, default 0    -- SQLite has no boolean; 0/1
  created_at    TEXT, default datetime('now')
```
No `transcript_url` column yet (no real transcript storage) — `summary` is the only content field, hand-seeded rather than generated. Real synced meetings (via Zoom/Google Meet) also leave `summary` empty — the sync only pulls calendar/meeting-list metadata (title, time, duration), not transcripts, which would need a separate per-meeting API call per provider.

`source`'s CHECK constraint and the new `external_id`/`UNIQUE(org_id, source, external_id)` were added via a full table rebuild in `db.ts` (SQLite can't `ALTER` a CHECK constraint or retrofit a UNIQUE constraint in place — the standard pattern is create-new-table/copy-rows/drop-old/rename, guarded by `PRAGMA foreign_keys = OFF` since `knowledge_documents.source_meeting_id` references `meetings(id)` and SQLite refuses to `DROP TABLE meetings` with FK enforcement on, even mid-rebuild). The migration is idempotent: it checks `sqlite_master` for whether `'google_meet'` already appears in the stored `CREATE TABLE` SQL before running, and drops any leftover `meetings_new` from a prior crashed attempt first.

`created_at` was added after the fact (via an `ALTER TABLE` migration in `db.ts`, since it didn't exist in the original schema) to support the Dashboard's "Today's meeting update" card (see `dashboard/backend.md`), which needed "when was this record logged" — distinct from `scheduled_at`, "when is/was the meeting." `seed.ts` sets it explicitly per meeting rather than relying on the column default.

## Endpoints (as built)

| Method | Path | Status | Notes |
|---|---|---|---|
| `GET` | `/api/meetings?filter=` | ✅ built | `filter` is `all\|this_week\|needs_review`. `this_week` is a real `datetime(scheduled_at) >= datetime('now','-7 days')` query — this is what makes the frontend's "This week" chip actually work now, unlike the old mock. It's a trailing 7-day window with no upper bound, so it also includes future-dated meetings (not just "the last 7 days" literally). `needs_review` maps to `sync_status = 'processing'`. |
| `GET` | `/api/meetings/:id` | ✅ built, wired to the frontend | Now the real payload for `/app/meetings/:id` — extends the list-item shape with `assets: MeetingAsset[]` and `tasks: MeetingTask[]`, each joined to the uploader/assignee's name (and initials, for tasks) so the frontend never needs a separate users lookup for display. |
| `POST` | `/api/meetings` | ✅ built, wired to the frontend | `{ title, summary?, projectId?, durationMin?, scheduledAt?, participantIds? }` — manual entry only, always `sync_status: 'synced'`, `source: 'manual_upload'`. `scheduledAt` defaults to "now" if omitted. Called from `MeetingsPage`'s "+ New meeting" modal. Both `scheduled_at` and `created_at` are written as an explicit JS `toISOString()` timestamp (fixed — see below), not SQL-side `datetime('now')`. `participantIds` (new — see "Participants on manual creation" below) is validated the same way task assignees are and notifies each added participant. |

## Meeting assets — real file uploads (as built)

Lives alongside the rest of `meetings.ts`, using `multer` (disk storage) for multipart parsing — the one new runtime dependency this feature needed, since Express doesn't parse `multipart/form-data` itself. Chosen over links/URLs specifically because the ask was to record a meeting's audio and post the actual recording as an asset, not just point at one.

| Method | Path | Status | Notes |
|---|---|---|---|
| `POST` | `/api/meetings/:id/assets` | ✅ built | `multipart/form-data`, single field `file`. Saves to `server/uploads/<meetingId>/<uuid>-<originalname>` (uuid prefix avoids collisions; original filename is kept for the download and the UI label). 200MB limit — generous for an audio recording without being unbounded. 404s if the meeting doesn't belong to the requester's org. |
| `GET` | `/api/meetings/:id/assets/:assetId/download` | ✅ built | Streams the file via `res.download()`, restoring the original filename. Deliberately **not** a public static file mount (`express.static('uploads')`) — that would let anyone with a guessable path read another org's files. This route re-checks `org_id` + `meeting_id` + `id` against the DB before touching the filesystem. |
| `DELETE` | `/api/meetings/:id/assets/:assetId` | ✅ built | Deletes the DB row and the file on disk (`unlinkSync`). |

`server/uploads/` is gitignored (like `data.sqlite`) — it's local, uploaded content, not something to check in.

## Meeting tasks — action items with assignee + due date (as built)

| Method | Path | Status | Notes |
|---|---|---|---|
| `POST` | `/api/meetings/:id/tasks` | ✅ built | `{ title, assigneeId?, dueDate? }`. `assigneeId`, if given, is validated against `isValidAssignee()` (same "must belong to your org" check used for project ownership in `projects.ts`), and notifies that assignee (see `notifications/backend.md`). |
| `PATCH` | `/api/meetings/:id/tasks/:taskId` | ✅ built | `{ title?, assigneeId?, dueDate?, done?, note? }` — same partial-update pattern as `PATCH /api/projects/:id`. This is what the frontend's checkbox toggle calls (`{ done: true/false, note? }`). Reassigning (the existing `isReassignment` gate — real, non-null, different assignee) also notifies the new assignee. |
| `DELETE` | `/api/meetings/:id/tasks/:taskId` | ✅ built | Hard delete, no soft-delete/archive. Assignee-only, same asymmetry as completion below — see "Delete permission" section. **No UI entry point** as of the frontend's Delete-button removal (direct request); the endpoint itself is untouched and still reachable directly. Also deletes the task's `task_activity` rows first (added once the journey feature existed — see below), since `task_activity.task_id` references this row with `foreign_keys` enforcement on and the delete would otherwise fail with a `FOREIGN KEY constraint` error for any task that's ever had activity logged against it. |

Tasks are ordered `done ASC, due_date IS NULL, due_date ASC` in the `GET /:id` response — open tasks first, then by due date, undated tasks last within each group.

### Completion permission + required reason (as built)
Direct request: only the person a task is assigned to (or, for the platform's admin — deliberately **not built**, see below) should be able to mark it done, and doing so should require a short note explaining what was done.

Asked how "admin" should be determined, since the app had no role/permission concept anywhere (checked — `users` has no `role` column). Answer: skip admin entirely for now, restrict to the assignee only. So `PATCH /:id/tasks/:taskId` enforces two rules, in the `done !== undefined` branch:

```
if (done !== undefined) {
  if (!existing.assignee_id) 403 not_assigned
  if (existing.assignee_id !== req.user!.id) 403 not_assignee
}
```

**Revised after a real bug report**: the first version let anyone mark an **unassigned** task done, on the reasoning that there's no "concerned person" to restrict an unassigned task to. In practice this was the loophole — a user (not the intended person, since the task's title named specific people but its `assignee` field was never set) was able to check it off. Direct request: "I need the concerned person can only mark the task done." Fixed by flipping the default — unassigned tasks are now **locked** (403 `not_assigned`) for everyone, including their own would-be assignee, until someone actually assigns them. This matters in practice, since a large share of auto-extracted tasks (the "Collaboration" block from `meetings/backend.md`'s task-extraction feature) are unassigned by design — those are now uncompletable until triaged with an assignee, which is the intended friction, not a bug. The restriction applies to *both* marking done and reopening (`done: false`), not just completion — toggling either direction on someone else's assigned task is rejected the same way.

**Required reason**: `done === true` additionally requires a non-empty `note` in the body (400 `note_required` if missing or blank after trimming). The note is stored in a new `meeting_tasks.completion_note` column and serialized as `completionNote` everywhere a task is returned (`GET /meetings/:id`, `GET /tasks`). Reopening a task (`done: false`) clears `completion_note` back to `NULL` — the note narrates one specific completion, not the task in general, so it shouldn't linger stale if the task gets reopened and later redone with a different note.

Verified via curl end-to-end: marking a task done as a non-assignee → 403 `not_assignee`; marking done as the real assignee with no `note` → 400; same request with a note → 204, `completionNote` correctly reflected on the next `GET`; reopening → `completionNote` back to `null`; an **unassigned** task → 403 `not_assigned` for every user, no exceptions.

### Delete permission (as built, then UI-removed)
Direct follow-up, asked after the completion lock: "why is there a Delete option at all" surfaced that `DELETE /:id/tasks/:taskId` had no permission check whatsoever — any org member could delete anyone's task, assigned or not, no confirmation. Fixed with **one deliberate asymmetry from completion**: an assigned task can only be deleted by its assignee (`403 not_assignee` otherwise), but an **unassigned** task stays deletable by anyone — unlike completion, deletion doesn't get the "locked until assigned" treatment, because that would make cleaning up a bad auto-extracted task (which is nobody's responsibility yet) require assigning it to yourself first just to unlock the button. Also added a native `window.confirm()` on the frontend before the request fires, since there was none before.

```
if (existing.assignee_id && existing.assignee_id !== req.user!.id) {
  403 not_assignee
}
```

Verified via curl: deleting a task assigned to someone else (Faizan, as Ambika) → 403; deleting a disposable unassigned test task → 204.

Shortly after, direct request: **"let's remove the delete option for the time being"** — the Delete button (and its `canDelete`/`handleDelete` wiring) was removed from both `TasksPage.tsx` and `MeetingDetailPage.tsx`. This endpoint and its permission check were left in place server-side; only the UI entry point is gone.

### Reassignment reason + task activity log (as built)
Direct request, describing a concrete flow: after picking a new assignee on `TasksPage.tsx`'s inline `<select>`, a field should "pop up" for a reason before it saves, a confirmation should follow, and "this journey" (assignment + completion history) should be viewable somewhere. Asked where the journey should be viewed — answer: expand the task row itself, no new page or modal.

**New table**, added directly to `db.ts`'s initial `CREATE TABLE IF NOT EXISTS` block (a genuinely new table needs no `ALTER`/backfill migration, unlike every other change in this file):

```sql
CREATE TABLE IF NOT EXISTS task_activity (
  id, org_id, task_id, actor_id,
  action      TEXT CHECK (action IN ('assigned','done','reopened')),
  assignee_id TEXT,  -- who it was assigned to ('assigned'), or the assignee at the time ('done'/'reopened')
  reason      TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
)
```

**`PATCH /:id/tasks/:taskId` gained a `reason` field and a new rule**, evaluated before any `UPDATE` runs: actually reassigning to a *different*, *non-null* assignee (not clearing, not re-selecting the current one) requires a non-empty `reason` (400 `reason_required` otherwise) — clearing an assignee needs no justification, since there's no one to explain it to. On success, the handler writes one `task_activity` row (`action: 'assigned'`) with the new assignee and reason. The existing `done`/reopen branch got the same treatment — every `done` change (not just marking done, reopening too) now also writes a `task_activity` row (`action: 'done'` or `'reopened'`), reusing the already-required completion `note` as that entry's `reason` (`null` for reopens, since no reason is collected there).

**New read endpoint**, `GET /:id/tasks/:taskId/activity`, returns `{ items: [{ id, action, actorName, assigneeName, reason, createdAt }] }` ordered oldest-first — joins `task_activity` to `users` twice (once for the actor, once for the assignee-at-the-time) so the frontend never has to resolve ids to names itself.

Verified via curl end-to-end: reassigning without a `reason` → 400 `reason_required`; with one → 204, and `GET .../activity` immediately shows the `assigned` entry with the right actor/assignee/reason; marking the same task done afterward adds a second `done` entry to the same log, in order.

Direct request: a top-level "Tasks" nav tab (to the right of "Knowledge Base") showing every task across every meeting in one place, not just per-meeting inside `MeetingDetailPage.tsx`.

Lives in `server/src/routes/tasks.ts`, mounted at `/api/tasks` — a **read-only aggregation** router, deliberately separate from `meetings.ts`. It adds exactly one new endpoint:

| Method | Path | Status | Notes |
|---|---|---|---|
| `GET` | `/api/tasks?filter=&assigneeId=&meetingFrom=&meetingTo=&dueFrom=&dueTo=` | ✅ built | `filter` is `all\|open\|done`. Joins `meeting_tasks` → `meetings` (for `meetingTitle` and `meetingScheduledAt`) → `users` (for assignee name/initials). Returns `{ items, counts }`; `counts` are always computed from the *whole org's* tasks regardless of the active `filter` (a second, unfiltered-by-`filter` query) — same reasoning as `knowledge.ts`'s type counts, so every filter chip shows its own total at once rather than only the currently-selected one. `m.scheduled_at AS meeting_scheduled_at` (serialized as `meetingScheduledAt`) exists because the frontend's no-due-date fallback was showing `t.created_at` (row-insert time — sync/backfill time for auto-extracted tasks, not any date tied to the actual meeting), which read as visibly wrong. `assigneeId`/`meetingFrom`/`meetingTo`/`dueFrom`/`dueTo` are additive (`AND`ed onto whatever `filter` chip is active, not exclusive of it) and applied to both the item list and the counts query via a shared `applyExtraFilters()` helper — same "counts respect every active narrowing" principle as everything else on this page. `meetingFrom`/`meetingTo`/`dueFrom`/`dueTo` are bound params, not string-interpolated.

`filter=mine`, `filter=due_this_week`, and finally `filter=overdue` (and their `counts.mine`/`counts.dueThisWeek`/`counts.overdue`) **all existed briefly, then were removed one at a time**, each per direct request, once the `Assignee` dropdown and `Due date` range picker made the chips redundant with a more general control already on the page. "Assigned to me" was a clean 1:1 trade (pick your own name in `Assignee`); "Due this week" wasn't quite (the `Due date` picker's presets are backward-looking, "Last 7 days" not "next 7 days," so reproducing it now takes a manual range selection instead of one click) — that tradeoff was explained and accepted. "Overdue" was flagged as the one chip *without* a real equivalent (it's `due_date < today`, a moving target no fixed date-range preset can express), but removed anyway on request — the row-level red-highlighting of overdue due dates (`isOverdue()` in `TasksPage.tsx`) is untouched, so overdue tasks are still visually distinguishable, just no longer filterable as their own chip.

**No new write endpoints** — mutating a task (toggle done, delete) reuses the existing `PATCH /api/meetings/:id/tasks/:taskId` and `DELETE /api/meetings/:id/tasks/:taskId` from above verbatim. `GET /api/tasks` includes `meetingId` on every task specifically so the frontend can call those existing per-meeting routes without needing a new parallel set of mutation endpoints — one source of truth for how a task gets updated, whether you're looking at it from `MeetingDetailPage.tsx` or the new cross-meeting `TasksPage.tsx`.

Verified via curl: created a task on a meeting, confirmed it appears in `GET /api/tasks` with the correct `meetingTitle`/`meetingId`, and that `counts` reflect org-wide totals correctly under each filter.

## Auto-task extraction from synced meeting-summary emails (as built)
Direct request: after a meeting asset syncs, auto-create real tasks (assignee + due date) instead of leaving action items buried in an excerpt no one reads. Investigated what's actually extractable first: Zoom cloud recordings (`meeting_assets`) are just video/audio/transcript **files** with no server-side parsing — the only place structured, task-shaped text already exists is the Gmail-synced Zoom AI Companion meeting-summary emails, which have a `Next steps <Name> / - <item>` section per person. There's no LLM anywhere in this app (see `ask-the-record/backend.md`), so this is a **heuristic text parser tailored to that exact template**, not general NLP — it will misparse or extract nothing from content that doesn't match this shape. That tradeoff was surfaced and accepted explicitly before building this.

Lives in `server/src/routes/integrations.ts`, run automatically at the end of `POST /api/integrations/gmail/sync` for every message — no separate endpoint or user action.

**The gap this had to solve first:** Gmail-synced summary emails and Zoom/Google Meet-synced meetings are two completely independent syncs with no link between them (`knowledge_documents.source_meeting_id` existed but nothing ever populated it — a gap called out in `knowledge-base/backend.md`). A task needs a real `meeting_id` (`meeting_tasks.meeting_id` is `NOT NULL`), so `findOrCreateMeetingForEmail()`:
1. Extracts a meeting name from the subject (`extractMeetingNameFromSubject()` — "Fwd: Meeting assets for Navedas Intelligence are ready!" → "Navedas Intelligence").
2. Prefers a real meeting (any source) with a matching title on the same calendar day, if one exists — tasks correctly attach to an actual Zoom/Google Meet-synced meeting when the two syncs happen to line up.
3. Otherwise reuses a meeting this function already auto-created for this exact email on a prior sync (dedup via a new `source: 'email_sync'` value on `meetings.source`'s CHECK constraint, keyed by `external_id` = the Gmail message id — same table-rebuild migration pattern as the earlier `'google_meet'` addition).
4. Otherwise creates one: title from the subject, `scheduled_at` = the email's own date, `duration_min: 30` (no real duration signal available), `source: 'email_sync'`.

Once the meeting is resolved, `knowledge_documents.source_meeting_id` is backfilled — closing that previously-documented gap as a side effect, not the main point.

**Parsing (`parseNextStepsBlocks()`):** the template alternates blank-line-separated blocks — a person's name alone, then their bullets, then the next name, then their bullets — starting right after the literal string `"Next steps "`. A block is treated as a per-person heading only if it's one or two capitalized words (`NAME_HEADING_RE`); the loop stops at the first heading whose following block isn't purely bullet-formatted, which is how it naturally stops at the template's free-form `"Summary <Title>"` prose sections. `"Collaboration"` (the template's shared/multi-person section) passes the same heading check but is special-cased: its bullets are kept verbatim and left **unassigned** rather than misattributed to "Collaboration" as if it were a person.

**Assignee matching + auto-account-creation (`findOrCreateAssigneeByFirstName()`):** matches the block's name against this org's registered users by first name (exact, or `"Name %"` for full names). Ambiguous (>1) matches fall back to unassigned — an ambiguous guess assigning to the wrong person is worse than leaving it unassigned. **Zero matches auto-create a lightweight account** (direct request, after the first version of this feature shipped and most names — coworkers mentioned by first name, not the Gmail inbox owner — had no account to assign to, since assignees have always had to be real registered users). There's no email in the source text to invite them properly (see `/users/invite`), so a synthetic, unusable one is generated (`<firstname>.auto-<random>@placeholder.internal`) along with an unrecoverable random password — the account exists purely so the task has somewhere real to point to, not so that person can log in. Subsequent mentions of the same name find and reuse this same account via the same first-name match, so one person mentioned across many meetings gets one account. The parsed name is kept in the task title (`"<Name>: <item>"`) only in the two cases where no single account gets resolved — an ambiguous name, or the "Collaboration" block — precisely so that context isn't lost just because the assignee field says "Unassigned".

**`NAME_ALIASES`**: exact-match-only lookup means two spellings of the same real person's name are two different people to this function — Zoom AI Companion transcribed one person as both "Pulak" and "Pullak" across different meetings, and another as both "Lupita" and "Lopita," each pair auto-creating a duplicate account. Discovered directly by the user, who confirmed the pairing and asked for the duplicates merged. One-off cleanup (not a migration, a throwaway script run once): reassigned every `meeting_tasks.assignee_id` / `task_activity.actor_id`/`assignee_id` / `knowledge_documents.owner_id` / `projects.owner_id` / `meeting_assets.uploaded_by` / `oauth_connections.user_id` pointing at the duplicate over to the canonical account, rewrote any `meetings.participants` JSON array containing the duplicate's id, then deleted the two duplicate `users` rows. Verified via the API: task counts moved intact (Pullak 18→20, Lopita 26→29, org-wide total unchanged at 365) and both duplicate names dropped out of every assignee dropdown.

That alone doesn't stop it from recurring — a future sync hitting the literal string "Pulak" in a summary email would auto-create a *new* duplicate, since the lookup has no memory of the merge. Direct follow-up: added `NAME_ALIASES`, a small hardcoded `{ pulak: 'Pullak', lupita: 'Lopita' }` map checked before the org lookup — `findOrCreateAssigneeByFirstName()` substitutes the alias (case-insensitively) before matching or creating, so "Pulak" now resolves straight to the real Pullak account instead of round-tripping through a new placeholder. Deliberately not a general fuzzy-name-matching system or a DB-backed alias table with its own UI — just the two known pairs, since guessing at *unknown* misspellings risks silently assigning to the wrong person, which is exactly the failure mode `findOrCreateAssigneeByFirstName()`'s ambiguous-match handling already refuses to do. Verified by replaying the exact lookup query with the alias substitution applied: both aliases resolve to exactly one match (the real merged accounts), confirming the function will route through rather than auto-create.

**Repairing already-extracted tasks:** the dedup branch (task already exists for this `external_id`) doesn't just skip — if the existing task is still `Unassigned` and a real assignee can now be resolved (e.g. it was extracted before auto-account-creation existed, or a name was ambiguous then but resolves cleanly now), it updates `assignee_id` and strips the title prefix in place. Never touches a task if its `assignee_id` is no longer `NULL` — a person's manual reassignment away from Unassigned is never overwritten by a later sync.

**Due dates (`resolveDueDate()`):** looks for `"today"`, `"tomorrow"`, or a weekday name in the item's own text and resolves it against the email's date as the anchor (the closest available signal to "when this was actually said" — there's no meeting transcript timestamp). No date phrase found → `null`, not a guess.

**Idempotency:** each extracted task gets a deterministic `external_id` of `"${gmailMessageId}:${bulletIndex}"`, checked before insert — re-syncing the same email (or re-running extraction) never recreates the same tasks, since `parseNextStepsBlocks()` produces the same bullet order every time for the same immutable email content. Required a new nullable `meeting_tasks.external_id` column (`NULL` for manually-created tasks).

**Verified**, since Gmail's OAuth token had expired mid-build (no refresh logic yet — a known, previously-documented gap) and a live re-sync wasn't available: wrote a temporary script that called the real `syncTasksFromSummaryEmail()` directly (not a reimplementation) against real stored excerpts already in the database, backfilling all 24 already-synced emails. Result: 322 tasks created across 23/24 emails (the 24th had already been covered by an earlier single-doc test run), 0 genuinely malformed titles (checked for leftover bullet markers, stray newlines, double-spaces) on manual inspection of the full set, due dates resolved correctly against each email's own weekday (e.g. a Monday-dated email correctly resolved "today"→same day, "tomorrow"→+1 day, "Wednesday"→+2 days), a real registered user (an org member added earlier via the invite flow) got correctly assignee-matched, unmatched names correctly fell back to unassigned with the name preserved in the title, and re-running the whole backfill a second time created zero additional tasks (idempotency holds). Confirmed live in the browser: the new `meetings` rows show a `"From synced email"` badge (added `email_sync` to `sourceLabel` in `meetings/frontend.md`) and their auto-extracted tasks render correctly on both the per-meeting detail page and the cross-meeting `/app/tasks` page.

**Auto-account-creation + repair verified separately**, same temporary-script technique, re-run against the same 24 emails after that feature shipped: unassigned tasks dropped from 233 to 63, 11 new lightweight accounts got created (one per distinct real name that had no existing account — Faizan, Lopita, Pullak, Sunita, Deepika, Shakti, Lupita, Salim, Aurosmita, Prangya, Pulak), total task count stayed at exactly 322 (no duplicates from the repair pass), and the 63 still-unassigned tasks were manually spot-checked to confirm they're genuinely multi-person "Collaboration" bullets (e.g. `"Sunita, Rashmibala, Aurosmita: Complete the small EVA changes..."`), not a matching failure. Note "Pulak" and "Pullak" ended up as two separate accounts — different spellings across different meetings' transcriptions of what's almost certainly the same real person — a known, accepted risk of this approach (see Open gaps).

## Zoom / Google Meet sync (as built — Approach A: OAuth + manual "Sync now")

Lives in `server/src/routes/integrations.ts`, mounted at `/api/integrations`. This is the "minimal viable" approach out of three considered during an `/office-hours` session (OAuth+button vs. webhook-driven live sync vs. scheduled polling) — chosen because it proves the real OAuth+API integration end-to-end without needing a publicly reachable webhook endpoint, which a `localhost` dev server can't provide. Webhook-driven sync (Zoom `recording.completed`, Google Workspace Events API) is the natural next step once this is deployed somewhere with a public URL — see Open gaps.

| Method | Path | Status | Notes |
|---|---|---|---|
| `GET` | `/api/integrations` | ✅ built | Per-provider status: `{ configured, connected, connectedAt }` for `zoom` and `google`. `configured` reflects whether this *server* has OAuth app credentials set (env vars) — independent of whether *this user* has connected their account. |
| `GET` | `/api/integrations/:provider/connect` | ✅ built | Redirects the browser to the provider's OAuth consent screen. 503s with a plain-text error if the server has no client id/secret configured for that provider. Must be a real browser navigation (`<a href>`), not a `fetch` — the whole point is the browser lands on Zoom's/Google's own login page. |
| `GET` | `/api/integrations/:provider/callback` | ✅ built | Provider redirects back here with `?code=...&state=...`. Exchanges the code for tokens, stores them in `oauth_connections`, then redirects the browser to `${FRONTEND_URL}/app/meetings?integration=zoom\|google&status=connected\|error`. |
| `DELETE` | `/api/integrations/:provider` | ✅ built | Disconnects — deletes the stored token row. Does not revoke the token with the provider (out of scope for this pass). |
| `POST` | `/api/integrations/sync` | ✅ built | Pulls meetings from every provider the requesting *user* has connected and upserts them into the shared `meetings` table. For Zoom meetings, also checks for a finished cloud recording and downloads any new files into `meeting_assets` (see "Zoom cloud recording sync" below). 400s with `no_connections` if the user has connected nothing. Per-provider try/catch — one provider failing doesn't block the other; response is `{ results: { zoom?: {imported, recordingsImported, error}, google?: {imported, recordingsImported, error} } }`. |
| `POST` | `/api/integrations/zoom/webhook` | ❌ not built | Would be Approach B (webhook-driven live sync) — see Open gaps. |

### OAuth mechanics
- **CSRF protection**: `createState()`/`consumeState()` in `integrations.ts` — a random token mapped to `{userId, orgId, provider, expiresAt}` in an in-memory `Map`, 5-minute TTL. Fine for a single-process dev backend; would need a shared store (Redis, or a DB table) behind a load balancer with multiple instances.
- **Config is read lazily**, not into module-level `const`s. `index.ts` calls `process.loadEnvFile('.env')` (Node's built-in env-file loader, no `dotenv` dependency needed) as its own top-level code — but ESM evaluates every static import, including `integrations.ts`, *before* any of `index.ts`'s own top-level statements run. A module-level `const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID` would have permanently captured `''`. Fixed by wrapping all env reads in a `config()` function called at request time, well after `.env` has loaded.
- **Zoom**: `zoom.us/oauth/authorize` → `zoom.us/oauth/token` (Basic auth with client id:secret) → `GET api.zoom.us/v2/users/me/meetings?type=scheduled` for the meeting list (id, topic, start_time, duration), then one `GET api.zoom.us/v2/meetings/{id}` per meeting for `agenda` (→ `summary`) and `settings.meeting_invitees` (→ participant emails) — the list endpoint doesn't include either.
- **Google**: `accounts.google.com/o/oauth2/v2/auth` (scope `calendar.readonly`, `access_type=offline&prompt=consent` to force a refresh token every time) → `oauth2.googleapis.com/token` → `GET calendar/v3/calendars/primary/events`, filtered to events with a `hangoutLink` or `conferenceData.conferenceSolution.name === 'Google Meet'`. Unlike Zoom, `description` (→ `summary`) and `attendees` (→ participant emails) are already in this same list response — no extra per-event request needed.
- **Dedup on sync**: each external meeting is upserted by `(org_id, source, external_id)` — re-running sync updates existing rows (title/time/duration, `sync_status` reset to `'synced'`) rather than duplicating them.
- **`.env` is optional**: `server/.env.example` documents `ZOOM_CLIENT_ID`/`SECRET`, `GOOGLE_CLIENT_ID`/`SECRET`, and the redirect URIs. Without a real `.env`, `configured: false` for both providers and the frontend shows "not configured" instead of a broken Connect button — this was a deliberate scaffolding choice (see the office-hours session) since real OAuth app credentials are something only the user can register with Zoom/Google, not something that can be fabricated.

### Zoom cloud recording sync (as built)
After a Zoom meeting ends, if it was recorded to Zoom's cloud, the host gets access to the recording/transcript/chat log via Zoom's Cloud Recording API. `POST /sync` now pulls these in automatically for every Zoom meeting it upserts, reusing the exact same `meeting_assets` table and storage path (`server/uploads/<meetingId>/`) that manual asset uploads use (see the Meeting assets section above) — a synced recording and a manually-uploaded recording look identical to the frontend.

- **`fetchZoomRecordings()`**: `GET api.zoom.us/v2/meetings/{zoomMeetingId}/recordings` → `recording_files[]`, each with an `id`, `file_type` (`MP4`/`M4A`/`TRANSCRIPT`/`CHAT`/`CC`), `recording_type` (e.g. `shared_screen_with_speaker_view`, `audio_only`), a `download_url`, and `file_size`. A `404` (no recording yet, or cloud recording not enabled on this Zoom account/plan) is treated as "nothing to import," not an error — most free/personal Zoom accounts don't have cloud recording at all, so this may legitimately import 0 recordings even when it works correctly.
- **`storeZoomRecording()`**: downloads each file via its `download_url` (Bearer token auth, same as every other Zoom call here), writes it to `server/uploads/<meetingId>/<uuid>-<label>`, and inserts a `meeting_assets` row with `external_id` set to Zoom's recording-file `id`. Dedup is a plain `SELECT` before download — re-running sync skips files already stored rather than re-downloading them.
- **Filename/mime type**: since Zoom doesn't give a nice display name, `labelForRecording()` builds one from the recording type + file type (e.g. `"Zoom shared screen with speaker view (MP4).mp4"`), and `RECORDING_MIME_TYPES` maps `file_type` → a real MIME type for the browser (`MP4` → `video/mp4`, `TRANSCRIPT`/`CC` → `text/vtt`, `CHAT` → `text/plain`, unknown types fall back to `application/octet-stream`).
- **Extra scope required**: needs `recording:read:list_user_recordings` (or Zoom's current equivalent name — scope naming has shifted across API versions) added on the Zoom app's Scopes tab, in addition to the `meeting:read:list_meetings` scope already needed for the meeting list. A user who connected before this scope was added will need to disconnect and reconnect Zoom to get a token that actually carries it.
- **`UPLOADS_ROOT` was extracted into `server/src/uploadsPath.ts`** so both `meetings.ts` (manual uploads) and `integrations.ts` (recording sync) compute the same path once instead of duplicating the relative-path math.

### Participants (two coexisting formats)
`meetings.participants` stores different shapes depending on when/how a row was written, and `resolveParticipants()` in `meetings.ts` normalizes both into the same output — `{ userId, name, initials, email }[]` — before the API ever serializes a response:
- **Legacy shape (seed.ts, and — until the change below — every manually-created meeting)**: a plain JSON array of internal `users.id` strings, e.g. `["uuid1","uuid2"]`. Resolved by looking each id up against `users` at read time (`email` comes back `null` for this shape — it was never needed before, so it isn't stored).
- **Descriptor shape (real Zoom/Google sync, via `buildParticipants()` in `integrations.ts`)**: a JSON array of descriptor objects. External invitees are just email addresses — some match an org member by email (enriched with `userId`/`initials`), others are genuine outside guests and stay as email-only entries (`userId: null`). The connecting user (the person who ran the sync) is always included, since Zoom's `meeting_invitees` and Google's `attendees` are typically "everyone else," not the host. (Renamed from `buildParticipantsJson()` — now returns the raw descriptor array, not a pre-stringified string, so `upsertSyncedMeeting()` can also inspect it for real `userId`s to notify; see `notifications/backend.md`.)

No DB migration was needed for this — both shapes were already just opaque JSON in a `TEXT` column; the normalization lives entirely in the read path.

### Participants on manual creation (as built)
Direct request, alongside adding task/meeting notifications: "the meeting scheduled ... also needs to be visible as the notification ... to the concerned member." Manual meetings had zero participant data before this — `POST /meetings` hardcoded `participants: '[]'`, and the "+ New meeting" form never collected any. Asked whether to scope meeting notifications to synced meetings only (where real participant data already existed) or also add participant selection to manual creation — confirmed the latter.

`POST /meetings` now accepts `participantIds?: string[]`, de-duplicated (`new Set(...)`) and validated one at a time with the same `isValidAssignee()` check task assignment already used, before anything is written — one invalid id 400s the whole request rather than silently dropping it. Stored using the **legacy** plain-array-of-ids shape (not the richer descriptor shape sync meetings use) — a manually created meeting has no external-guest-email concept, only real org members, so the simpler shape `resolveParticipants()` already handles is a natural fit with no schema or normalization changes needed. After the insert, every participant except the creator gets notified (see `notifications/backend.md`).

### OAuth callback doesn't use requireAuth (bug found via ngrok/tunnel testing)
`GET /zoom/callback` and `GET /google/callback` were originally covered by `integrationsRouter.use(requireAuth)` like every other route. That works fine when everything's on `localhost`, but breaks the moment the callback is reached via a different domain than where the session cookie was set — which happens whenever local OAuth testing uses an HTTPS tunnel (ngrok, ssh -R, etc., needed because Zoom rejects `http://localhost` redirect URIs outright): the browser lands on the *tunnel's* domain, which never had the `record_session` cookie set on it, so `requireAuth` 401s before the callback can even exchange the code. **Fix:** `requireAuth` moved from router-level to per-route — every route except the two callbacks. The callbacks authenticate the request via the OAuth `state` param instead (`consumeState()`, already resolving to `{userId, orgId}`), which is exactly what `state` exists for and was already being generated — it just wasn't being used as the *sole* auth mechanism until this fix.

## Auth
`requireAuth`, scoped to `req.user.org_id`. Applied per-route in `integrations.ts` (not router-wide) — see above.

## Seed data includes one future meeting
"Q3 Roadmap — Sprint Planning" is seeded ~2 days ahead of "now" (negative `daysAgo` in `seed.ts`) — added specifically so the Dashboard's "Next event" card (see `dashboard/frontend.md`) has real upcoming data to show, since every other seeded meeting is today-or-past.

## Date-comparison bug fixed here too
The `this_week` filter's SQL was affected by the same JS-ISO-vs-SQLite-datetime format mismatch documented in `dashboard/backend.md` — fixed the same way, by wrapping the column in `datetime(...)` before comparing.

## Bug found + fixed: `POST /api/meetings` wrote timestamps in the wrong format
Previously wrote both `scheduled_at` and `created_at` using SQL-side `datetime('now')`, while `seed.ts` writes both using JS's `toISOString()`. This is the same bug documented in `projects/backend.md` (discovered there first, while wiring up "+ New project") — a `Z`-less, space-separated SQL timestamp gets misread as local time by the frontend's `new Date(iso)`, producing a wrong "time ago" display. Fixed by writing `new Date().toISOString()` explicitly for both columns, same as every other write path in the app.

## Open gaps
- No transcript *view* — the VTT transcript file, when Zoom's cloud recording produces one, downloads as a plain asset like any other file (download-only, no in-app rendering/search of its contents).
- Zoom recording sync only ever finds anything on accounts with cloud recording enabled (paid/admin-enabled) — most personal/free Zoom accounts won't produce any recordings to import, so this may need a real paid account to verify end-to-end.
- No polling/retry for "recording still processing" — if `/sync` runs before Zoom finishes processing a just-ended meeting's recording, that sync gets nothing; the user has to click "Sync now" again later once Zoom's processed it. No background job checks automatically.
- Participant emails are matched to org users by exact (case-insensitive) email match only — no fuzzy matching, so a Zoom/Google invitee using a different email than their org account (e.g. a personal Gmail vs. work email) shows up as a separate email-only entry instead of being recognized as that org member.
- No de-duplication across syncs beyond the meeting level — if the same external guest's email appears differently cased or with extra whitespace across two different sync runs for the *same* meeting, `buildParticipantsJson` rebuilds the whole list fresh each time (it doesn't merge with what was there before), so this isn't actually a risk in practice, but worth noting as a design choice rather than an oversight.
- No token refresh logic — access tokens expire (~1hr for both providers) and there's no refresh-before-expiry path yet, so `/sync` will start failing for a connection until the user disconnects/reconnects. The `refresh_token` is stored but unused.
- Webhook-driven live sync (Approach B from the office-hours session) is the natural upgrade once this is deployed with a public URL: Zoom `recording.completed`/`meeting.ended` webhooks and the Google Workspace Events API would make `sync_status` mean something real (`processing` while a transcript is fetched, `failed` on webhook error) instead of always being `'synced'` the moment a meeting lands.
- Disconnecting (`DELETE /api/integrations/:provider`) deletes the local token but doesn't revoke it with the provider.
- Asset storage (`server/src/storage.ts`) defaults to local disk but is opt-in switchable per-deployment: `BLOB_READ_WRITE_TOKEN` routes uploads to Vercel Blob, or `FILE_STORAGE=postgres` stores them as rows in a `file_blobs` table — either is required once deployed somewhere with an ephemeral/serverless filesystem (e.g. Vercel), since local disk alone silently loses every uploaded file there. The Postgres option is a real tradeoff, not a free upgrade: fine for avatars/documents (a few MB), a poor fit for meeting recordings (up to 200MB) since large blobs bloat Postgres's WAL. See `server/.env.example`.
- No file-type restriction on uploads (any mime type is accepted) — reasonable for a demo, would want a stricter allowlist (audio/video types) in a real product to reduce the attack surface of arbitrary uploads.
- No permission check beyond "authenticated in this org" on assets, or on a task's `title`/`assigneeId`/`dueDate` fields — any org member can upload/delete any meeting's asset, or reassign/retitle/reschedule any task (including one assigned to someone else). Only `done` (completion) and the task-level `DELETE` are assignee-gated — see the two "as built" sections above.
- Auto-task extraction is a heuristic parser tied to one specific email template (Zoom AI Companion's "Next steps" format) — it silently extracts nothing from any summary email that doesn't match this shape, rather than partially extracting or erroring. A genuinely different meeting-notes format (a different tool, a manually-written summary) would need its own parser or, more robustly, a real LLM-based extraction step (this app has none — see `ask-the-record/backend.md`).
- The "Collaboration" (shared/multi-person) section's bullets are always left unassigned by design — no attempt is made to parse "Faizan and Pullak: <action>"-style multi-name prefixes into multiple per-person tasks.
- Auto-created `email_sync` meetings always get `duration_min: 30` — there's no real duration signal in a summary email to use instead.
- No UI to review/undo a batch of auto-extracted tasks — they land directly in `meeting_tasks` and are only removable one at a time from `TasksPage.tsx` or `MeetingDetailPage.tsx`, same as any other task. At real-world volume (322 tasks were extracted from 24 already-synced emails during verification) a bulk-review or bulk-delete tool would be a natural next step.
- Auto-created accounts (`findOrCreateAssigneeByFirstName()`) match purely on first name with no way to tell two different real people apart if they share one (would incorrectly collapse into a single account), and no way to tell that two *different* spellings of the same name ("Pulak" vs "Pullak", observed directly in real synced data) are the same real person (creates two accounts instead of one). No merge/rename UI exists to fix either case after the fact — would need to manually reassign affected tasks and delete the duplicate account today.
- Auto-created accounts have an unusable synthetic email + random unrecoverable password — there's no path today to convert one into a real, loggable-in account (e.g. if that person actually wants to join the platform, someone would need to use `/users/invite` with a real email, which would create a *second*, separate account rather than upgrading the auto-created one).
- No visual distinction in the UI between an auto-created "placeholder" account and a real invited/signed-up one — both just show as a name + initials in every assignee dropdown and task row.
