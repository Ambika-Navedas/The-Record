import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

// Loaded here, not left to index.ts's own process.loadEnvFile() call — ES module imports are
// hoisted and evaluated before any of the importing module's top-level statements run, so
// `import './db.ts'` in index.ts actually executes before index.ts's own .env-loading line does,
// regardless of their textual order. db.ts needs DATABASE_URL before constructing the pool below,
// so it has to load .env itself rather than depend on being imported after another module does it.
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true }, // Neon uses a trusted CA; no self-signed cert workaround needed
})

pool
  .query(`
    -- One-time cleanup: payslips was removed outright ("remove the payslip section, I don't
    -- need that one") — no frontend ever reached it after the earlier tab removal, and the
    -- table (with its 3 real rows) is gone too, not just orphaned.
    DROP TABLE IF EXISTS payslips;

    CREATE TABLE IF NOT EXISTS organizations (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES organizations(id),
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name          TEXT NOT NULL,
      initials      TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      designation   TEXT NOT NULL DEFAULT '',
      department    TEXT NOT NULL DEFAULT '',
      employee_id   TEXT NOT NULL DEFAULT '',
      avatar_path   TEXT,
      disabled_at   TIMESTAMPTZ -- set = deactivated (blocked from login), NULL = active. Soft, not a
                                 -- DELETE, since real rows elsewhere (tasks, meetings, documents,
                                 -- leave) reference this user and none of those FKs cascade.
    );

    -- Existing installs already have the users table from before this column existed —
    -- CREATE TABLE IF NOT EXISTS above is a no-op for them, so it has to be added explicitly.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id              TEXT PRIMARY KEY,
      org_id          TEXT NOT NULL REFERENCES organizations(id),
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      owner_id        TEXT NOT NULL REFERENCES users(id),
      status          TEXT NOT NULL CHECK (status IN ('on_track','attention','blocked')),
      git_url         TEXT NOT NULL DEFAULT '',
      deployment_url  TEXT NOT NULL DEFAULT '',
      env_username    TEXT NOT NULL DEFAULT '',
      env_password    TEXT NOT NULL DEFAULT '', -- plain text, demo-scale only — see projects/backend.md
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Append-only, same shape as task_activity: what changed, who changed it, when. Projects only
    -- ever held current status/owner before this — no record of a prior status or a prior owner.
    CREATE TABLE IF NOT EXISTS project_history (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES organizations(id),
      project_id    TEXT NOT NULL REFERENCES projects(id),
      actor_id      TEXT NOT NULL REFERENCES users(id),
      action        TEXT NOT NULL CHECK (action IN ('status_changed','owner_changed')),
      from_value    TEXT NOT NULL, -- old status, or old owner_id
      to_value      TEXT NOT NULL, -- new status, or new owner_id
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS meetings (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES organizations(id),
      project_id    TEXT REFERENCES projects(id),
      title         TEXT NOT NULL,
      summary       TEXT NOT NULL,
      participants  TEXT NOT NULL, -- JSON array of user ids
      scheduled_at  TIMESTAMPTZ NOT NULL,
      duration_min  INTEGER NOT NULL,
      sync_status   TEXT NOT NULL CHECK (sync_status IN ('synced','processing','failed')) DEFAULT 'synced',
      source        TEXT NOT NULL CHECK (source IN ('zoom','google_meet','manual_upload','other','email_sync')) DEFAULT 'manual_upload',
      external_id   TEXT, -- Zoom cloud recording file id / Gmail message id, for dedup on re-sync; NULL for manual uploads
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(org_id, source, external_id)
    );

    CREATE TABLE IF NOT EXISTS oauth_connections (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES organizations(id),
      user_id       TEXT NOT NULL REFERENCES users(id),
      provider      TEXT NOT NULL CHECK (provider IN ('zoom','google','gmail')),
      access_token  TEXT NOT NULL,
      refresh_token TEXT NOT NULL DEFAULT '',
      expires_at    TIMESTAMPTZ NOT NULL,
      connected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      sync_query    TEXT NOT NULL DEFAULT '', -- Gmail search query (provider='gmail' only) — ignored by other providers
      UNIQUE(user_id, provider)
    );

    CREATE TABLE IF NOT EXISTS meeting_assets (
      id            TEXT PRIMARY KEY,
      meeting_id    TEXT NOT NULL REFERENCES meetings(id),
      org_id        TEXT NOT NULL REFERENCES organizations(id),
      filename      TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL,
      storage_path  TEXT NOT NULL, -- relative path under server/uploads/
      uploaded_by   TEXT NOT NULL REFERENCES users(id),
      external_id   TEXT, -- Zoom cloud recording file id, for dedup on re-sync; NULL for manual uploads
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS meeting_tasks (
      id               TEXT PRIMARY KEY,
      meeting_id       TEXT NOT NULL REFERENCES meetings(id),
      org_id           TEXT NOT NULL REFERENCES organizations(id),
      title            TEXT NOT NULL,
      assignee_id      TEXT REFERENCES users(id),
      due_date         TEXT,
      done             INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      external_id      TEXT, -- dedup key for auto-extracted tasks; NULL for manually-created tasks
      completion_note  TEXT
    );

    CREATE TABLE IF NOT EXISTS task_activity (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES organizations(id),
      task_id       TEXT NOT NULL REFERENCES meeting_tasks(id),
      actor_id      TEXT NOT NULL REFERENCES users(id),
      action        TEXT NOT NULL CHECK (action IN ('assigned','done','reopened')),
      assignee_id   TEXT REFERENCES users(id), -- who it was assigned to ('assigned'), or the assignee at the time ('done'/'reopened')
      reason        TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS holidays (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES organizations(id),
      date          TEXT NOT NULL, -- 'YYYY-MM-DD'
      name          TEXT NOT NULL,
      is_optional   INTEGER NOT NULL DEFAULT 0, -- floating/optional holiday (e.g. "pick 2 of these"), not a company-wide closure
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(org_id, date)
    );

    CREATE TABLE IF NOT EXISTS holiday_selections (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES organizations(id),
      user_id       TEXT NOT NULL REFERENCES users(id),
      holiday_id    TEXT NOT NULL REFERENCES holidays(id),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, holiday_id)
    );

    CREATE TABLE IF NOT EXISTS leave_types (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES organizations(id),
      name          TEXT NOT NULL,
      UNIQUE(org_id, name)
    );

    CREATE TABLE IF NOT EXISTS leave_balances (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES organizations(id),
      user_id       TEXT NOT NULL REFERENCES users(id),
      leave_type_id TEXT NOT NULL REFERENCES leave_types(id),
      balance       REAL NOT NULL DEFAULT 0, -- days; half-days allowed, hence REAL not INTEGER
      UNIQUE(user_id, leave_type_id)
    );

    CREATE TABLE IF NOT EXISTS leave_requests (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES organizations(id),
      user_id       TEXT NOT NULL REFERENCES users(id),
      leave_type_id TEXT NOT NULL REFERENCES leave_types(id),
      from_date     TEXT NOT NULL, -- 'YYYY-MM-DD'
      to_date       TEXT NOT NULL, -- 'YYYY-MM-DD'
      days          REAL NOT NULL, -- inclusive day count between from_date/to_date
      reason        TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      reviewed_by   TEXT REFERENCES users(id),
      reviewed_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id                 TEXT PRIMARY KEY,
      org_id             TEXT NOT NULL REFERENCES organizations(id),
      project_id         TEXT REFERENCES projects(id),
      type               TEXT NOT NULL CHECK (type IN ('sop','meeting_note','decision','faq','email','file')),
      title              TEXT NOT NULL,
      excerpt            TEXT NOT NULL,
      owner_id           TEXT NOT NULL REFERENCES users(id),
      source_meeting_id  TEXT REFERENCES meetings(id),
      keywords           TEXT NOT NULL, -- JSON array
      view_count         INTEGER NOT NULL DEFAULT 0, -- incremented each time Ask The Record cites this doc as a source
      external_id        TEXT, -- Gmail message id, for dedup on re-sync; NULL for non-synced docs
      storage_path       TEXT, -- relative path under UPLOADS_ROOT, type='file' only
      file_name          TEXT, -- original uploaded filename, type='file' only
      mime_type          TEXT, -- type='file' only
      size_bytes         INTEGER, -- type='file' only
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at         TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES organizations(id),
      user_id     TEXT NOT NULL REFERENCES users(id), -- recipient
      message     TEXT NOT NULL, -- plain text, pre-rendered by whatever created it — no template/type system
      read_at     TIMESTAMPTZ, -- NULL = unread
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id           TEXT PRIMARY KEY,
      org_id       TEXT NOT NULL REFERENCES organizations(id),
      user_id      TEXT NOT NULL REFERENCES users(id), -- personal — only the creator ever sees their own
      text         TEXT NOT NULL,
      due_at       TIMESTAMPTZ, -- NULL = a plain note with no due date, never auto-notifies
      notified_at  TIMESTAMPTZ, -- NULL = not yet converted into a notification (only relevant once due_at has passed)
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Opt-in file storage backend (FILE_STORAGE=postgres — see storage.ts) for hosts with no
    -- persistent disk and no separate blob store, e.g. a Vercel deploy without Vercel Blob added.
    -- Deliberately its own table rather than a column on each file-owning table (avatars, meeting
    -- assets, project docs) — one shared blob store, referenced by storage_path holding 'db:<id>'.
    CREATE TABLE IF NOT EXISTS file_blobs (
      id          TEXT PRIMARY KEY,
      data        BYTEA NOT NULL,
      mime_type   TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  .catch((err) => {
    console.error('Schema init failed:', err)
    process.exit(1)
  })
