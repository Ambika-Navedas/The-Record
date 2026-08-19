# Landing / Login — Frontend

## Route
`/` → `src/pages/LandingPage.tsx` (public, no auth guard).

## Component structure
Single-file page component, no sub-components extracted yet.

- `LogoMark()` — inline SVG mountain-peak mark, duplicated in `AppLayout.tsx` (not shared). Worth extracting to `src/components/LogoMark.tsx` if a third usage appears.
- `LandingPage()` — the page itself:
  - `nav` — logo + "Log in" button only (product/solutions/resources/pricing links and the "Try The Record free" / "Contact sales" nav items were removed per user request; see design.md for history).
  - Hero grid (`grid-cols-[60%_40%]`) — left column: eyebrow pill + headline + subheading only (CTA button row and "Trusted by teams at" logo strip were removed; left column has an unresolved whitespace gap below the subheading).
  - Right column: `<form onSubmit={handleSubmit}>` — the login/signup card. Toggles between `mode: 'login' | 'signup'` (local `useState`) — signup mode adds a "Full name" field and swaps copy/button labels.
  - Bottom strip — avatar stack + "312 knowledge items and 48 meetings..." line (still hardcoded, not real).

## State & behavior
Real auth now, backed by `server/src/routes/auth.ts`:
```ts
async function handleSubmit(e: React.FormEvent) {
  e.preventDefault()
  setError(null)
  setSubmitting(true)
  try {
    if (mode === 'signup') {
      await api.post('/auth/signup', { name, email, password })
    } else {
      await api.post('/auth/login', { email, password })
    }
    navigate('/app/dashboard')
  } catch (err) {
    setError(err instanceof ApiError ? err.message : 'Something went wrong. Is the API server running?')
  } finally {
    setSubmitting(false)
  }
}
```
- Controlled inputs: `name`, `email`, `password` (`useState`), plus `error` and `submitting` for UI feedback.
- On success, the server sets an httpOnly session cookie (`record_session`) and the app navigates to `/app/dashboard`. `AppLayout`'s auth guard (`useAuth()`) picks up the session via `GET /api/auth/me`.
- Submit button shows "Please wait…" and disables while `submitting` is true; a red inline error box shows API failures (e.g. duplicate email on signup, wrong password on login).

## Google sign-in / SSO (as built)
Direct request: "make the set up," after being told the buttons were dead. Both **"Continue with Google"** and **"Continue with SSO"** call the same `handleGoogleSignIn()`, a real full-page navigation — `window.location.href = \`${API_BASE_URL}/auth/google\`` — not an `api.post(...)` fetch, since Google's consent screen needs a top-level browser redirect, not something a background request can drive. See `landing-login/backend.md`'s "Google sign-in" section for why "SSO" reuses the Google flow instead of a separate identity provider, and the full server-side round trip.

Success never comes back to this component at all — the server sets the session cookie and redirects straight to `/app/dashboard` itself, bypassing `handleSubmit`/`navigate()` entirely (those still only handle the email/password form). Failure comes back as `?error=google_auth_failed` on a reload of `/`, since a thrown-and-caught exception isn't possible across a real page navigation the way it is for the `fetch`-based login/signup calls. A `useEffect` (`useSearchParams` from `react-router-dom`) checks for that param once on mount, sets the same `error` state the password form's catch block uses (so it renders in the identical red banner), then strips the param from the URL (`setSearchParams(..., { replace: true })`) so refreshing the page doesn't keep re-showing a stale error from a prior failed attempt.

The "Continue with SSO" button keeps its own label and a `title` tooltip ("Uses your Google account — no separate enterprise identity provider is configured") rather than being silently identical to the Google button or relabeled — an honest hint for the one person who might expect a different login screen, without pretending to be enterprise SSO it isn't.

## App header — profile menu + Profile settings page (as built)
Direct request: the avatar circle in `AppLayout.tsx`'s header used to *be* the logout button — one click, no menu, no way to get anywhere else. Now it opens a dropdown (`menuOpen` state, `menuRef` + a `mousedown` listener added/removed via `useEffect` to close on an outside click) showing the user's name/email, a **Profile settings** link, a **`{org_name} Holidays`** link (added later — see below), a **WorkNest** link (added later still — leave management, see `worknest/frontend.md`; originally leave management + payslips, but the payslips section was removed entirely, see `worknest/backend.md`), and **Log out** — logout is now a menu item instead of the entire button's behavior.

New route `/app/profile` → `src/pages/ProfileSettingsPage.tsx`, three independent cards:
- **Profile picture**: a circular preview — the uploaded photo (`<img>`, `object-cover`) if `user.avatar_url` is set, else the same initials-on-flat-color fallback used everywhere else in this app. **Upload photo** / **Change photo** triggers a hidden `<input type="file" accept="image/*">` via a `ref` (`avatarInputRef.current?.click()` — no visible native file-input chrome). Selecting a file immediately uploads it (`api.upload('/auth/me/avatar', formData)`, no separate "save" step) and calls `updateUser()` with the response. A **Remove** button (only rendered once a photo exists) calls `DELETE /auth/me/avatar`. A local `avatarBust` counter, incremented on every successful upload/remove and appended as `?v=` on the image URL, forces the browser to refetch instead of showing a stale cached image at the same URL after a change.
- **Personal details**: `Email` (read-only), `Full name` (the pre-existing "Display name" field, relabeled — same underlying `PATCH /auth/me` `name` field, not a new one), `Designation`, `Department / Team`, `Employee ID` — all plain text, all optional. One **Save details** button, disabled until at least one field's trimmed value differs from the current user record. Submits `PATCH /auth/me` with `{ name, designation, department, employeeId }` together in one request.
- **Change password**: current/new/confirm fields, unchanged from before. Confirms `newPassword === confirmPassword` client-side before the request (the API only ever sees `currentPassword`/`newPassword`, never the confirmation field). Submits `PATCH /auth/me` with `{ currentPassword, newPassword }`.

All three call `useAuth().updateUser(updated)` on success — pushing the full `AuthedUser` response straight into `AuthContext` — which is what makes the header avatar (initials *or* photo, see below) update immediately after any change, with no page reload and no redundant `GET /auth/me` call.

`AppLayout.tsx`'s header button (the one that opens the account dropdown) now also renders `user.avatar_url` as an image when set, `overflow-hidden` on the circular button so the `<img className="h-full w-full object-cover">` clips to the same circle the initials used to fill — same avatar, same place, just a photo instead of a two-letter fallback once one's uploaded.

**Bug caught in browser verification, not curl**: the first version's uploaded photo rendered as a broken-image icon in both the Profile Settings card and the header button. Root cause was a backend URL-shape bug (double `/api` prefix — see `landing-login/backend.md`'s "Employee profile fields" section for the fix); confirmed the fix by checking `naturalWidth` on the `<img>` elements directly (`0` when broken, `1` once fixed, matching the 1×1 test image used), not just a visual screenshot.

Verified live: opening the menu shows name/email/Profile settings/Log out; navigating to `/app/profile` pre-fills the current name/designation/department/employee ID and shows the disabled "Save details" button (unchanged values). Filled and saved all three new fields through the real form, confirmed a "Saved." message, reloaded the page and confirmed the values persisted. Uploaded a real image through the real (hidden) file input — not simulated via raw JS — confirmed it rendered correctly in both the Profile Settings card and the header dropdown button; clicked **Remove**, confirmed both reverted to the initials fallback. All test values and the uploaded file were reset/removed afterward via the same UI/API, leaving the real account's row and `server/uploads/avatars/` clean. Name/password round-tripping itself was verified via curl instead of live-editing the real logged-in demo account (see `landing-login/backend.md`'s "Profile settings" section for those results) — the new HR fields and avatar, by contrast, were verified end-to-end through the actual UI.

**Company holidays: added to Profile Settings, then moved to its own page.** First cut (direct follow-up once the dashboard's "Next event" calendar gained holiday support, see `dashboard/backend.md`/`dashboard/frontend.md`) put a third card on `ProfileSettingsPage.tsx`, since a `holidays` table with no CRUD UI anywhere would be a dead feature and Profile Settings was the only settings-ish page that existed. Then admin-gated (`isAdmin = user.role === 'admin'` — see `landing-login/backend.md`'s "Admin role" section for the `users.role` column and `requireAdmin` middleware this introduced): the list itself always rendered for everyone, but each row's **Remove** button and the add `<form>` only rendered `{isAdmin && ...}` — a non-admin saw the same list plus the sentence "Only an admin can add or remove company holidays" in place of the form, not a disabled/grayed-out one, since there was nothing productive left to interact with.

**Then moved out of Profile Settings entirely**, direct follow-up: "Holiday calendar needs to be visible as Navedas Holidays within the dropdown of the account section and not within the profile settings." New page, `src/pages/HolidaysPage.tsx` (all the same logic and markup lifted out of `ProfileSettingsPage.tsx` verbatim — `fetchHolidays()`, `formatHolidayDate()`, the admin-gated list/form), new route `/app/holidays`, and a new item in the account dropdown between "Profile settings" and "Log out" reading **`{user.org_name} Holidays`** — literally "Navedas Holidays" for this org, not a hardcoded string, so this reads correctly for any org rather than baking in one company's name.

`org_name` didn't exist on the authed-user object before this — `AuthedUser`/`getUserForToken` only ever selected columns off `users`, nothing from `organizations`. Added a `JOIN organizations o ON o.id = u.org_id` to that query (and to `PATCH /auth/me`'s response query, which — caught while making this change — had been missing `role` this whole time despite `landing-login/backend.md` claiming otherwise; both gaps fixed together). The page title reads `{user.org_name} Holidays` too, so it's self-evident whose calendar you're looking at without needing the dropdown label as context.

Verified live: added a holiday through the real form and confirmed the new row appeared; removed one through the real **Remove** button, confirmed via a direct `GET /api/holidays` re-query that it persisted server-side rather than trusting the page's own re-render; flipped the same session's role between screenshots to confirm both the admin and non-admin views render correctly on the new page. Confirmed the dropdown now shows "Navedas Holidays" as a real link (`href="/app/holidays"`) with the correct org name interpolated, the new page renders the full list at its own route, and `ProfileSettingsPage.tsx` no longer mentions "Company holidays" anywhere.

**Split into "Holidays" and "Optional Holidays" sections**, direct follow-up: "Make the optional holidays a different section within the same page." Until this point the distinction was purely textual (`" (Optional)"` appended to a name) — `HolidaysPage.tsx` now filters the same `holidays` array client-side into `mandatoryHolidays`/`optionalHolidays` (`.filter(h => !h.isOptional)` / `.filter(h => h.isOptional)`, reading the new `isOptional` field — see `landing-login/backend.md`'s "Mandatory vs. optional holidays" section for the backend column). Mandatory holidays render through a shared `renderList()` helper into their own card; the Optional card originally reused the same helper too, then got its own custom row markup once per-person selection landed (see below) — it needed a checkbox `renderList()` had no slot for. A third card holds the add form, with a **"This is an optional holiday"** checkbox (`holidayOptional` state) that gets included as `isOptional` in the `POST /holidays` body and reset after a successful add — previously an admin would've had to manually type `"(Optional)"` into the name field to get the same effect, which is exactly the kind of fragile string convention this change replaced.

Verified live: added a disposable test holiday with the checkbox checked through the real form, confirmed via `GET /api/holidays` that it saved with `isOptional: true`, then confirmed visually (screenshot) that it rendered inside the "Optional Holidays" card, not "Holidays" — then removed it, leaving the real 8/5 split (13 total) intact.

**Per-person selection, immediate follow-up**: "This year everyone allowed to have only 2 optional holidays, this option needs to be there so that each member can apply." The Optional Holidays card gained a real checkbox per row (`checked={h.selectedByMe}`, `onChange={() => handleToggleSelect(h)}` — `POST`/`DELETE /holidays/:id/select`, see `landing-login/backend.md`), a live counter in the section subtitle (`"(N of 2 selected)"`, `MAX_OPTIONAL_SELECTIONS = 2` mirrored client-side purely for that copy — the backend is what actually enforces the cap), and a `disabled` state on any *unchecked* box once `selectedCount >= MAX_OPTIONAL_SELECTIONS` (a `title` tooltip explains why, same disabled-with-tooltip pattern as the task-completion checkbox in `meetings/frontend.md`). A checked box always stays enabled regardless of count, so unchecking to free a slot is never blocked. This checkbox is deliberately **not** admin-gated — every member (including a non-admin) can select their own, since it's a personal pick, not an org-wide edit; the admin-only **Remove** button still sits in the same row, doing something entirely different (deleting the holiday from the calendar for everyone).

Verified live: selected 2 optional holidays through the real checkboxes, confirmed the counter updated to "2 of 2" and the 3 remaining boxes became `disabled: true` (checked via direct DOM inspection, not just visually) while the 2 checked ones stayed `disabled: false`; deselected both afterward and confirmed via `GET /api/holidays` that the org's data returned to 0 selections.

## Data dependencies
`src/lib/api.ts`'s `api.post()` for `/auth/signup` and `/auth/login`, `api.patch()` for `/auth/me` (Profile settings page — see above), `api.upload()`/`api.delete()` for `/auth/me/avatar` (Profile picture card — see above), `api.get()`/`api.post()`/`api.delete()` for `/holidays` (Company holidays section — see above). No other page data — headline/trusted-by copy/bottom-strip counts are still hardcoded JSX.

## Known gaps
- Google/SSO buttons don't do anything (need real OAuth client credentials — see backend.md).
- No client-side form validation beyond HTML5 `required`/`type="email"` (server does validate required fields and duplicate-email on signup).
- "Stay signed in" checkbox is decorative — session length is currently fixed (30 days) regardless of the checkbox state.
- "Forgot password?" link is dead (`href="#"`).
- Left hero column has an unresolved whitespace gap after the earlier CTA/trusted-by removal.
- Bottom strip's "312 knowledge items and 48 meetings" is still a hardcoded string, not derived from the real org's data.
- `Employee ID` isn't validated or enforced-unique client- or server-side — two people in the same org could save the same ID with nothing stopping them.
- No cropping/resizing on avatar upload — whatever image is selected renders at its native aspect ratio inside a fixed circle via `object-cover`, so an off-center or non-square photo may crop awkwardly.
