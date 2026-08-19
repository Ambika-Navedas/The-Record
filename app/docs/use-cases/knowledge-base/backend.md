# Knowledge Base — Backend

**Status: built** (manual/seeded documents, plus a real Gmail email sync — see below). Lives in `server/src/routes/knowledge.ts` and (for the Gmail sync specifically) `server/src/routes/integrations.ts`. This is the most foundational table in the app — `ask-the-record`'s retrieval engine (`server/src/search.ts`) queries it directly, and `meetings` conceptually should populate it (not yet automated, see gaps).

## Data model (as built)

```
knowledge_documents
  id                 TEXT pk
  org_id             TEXT -> organizations.id
  project_id         TEXT -> projects.id, nullable
  type               TEXT CHECK IN ('sop','meeting_note','decision','faq','email','file')  -- 'email' then 'file' added later, see below
  title              TEXT
  excerpt            TEXT       -- content field for text-based types; empty for type='file' — see "Attach a document" below
  owner_id           TEXT -> users.id
  source_meeting_id  TEXT -> meetings.id, nullable
  keywords           TEXT       -- JSON array, hand-seeded; not auto-extracted (except email — see below)
  view_count         INTEGER    -- default 0; added later, see below
  external_id        TEXT, nullable  -- Gmail message id, for dedup on re-sync — added later, see below
  storage_path       TEXT, nullable  -- relative path under UPLOADS_ROOT, type='file' only — added later, see "Attach a document" below
  file_name          TEXT, nullable  -- original uploaded filename, type='file' only
  mime_type          TEXT, nullable  -- type='file' only
  size_bytes         INTEGER, nullable  -- type='file' only
  created_at         TEXT
  updated_at         TEXT
  deleted_at         TEXT, nullable  -- soft delete for the trash feature — NULL = active, timestamp = trashed. Added later, see "Trash" below.
```
Deviation from the original spec: no separate `body` vs `excerpt` — for a demo-scale corpus (12 docs), one content field is enough. `keywords` remain hand-authored in the seed data rather than auto-extracted, same as the original frontend mock — except for synced emails, where `keywords` is set to `[senderEmail]` automatically (see below).

`type`'s CHECK constraint and the new `external_id` column were added via the same full-table-rebuild pattern documented in `meetings/backend.md` (SQLite can't `ALTER` a CHECK constraint in place). No `PRAGMA foreign_keys` toggle was needed for this rebuild, unlike the `meetings` one — nothing else in the schema has an incoming foreign key reference to `knowledge_documents(id)`.

`view_count` was added later (via an `ALTER TABLE` migration in `db.ts`) as a lightweight popularity signal for the Dashboard's "Most popular content" card (see `dashboard/backend.md`). It's incremented by `server/src/routes/chat.ts` every time Ask The Record cites the document as a source — see `ask-the-record/backend.md` for the exact increment logic and why this is a deliberately different kind of persistence than the `chat_queries` log that was removed earlier in the project (a counter on the document, no question text, no user identity attached).

## Endpoints (as built)

| Method | Path | Status | Notes |
|---|---|---|---|
| `GET` | `/api/knowledge?type=&date=` | ✅ built | `type` is `all\|sop\|meeting_note\|decision\|faq`. `date` is `all\|today\|week\|month` — added later (see below) to replace a decorative frontend sort control with a real filter. Returns `{ items, counts }`, counts from a separate `GROUP BY type` query that also respects `date`, so switching date range updates every type chip's count, not just which rows show. Each item includes a real `isFresh` boolean — `updated_at` within `FRESH_WINDOW_HOURS` (24h), replacing the old frontend string-matching hack. |
| `GET` | `/api/knowledge/:id` | ✅ built, wired to the frontend | Now powers `KnowledgeDetailPage.tsx` — same `serialize()` shape as list items, full (untruncated by this endpoint) `excerpt` included. |
| `POST` | `/api/knowledge` | ✅ built, still **no frontend caller** | `{ type, title, excerpt?, projectId?, keywords? }`. This is the endpoint that *could* have powered a general-purpose "add a document" UI — instead, project-creation's document upload writes directly via its own `INSERT` in `projects.ts` (see `projects/backend.md`), since it needed multipart file handling this JSON-only endpoint doesn't have. |
| `PATCH` | `/api/knowledge/:id` | ✅ built | `{ title?, excerpt? }`, bumps `updated_at`. No frontend UI calls this. |
| `GET` | `/api/knowledge/trash` | ✅ built | Lists this org's trashed documents (`deleted_at IS NOT NULL`), ordered by `deleted_at DESC`. Registered *before* `/:id` in the router so the literal path `trash` isn't swallowed by the `:id` param route. |
| `GET` | `/api/knowledge/:id/download` | ✅ built (new) | `type='file'` documents only — serves the raw uploaded file via `res.download()` (forces a download with the original filename, same as `meetings.ts`'s asset download route). 404 if the document has no `storage_path`, or if `not_found`. Org-scoped. |
| `POST` | `/api/knowledge/:id/trash` | ✅ built | Soft delete — sets `deleted_at` to now. Idempotent (204 no-op if already trashed). |
| `POST` | `/api/knowledge/:id/restore` | ✅ built | Clears `deleted_at`, making the document active again everywhere. |
| `DELETE` | `/api/knowledge/:id` | ✅ built | Permanent delete — actually removes the row. 400s with `not_trashed` if the document isn't already trashed; the only way to hard-delete is trash first, then delete from there. For a `type='file'` row, also unlinks `storage_path` from disk (same "delete the DB row and its file together" pattern as `meetings.ts`'s asset delete). |

`PATCH`'s `updated_at` bump was fixed to write `new Date().toISOString()` explicitly rather than SQL-side `datetime('now')` — the same timestamp-format bug documented in `projects/backend.md` (a JS-parsed-as-local `Z`-less timestamp shows the wrong "time ago") applied here too, before anything had exercised this code path enough to notice.

## Date filter (as built)
Direct request: remove the frontend's `Sort: Recently updated ⌄` dropdown and replace it with a real date filter. First version: `applyDateFilter(sql, params, date, from, to)` supported named buckets (`date=today|week|month`) plus a `date=custom&from=&to=` pair, applied to **both** the item-list query and the type-counts query in `GET /` so the date range narrows the whole view (every chip's count changes with it), not just which rows render. Deliberately **not** applied to `GET /trash`'s count — trash is a separate view of removed items, not part of "browse active docs by date."

**Simplified** once the frontend moved to `DateRangePicker` (see `frontend.md`) — that component resolves every preset ("Last 7 days" etc.) to concrete dates client-side, so the backend never receives a named bucket anymore, only ever a `from`/`to` pair or nothing. `applyDateFilter(sql, params, from, to)` dropped the `date` enum entirely: `from` present → `AND date(kd.updated_at) >= date(?)`, `to` present → `AND date(kd.updated_at) <= date(?)`, both bound params (never string-interpolated, even though they're expected to already be date-shaped — a raw query-string value never goes straight into SQL text). Either bound alone is valid (open-ended range); both together narrow to an inclusive window. Now the same shape as `tasks.ts`'s `meetingFrom`/`meetingTo`/`dueFrom`/`dueTo` filters, which never had a named-bucket phase to begin with. Verified via curl at each stage: `date=today` → 0 items, `date=week` → 3 items (first version); `from=2026-07-20&to=2026-07-31` → 6 items, every `updatedAt` inside the window (both versions), cross-checked against the live browser render.

## Trash (as built)
Direct request: deleting a document from the Knowledge Base shouldn't remove it from the database — it should move to a trash view, recoverable, until explicitly deleted from *there*, at which point it's gone for good.

Implemented as a soft-delete column (`deleted_at`, nullable — see data model above) rather than a separate `trashed_documents` table, so a trashed row is still the same row with the same id, same relations, same everything — restoring it is a single `UPDATE ... SET deleted_at = NULL`, not a copy-back-and-forth between two tables.

**Every place that reads `knowledge_documents` had to be updated to filter `deleted_at IS NULL`**, not just the main list endpoint — otherwise a "deleted" document would still show up in places that read the table directly:
- `GET /api/knowledge` (list + `counts` — `counts.trash` added, a separate `COUNT(*) WHERE deleted_at IS NOT NULL`)
- `dashboard/backend.md`'s summary endpoint (project doc-counts, freshness stats, daily trend, `documentsByType`, "Most popular content")
- `projects/backend.md`'s project list/detail doc-counts
- The global search bar (`routes/search.ts`)
- Ask The Record's retrieval corpus (`search.ts`'s `buildIndex()`) — a trashed document is excluded from `searchOrgKnowledge`/`answerQuestion` entirely, so the chatbot can't cite something the user just threw away

`GET /api/knowledge/:id` deliberately does **not** filter on `deleted_at` — a trashed document is still readable by direct id (matches "not deleted from the database", and lets a detail link keep working while something sits in trash), it's just excluded from every *list* surface above.

Verified the full lifecycle via curl and live in the browser (gstack `browse`): trash a document → disappears from the main list and `counts.all` drops, appears in `/knowledge/trash` with `counts.trash` incremented, still fetchable by id (200, not 404) → restore → back in the main list, gone from trash → trash again → hard delete via `DELETE /:id` → 404 on direct fetch, main list count and `dashboard/summary`'s `documentsByType.totalItems` both back to their pre-trash value. Also confirmed the guard: `DELETE /:id` on a document that was never trashed correctly 400s with `not_trashed` rather than silently deleting.

## Gmail email sync (as built)

Lives in `server/src/routes/integrations.ts`, alongside the Zoom/Google Meet meeting sync (see `meetings/backend.md`) — reuses the exact same OAuth machinery (`createState`/`consumeState`, `config()`, `upsertConnection`), just a third `Provider` value (`'gmail'`) and its own connect/callback/sync endpoints, since importing emails is a fundamentally different kind of sync than importing meetings (lands in `knowledge_documents`, not `meetings`; requires a mandatory filter; has no natural "sync everything" mode).

| Method | Path | Status | Notes |
|---|---|---|---|
| `GET` | `/api/integrations/gmail/connect` | ✅ built | Same pattern as `/google/connect`, but requesting the `gmail.readonly` scope instead of `calendar.readonly`, and its own redirect URI (`GMAIL_REDIRECT_URI`). Reuses the *same* `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` — one Google Cloud OAuth app, two independent grants, so a user can connect Google Meet without also handing over inbox access (or vice versa). |
| `GET` | `/api/integrations/gmail/callback` | ✅ built | Same shape as the other OAuth callbacks — exchanges the code, stores the token in `oauth_connections` with `provider='gmail'`, redirects to `/app/knowledge?integration=gmail&status=connected\|error` (not `/app/meetings` — Gmail's home is the Knowledge Base page). |
| `PUT` | `/api/integrations/gmail/query` | ✅ built | `{ query }` — sets `oauth_connections.sync_query` for the user's Gmail connection. 400s with `not_connected` if Gmail isn't connected yet. This is the filter that scopes what `/gmail/sync` imports — see below. |
| `POST` | `/api/integrations/gmail/sync` | ✅ built | Fetches messages matching the saved query and upserts them into `knowledge_documents` (`type: 'email'`). 400s with `no_connections` if Gmail isn't connected, or `no_query` if a search query hasn't been saved yet. Returns `{ imported }`. |
| `DELETE` | `/api/integrations/gmail` | ✅ built | Same generic disconnect endpoint used for Zoom/Google (`DELETE /api/integrations/:provider`), extended to accept `gmail`. |

### Why a mandatory search query, not an optional filter
A Gmail inbox has no natural boundary the way a calendar does — "sync my meetings" means "the meetings on my calendar," a few dozen at most; "sync my emails" with no filter could mean tens of thousands of irrelevant messages. `fetchGmailMessages()` reuses **Gmail's own search query syntax** (`label:clients`, `from:*@acme.com`, `subject:invoice`, any combination) rather than the app inventing separate filter UI (label picker, sender allowlist, etc.) — the query is passed straight through to the Gmail API's `q` parameter. `/gmail/sync` refuses to run at all (`no_query` error) until one is saved, rather than defaulting to "everything" or silently importing nothing.

### Parsing Gmail messages
- `GET gmail/v1/users/me/messages?q={query}` returns message id stubs only; `GET gmail/v1/users/me/messages/{id}?format=full` per message gets the actual headers/body — an N+1 pattern, same shape as the Zoom meeting-detail fetch in the meeting sync.
- Message bodies come back **base64url-encoded**, and can be split across nested `parts` for multipart messages (HTML + plain-text alternatives, inline images). `extractGmailPlainText()` recurses through `payload.parts` depth-first looking for the first `text/plain` part; HTML-only messages (no plain-text alternative) currently produce an empty excerpt rather than falling back to stripped HTML.
- Mapping into `knowledge_documents`: `Subject` header → `title`, decoded plain-text body (truncated to `EMAIL_EXCERPT_MAX_CHARS` = 8000 chars — bumped up from an original 500 once `KnowledgeDetailPage.tsx` made `excerpt` something a person actually reads, not just a search-index preview; see `knowledge-base/frontend.md`) → `excerpt`, `From` header → `keywords: [from]`, Gmail's `internalDate` → `created_at`/`updated_at`, `type: 'email'`, `project_id: NULL` (no project-linking UI for synced emails yet).
- **Dedup**: by `external_id` (Gmail's message id) — re-running sync with the same query updates existing rows (title/excerpt/`updated_at`) rather than duplicating them, same check-before-write pattern as the Zoom recording sync.
- **Link-only lines stripped**: Gmail's plain-text MIME alternative renders every HTML hyperlink as its anchor text followed by a line that's just `<the raw href>` — a generic plain-text-email convention, not Zoom-specific. `stripLinkOnlyLines()` filters out any line that, once trimmed, is nothing but a bracketed URL (`^<https?:\/\/\S+>$`), applied inside `extractGmailPlainText()` before the text is stored. See "Bug found + fixed" below.

## Bug found + fixed: synced emails included raw tracking URLs as their own lines
Reported directly: a synced Zoom AI meeting-summary email's excerpt showed each action-item bullet followed by an ugly `<https://tasks.zoom.us?meetingId=...&stepId=...>` line — "why is it taking the urls, it needs to sync the texts only not the urls." Confirmed by pulling a real synced document's raw excerpt from the DB: every hyperlink in these emails (the top `<https://zoom.com>` branding link, the `<https://us06web.zoom.us/launch/aic?...>` "Review action items" link, and a `<https://tasks.zoom.us?...>` line after nearly every task bullet) follows the exact same pattern — link text on one line, then a line that's *only* the bracketed URL immediately after. `extractGmailPlainText()` decoded the MIME part completely verbatim, so none of it was ever stripped. **Fixed** by adding `stripLinkOnlyLines()`, applied at the point the plain-text body is extracted — generic to the pattern (any bracketed-URL-only line), not hardcoded to `tasks.zoom.us`, so it also cleans the two other link types in the same email. Verified against a real stored excerpt: 14 URLs in the original text, 0 remaining after stripping, all surrounding text (including multi-bullet, multi-person sections) intact. Only applies to newly-synced/re-synced messages — see "Open gaps" for backfilling the 25 already-synced rows.

## Bug found + fixed: re-syncing stamped every email with the sync time, not the email's own date
`upsertGmailMessage()`'s UPDATE branch (the dedup path, for a message already synced once before) originally set `updated_at = new Date().toISOString()` — the moment the sync ran, not the email's actual date (`m.date`, from Gmail's `internalDate`). The INSERT branch was already correct (`updated_at = m.date`). Since re-running sync updates every previously-synced message, one sync call stamped *all* of them with the same "just now" timestamp, clustering the entire list at the top with no real order between them and burying the actual most-recent email wherever it happened to land in iteration order — "Recently updated" sort became meaningless. An email is immutable once sent; re-syncing it isn't a real content update at sync time, just a re-fetch of unchanged content, so `updated_at` should always reflect when the email itself was sent, not when we last looked at it. **Fixed** by using `m.date` on both branches. Re-ran sync after the fix to restore correct timestamps on the 25 already-synced rows — confirmed via `GET /knowledge?type=email` that `updatedAt` values are now spread across real dates (hours to weeks apart) instead of identical.

## Attach a document — `type='file'` (as built)
Traced from a direct question ("why is this showing 0 doc and 0 meetings" on a brand-new project) into "where's the option to upload a doc" into "how does a doc sync to a project from a meeting." The last question's answer was the real finding: **there was no path, automatic or manual, for a document to ever end up linked to a project.** Gmail-synced emails (the only thing that auto-creates `knowledge_documents` rows) always insert `project_id: NULL` — even when the email's associated meeting *does* belong to a project, that link never propagates to the document. The one manual-create endpoint, `POST /knowledge`, accepts a `projectId` and would work — but nothing in the frontend has ever called it. Two possible fixes were on the table (teach Gmail sync to infer a project; build a manual upload UI); the user picked the manual path, scoped specifically to project creation — see `projects/backend.md` for that side.

`type` gained a fifth-then-sixth value, `'file'` (after `'email'`), via the same full-table-rebuild migration pattern used for every other CHECK-constraint addition in this schema — plus four new nullable columns: `storage_path`, `file_name`, `mime_type`, `size_bytes`. A `type='file'` row is fundamentally different from every other type here: `excerpt` is empty (a binary file has no text excerpt), and the "content" is the file on disk, addressed by `storage_path` (relative to `UPLOADS_ROOT`, same convention as `meeting_assets.storage_path`).

**Deliberately not a separate table.** The obvious alternative — a `project_files` or `attachments` table, parallel to `meeting_assets` — was rejected because the actual complaint that started this thread was "0 docs" on the project card, and `docCount` is a `COUNT(*) FROM knowledge_documents WHERE project_id = ?` query (see `projects/backend.md`). A file living in a separate table would never close that loop; it'd just be a second, disconnected "stuff attached to a project" concept. Reusing `knowledge_documents` means an uploaded file is a real Knowledge Base entry — it shows up in `GET /knowledge`, counts toward `docCount`, has a real detail page, and is subject to the same trash/restore/permanent-delete lifecycle as everything else — with `hasFile`/`fileName`/`sizeBytes` added to the serialized shape (`hasFile: file_name !== null`) so the frontend can render it differently (a file card + Download button, not a text excerpt).

The actual upload/write happens in `projects.ts`'s `POST /` handler (multipart, `multer.memoryStorage()`, since the parent project doesn't exist yet when the file arrives — full reasoning in `projects/backend.md`), not here — this file only reads what that write produced (list/detail/download).

Verified via curl (see `projects/backend.md`'s verification for the create-side confirmation): `GET /knowledge?type=file` returned the new row with `hasFile: true`, correct `fileName`("test_project_doc.txt")/`sizeBytes`(67); `GET /knowledge/:id/download` returned `Content-Disposition: attachment; filename="test_project_doc.txt"` and byte-identical content to the original upload. Live in the browser: the Knowledge Base's new "Files" filter chip showed the correct count, the list row showed the 📎 icon and the correct project pill, and the detail page (`KnowledgeDetailPage.tsx`) rendered a file card with a working Download button instead of the "No content on this document" empty state a text-type doc with no excerpt would show. All test rows deleted directly afterward, including their files on disk (`project-docs/<projectId>/` folders removed), leaving the real 27 email-type docs untouched.

## Auth
`requireAuth`, scoped to `req.user.org_id`.

## Open gaps
- No automatic `knowledge_documents` row creation when a meeting is added — the original spec's idea of "every synced meeting produces a Meeting note doc" isn't wired (meetings and knowledge docs are seeded independently, with matching titles but no `source_meeting_id` link in the seed data despite the column existing).
- **Partially closed**, in the other direction: `source_meeting_id` now *does* get backfilled onto a synced email's `knowledge_documents` row when meetings/backend.md's auto-task-extraction runs against it (matching or auto-creating the meeting the email is about) — but only for emails matching the Zoom AI Companion "Next steps" template that extraction looks for. Emails without that structure still leave `source_meeting_id` `NULL`.
- `keywords` are hand-authored for manual docs, not derived from `excerpt`/`title` — fine for a 12-doc demo corpus, would need real keyword extraction (or drop keyword-matching in favor of full-text search) at real scale.
- No edit UI anywhere in the frontend despite `PATCH` existing — the new detail view is read-only.
- HTML-only emails (no plain-text MIME part) sync with an empty excerpt — no HTML-to-text fallback exists yet.
- `EMAIL_EXCERPT_MAX_CHARS` (8000) is still a hard cutoff, not "the whole email" — a long email/thread can still be truncated. No "show more" / pagination for excerpt content on the detail page.
- No token refresh logic for Gmail either (same gap as Zoom/Google Meet, documented in `meetings/backend.md`) — the connection will silently stop working ~1hr after connecting until the user disconnects/reconnects. Hit directly while verifying the link-stripping fix above: the access token had already expired, so a live re-sync to backfill the 25 already-synced rows returned a 401 rather than completing. The fix itself was verified by running the new `stripLinkOnlyLines()` logic against a real stored excerpt instead — the 25 existing rows still have the un-stripped links in their `excerpt` until Gmail is reconnected and "Sync now" is run again (the dedup-by-`external_id` upsert path will clean them at that point; anything synced fresh from here on is already clean).
- Attachments aren't synced — only the message subject/body/sender. Pulling actual attachment files would follow the same download-and-store pattern as the Zoom recording sync (`meeting_assets`), but there's no equivalent "email_assets" concept yet.
- `POST /knowledge` still has no frontend caller — the only way to attach a document today is the project-creation flow's own upload (a direct `INSERT` in `projects.ts`, not this endpoint). Adding a document to an *existing* project, or creating a standalone knowledge doc with no file at all, has no UI path.
- Gmail-synced emails and their auto-created meetings still never get a `project_id` — the "teach sync to infer a project" half of the original two options was explicitly not built (see the user's "remove point 1" direction).
