# Dashboard — Backend

**Status: built.** Lives in `server/src/routes/dashboard.ts`. Three endpoints, real SQL aggregation over `projects`, `knowledge_documents`, and `meetings` (via `nextEvent` only now — see below). No denormalized snapshot tables yet (see gaps below).

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/dashboard/summary` | No query params. Everything below, scoped to `req.user.org_id`. |
| `GET` | `/api/dashboard/task-calendar?month=YYYY-MM` | `month` optional, defaults to the current month if omitted or malformed. See "Task calendar + Leave calendar" below. |
| `GET` | `/api/dashboard/leave-calendar?month=YYYY-MM` | Same `month` handling. |

### Response shape (as built)
```jsonc
{
  "user": { "name": "Ambika" },
  "org": { "name": "Navedas" },
  "projects": [ /* top 4 by updated_at: id, name, status, updatedAt, docCount, owner: { name, initials } */ ],
  "taskOverview": {
    "totalItems": 366,
    "completionRatePct": 0,            // done_count / totalItems, rounded — round(1/366*100) = 0
    "overdueCount": 31,
    "breakdown": [                     // always these three statuses, in this order, even at count 0
      { "status": "open", "count": 334, "pct": 91 },
      { "status": "overdue", "count": 31, "pct": 8 },
      { "status": "done", "count": 1, "pct": 0 }
    ]
  },
  "documentsByType": { "totalItems": 12, "breakdown": [{ "type": "sop", "pct": 42 }, ...] },
  "upcomingHolidays": [                // date >= today, ascending, capped at 10
    { "date": "2026-08-15", "name": "Independence Day" },
    { "date": "2026-09-01", "name": "Company Foundation Day" }
  ],
  "nextEvent": {                       // null if no meeting has scheduled_at in the future
    "id": "...", "title": "Q3 Roadmap — Sprint Planning", "project": "Q3 Roadmap",
    "scheduledAt": "2026-07-31T10:36:01.350Z", "durationMin": 45
  },
  "todaysMeetingUpdate": {             // null if the org has no meetings at all
    "id": "...", "title": "Rollback Runbook — Weekly Sync", "summary": "...",
    "project": "Rollback Runbook", "scheduledAt": "2026-07-29T11:15:11.865Z", "syncStatus": "synced"
  },
  "mostPopularContent": {              // null until Ask The Record has cited at least one doc
    "id": "...", "title": "Rollback Runbook — Ownership & Escalation Path",
    "type": "sop", "project": "Rollback Runbook", "viewCount": 2
  }
}
```
`nextEvent` — soonest meeting with `datetime(scheduled_at) > datetime('now')`, left-joined to `projects` for the project name. `null` if nothing's scheduled ahead.

**Frontend no longer renders `todaysMeetingUpdate`, `mostPopularContent`, or `documentsByType`** — direct request to remove those three dashboard sections (see `dashboard/frontend.md`'s "Removed later" note). Deliberately left computing and returning all three here rather than trimming the response — same "remove the UI, leave the endpoint" pattern already used elsewhere in this app — so re-adding a UI for any of them later wouldn't need backend work.

`todaysMeetingUpdate` — the meeting with the most recent `created_at` (`ORDER BY datetime(created_at) DESC LIMIT 1`), regardless of whether it's past or future. Named "today's" per the user's request, but it's really "most recently logged," not literally filtered to today — see Known gaps.

`mostPopularContent` — the `knowledge_documents` row with the highest `view_count` (`WHERE view_count > 0 ORDER BY view_count DESC LIMIT 1`). `null` on a fresh DB where nothing has view_count > 0 yet.

## Deviations from the original spec
- No `freshnessDeltaPct` / `deltaPctThisMonth` fields — the "+6%"/"+12%" pills in the original mock implied a comparison against a prior period, but there's no historical snapshot table to diff against. Dropped rather than faked.
- No `questionsAnswered` section at all (**removed**, not just deviated) — see "Chat query logging removed" below.
- No `meetingSyncActivity` section at all (**removed**, not just deviated) — see "Meeting sync activity removed" below.
- No `knowledgeHealth` section at all (**removed**, not just deviated) — see "Knowledge health replaced with Task overview" below.

## Knowledge health replaced with Task overview
Direct request: "remove the knowledge health graph and add the task section overview in graphical representation." `knowledgeHealth` (`freshnessScorePct`, `avgReviewTimeDays`, `dailyFreshnessTrend`) is gone from the response entirely — not hidden in the frontend, the backend query that computed it (`docStats`, the 7-iteration daily-trend loop) was deleted too, so nothing about knowledge-document freshness is computed by this endpoint anymore. That data doesn't surface anywhere else on the dashboard — `KnowledgePage.tsx` only shows a per-document fresh/stale dot, no aggregate score — so this is a real information trade, not just a cosmetic swap; confirmed with the user before building (see `dashboard/frontend.md`).

`taskOverview` replaces it: a status breakdown (open / overdue / done) across every `meeting_tasks` row in the org, plus `completionRatePct` and `overdueCount` as headline numbers — same two-stat-tile shape as the old `freshnessScorePct`/`avgReviewTimeDays` footer, for layout parity.

**Why a status breakdown instead of a daily trend** (`knowledgeHealth`'s most visually distinctive feature was its 7-bar trend chart, and the obvious instinct was to build the same shape for tasks): tried "tasks completed per day over the last 7 days" first, using `task_activity`'s `done` rows — but that table is brand new (added earlier this session for the assignment/completion journey feature, see `meetings/backend.md`) and 364 of this org's 365 seeded tasks have never been touched by it. A trend chart over that data would render as one flat, nearly-empty line — technically real, but not actually informative. `due_date`/`done` on `meeting_tasks` itself, by contrast, is fully populated for every row regardless of history, so a **current status split** is the metric that's actually meaningful with this org's data today.

`overdue` is computed the same way `TasksPage.tsx`'s `isOverdue()` already does client-side (`!done && due_date IS NOT NULL AND due_date < today`), just server-side and aggregated: `openOnTrackCount = total - done_count - overdue_count`, so the three `breakdown` counts always sum to `totalItems` with no double-counting (an overdue task is never also counted as `open`).

Verified via curl: `taskOverview.breakdown` summed to `totalItems` (366); `completionRatePct` matched `round(1/366*100) = 0`; `overdueCount` (31) independently cross-checked against `GET /api/tasks?filter=open`, filtering client-side for `dueDate < today` — both queries agreed.

### "Agent performance" — per-assignee breakdown (as built)
Direct follow-up: "can we add the agent performance in the task overview." Asked what "agent" meant, since this app has no literal AI-agent concept of its own (the *seed data's* meeting notes are full of "agent" talk — Navedas Intelligence, the seeded org, is itself building a CSAT-agent product — but that's content inside task titles, not a real entity this app tracks). Confirmed: "agent" means the person a task is assigned to, same usage as a support/sales agent.

`taskOverview.byAssignee` — one more query in `dashboard.ts`, `meeting_tasks` `JOIN users` (inner join, not left — unassigned tasks have no agent to attribute anything to, same reasoning as every other assignee-related feature in this app treating "unassigned" as ownerless) `GROUP BY assignee_id`, ordered by task count descending. Each row: `{ id, name, initials, total, doneCount, overdueCount, completionRatePct }`. Sorted by volume, not completion rate — the point is "who's carrying the load," not a leaderboard of whoever happens to have finished their one assigned task.

**Initially capped at top 6**, then direct follow-up — "can we show all Agent performance there?" — dropped the `LIMIT 6` entirely. Every assignee with at least one task now returns (12 in this org, out of 14 registered users — 2 have never been assigned anything).

Verified via curl: 12 rows returned, sorted descending by `total` (56 down to 2); the top row's `doneCount`/`overdueCount` cross-checked exactly against `GET /api/tasks?assigneeId=` (56 total, 0 done, 1 overdue — matched).

## Two new fields, two schema additions
Adding `todaysMeetingUpdate` and `mostPopularContent` required two new columns:
- `meetings.created_at` (TEXT, default `datetime('now')`) — didn't exist before; the table only had `scheduled_at`. Needed a genuine "when was this record logged" timestamp distinct from "when is/was the meeting," since `todaysMeetingUpdate` is about the former. Backfilled for existing rows via a migration (see `server/src/db.ts`'s `columnExists()` check + `ALTER TABLE` + `UPDATE`) — SQLite's `ALTER TABLE ADD COLUMN` only accepts constant defaults, so the column was added with `DEFAULT ''` then backfilled with `UPDATE meetings SET created_at = scheduled_at WHERE created_at = ''` (treating "logged" as "around when it happened," for existing seed data).
- `knowledge_documents.view_count` (INTEGER, default 0) — new lightweight popularity counter, incremented by `server/src/routes/chat.ts` every time Ask The Record cites the document as a source. See `ask-the-record/backend.md` for the increment logic and the reasoning for why this is a different kind of persistence than the `chat_queries` log that was removed earlier (no question text, no user identity — just a number on the document).

`seed.ts`'s `makeMeeting()` sets `created_at` explicitly per meeting: past/present meetings get `created_at = scheduledAt` (logged when it happened), the one future meeting gets `created_at = now` (logged today, ahead of time).

## Meeting sync activity removed
The `meetingSyncActivity` section (`daysActive`, `meetingsSynced`, `calendarDots`) and the query computing it (`COUNT(DISTINCT date(scheduled_at))` + a 21-iteration per-day loop, see prior versions of this doc) were **removed entirely** per direct request, after a conversation about what distinguished this card from the newer `nextEvent` card — this one was a look-back activity summary with no single meeting identified, `nextEvent` names one specific upcoming meeting. Once articulated, the user chose to cut the summary. Unlike the Questions Answered removal, this wasn't a "no data source left" situation — the `meetings` table still has everything needed to bring this back if wanted later.

## Chat query logging removed
The `questionsAnswered` section (and the `chat_queries` table it was computed from) was **removed entirely** per direct request: "the result should not be saved again in the db" — every chatbot answer should still be fetched live from the knowledge base and shown, but no longer persisted anywhere. `server/src/routes/chat.ts` no longer inserts into `chat_queries`; `server/src/db.ts` no longer creates that table (and drops it via a one-time `DROP TABLE IF EXISTS chat_queries` migration for any existing DB file that still had it from before this change). See `ask-the-record/backend.md`.

## Bug found + fixed: SQLite date-string comparison mismatch
While building `nextEvent`, discovered that every raw SQL comparison of the form `some_column >= datetime('now', ...)` was subtly broken. All timestamps in this app are written by JS as `new Date(...).toISOString()` (format: `2026-07-29T10:36:01.337Z`), but SQLite's `datetime('now')` produces its own canonical format (`2026-07-29 10:36:01`, space-separated, no `Z`, no milliseconds). Compared as raw TEXT, `'T' (0x54) > ' ' (0x20)`, so **any JS-written timestamp sorts as "greater than" `datetime('now')` for same-or-later dates, regardless of the actual time** — meaning "is this in the future" checks were unreliable in both directions depending on which side of the bug they fell on.

`date(col) = date('now', ...)` and `julianday(col)` were **not** affected — those functions parse the ISO8601 input correctly before extracting/computing, so only raw `>`/`>=` comparisons against a bare column were broken.

**Fix:** wrap the column side in `datetime(...)` too, so both sides get normalized to the same canonical form before comparing: `datetime(scheduled_at) > datetime('now')`. Fixed in:
- `dashboard.ts` — `nextEvent` future check, `knowledgeHealth` 7-day freshness window, and (at the time) `meetingSyncActivity`'s "this month" window — that query no longer exists (see "Meeting sync activity removed" above), but the fix was in place before the removal.
- `meetings.ts` — the `this_week` filter.
- `auth.ts` — session expiry check (`sessions.expires_at > datetime('now')`) — this one meant sessions were never actually being rejected as expired, since a JS-written `expires_at` always compared as "in the future." Not a security-critical issue at demo scale (short-lived local dev sessions), but a real correctness bug in what should enforce the 30-day session TTL.

## To close the gaps
A `dashboard_snapshots` table (org_id, captured_at, docs_total, ...) written by a daily cron/background job would let a future version compute real week-over-week deltas instead of dropping them — the same gap that ruled out a completion-per-day trend for `taskOverview` (see above): there's no daily history to plot yet, `task_activity` only goes back as far as this session.

## Auth
`requireAuth` middleware, same session-cookie pattern as every other route. No separate `:orgId` path param — the org is always taken from the authenticated session (`req.user.org_id`), which also closes the IDOR risk the original spec's `:orgId`-in-path design would have had.

## Company holidays (as built)
Direct request: "add the holiday calendar of our company and show within the upcoming event calendar." Explained the tradeoff first — this app has no calendar sync that would supply real holiday data (Zoom/Google Meet sync only imports actual meetings), and no org-level country/region field a hardcoded regional list could key off. Two options: a manually-entered table (real data, but someone has to maintain it) or a hardcoded list (zero setup, but guessing at a country this org never specified — the same kind of fake-data shortcut this app has avoided elsewhere, e.g. the dropped `+6%` trend deltas). User picked the manual table.

New `holidays` table (`org_id`, `date` TEXT 'YYYY-MM-DD', `name`, `UNIQUE(org_id, date)` — one holiday per date per org) and a new router, `server/src/routes/holidays.ts`, mounted at `/api/holidays`:

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/holidays` | All holidays for the org, ordered by date. No pagination — a company's holiday list is small by nature. `requireAuth` only — any org member. |
| `POST` | `/api/holidays` | `{ date, name }`. 400 if `date` isn't `YYYY-MM-DD` or `name` is blank. 409 if that date already has a holiday (the `UNIQUE` constraint backing this — caught explicitly with a friendlier message rather than surfacing a raw SQLite constraint error). `requireAdmin` — see below. |
| `DELETE` | `/api/holidays/:id` | Org-scoped existence check before delete, same 404-if-not-found pattern as every other delete in this app. `requireAdmin` — see below. |

**Update:** initially shipped with no permission restriction beyond `requireAuth` — any org member could add or remove a holiday. Direct follow-up locked this down: `POST`/`DELETE` now require `role === 'admin'` (`GET` stays open to everyone). This introduced the app's first real admin/role concept — see `landing-login/backend.md`'s "Admin role" section for the full `users.role` column, `requireAdmin` middleware, and who gets promoted.

`dashboard.ts`'s `GET /summary` gained one more query: `upcomingHolidays` — every holiday with `date >= date('now')`, limited to 10, ordered ascending. Small window is enough since the frontend only ever needs to check whether one falls within the single week it renders (see `dashboard/frontend.md`).

**Initially seeded two placeholder holidays** ("Independence Day," "Company Foundation Day") for the demo org so the feature had something to show immediately — inserted via a one-off script, not baked into `seed.ts`'s reseed path, since these were always meant to be replaced with the org's real dates rather than regenerated fresh every reseed.

**Replaced with the org's real 2026 holiday calendar**, direct follow-up, given as a plain list (not structured input) — 8 fixed company holidays plus 5 "optional" ones from a separate list where "one can take two of the below, of their own choice." At the time, the `holidays` schema had no optional/mandatory flag, and adding one for a single list wasn't worth a migration yet — the 5 optional entries got `(Optional)` appended directly to their `name` instead, so the distinction survived without changing the data model. (A real `is_optional` column and a proper two-section UI followed shortly after — see `landing-login/backend.md`'s "Mandatory vs. optional holidays" section; the name-suffix approach was a temporary stand-in, not the final design.) Removed the two placeholders and inserted all 13 via the same kind of one-off script (13 unique dates, no `UNIQUE(org_id, date)` collisions). One entry, "Xmas Day," was given as `25th Dec 2025` in the source list — inserted exactly as given rather than "corrected" to 2026, since that's the org's real data now and any correction should come from them via the Remove/Add UI (now on the dedicated Holidays page — see `landing-login/frontend.md`), not an assumption on my part.

Verified via curl: `POST` with a date already taken → 409; malformed date → 400; a full add → 204/201 → shows up in the next `GET`; `DELETE` → 204 → gone from the next `GET`. All 13 real holidays confirmed present via `GET /api/holidays`, sorted ascending, "Xmas Day" 2025-12-25 correctly appearing first (past relative to "today"). Live in the browser: added and removed a holiday through the real Profile Settings form (not just curl) — confirmed the delete actually persisted by re-querying `GET /api/holidays` directly rather than trusting the page's own re-render.

## Task calendar + Leave calendar (as built)
Direct request: "Add a task calender showing the task count of the individuals per date and a leave calender on the dashboard page showing the persons on leave." Initially built as two new fields on the existing `GET /dashboard/summary` response — no new endpoint, no query params, no month navigation; both scoped to "the current month" as of the request (server clock), same no-navigation simplicity as `nextEvent`'s week strip.

**Query logic** — `getTaskCalendar(orgId, year, monthIndex0)`: `meeting_tasks` grouped by `due_date` then `assignee_id`, filtered to `done = 0` (an open-tasks capacity view — done tasks are no longer on anyone's plate, so including them would answer a different question than "who has what due when") and `strftime('%Y-%m', due_date) = ?` bound to the requested month. Grouped in JS into `{ date, byAssignee: [{ id, name, initials, count }] }[]`, one entry per date that has at least one open task due, sorted by count descending within each date (busiest person first). Sparse, not a full 28-31 day array — the frontend fills in blank days itself when building the month grid, same pattern `upcomingHolidays` already established (a `Map` keyed by date, looked up per rendered day).

**`getLeaveCalendar(orgId, year, monthIndex0)`** — `leave_requests` joined to `users`/`leave_types`, filtered to `status = 'approved'` and overlapping the requested month (`from_date <= monthEnd AND to_date >= monthStart`, plain string comparison — both sides are already `'YYYY-MM-DD'`, which sorts correctly as text with no `datetime()` wrapping needed, unlike the ISO-timestamp bug documented above). Each matching request's `[from_date, to_date]` span is then **expanded in JS into one entry per day**, clipped to the month boundary — a calendar needs "who's out on the 14th," not "who has a request that happens to span the 14th," so a 5-day leave produces 5 separate day entries, not one. Result: `{ date, people: [{ id, name, initials, leaveTypeName }] }[]`, same sparse-array shape as the task calendar.

Both computed with plain server-side `Date` math (`year`/`monthIndex0` in, month-start/month-end date strings out), not a SQL-only approach — expanding a date range into individual days is awkward in SQLite without a recursive CTE, and this app doesn't use one anywhere else, so plain JS loops matched existing style better than introducing a new SQL pattern for one feature.

Verified via curl: `taskCalendar` returned 5 populated dates for the current month, correctly grouped and sorted (e.g. Aug 4 → `[{Rashmibala, count:2}, {Shakti, count:1}]`, busiest first); a live "+1 more" case confirmed in the browser where a date had 3 assignees (only the top 2 render as chips, the rest collapse into a "+N more" line, full breakdown available via the cell's `title` tooltip). `leaveCalendar` started empty (the org's only approved leave at the time fell in September, outside the current month) — created a disposable 2-day approved leave request inside the current month, confirmed it expanded into exactly 2 separate day entries, confirmed it rendered as an avatar chip on both days in the browser, then deleted the test request directly (no `DELETE /leave-requests/:id` endpoint exists yet — see `worknest/backend.md`) and restored the leave balance the test approval had deducted, leaving the real data untouched.

## Month navigation (as built)
Direct follow-up: "Can you keep the task calender and the leave calender in a single line instead of 2" (unrelated layout change, see `dashboard/frontend.md`) surfaced the lack of navigation — the user then asked directly why there was no previous/next month option, and confirmed wanting it added.

**Split into three endpoints rather than adding a `?month=` param to `/summary`.** `taskCalendar`/`leaveCalendar` were pulled out of the summary response entirely and given their own routes (`GET /task-calendar`, `GET /leave-calendar`, both accepting `?month=YYYY-MM`). Reasoning: `/summary` computes a dozen unrelated things (projects, task overview, holidays, next event, most popular content) that aren't month-scoped and don't change when the user clicks "next month" — re-fetching the entire summary on every navigation click would mean re-running every one of those queries for data that hasn't changed, just to get one calendar's new month. A dedicated endpoint per calendar means clicking "›" is exactly one query, for exactly the data that changed.

The original current-month-only SQL (`strftime('%Y-%m', due_date) = strftime('%Y-%m', 'now')`, `now.getFullYear()`/`getMonth()` for the leave-calendar's month bounds) was refactored into two shared functions, `getTaskCalendar(orgId, year, monthIndex0)` and `getLeaveCalendar(orgId, year, monthIndex0)`, parameterized by an explicit month instead of asking SQLite or `Date` for "now." `/summary` no longer calls either — the Dashboard now fetches both calendars itself via the new endpoints (see `dashboard/frontend.md`), including for the initial "this month" view, so there's exactly one code path for "show a month's calendar," not two.

**`month` parsing** (`parseMonthParam`, shared by both new routes): a `/^\d{4}-\d{2}$/` regex check; anything missing or malformed silently falls back to the current month rather than 400ing — a calendar widget's own internal navigation always sends a well-formed value, so this is defensive against a hand-typed or malformed URL, not a real validation surface worth erroring on.

Verified via curl: `GET /summary` no longer includes `taskCalendar`/`leaveCalendar` keys at all; `GET /task-calendar` (no `month`) returned the same 5 current-month dates as before the refactor; `GET /task-calendar?month=2026-09` returned a different (empty, at the time) result, confirming the month param actually changes what's queried; `GET /leave-calendar?month=2026-09` returned the org's 2 real Sept leave entries — the ones invisible in the default "this month" (August) view — confirming navigating forward actually surfaces data the current-month-only version could never have shown; `GET /leave-calendar?month=garbage` returned `200` (fell back to current month) rather than erroring.

## Owner on "Your projects" cards (as built)
Direct request: "owner name needs to be visible on the project card" — the Dashboard's "Your projects" row (distinct from the `/app/projects` page's own cards, which already showed owner) never selected owner info at all. The `projects` query gained a `JOIN users u ON u.id = p.owner_id` plus `u.name AS owner_name, u.initials AS owner_initials`, and each item in the response's `projects` array gained an `owner: { name, initials }` object — same shape `ProjectItem.owner` already used on the Projects page, for consistency between the two surfaces rather than inventing a second owner shape.

Verified via curl: `GET /dashboard/summary`'s `projects[0].owner` returned `{ "name": "Ambika", "initials": "A" }`, matching the real project's actual owner.
