# Projects — Backend

**Status: built.** Lives in `server/src/routes/projects.ts`. Schema in `server/src/db.ts` (`projects` table).

## Data model (as built)

```
projects
  id              TEXT pk
  org_id          TEXT -> organizations.id
  name            TEXT
  description     TEXT NOT NULL DEFAULT ''   -- added later, see below
  owner_id        TEXT -> users.id
  status          TEXT CHECK IN ('on_track','attention','blocked')
  git_url         TEXT NOT NULL DEFAULT ''   -- added later, see below
  deployment_url  TEXT NOT NULL DEFAULT ''   -- added later, see below
  env_username    TEXT NOT NULL DEFAULT ''   -- added later, see below
  env_password    TEXT NOT NULL DEFAULT ''   -- added later, see below — plain text, no hashing
  created_at      TEXT
  updated_at      TEXT       -- drives default sort and "Updated Xh ago"
```
`description` was added via an `ALTER TABLE ... DEFAULT ''` migration (a plain empty-string default is a constant, so — unlike the `meetings.created_at` migration — no separate backfill `UPDATE` was needed). Added specifically because creating a project with only a name wasn't giving the project any real content — see `projects/frontend.md` for the "+ New project" form that now sets it.

`git_url` / `deployment_url` / `env_username` / `env_password` were added the same way (constant `''` defaults, no backfill) for the "environment/deployment access" fields the user asked to add to each project — where's the repo, where's it deployed, and what credentials open it. API/UI-facing field names are the plain `gitUrl` / `deploymentUrl` / `username` / `password`; the DB columns use an `env_` prefix on the latter two specifically to avoid any confusion with the real auth system's `users.password_hash` — these are a linked environment's login, not this app's.

**`env_password` is stored as plain text, not hashed or encrypted.** This was an explicit, direct instruction from the user ("Keep as normal text") after being asked whether to mask/encrypt it — not an oversight. The frontend also renders it as a plain visible `type="text"` input, not `type="password"`. In a real production app storing real third-party credentials this would be a serious risk (plaintext secrets in the DB and on-screen); it's acceptable here only because this is a demo/portfolio app with seeded, non-sensitive data. If this app ever handled real credentials, this column should move to an encrypted-at-rest secret store instead.
`doc_count` / `meeting_count` are **not** denormalized columns — they're computed live via correlated subqueries (`SELECT COUNT(*) FROM knowledge_documents WHERE project_id = p.id`) on every list/detail query. Fine at this scale (single-digit projects); would need real denormalized counters or a join+aggregate rewrite before this matters at real scale.

## Endpoints (as built)

| Method | Path | Status | Notes |
|---|---|---|---|
| `GET` | `/api/projects?status=` | ✅ built | `status` is one of `all\|on_track\|attention\|blocked`. Returns `{ items, counts }` — `counts` is a separate `GROUP BY status` query over the *unfiltered* set, so chip counts stay correct regardless of the active filter. Each item's `owner` now includes `id` (previously name/initials only — needed so the frontend can pre-fill an edit form's owner dropdown). |
| `POST` | `/api/projects` | ✅ built, wired to the frontend | **Multipart**, not JSON (see below). Fields: `name, description?, status?, ownerId?, gitUrl?, deploymentUrl?, username?, password?, file?` → `status` defaults `'on_track'` if omitted (else validated against the 3 allowed values), `ownerId` defaults to the requesting user if omitted (else validated to belong to the same org via `isValidOwner()`), the 4 env fields default to `''`. Called from `ProjectsPage`'s create modal. |
| `GET` | `/api/projects/:id` | ✅ built | Single project, same shape as list items (now including `gitUrl`/`deploymentUrl`/`username`/`password`). No frontend route consumes this directly (the edit modal is pre-filled from the list response, not a separate detail fetch). |
| `PATCH` | `/api/projects/:id` | ✅ built, wired to the frontend | `{ name?, description?, status?, ownerId?, gitUrl?, deploymentUrl?, username?, password? }` — same validation as `POST` for `status`/`ownerId`. **Owner-only** (403 `not_owner` otherwise — see below). Bumps `updated_at`. Called from `ProjectsPage`'s edit drawer (opened by clicking a project card). |
| `GET` | `/api/users` | ✅ built (new route, `server/src/routes/users.ts`) | `{ items: { id, name, initials }[] }`, all users in the requester's org, sorted by name. Powers the "Owner" dropdown in both the create and edit forms. |

No pagination (`page`/`limit`) implemented on `/api/projects` — deferred since the seed data is only ~9-12 projects. No `DELETE /api/projects/:id` — nothing in the frontend needs it yet.

## Auth
`requireAuth`, all queries scoped to `req.user.org_id` (no `:orgId` path param, unlike the original spec — see `dashboard/backend.md` for why). `POST` (create) has no permission check beyond org membership — anyone can create a project, becoming its owner. `PATCH` (edit) is now owner-only — see below. `GET` (view) stays open to every org member regardless of ownership.

## Owner-only editing (as built)
Direct request: "each project on the dashboard needs to be clickable so that each one view the details but it can't be editable except the owner." Two parts: making projects clickable/viewable from the Dashboard (see `dashboard/frontend.md` and `projects/frontend.md`) and — the part that lives here — actually enforcing that only the owner can change one.

`PATCH /api/projects/:id` now looks up the existing row's `owner_id` before touching anything else, and 403s with `{ error: 'not_owner', message: '...' }` if `existing.owner_id !== req.user!.id`. This check runs against the *current* `owner_id` — if ownership is ever reassigned, the new owner can edit going forward and the old owner immediately can't, with no grandfathering either direction. Deliberately not extended to admins-can-always-edit or any other exception — the request was specifically "except the owner," so that's the literal rule implemented; `GET` remains unrestricted (any org member can still view/open a project, just not change it), matching the "view details" half of the request.

**Not just a frontend hide** — the check is server-side, so calling `PATCH` directly (curl, a modified client, etc.) as a non-owner is rejected regardless of what the UI shows or disables. The frontend's disabled fields (see `projects/frontend.md`) are a UX courtesy, not the actual enforcement.

Verified via curl: temporarily reassigned the real project's `owner_id` to a different org user, confirmed `GET /projects/:id` still returned `200` for the original owner (viewing stays open), confirmed `PATCH` from the original owner's session now returned `403 not_owner`, then reassigned ownership back and confirmed the same session's `PATCH` succeeded (`204`) again — proving the check tracks live ownership, not a cached/stale value.

## Bug found + fixed while wiring up "+ New project": timestamps written via SQL default showed the wrong "time ago"
`POST /api/projects` didn't set `created_at`/`updated_at` explicitly, so they fell back to the column's `DEFAULT (datetime('now'))` — SQLite's own space-separated format, no `Z`. Every other timestamp in the app is written by JS as `new Date().toISOString()` (`T`/`Z`/milliseconds). The frontend's `timeAgo()` does `new Date(iso).getTime()`, and browsers parse a `Z`-less, space-separated string as **local** time rather than UTC — so a project created seconds ago showed up as "Updated 6h ago" (the size of the gap matches the local/UTC offset). This is the write-side sibling of the read-side bug documented in `dashboard/backend.md` (same root cause: mixing SQL-generated and JS-generated timestamp formats in the same column).

**Fix:** `POST /api/projects` and `PATCH /api/projects/:id`'s `updated_at` bump now both write `new Date().toISOString()` explicitly instead of relying on `datetime('now')`. The same fix was applied to `knowledge.ts`'s `PATCH` and `meetings.ts`'s `POST` (both had the identical pattern) — see those files' backend docs. Verified via curl: a freshly created project now returns `updatedAt: "2026-07-29T11:46:50.398Z"` and renders as "just now" instead of "Updated 6h ago".

## Attach a document on project creation (as built)
The "0 docs" question ("why is this showing 0 doc and 0 meetings") led into "where's the option to upload a doc," which surfaced that this app had **no** path — automatic or manual — for a document to ever get linked to a project (see `knowledge-base/backend.md`'s "Attach a document" section for the full trace of why: Gmail-synced docs always insert `project_id = NULL`, and the one manual-create endpoint, `POST /knowledge`, had no frontend caller at all). Two fixes were on the table — teaching Gmail sync to infer a project, and a manual upload UI — the user picked the second, scoped specifically to project creation: "while creating the project details, there should be a field to upload the doc if any."

`POST /api/projects` changed from JSON to **multipart** to carry optional files alongside the existing project fields in the same request — multer parses the non-file fields into `req.body` as strings exactly like JSON would have, so none of the existing field-handling logic needed to change, just the request's content type.

**Why memory storage, not disk storage** (the pattern every other upload in this app uses — meeting assets, avatars): those all have their parent entity's id available *before* the file arrives (the meeting/user already exists, the id is in the URL). Here, the project doesn't exist yet — it's being created in this same request — so there's no id yet for multer's `diskStorage.destination` callback (which runs before the route handler body) to build a folder from. `multer.memoryStorage()` buffers the upload in memory instead; the route handler creates the project row first, gets its real id, *then* writes each buffered file to `UPLOADS_ROOT/project-docs/<projectId>/<uuid>-<filename>` by hand. 20MB cap per file — a document (PDF/deck/sheet), not a recording (`meetings.ts`'s asset cap is 200MB).

**The uploaded files become `knowledge_documents` rows, not a separate "project attachment" table** — deliberately, so each one counts toward the project's existing `docCount` (closing the loop on the original "0 docs" question) and shows up in the Knowledge Base like anything else, rather than inventing a second, parallel "files" concept. New `type = 'file'` value (schema/migration, download endpoint — see `knowledge-base/backend.md`). `title` is the original filename, `excerpt` is empty (a file has no text excerpt to show), `project_id` is the newly created project's id.

**Multiple files, not one** — direct follow-up: "there is no option to add multiple doc." The field is `files` (plural), handled with `projectDocUpload.array('files', MAX_PROJECT_DOC_FILES)` instead of `.single('file')`, capped at `MAX_PROJECT_DOC_FILES = 10`. `req.files` (an array) is looped, writing and inserting one `knowledge_documents` row per file — same per-file logic as the single-file version, just repeated. Zero files, one file, and many files are all the same code path (an empty/absent `files` array just means the loop body never runs), not a special case for "just one."

Verified via curl: created a project with 3 attached `.txt` files via multipart (`files=@a`, `files=@b`, `files=@c`) — the project's `GET /:id` immediately showed `docCount: 3`, and `GET /knowledge?type=file` listed all 3 with the correct `project`/`fileName` values. Downloaded one via `GET /knowledge/:id/download` and confirmed byte-for-byte content match. Created a project with no files and confirmed the request still succeeds normally (files are genuinely optional). Live in the browser: filled the real "New project" form, selected 3 files at once through the actual native file-picker (not simulated), confirmed all 3 listed with individual "×" remove buttons, removed one via its button and confirmed only the other 2 remained, submitted, and confirmed the new project's card showed "2 docs" — matching exactly the 2 files left after the removal, not 3. All test projects/docs/files removed afterward (DB rows deleted, `project-docs/<id>/` folders removed from disk), leaving only the org's real "Navedas IQ" project.

## Open gaps
- Add pagination once seed data grows.
- Decide on RBAC before `PATCH`/`POST` matter in a real multi-user org (currently: any member, any project — including reassigning ownership to anyone else in the org, with no permission check beyond "is authenticated in this org").
- No `DELETE` endpoint.
- `GET /api/users` returns every org member with no pagination — fine at 5 seeded users, would need it at real team size.
- No way to attach a document to an existing project after creation — the files field only exists on the create form, matching the literal scope of the request ("while creating the project details"). Adding a doc to a project later still has to go through the Knowledge Base's `POST /knowledge` — which itself has no frontend caller, see `knowledge-base/frontend.md`.
- Hard cap of 10 files per project creation (`MAX_PROJECT_DOC_FILES`) — multer rejects the 11th+ file rather than silently accepting only the first 10, but there's no custom multer-error handler wired up, so exceeding the cap currently surfaces as a generic 500 rather than a clean 400 with a helpful message. Not hit in practice (10 is a lot for one project), but worth a proper error handler if this ever gets tightened.
