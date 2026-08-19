# Notifications — Backend

**Status: built.** Lives in `server/src/routes/notifications.ts`, mounted at `/api/notifications`. Schema in `server/src/db.ts` (`notifications` table).

## Origin
Direct request, after building admin balance adjustment for WorkNest (`worknest/backend.md`): "The same modification needs to be visible as the notification under the notification section to the particular member." The bell icon in `AppLayout.tsx`'s header had existed since early in this project but was purely decorative (documented as a known gap in `dashboard/frontend.md`) — no backend, no click handler, nothing behind it. This is the first thing to actually populate it.

Asked two scoping questions before building: whether notifications should track read/unread state with a badge count, and whether the table/endpoints should be general-purpose (reusable by future features) or built narrowly just for this one event. Both answered toward the fuller option — read/unread with a badge, and a general-purpose `notifications` table — so this is designed as real, reusable infrastructure, even though the only thing that currently creates a notification is `worknest.ts`'s balance-adjustment endpoint.

## Data model (as built)
```
notifications
  id          TEXT pk
  org_id      TEXT -> organizations.id
  user_id     TEXT -> users.id       -- the recipient
  message     TEXT                   -- plain text, pre-rendered by whatever created it
  read_at     TEXT, nullable         -- NULL = unread
  created_at  TEXT
```
Deliberately no `type` column, no structured payload, no template system — `message` is a finished, human-readable string written by the code that creates the notification (e.g. `worknest.ts`'s `` `Your ${leaveType.name} leave balance was updated to ${balance}.` ``). This keeps the table genuinely generic (any feature can `INSERT` a notification with any message) without needing a rendering layer on the read side to turn structured data into text — a real tradeoff: if a future notification type needs to link somewhere or carry data the UI acts on, this schema would need a column added for that, not a rewrite.

## Endpoints (as built)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/notifications` | Caller's own, `created_at DESC`, capped at 50 (demo-scale, no pagination). Returns `{ items, unreadCount }` — `unreadCount` is a separate `COUNT(*) WHERE read_at IS NULL` query, not derived from the capped `items` list, so it stays correct even if more than 50 unread notifications exist. Also calls `checkDueReminders(orgId, userId)` first (see `reminders/backend.md`) — this is what makes a due reminder show up as a real notification, since the bell fetches this on every page load. |
| `POST` | `/api/notifications/read-all` | Bulk-marks every one of the caller's unread notifications as read (`read_at = now()`). No per-notification mark-read endpoint — matches "opening the panel marks them read," not an explicit dismiss-one action. |

Both `requireAuth` only — no admin gate on either; every user manages their own notifications, there's no cross-user read here at all (unlike `worknest.ts`'s admin-only team-balances view).

## Shared helper
`server/src/notifications.ts` exports one function, `notify(orgId, userId, message)` — a thin wrapper around the `INSERT`, used by every producer below instead of each one duplicating the query. Not a router, not mounted anywhere — a plain module, same shape as `server/src/auth.ts`'s shared session helpers.

## Producers (as built)

**WorkNest balance adjustment** — `PATCH /worknest/leave-balances/:userId` (see `worknest/backend.md`) calls `notify()` for the **target member** (not the admin making the change) immediately after the balance write succeeds, in the same request: `` `Your ${leaveType.name} leave balance was updated to ${balance}.` ``. Required extending that handler's existing leave-type lookup to also select `name`, since the message needed it and the prior query only fetched `id` for existence-checking.

**Task assigned** — direct follow-up: "the task assigned ... needs to be visible as the notification ... to the concerned member." Two call sites in `server/src/routes/meetings.ts`:
- `POST /:id/tasks` (task creation with an `assigneeId`) — notifies that assignee right after the insert: `` `You were assigned a task: ${title}.` ``.
- `PATCH /:id/tasks/:taskId`, inside the existing `isReassignment` branch (a real, non-null, *different* assignee being set — same gate that already required a `reason` and wrote to `task_activity`) — notifies the new assignee with the same message shape. Required widening that handler's existing-row lookup to also select `title` (previously only `id, assignee_id`), so the message has a real task title even when the same `PATCH` doesn't also change it.

**Deliberately excluded**: `integrations.ts`'s Gmail-summary auto-task-extraction (`syncTasksFromSummaryEmail`/`findOrCreateAssigneeByFirstName`) writes `assignee_id` directly, bypassing both routes above — no notification fires for it. Left out on purpose: assignees there are frequently auto-created placeholder accounts (`bcrypt.hashSync(randomBytes(16)...)` — no usable password, see `meetings/backend.md`) that nobody can actually log into to see a notification. Noted under gaps below rather than silently — a real registered user mentioned by name in a synced meeting summary currently gets assigned tasks with no notification either, which is a real (if narrower) gap.

**Meeting scheduled** — direct follow-up in the same message: "the meeting scheduled ... also needs to be visible as the notification ... to the concerned member." Two producers, since real participant data only existed on one of the two meeting-creation paths before this change:
- **Manual creation** (`POST /meetings`, `meetings.ts`) — previously hardcoded `participants: '[]'`; now accepts `participantIds?: string[]`, validates each with the same `isValidAssignee()` check tasks already use, stores them as a plain array of user ids (the "old" shape `resolveParticipants()` already handled — see `meetings/backend.md`), and after the insert, notifies every participant except the creator: `` `You were added to a meeting: ${title}.` ``.
- **Zoom/Google Meet sync** (`upsertSyncedMeeting`, `integrations.ts`) — `buildParticipantsJson()` was renamed `buildParticipants()` and changed to return the raw descriptor array instead of a pre-stringified JSON string (stringified once, at the call site, for storage) so the caller could also see which entries have a real `userId` to notify. Notifications fire **only on genuine creation, not on re-sync updates** — otherwise every "Sync now" click would re-notify the same people about a meeting they already know about. Skips the connecting user (they just ran the sync) and any descriptor with `userId: null` (an outside guest has no account, so no notifications inbox to write to).

**Reminder due** — the one producer that isn't triggered by another user's action; a member notifying their future self. See `reminders/backend.md` for the full design — in short, `server/src/reminders.ts`'s `checkDueReminders()` calls `notify()` for any of the caller's own reminders whose `due_at` has passed, and is itself called from this router's `GET /` (see above) as well as from `GET /reminders`.

## Verified
**Balance adjustment**: full round trip via curl using the real admin session (Ambika) against a disposable target member (created, tested, deleted — real data untouched): admin `PATCH`'d the target's Sick Leave balance to `6` (`204`); the target's own `GET /notifications` immediately showed the new notification (`"Your Sick Leave leave balance was updated to 6."`, `read: false`) with `unreadCount: 1`; `POST /notifications/read-all` as the target returned `204`, and a re-`GET` confirmed `read: true` and `unreadCount: 0`.

**Task assigned + meeting scheduled**: full round trip via curl against two disposable accounts (a creator/admin and a target, both created, exercised, then deleted). As the creator: `POST /meetings` with the target in `participantIds` → target's `GET /notifications` immediately showed `"You were added to a meeting: Notif Test Meeting."`. `POST /meetings/:id/tasks` assigning that meeting's task to the target → target's notifications grew to 2, including `"You were assigned a task: Follow up on notif test."`. `PATCH .../tasks/:taskId` reassigning the same task back to the creator (with a `reason`, required by the existing `isReassignment` gate) → the creator's own `GET /notifications` showed the matching reassignment notification.

Row counts (`users: 12`, `meetings: 30`, `meeting_tasks: 366`) confirmed back to the real baseline after cleanup. One real notification (Ambika's own, from a genuine balance edit made while testing the confirmation modal live) was found during this cleanup pass and deliberately left in place — it's real user data, not test debris.

**Reminder due**: see `reminders/backend.md`'s Verified section for the full round trip (an overdue reminder correctly auto-converting into a real notification on the very next `GET /reminders` or `GET /notifications` call, with no duplicate on repeated checks).

## Known gaps
- No pagination beyond the 50-item cap — fine at this app's demo scale, would need a real cursor/offset scheme at higher volume.
- No per-notification delete or individual mark-read — only bulk mark-all-read exists.
- No push/real-time delivery — a notification only becomes visible the next time the frontend calls `GET /notifications` (on page load, or when the bell is opened), not the moment it's created. See `notifications/frontend.md`.
- No structured payload or link target — a notification is display-only text; clicking one doesn't navigate anywhere, since there's nowhere encoded in the row to navigate to.
- Gmail-summary auto-extracted task assignments never notify anyone, including real registered users matched by name — see "Deliberately excluded" above.
- A meeting's participants can only be set at creation time (manual) or by the sync process (Zoom/Google Meet) — there's no way to add/remove a participant from an existing meeting afterward, so there's no "you were added to an existing meeting" notification path either, only "a new meeting was created with you in it."
