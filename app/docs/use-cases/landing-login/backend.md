# Landing / Login — Backend

**Status: built**, including Google sign-in (see "Google sign-in" below). "Continue with SSO" reuses the same Google OAuth flow — no separate enterprise identity provider (Okta, Azure AD, generic SAML/OIDC) is configured, by direct request. Lives in `server/src/routes/auth.ts` + `server/src/auth.ts` (session helpers/middleware) + `server/src/db.ts` (schema).

## Data model (as built)

```
organizations
  id      TEXT pk
  name    TEXT
  domain  TEXT unique

users
  id             TEXT pk
  org_id         TEXT -> organizations.id
  email          TEXT unique
  password_hash  TEXT        -- bcryptjs, cost 10
  name           TEXT
  initials       TEXT        -- derived at signup from name, used for avatar UI fallback
  role           TEXT        -- 'admin' | 'member', default 'member' — see "Admin role" below
  designation    TEXT        -- free text, default '' — see "Employee profile fields" below
  department     TEXT        -- free text, default '' — same
  employee_id    TEXT        -- free text, default '', NOT enforced-unique — same
  avatar_path    TEXT        -- nullable, relative path under UPLOADS_ROOT — same
  created_at     TEXT

sessions
  id          TEXT pk        -- the session token itself (randomUUID), not a separate token_hash column
  user_id     TEXT -> users.id
  created_at  TEXT
  expires_at  TEXT           -- 30 days from creation, fixed regardless of "stay signed in" checkbox
```
Deviations from the original spec: no `avatar_color` column (avatars are a single flat neutral color app-wide, see dashboard/design.md); session stores the raw token as its own primary key rather than a separate `token_hash`, since this is a demo, not a security-hardened product.

## Endpoints (as built)

| Method | Path | Status | Notes |
|---|---|---|---|
| `POST` | `/api/auth/signup` | ✅ built | `{ name, email, password, orgDomain? }`. Auto-creates an `organizations` row from the email domain if none exists yet (no "pending approval" flow — first signup from a domain just becomes that org). Sets session cookie, returns the user. |
| `POST` | `/api/auth/login` | ✅ built | `{ email, password }`. bcrypt-compares password, sets session cookie. |
| `POST` | `/api/auth/logout` | ✅ built | Deletes the session row, clears the cookie. |
| `GET` | `/api/auth/me` | ✅ built | Returns the authed user (401 if no valid session) — this is what `AppLayout`'s `AuthContext` polls on mount to gate `/app/*`. |
| `PATCH` | `/api/auth/me` | ✅ built | `{ name?, currentPassword?, newPassword?, designation?, department?, employeeId? }` — see "Profile settings" and "Employee profile fields" below. |
| `POST` | `/api/auth/me/avatar` | ✅ built | Multipart, field name `avatar`. Uploads/replaces the caller's profile picture — see "Employee profile fields" below. |
| `DELETE` | `/api/auth/me/avatar` | ✅ built | Removes the caller's profile picture, reverts to initials. |
| `GET` | `/api/users/:id/avatar` | ✅ built | Serves the raw image file (org-scoped) — lives in `users.ts`, not `auth.ts`, alongside the other `/api/users` routes. |
| `GET` | `/api/auth/google` | ✅ built | Starts the "Continue with Google"/"Continue with SSO" OAuth redirect — see "Google sign-in" below. |
| `GET` | `/api/auth/google/callback` | ✅ built | OAuth redirect target; exchanges the code, logs the user in (or auto-creates their account), redirects back to the app. |
| `POST` | `/api/auth/forgot-password` | ❌ not built | "Forgot password?" link is still dead in the frontend. |
| `POST` | `/api/users/invite` | ✅ built | Lives in `server/src/routes/users.ts`, not `auth.ts` — see "Invite teammate" below. A second, distinct way to create a `users` row alongside `/auth/signup`. |

## Invite teammate (as built)
A second account-creation path, separate from self-serve `/auth/signup`. Built specifically to solve a real gap: the task-assignee dropdown on a meeting's detail page (see `meetings/frontend.md`) only lists actual platform users, but a meeting's real participants (synced from Zoom/Google Calendar) often include people who've never signed up — there was no way to make one of them assignable.

- `POST /api/users/invite` — `requireAuth`, `{ name, email }`. Unlike `/auth/signup` (which resolves the org by matching the *signer-upper's own* email domain), this adds the new user directly to the **inviter's** `org_id` — deliberate, so an external contractor with a different email domain can still be invited to the same org. 409s if the email is already registered.
- **No email-sending infrastructure exists in this demo** — instead of a real invite-link email, the endpoint generates a random password (`randomBytes(6).toString('base64url')`, bcrypt-hashed same as everywhere else) and returns it **directly in the API response**. The frontend shows it once, in a modal, for the inviter to copy and share manually (Slack, in person, etc.) — see `meetings/frontend.md`. This is the same kind of explicitly-flagged demo-scale tradeoff as `projects/backend.md`'s plain-text environment password: a real product would email a signed invite link instead of ever exposing a raw password to a third party (the inviter) at all.
- The invited user is a fully real row in `users` — same table, same login flow, same `requireAuth` middleware as everyone else. They can log in with the manually-shared credentials immediately.

Session cookie: `record_session`, httpOnly, `sameSite: 'lax'`, 30-day expiry, `secure: false` (would need `true` once served over HTTPS). CORS is configured with `credentials: true` and an explicit origin allowlist (`http://localhost:5173`, `http://localhost:4173` for prod-preview testing) in `server/src/index.ts` — this must be updated if the frontend is ever deployed to a real domain.

## Google sign-in (as built)
Direct request, after being told the buttons were dead: "make the set up." Asked how far "SSO" should go given there's no real enterprise identity provider configured — confirmed both **"Continue with Google" and "Continue with SSO"** should trigger the same Google OAuth flow (no separate provider), and that a Google account with no matching `users` row should auto-create an account rather than being rejected — same behavior as `/auth/signup`, just triggered by Google identity instead of a submitted password.

**Distinct from `integrations.ts`'s existing Google OAuth flows.** Those (`/api/integrations/google/*`, `/api/integrations/gmail/*`) authorize a *data-access grant* for an already-logged-in user (Calendar/Gmail scopes, state carries `userId`/`orgId`, gated behind `requireAuth`). This is authentication itself — there's no user yet when the flow starts, so it needs its own scope (`openid email profile`, identity only, no Calendar/Gmail access), its own redirect URI (`GOOGLE_LOGIN_REDIRECT_URI`, defaults to `/api/auth/google/callback`), and its own CSRF state (a bare nonce in `pendingLoginStates`, since there's no user identity to attach to the state yet). All three flows reuse the same `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` — one Google Cloud OAuth client, three authorized redirect URIs registered against it.

**Flow:**
1. `GET /api/auth/google` — 503s `{error: 'Google sign-in is not configured on this server.'}` if the client id/secret env vars are empty (same "not configured" pattern as the Zoom/Meet/Gmail Connect buttons). Otherwise redirects to Google's consent screen with a fresh CSRF `state`.
2. `GET /api/auth/google/callback` — rejects (redirects to `${FRONTEND_URL}/?error=google_auth_failed`) if `state` doesn't match a pending one, the user denied consent, or the token/userinfo exchange fails. Otherwise exchanges the code for an access token, calls Google's `userinfo` endpoint (not a decoded/verified `id_token` JWT — avoids adding a JWT-verification dependency for a demo app), and requires `email_verified` to be true before trusting the returned email at all.
3. **Existing email** → logs them in directly (`createSession`), no password check — Google's own verification stands in for it.
4. **No matching user** → auto-creates one: same find-or-create-org-by-email-domain logic as `/auth/signup` (first signup from a domain becomes `'admin'`, joining an existing org becomes `'member'`), `name`/`initials` derived from Google's profile name (falls back to the email's local part if Google returns no name). The row gets a real bcrypt hash of a random value as `password_hash` — same pattern already used for the auto-created Gmail-summary-extraction assignee accounts in `integrations.ts` — so `users.password_hash NOT NULL` is satisfied but the account has no usable password; going forward this person can only log in via Google, not the email/password form.
5. Either way, sets the session cookie and redirects to `${FRONTEND_URL}/app/dashboard` — same destination the email/password login form navigates to on success.

**Why a full-page redirect, not a fetch call.** Every other auth action in this app (`login`, `signup`) is a JSON `fetch` from `LandingPage.tsx` that awaits a response and handles errors inline. OAuth can't work that way — Google's consent screen has to be a real top-level browser navigation, not an iframe or XHR target. The frontend button does `window.location.href = ${API_BASE_URL}/auth/google` (a real navigation, not `api.post(...)`), and a failure comes back as a query param (`?error=google_auth_failed`) on the reloaded landing page rather than a caught exception — `LandingPage.tsx` reads it once on mount and shows it in the same error banner the password form uses, then strips it from the URL so a refresh doesn't re-show a stale error.

**Setup requirement, not yet done by this change:** `GOOGLE_LOGIN_REDIRECT_URI` (`http://localhost:4000/api/auth/google/callback` locally) must be added to the OAuth client's **Authorized redirect URIs** list in Google Cloud Console — the existing `GOOGLE_REDIRECT_URI`/`GMAIL_REDIRECT_URI` entries don't cover it, and Google will reject the callback with `redirect_uri_mismatch` until it's added. Verified structurally (the redirect to Google's consent URL is built correctly, and the error-path redirect back to the frontend works), but the full consent-screen round trip needs a real interactive Google login to confirm end-to-end, and can't complete until the redirect URI above is registered.

## Profile settings (as built)
Direct request: the avatar in the header did one thing — log out on click, no menu — and there was no way to edit your own name or password anywhere in the app. That mattered more than it might for a typical account, since invited teammates (see above) get a random generated password shown once, with no way to ever change it to something they'd actually remember.

`PATCH /api/auth/me` (`requireAuth`) accepts `name`, or `currentPassword`+`newPassword`, or both in one request — at least one of `name`/`newPassword` is required (400 otherwise). Both are validated *before* either is written (no real SQL transaction, just validation-then-writes ordering, same as `meetings.ts`'s multi-field `PATCH`), so a bad password doesn't leave a half-applied name change:
- `name`: trimmed, rejected if empty. Initials are regenerated from the new name using the exact same first-letter-of-each-word logic as `/auth/signup` (`"Ambika K"` → `AK`).
- `newPassword`: requires `currentPassword` (400 if missing), verified with `bcrypt.compareSync` against the stored hash (401 if wrong), minimum 6 characters (400 if shorter). No complexity rules beyond that — same permissiveness as signup, which has none either.

Returns the updated `AuthedUser` shape (`{ id, org_id, org_name, email, name, initials, role, designation, department, employee_id, avatar_url }`) — same shape as `GET /auth/me` — so the frontend can push it straight into `AuthContext` without a redundant re-fetch. (Neither `role` nor `org_name` are ever accepted in the request body — both are add-later columns this endpoint only echoes back, never writes. `role` was documented here as already returned when the admin-role work landed, but its `SELECT` was never actually updated to include it — caught and fixed alongside adding `org_name`, see "Navedas Holidays page" below.)

Verified via curl: name update round-tripped correctly (initials `A` → `AK` → back to `A`); password change rejected with no `currentPassword` (400) and with a wrong one (401); a real change-then-revert with the correct current password succeeded both ways, confirmed by logging in again with the restored password afterward.

**Still not built**: `POST /api/auth/forgot-password` (this only covers changing your password *while already logged in* — a locked-out user still has no self-serve recovery path) — the "Forgot password?" link stays dead.

## Employee profile fields + profile picture (as built)
Direct request: "Add the full name, designation, department/Team and employee id to the profile settings, Also have the option for profile picture." No existing HR-style fields on `users` beyond `name` — this is the first pass at treating a user record like an employee profile rather than just a login identity. The pre-existing "Display name" field on Profile Settings was relabeled "Full name" (same underlying `users.name` column, no new field) rather than adding a second, redundant name field.

**Schema**: four new columns on `users`, all migrated the same `columnExists()`-guarded way as every other add-later column in this file — `designation`, `department`, `employee_id` (all `TEXT NOT NULL DEFAULT ''`), and `avatar_path` (nullable `TEXT`, relative path under `UPLOADS_ROOT`, same convention as `meeting_assets.storage_path`). `employee_id` is free text, deliberately **not** enforced-unique — SQLite's `ALTER TABLE ADD COLUMN` can't attach a `UNIQUE` constraint after the fact, and at this app's demo scale that's left as an admin convention rather than a hard constraint.

**Shared row→user helper**: `AuthedUser` (the client-facing shape) and the new `AuthedUserRow` (the raw SQL row, which carries `avatar_path` instead of `avatar_url`) both live in `server/src/auth.ts`, along with a shared `USER_SELECT_COLUMNS` constant and a `toAuthedUser()` transform. Every place that needs a full authed-user response — `getUserForToken()`, `PATCH /auth/me`, the avatar upload/remove handlers — uses the same SELECT + transform instead of duplicating the join four times. `avatar_url` is computed, never stored: `avatar_path ? '/users/<id>/avatar' : null` — the raw storage path is never sent to the client.

**`PATCH /api/auth/me`** gained `designation?`, `department?`, `employeeId?` alongside the existing `name`/`currentPassword`/`newPassword`. Same ordering convention as the rest of this endpoint (validate before writing), but these three are free-text HR fields, not identity-bearing like name/password — no validation beyond `.trim()`, blank is a valid "not set yet" value, and the "nothing to update" 400-check now spans all five optional fields.

**Avatar upload** (`POST /api/auth/me/avatar`, multipart field `avatar`) uses the same `multer.diskStorage` pattern as `meetings.ts`'s asset uploads, writing to `server/uploads/avatars/<userId>/<uuid>-<originalname>` instead of a per-meeting folder. 5MB limit (a profile photo, not a recording — `meetings.ts`'s asset limit is 200MB). `fileFilter` silently drops non-image MIME types (`req.file` stays `undefined`, checked as a 400 rather than surfacing multer's own error path — simpler for a demo-scale upload). Uploading replaces any prior photo: the old file is `unlinkSync`'d after the DB row is updated to point at the new one. **`DELETE /api/auth/me/avatar`** clears `avatar_path` back to `NULL` and unlinks the file from disk.

**`GET /api/users/:id/avatar`** (in `users.ts`, not `auth.ts` — grouped with the rest of `/api/users`) serves the raw file, org-scoped (`WHERE org_id = ? AND id = ?`, 404 if the row or file is missing). Deliberately **no** `Content-Disposition` header (unlike `meetings.ts`'s asset `/download` route, which forces a download) — this needs to render inline as an `<img src>`, and `res.sendFile` sets `Content-Type` from the file extension automatically.

**Bug caught during browser verification**: the first version returned `avatar_url: '/api/users/<id>/avatar'` from `toAuthedUser()` — but the frontend's `API_BASE_URL` already includes the `/api` prefix (same convention as every other `${API_BASE_URL}/<path>` usage in this app), so the actual `<img src>` resolved to `/api/api/users/.../avatar` and 404'd, rendering a broken-image icon in both the Profile Settings card and the header dropdown button. Confirmed via `document.querySelectorAll('img')` in the browser (`naturalWidth: 0` on the broken image) before finding the double-prefix in the network log. Fixed by dropping the `/api` from the backend-generated path (`'/users/<id>/avatar'`) — re-verified afterward with `naturalWidth: 1` on both the card and header images.

Verified via curl end-to-end: `GET /auth/me` returns the four new fields with correct empty/`null` defaults on an untouched user; `PATCH /auth/me` round-tripped `designation`/`department`/`employeeId`; avatar upload returned an `avatar_url`, the served file came back with `Content-Type: image/png` and the correct bytes; `DELETE` avatar returned `avatar_url: null` and the file 404'd afterward; org-scoping confirmed by the file path including the org-scoped `WHERE` clause (not separately cross-org tested — no second org's user was available in this session). Then verified live in the browser (not just curl): filled and saved all three HR fields through the real form, confirmed a "Saved." message, reloaded the page and confirmed the values persisted; uploaded a real image through the hidden file input (native `<input type="file">`, not simulated), confirmed it rendered in both the Profile Settings card and the header dropdown button; clicked **Remove**, confirmed it reverted to the initials fallback in both places. All test data (HR field values, uploaded file) reset/removed afterward, leaving the real user's row and `server/uploads/avatars/` clean.

## Admin role (as built)
Direct request, after the "Company holidays" feature shipped fully open (any org member could add/remove — see `dashboard/backend.md`): "It should not be accessible to everybody." This is the first real *role* check anywhere in this app — every permission decided earlier (task completion, task delete) was scoped to "the person a specific thing belongs to" (an assignee), which a company-wide holiday list has no equivalent of. Asked whether viewing should also be restricted, or only editing — confirmed viewing stays open to everyone, only add/remove gets locked down.

`users.role` (`'admin' | 'member'`, default `'member'`) — a plain column, not a separate roles/permissions table, since there's exactly one binary distinction to make so far. `requireAdmin` (`server/src/auth.ts`), chained after `requireAuth`, checks `req.user!.role === 'admin'` and 403s (`admin_required`) otherwise.

**Who becomes admin:** `POST /auth/signup` now checks whether the org already existed *before* creating it — if not (this signup is the one creating a brand-new org), that user becomes `'admin'`; joining an org that already exists (matching email domain) makes you a `'member'`. Nobody else could reasonably start out with the role, since no one else exists in a brand-new org to have granted it. Invited teammates (`POST /users/invite`) and every other user-creation path stay `'member'` by the column's default — invites in particular should never silently grant admin.

**Existing seed data predates this migration** (`users` didn't have a `role` column until now — `columnExists('users', 'role')` migration in `db.ts`, defaulting every existing row to `'member'`), so nobody in this org would've had `'admin'` without a one-off fix. Promoted `Ambika` — the one user `seed.ts` actually creates directly (everyone else in this org was auto-created later by the task-extraction feature, see `meetings/backend.md`) — via a one-off script, same pattern as every other retroactive data fix this session.

Applied to `holidays.ts`: `GET /holidays` stays `requireAuth`-only (unchanged); `POST`/`DELETE` gained `requireAdmin` as a second middleware. One TypeScript wrinkle: adding `requireAdmin` as an extra handler argument on `.delete('/:id', requireAdmin, ...)` widened `req.params.id`'s inferred type from `string` to `string | string[]` (Express's overload resolution loosens params typing when a generically-typed middleware is chained in) — worked around with an explicit `req.params.id as string` cast rather than fighting the overload resolution.

Verified via curl: demoted Ambika to `'member'` temporarily, confirmed `POST`/`DELETE /holidays` both now 403 (`admin_required`) while `GET /holidays` still 200 — restored her to `'admin'` immediately after. `GET /auth/me` confirmed returning `"role":"admin"` for the real session. Live in the browser: the holidays UI (Profile Settings at the time — later moved, see below) correctly hid the Remove buttons and Add form for a `'member'` session (replaced with "Only an admin can add or remove company holidays."), and showed them for `'admin'` — same session, role flipped in the DB between the two screenshots, not two different logins.

## `org_name` on the authed user (as built)
Direct follow-up, needed for the "Navedas Holidays" dropdown/page move (see `landing-login/frontend.md`): the account menu needed to read `"{org name} Holidays"`, but `AuthedUser` had never carried anything from `organizations` — `org_id` only. `getUserForToken()`'s query gained `JOIN organizations o ON o.id = u.org_id` and `o.name AS org_name`; `PATCH /auth/me`'s response query got the same join, since it independently re-selects the user rather than reusing `req.user`. Fixing the `PATCH` query surfaced the pre-existing `role` gap noted above — both columns added to that `SELECT` in the same edit.

Verified via curl: `GET /auth/me` and `PATCH /auth/me` both confirmed returning `"org_name":"Navedas"` for the real session, alongside `role`.

## Mandatory vs. optional holidays (as built)
Direct follow-up: "Make the optional holidays a different section within the same page." The 5 floating/pick-your-own holidays had been distinguished from the 8 fixed company closures only by an `"(Optional)"` suffix baked directly into the `name` string (see `dashboard/backend.md`'s original holiday-list import) — enough to read, not enough to reliably section on.

New `holidays.is_optional` column (`INTEGER NOT NULL DEFAULT 0`), migrated the same `columnExists()`-guarded way as every other add-later column in this schema. `POST /holidays` now accepts an optional `isOptional` boolean in the body (defaults `false` if omitted); `GET /holidays` serializes it as `isOptional` on every row. Existing data fixed via a one-off script: the 5 optional holidays got `is_optional = 1` and had the now-redundant `" (Optional)"` suffix stripped back out of their `name` — the flag carries that meaning structurally now, so the string didn't need to say it too.

Verified via curl: `GET /holidays` confirmed 8 `isOptional: false` / 5 `isOptional: true` after the fix; added a disposable test holiday with `isOptional: true` through the real Add form (checkbox, not curl), confirmed it returned `isOptional: true` from the API, then deleted it, leaving the real 13 intact.

## Per-person optional-holiday selection (as built)
Direct follow-up: "This year everyone allowed to have only 2 optional holidays, this option needs to be there so that each member can apply." Up to this point "optional" only meant *displayed separately* — there was no way for an individual to actually pick which 2 of the 5 they were taking.

New `holiday_selections` table (`id`, `org_id`, `user_id`, `holiday_id`, `created_at`, `UNIQUE(user_id, holiday_id)`) — a plain new table (no migration needed, added straight to the initial `CREATE TABLE IF NOT EXISTS` block same as `holidays`/`task_activity` were). Personal, not org-wide, so it tracks *who* picked *what*, not just a count.

Three new endpoints on `holidaysRouter`, all `requireAuth`-only — **not** `requireAdmin`. This is a deliberate asymmetry from adding/removing a holiday itself: picking your own 2 is a personal action like marking a task done (only the assignee), not an org-wide edit like adding a holiday (only admin):
- `GET /holidays` — every row now also carries `selectedByMe: boolean`, via `EXISTS(SELECT 1 FROM holiday_selections WHERE holiday_id = h.id AND user_id = ?)` scoped to the requesting user. Each person's `GET` reflects their own picks, not anyone else's.
- `POST /holidays/:id/select` — 404 if the holiday doesn't exist, 400 `not_optional` if it's a mandatory holiday (nothing to "select" — mandatory ones apply to everyone automatically), 409 `already_selected` if already picked, 400 `limit_reached` (`"You can only select 2 optional holidays this year"`) if the user already has `MAX_OPTIONAL_SELECTIONS` (a plain constant, `2`, not a per-org/per-year settings row — nothing yet suggests this number needs to vary, and building a settings table for one number felt premature).
- `DELETE /holidays/:id/select` — removes the caller's own selection, 404 if they hadn't selected it.

`DELETE /holidays/:id` (the admin-only holiday-deletion endpoint) now also clears `holiday_selections WHERE holiday_id = ?` first — same reasoning as `task_activity`'s cleanup before a task delete: `holiday_selections.holiday_id` references the row with `foreign_keys` enforcement on, so deleting a holiday that anyone has selected would otherwise fail with a constraint error.

Verified via curl end-to-end: selected 2 optional holidays successfully (204 each); a 3rd correctly rejected with `limit_reached`; re-selecting an already-picked one correctly rejected with `already_selected`; selecting a mandatory holiday (Holi) correctly rejected with `not_optional`; deselecting one freed a slot, confirmed by successfully selecting a different one afterward. All test selections deselected afterward, leaving a clean 0-selected state on the real data.

## Auth requirements — implemented
- `/app/*` routes are now protected: `AppLayout` calls `useAuth()`, shows a loading state while `GET /api/auth/me` resolves, and redirects to `/` via `<Navigate>` if there's no user.
- Every other route (`projects`, `meetings`, `knowledge`, `dashboard`, `chat`, `search`) uses the same `requireAuth` middleware and scopes all queries to `req.user.org_id` — no cross-org data leakage.

## Bug fixed: session expiry check never actually rejected expired sessions
`getUserForToken()` in `server/src/auth.ts` compared `sessions.expires_at > datetime('now')` — since `expires_at` is written in JS's `toISOString()` format (`T`/`Z`/milliseconds) and `datetime('now')` produces SQLite's own space-separated format, the raw TEXT comparison always favored the JS-formatted side, so this check effectively never rejected an expired session. Fixed by wrapping the column: `datetime(s.expires_at) > datetime('now')`. Same root cause as the bug documented in `dashboard/backend.md` — affects any raw comparison against `datetime('now')` throughout the codebase, all instances of which are now fixed.

## Bug fixed: reseeding used to silently log everyone out
`server/src/seed.ts` used to unconditionally `DELETE FROM sessions; DELETE FROM users; DELETE FROM organizations;` before rebuilding demo data. Since `npm run seed` gets re-run constantly during development (any time the schema or demo content changes), this meant every reseed invalidated whatever session cookie was sitting in the browser — the cookie itself survived, but the session row (and the user row it pointed at) was gone, so `GET /api/auth/me` would 401 and bounce back to the login page. The user explicitly asked to stay logged in across changes, and this was the actual root cause.

**Fix:** seeding is now idempotent for identity data. `organizations` and `users` are looked up by their natural unique key (domain, email respectively) and only inserted if missing — existing rows, and therefore existing sessions pointing at them, are left completely alone. Only the content tables (`projects`, `meetings`, `knowledge_documents`) get wiped and rebuilt on every run, since those are what's actually iterated on during feature work and nothing has a live session tied to their IDs. `sessions` is never touched by the seed script at all anymore.

A related short-lived detour: at one point the login form's email/password fields were temporarily removed in favor of a `POST /api/auth/dev-login` bypass endpoint (log in as the first seeded user, no credentials). The user asked to undo that and keep the real form — `dev-login` was removed again once the seeding fix addressed the actual underlying complaint (repeated logins), which turned out not to require touching the login UI at all.

## Open questions (unresolved)
- Single org per user, or multi-org membership? Current implementation is single-org-per-user, hard link via `users.org_id`.
- "Stay signed in" checkbox is UI-only right now — doesn't actually change session length.
- Where does "Contact sales" route to, now that it's removed from the header?
