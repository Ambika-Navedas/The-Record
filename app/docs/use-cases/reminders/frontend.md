# Reminders — Frontend

## Route
`/app/reminders` → `src/pages/RemindersPage.tsx`. Entry point is a new **Reminders** item in the account dropdown (`AppLayout.tsx`), between "WorkNest" and "Log out" — same dropdown, same pattern as every other account-area page (Profile settings, `{org_name}` Holidays, WorkNest).

## Component structure
Single-file page, same two-card layout convention as `HolidaysPage.tsx` (a list card, then an add-form card, stacked in a `max-w-xl` column — no two-column grid here, unlike WorkNest, since there's no right-rail-worthy secondary content).

- **Your reminders** card — `reminders: ReminderItem[] | null` from `GET /reminders` (already correctly ordered server-side — dated-soonest-first, then plain notes newest-first, see `reminders/backend.md`). Each row shows the reminder's text, a `Due {date}` line only when `dueAt` is set (a plain note shows just the text, no second line), and a **Remove** button (`DELETE /reminders/:id`, same "call then refetch" pattern as `HolidaysPage.tsx`'s `handleDeleteHoliday`).
- **Add a reminder** card — a `<textarea>` for the text (required) and an `<input type="datetime-local">` for an optional due date/time, submitting to `POST /reminders`. Leaving the date input blank sends no `dueAt` at all (`dueAt: dueAt ? new Date(dueAt).toISOString() : undefined`), which the backend stores as `NULL` — a plain note.

No done/complete checkbox anywhere — per the direct answer when this was scoped ("create and delete only"), there's no state between existing and being removed.

## Verified
`tsc --noEmit` clean. The actual create/list/due-notification/delete behavior was verified end-to-end via curl against the real backend (see `reminders/backend.md`'s Verified section) rather than re-verified separately through the browser UI in this pass — the frontend here is a thin, direct mapping onto already-confirmed endpoints (same request/response shapes, no client-side logic beyond the optional-date encoding above).

## Known gaps
- No edit UI, matching the backend having no `PATCH` endpoint — a mistake in a reminder's text or due date means deleting and re-creating it.
- No visual distinction for an overdue-but-not-yet-notified reminder vs. one that already fired — both just show their `Due {date}` line the same way; the only place the distinction is visible at all is that a fired one also produced a bell notification.
- No timezone indicator on the due-date display — `formatDueDate()` renders in the viewer's local time via `toLocaleDateString`, with no explicit "your timezone" label, same convention as the rest of this app's date displays.
