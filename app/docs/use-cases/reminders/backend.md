# Reminders — Backend

**Status: built.** Lives in `server/src/routes/reminders.ts`, mounted at `/api/reminders`. Schema in `server/src/db.ts` (`reminders` table). Shared due-check logic in `server/src/reminders.ts` (a plain module, not a router — same split as `server/src/notifications.ts`).

## Origin
Direct request: "Add a note or reminder section under the account so that one member can make a reminder." Asked two scoping questions before building:
1. Whether a reminder should be a simple text note, or carry a due date/time that automatically becomes a notification once due — answered **both**: a reminder can optionally have a due date; with one, it auto-notifies; without one, it's just a persistent personal note.
2. Whether reminders need a done/complete state — answered **no**, create and delete only.

## Data model (as built)
```
reminders
  id           TEXT pk
  org_id       TEXT -> organizations.id
  user_id      TEXT -> users.id       -- personal — only the creator ever sees their own
  text         TEXT
  due_at       TEXT, nullable         -- NULL = a plain note, never auto-notifies
  notified_at  TEXT, nullable         -- NULL = not yet converted into a notification
  created_at   TEXT
```
No `done`/`completed` column — per the second scoping answer, a reminder only ever exists or doesn't; there's no state in between create and delete.

## Endpoints (as built)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/reminders` | Caller's own only — no team/admin view exists. Calls `checkDueReminders()` first (see below), then returns the list ordered dated-soonest-first, then plain notes newest-first (`ORDER BY (due_at IS NULL) ASC, due_at ASC, created_at DESC`). |
| `POST` | `/api/reminders` | `{ text, dueAt? }`. `text` is required (trimmed, 400 if empty after trimming). `dueAt` is optional — omitted or falsy stores `NULL` (a plain note). |
| `DELETE` | `/api/reminders/:id` | Caller's own only — 404 if the reminder doesn't exist or belongs to someone else (no separate "not yours" error; ownership and existence are checked together in one query). |

## The due-reminder → notification bridge (as built)
There's no background job/cron anywhere in this app, so a reminder becoming due isn't caught the instant the clock ticks past it — it's caught lazily, the next time either of two things happens, both calling the same `checkDueReminders(orgId, userId)` from `server/src/reminders.ts`:
1. `GET /api/reminders` (opening the Reminders page itself).
2. `GET /api/notifications` (see `notifications/backend.md`) — fetched by `AppLayout.tsx`'s bell on **every page load**, which is what actually makes "you get notified once it's due" work in practice without the member needing to have the Reminders page open at the exact due moment.

`checkDueReminders()` selects every reminder for that user with `due_at IS NOT NULL AND due_at <= now() AND notified_at IS NULL`, calls `notify(orgId, userId, \`Reminder: ${text}\`)` (the shared helper from `notifications/backend.md`) for each, and stamps `notified_at = now()` so it's never converted twice. This is why `notifications.ts`'s `GET /` route now takes an `orgId` param it didn't need before — it has to pass it through to `checkDueReminders()`.

## Verified
Full round trip via curl against a disposable test account (created, exercised, deleted — real data untouched): created a plain note (no `dueAt`), a far-future-dated reminder (2030), and a past-dated one (2020). `GET /reminders` immediately returned all three correctly ordered (2020 reminder first, 2030 reminder second, plain note last) — and, as a side effect of that same request, the overdue one had already been converted: a follow-up `GET /notifications` showed `"Reminder: Overdue reminder"` with `unreadCount: 1`. A second `GET /reminders` (re-triggering `checkDueReminders()`) did **not** produce a duplicate notification — confirmed `GET /notifications` still showed exactly 1 item, verifying `notified_at` correctly prevents re-firing. `DELETE /reminders/:id` on the plain note returned `204`. Row counts (`users: 12`, `reminders: 0`) confirmed back to real baseline after cleanup.

## Known gaps
- Due-reminder detection is lazy, not real-time — a reminder due at 2:00pm doesn't notify at exactly 2:00pm, only the next time the member's browser fetches notifications (page load, or opening the bell/Reminders page). Someone who doesn't open the app between 2:00pm and, say, 6:00pm won't see it until 6:00pm.
- No edit — a reminder's text or due date can't be changed after creation, only deleted and re-created.
- No recurring reminders — every reminder is one-shot; there's no "remind me every Monday" concept.
- No timezone handling beyond what the browser's `datetime-local` input and `Date` object already do implicitly — a reminder's due time is whatever the creating browser's local clock interpreted it as, converted to UTC at creation and never revisited.
