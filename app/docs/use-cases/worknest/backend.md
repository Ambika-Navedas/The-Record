# WorkNest — Backend

**Status: built.** Lives in `server/src/routes/worknest.ts`, mounted at `/api/worknest`. New feature area — leave management, distinct from the account/login area (`landing-login/backend.md`) that Profile Settings and the holiday calendar live in, even though the dropdown entry point sits right next to them. **No longer a request/approval system — self-service instead.** See "Leave request/approval workflow — removed, then self-service logging added back" below; this doc's data model and endpoint list reflect current state.

## Origin
Direct request, with a screenshot of a real payroll product (Paybooks) as reference: "add another option 'WorkNest' in the account section through which one can apply the leaves and see the payslip... like the payroll and HR management system." Given the scope implied by "like the payroll and HR management system," asked how much to build now — full payroll computation (tax brackets, PF, etc.) was flagged as needing fabricated numbers this app has never had any concept of. Confirmed: build leave management **and** payslips together, accepting that payslip figures are admin-entered, not computed. **Payslips were later removed outright** — see "Payslips — removed" below. **The leave apply/approve workflow was later removed too** — see "Leave request/approval workflow — removed" below.

## Data model (as built)
```
leave_types
  id        TEXT pk
  org_id    TEXT -> organizations.id
  name      TEXT
  UNIQUE(org_id, name)

leave_balances
  id             TEXT pk
  org_id         TEXT -> organizations.id
  user_id        TEXT -> users.id
  leave_type_id  TEXT -> leave_types.id
  balance        REAL         -- days; REAL not INTEGER, half-days are legitimate in real leave systems
  UNIQUE(user_id, leave_type_id)

leave_requests
  id             TEXT pk
  org_id         TEXT -> organizations.id
  user_id        TEXT -> users.id
  leave_type_id  TEXT -> leave_types.id
  from_date      TEXT         -- 'YYYY-MM-DD'
  to_date        TEXT         -- 'YYYY-MM-DD'
  days           REAL         -- inclusive day count, computed server-side from the date range
  reason         TEXT
  status         TEXT         -- always 'approved' on any row created since self-service logging — see below
  reviewed_by    TEXT -> users.id, nullable
  reviewed_at    TEXT, nullable
  created_at     TEXT
```
`status`/`reviewed_by`/`reviewed_at` predate the removal of the approve/reject workflow and are kept for shape-compatibility (the frontend's status pill still reads `status`) rather than because anything sets them meaningfully anymore: every row created through the current self-service `POST` is inserted as `'approved'` outright with `reviewed_by`/`reviewed_at` left `NULL` (nobody reviewed it — see below), so `'pending'`/`'rejected'` and a populated `reviewed_by`/`reviewed_at` can now only exist on the 2 real rows that predate this change.
All three are brand-new tables, added directly to `db.ts`'s initial `CREATE TABLE IF NOT EXISTS` block — no migration needed, same as `holidays`/`task_activity`/`holiday_selections` before them. (A fourth table, `payslips`, existed alongside these but was later dropped entirely — see "Payslips — removed" below.)

## Endpoints (as built)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/worknest/leave-types` | All leave types for the org. Powers the "Log leave" form's dropdown (see `worknest/frontend.md`). |
| `GET` | `/worknest/leave-balances` | Caller's own balance per leave type — `LEFT JOIN` so a type never allocated to this user still shows `0` rather than being missing. |
| `GET` | `/worknest/leave-balances/team` | Admin-only (403 otherwise). Every org member's balance across every leave type, grouped per user. Powers the "Team leave balances" admin table — see below. |
| `PATCH` | `/worknest/leave-balances/:userId` | Admin-only. `{ leaveTypeId, balance }` — sets (not adjusts by delta) that member's balance for that type to the given non-negative number. See below. |
| `GET` | `/worknest/leave-requests` | Caller's own leave history, `created_at DESC`. Always scoped to the caller — no `?scope=team`. |
| `POST` | `/worknest/leave-requests` | `{ leaveTypeId, fromDate, toDate, reason }`. Self-service — no approval step. Validates the date range, computes `days` server-side, 400s `insufficient_balance` if `days` exceeds the caller's current balance. Inserts as `'approved'` immediately and deducts the balance in the same request. |
| `GET` | `/worknest/on-leave` | Any org member, no admin gate. Every **approved** leave request whose `to_date` hasn't passed yet (`to_date::date >= CURRENT_DATE`), org-wide, ordered by `from_date` ascending. Read-only info — see below. |

## Leave request/approval workflow — removed, then self-service logging added back
Two direct requests in sequence. First: "There should be no leave request and approval system within this. But each individual can show their leave history in place of My Requests under worknest." Confirmed the removal should reach the backend, not just the UI: `POST /worknest/leave-requests` (file a request) and `PATCH /worknest/leave-requests/:id` (admin approve/reject, with its balance-deduction-on-approval logic) were both deleted from `worknest.ts`, along with `requireAdmin` (nothing left in the file needed it) and the `daysBetweenInclusive()`/`DATE_RE` helpers that only existed for the deleted `POST` handler's validation. `GET /worknest/leave-requests` was simplified to always return the caller's own requests (the `?scope=team` branch and its admin check came out too).

That left no way for anyone to actually create a leave record at all — asked directly, and got a follow-up: "How one member will inform the team about the leave where to intimate?" then "without the request/approval, all rest should be there." So `POST /worknest/leave-requests` came back, but reshaped: rather than restoring the old two-step file-then-approve flow, submitting now does everything in one step — the row is inserted as `'approved'` immediately (no `'pending'` state ever exists on a newly-created row) and the balance is deducted in the same request, re-using the exact validation (`daysBetweenInclusive()`, `DATE_RE`, the `insufficient_balance` check) and the exact balance-update logic the old `PATCH` handler used to run on approval — just inlined into `POST` instead of split across two endpoints with a review step in between. `reviewed_by`/`reviewed_at` are deliberately left `NULL` on these rows rather than backfilled with the submitter's own id — nobody reviewed it, so recording a fake reviewer would misrepresent what happened. No `requireAdmin` anywhere in the new `POST` — this is intentionally something any org member can do for themselves, same permission level as picking your own optional holiday.

**`/on-leave` was never touched by either round** — it already read `leave_requests` generically (`status = 'approved'`, `to_date` not yet passed), so a self-service-logged leave shows up there exactly the same way an old admin-approved one used to.

## Admin balance adjustment (as built)
Direct follow-up, once self-service logging meant balances could only ever go down: "the admin need to have the option to modify the leave balance of each member." Explicitly *not* the same thing as reintroducing approval — confirmed directly ("there should be not be any approval section from the admin. Its just the info to the team") before building this, so it's scoped narrowly to balance correction/allocation, with nothing that touches or gates `leave_requests` rows.

`requireAdmin` is back in this file for exactly these two routes (`GET /leave-balances/team`, `PATCH /leave-balances/:userId`) — everywhere else (`POST /leave-requests`, `GET /leave-requests`, `GET /on-leave`) stays admin-free.

`GET /leave-balances/team` does a `CROSS JOIN` of every org user against every org leave type (`LEFT JOIN leave_balances` for the actual values), so a member who's never had a balance row for some type still appears with `0` rather than a missing cell — same "show the zero, don't hide the gap" reasoning as the single-user `GET /leave-balances` above. At this org's real scale (12 users × 5 types) that's 60 rows every call, matching `leave_balances`' current real row count exactly. Each grouped user object also carries `employeeId` (`u.employee_id`, added by direct request — "there should be employee ID in the popup" — for the frontend's balance-update confirmation modal) — free text, not enforced-unique, can be `''` for a user who's never had one set (see `landing-login/backend.md`'s "Employee profile fields").

`PATCH /leave-balances/:userId` sets an absolute value, not a delta (`{ leaveTypeId, balance: 8 }` means "this is 8 now," not "add 8") — same "real number in, real number out" spirit `payslips` used to have, chosen over an increment/decrement API since an admin correcting a balance is almost always thinking "it should read X," not "add/subtract Y." Validates `balance >= 0` (400 otherwise) and that both the target user and leave type belong to the caller's org (404 otherwise) before upserting — same existing-row-or-insert pattern the old approval-branch balance update used to follow.

**Notifies the target member**, direct follow-up: "The same modification needs to be visible as the notification under the notification section to the particular member." After the balance write succeeds, this handler also inserts one row into the new `notifications` table (`user_id` = the member whose balance changed, not the admin) — see `notifications/backend.md` for the table/endpoint design. Required extending this handler's leave-type lookup to also select `name` (previously only fetched for existence-checking), since the notification message needs it.

## Payslips — removed
Direct request: "remove the payslip section, I don't need that one." The frontend's Payslips tab was already gone by this point (see `worknest/frontend.md`) — no UI reached these endpoints anymore. Since the user confirmed removing the data too (not just orphaning it further), this closed the loop completely: `GET/POST /worknest/payslips` deleted from `worknest.ts`, the `payslips` table dropped from Neon via a one-time `DROP TABLE IF EXISTS payslips;` in `db.ts` (same pattern as the earlier `chat_queries` cleanup), the table removed from `db.ts`'s schema and from `migrate-to-neon.ts`'s table list, and the `Payslip` type removed from `app/src/lib/api.ts`. The 3 real payslip rows that had been migrated from SQLite are gone — not recoverable except from the untouched `server/data.sqlite` backup file.

## Seed data
Leave types and default balances seeded via a one-off script (not `seed.ts`'s reseed path — same reasoning as the holiday-list seed): `Loss of Pay` (365), `Sick Leave` (8), `Casual Leave` (6), `My Day` (0), `Earned Leave` (15) — the exact five types and starting balances shown in the reference screenshot, applied to all 12 org users.

## Verified
Full round trip via curl against a disposable org member (created, tested, then deleted — real data untouched): with a 0 balance, logging 2 days of Casual Leave correctly 400'd `insufficient_balance` ("requested 2 days, 0 available"); granted a 5-day balance directly in Neon, logged the same 2-day request — 201, balance immediately read back as 3 (5 − 2); `GET /worknest/leave-requests` showed the new row with `status: 'approved'`, `reviewerName: null`, `reviewedAt: null`; `GET /on-leave` immediately included the test user's entry alongside the org's 2 real historical ones. Row counts (`leave_requests: 2`, `leave_balances: 60`) confirmed back to the real baseline after cleanup.

**Admin balance adjustment** verified via curl using the real admin session (Ambika) against a second disposable member (created, edited, deleted — real data untouched): `GET /leave-balances/team` returned the real 12-member × 5-type grid correctly; `PATCH` on the disposable member's Casual Leave (`0` → `8`) returned `204`, and the target member's own `GET /leave-balances` immediately reflected `8`; the same `PATCH` and `GET /leave-balances/team` both confirmed `403` when attempted by the (non-admin) disposable member's own session. Row counts confirmed back to real baseline (`users: 12`, `leave_balances: 60`) after cleanup.

`employeeId` on `GET /leave-balances/team` re-verified with the same real admin session: Ambika's row correctly returned `"employeeId": ""` (never set, matching `landing-login/backend.md`'s documented free-text/no-default behavior) — confirming the frontend's fallback display needs to handle an empty string, not just a missing field.

## Known gaps
- No cancellation/edit of a logged leave entry itself — once submitted, the `leave_requests` row (dates, reason) is permanent; only the associated *balance* can be corrected afterward by an admin, not the entry's details.
- No upper bound on how far in the future (or past) a date range can be logged — the only validation is `toDate >= fromDate` and sufficient balance.
- No notification to the team when someone logs leave, or when an admin adjusts a balance — both only become visible the next time someone loads or refreshes the relevant view.
- No audit trail for admin balance edits — `PATCH /leave-balances/:userId` overwrites silently, with no log of who changed what from what to what or when (unlike the old approval flow's `task_activity`-style trail, which this deliberately isn't trying to recreate).
