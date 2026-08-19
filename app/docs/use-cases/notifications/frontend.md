# Notifications — Frontend

## Component
No dedicated page or route — lives entirely in `src/components/AppLayout.tsx`'s header, replacing what used to be a plain decorative `🔔` `<div>` (no `onClick`, no state) with a real button + dropdown panel, same overall interaction shape as the adjacent profile menu (`menuOpen`/`menuRef`, outside-click-to-close via a `mousedown` listener added/removed in a `useEffect`) — `notifOpen`/`notifRef` follow the identical pattern, just for a second, independent dropdown.

## State & behavior
- `notifications: NotificationItem[] | null` — `null` while loading, then the caller's own list from `GET /notifications`.
- `unreadCount: number` — drives the small red badge on the bell (`9+` once it exceeds 9, otherwise the exact number); hidden entirely when `0`.
- Fetched once on mount (`useEffect` depending on `user`) so the badge count is visible before the bell is ever clicked — not polled, so a notification created by someone else while this tab is already open only appears after a reload or the next time the bell is opened (see `notifications/backend.md`'s "no push/real-time delivery" gap).
- `handleToggleNotifications()` — toggles `notifOpen`; on **open** only (not on close), it refetches `GET /notifications` (so anything created since mount shows up) and, if `unreadCount > 0`, fires `POST /notifications/read-all` and optimistically zeroes the badge locally rather than waiting on a second round trip.

## Panel
A right-aligned dropdown (`absolute right-0 top-[46px]`, same z-index/shadow convention as the profile menu), fixed-width (`w-80`), scrollable body capped at `max-h-80` for a long list. Each row shows the notification's `message` verbatim (no truncation, no title/body split — messages are short, pre-written sentences from the backend) and a formatted timestamp (`notificationTime()`, a page-local helper combining date + time, since "Aug 17, 2:42 PM" is more useful here than a bare date — unlike most other timestamp displays in this app, a notification's exact time of day matters). No per-item read/unread visual distinction inside the panel (no bold vs. normal text) — everything visible gets marked read as a side effect of opening the panel at all, so a lingering unread/read split inside the list itself would be misleading by the time it's rendered.

## Verified
`tsc --noEmit` clean. Full flow verified via curl against a disposable target member (see `notifications/backend.md`'s Verified section for the exact steps) — the frontend logic itself (state wiring, badge math, panel rendering) was reasoned through against that confirmed backend behavior rather than re-verified through the browser UI directly in this pass.

## Known gaps
- No live polling — see `notifications/backend.md`.
- No empty-vs-loading distinction beyond the two text states ("Loading…" / "No notifications yet.") — no skeleton, matches this app's general convention elsewhere.
- Badge caps its displayed number at `9+` but the underlying `unreadCount` has no cap — cosmetic only, doesn't affect `read-all` correctness.
- No way to open the panel and *not* mark everything read — there's no "peek without dismissing" mode.
