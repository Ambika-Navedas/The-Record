import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import multer from 'multer'
import { pool } from '../db.ts'
import { requireAuth } from '../auth.ts'
import { recordActivity, recordProjectInvolvement, upsertDocument, upsertProject } from '../graph.ts'
import { saveFile } from '../storage.ts'

export const projectsRouter = Router()
projectsRouter.use(requireAuth)

const VALID_STATUSES = ['on_track', 'attention', 'blocked']

// Memory storage, not diskStorage — unlike meeting assets or avatars, the project these files
// belong to doesn't exist yet when multer parses the upload (it's created in the same request,
// see POST '/' below), so there's no id yet to build a destination folder from. Buffering in
// memory and writing to disk ourselves after the project row exists sidesteps that ordering
// problem entirely. 20MB per file — a document (PDF/deck/sheet), not a recording (meetings.ts's
// asset cap is 200MB). Up to 10 files per project creation — generous for "attach a few docs,"
// not unbounded.
const MAX_PROJECT_DOC_FILES = 10
const projectDocUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

interface ProjectRow {
  id: string
  name: string
  description: string
  status: string
  updated_at: string
  owner_id: string
  owner_name: string
  owner_initials: string
  doc_count: number
  meeting_count: number
  git_url: string
  deployment_url: string
  env_username: string
  env_password: string
}

function serialize(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    updatedAt: row.updated_at,
    owner: { id: row.owner_id, name: row.owner_name, initials: row.owner_initials },
    docCount: row.doc_count,
    meetingCount: row.meeting_count,
    gitUrl: row.git_url,
    deploymentUrl: row.deployment_url,
    username: row.env_username,
    password: row.env_password,
  }
}

// Confirms an owner id belongs to the requesting org, so you can't assign a project
// to a user outside your organization.
async function isValidOwner(orgId: string, ownerId: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM users WHERE id = $1 AND org_id = $2', [ownerId, orgId])
  return rows.length > 0
}

projectsRouter.get('/', async (req, res) => {
  const orgId = req.user!.org_id
  const status = req.query.status as string | undefined

  let sql = `
    SELECT p.id, p.name, p.description, p.status, p.updated_at,
           u.id AS owner_id, u.name AS owner_name, u.initials AS owner_initials,
           (SELECT COUNT(*) FROM knowledge_documents kd WHERE kd.project_id = p.id AND kd.deleted_at IS NULL)::int AS doc_count,
           (SELECT COUNT(*) FROM meetings m WHERE m.project_id = p.id)::int AS meeting_count,
           p.git_url, p.deployment_url, p.env_username, p.env_password
    FROM projects p
    JOIN users u ON u.id = p.owner_id
    WHERE p.org_id = $1
  `
  const params: string[] = [orgId]
  if (status && status !== 'all') {
    sql += ' AND p.status = $2'
    params.push(status)
  }
  sql += ' ORDER BY p.updated_at DESC'

  const rows = (await pool.query(sql, params)).rows as ProjectRow[]

  const countRows = (
    await pool.query('SELECT status, COUNT(*)::int as n FROM projects WHERE org_id = $1 GROUP BY status', [orgId])
  ).rows as { status: string; n: number }[]
  const counts: Record<string, number> = { all: 0, on_track: 0, attention: 0, blocked: 0 }
  for (const r of countRows) {
    counts[r.status] = r.n
    counts.all += r.n
  }

  res.json({ items: rows.map(serialize), counts })
})

// Multipart, not JSON — accepts optional 'files' fields alongside the same project fields as
// before (multer parses non-file multipart fields into req.body as strings, same as JSON would
// have). Direct request: "while creating the project details, there should be a field to upload
// the doc if any" — then "there is no option to add multiple doc," so this accepts an array,
// not a single file.
projectsRouter.post('/', projectDocUpload.array('files', MAX_PROJECT_DOC_FILES), async (req, res) => {
  const orgId = req.user!.org_id
  const { name, description, status, ownerId, gitUrl, deploymentUrl, username, password } = req.body as {
    name?: string
    description?: string
    status?: string
    ownerId?: string
    gitUrl?: string
    deploymentUrl?: string
    username?: string
    password?: string
  }
  if (!name) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  if (status && !VALID_STATUSES.includes(status)) {
    res.status(400).json({ error: `status must be one of ${VALID_STATUSES.join(', ')}` })
    return
  }
  const resolvedOwnerId = ownerId || req.user!.id
  if (ownerId && !(await isValidOwner(orgId, ownerId))) {
    res.status(400).json({ error: 'ownerId must belong to your organization' })
    return
  }

  const id = randomUUID()
  // Written explicitly as a JS ISO timestamp (not the column's SQL-side now() default) so the
  // frontend's `new Date(updatedAt)` parses it correctly — see dashboard/backend.md's
  // date-comparison bug writeup for why mixing formats used to break things.
  const now = new Date().toISOString()
  await pool.query(
    `INSERT INTO projects (id, org_id, name, description, owner_id, status, git_url, deployment_url, env_username, env_password, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      orgId,
      name,
      description ?? '',
      resolvedOwnerId,
      status ?? 'on_track',
      gitUrl ?? '',
      deploymentUrl ?? '',
      username ?? '',
      password ?? '',
      now,
      now,
    ],
  )
  await upsertProject(id, name)
  await recordProjectInvolvement(resolvedOwnerId, id, now)

  // Attaches each uploaded file as its own knowledge_documents row (type='file') so every one
  // counts toward the project's docCount and shows up in the Knowledge Base like any other
  // document — not a separate "project attachments" concept. See db.ts for the storage_path/
  // file_name/mime_type/size_bytes columns this needs. Wrapped in a real transaction (unlike the
  // old sync-SQLite loop, which was accidentally atomic just by being single-threaded) so a
  // failure partway through never leaves some files attached and others not.
  const files = (req.files as Express.Multer.File[] | undefined) ?? []
  if (files.length > 0) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const file of files) {
        const storedPath = await saveFile(
          file.buffer,
          path.join('project-docs', id),
          `${randomUUID()}-${file.originalname}`,
          file.mimetype,
        )
        const docId = randomUUID()
        await client.query(
          `INSERT INTO knowledge_documents (id, org_id, project_id, type, title, excerpt, owner_id, keywords, storage_path, file_name, mime_type, size_bytes)
           VALUES ($1, $2, $3, 'file', $4, '', $5, '[]', $6, $7, $8, $9)`,
          [docId, orgId, id, file.originalname, req.user!.id, storedPath, file.originalname, file.mimetype, file.size],
        )
        // Fire-and-forget-adjacent: awaited so it happens, but outside the SQL transaction —
        // Neo4j isn't transactional with Postgres here, and a graph-sync hiccup must never roll
        // back a real file upload. See graph.ts — this degrades to a silent no-op on failure.
        await upsertDocument(docId, file.originalname, 'file', id, null)
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  res.status(201).json({
    id,
    name,
    description: description ?? '',
    status: status ?? 'on_track',
    ownerId: resolvedOwnerId,
    gitUrl: gitUrl ?? '',
    deploymentUrl: deploymentUrl ?? '',
    username: username ?? '',
    password: password ?? '',
  })
})

projectsRouter.get('/:id', async (req, res) => {
  const orgId = req.user!.org_id
  const row = (
    await pool.query(
      `SELECT p.id, p.name, p.description, p.status, p.updated_at,
              u.id AS owner_id, u.name AS owner_name, u.initials AS owner_initials,
              (SELECT COUNT(*) FROM knowledge_documents kd WHERE kd.project_id = p.id AND kd.deleted_at IS NULL)::int AS doc_count,
              (SELECT COUNT(*) FROM meetings m WHERE m.project_id = p.id)::int AS meeting_count,
              p.git_url, p.deployment_url, p.env_username, p.env_password
       FROM projects p JOIN users u ON u.id = p.owner_id
       WHERE p.org_id = $1 AND p.id = $2`,
      [orgId, req.params.id],
    )
  ).rows[0] as ProjectRow | undefined
  if (!row) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  res.json(serialize(row))
})

projectsRouter.patch('/:id', async (req, res) => {
  const orgId = req.user!.org_id
  const { name, description, status, ownerId, gitUrl, deploymentUrl, username, password } = req.body as {
    name?: string
    description?: string
    status?: string
    ownerId?: string
    gitUrl?: string
    deploymentUrl?: string
    username?: string
    password?: string
  }
  const existing = (
    await pool.query('SELECT id, owner_id, status FROM projects WHERE org_id = $1 AND id = $2', [orgId, req.params.id])
  ).rows[0] as { id: string; owner_id: string; status: string } | undefined
  if (!existing) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  // Direct request: "it can't be editable except the owner." Anyone in the org could view
  // (GET), but only the project's current owner can change it — reassigning ownership doesn't
  // let the old owner back in, and the new owner isn't retroactively allowed to have edited
  // before the reassignment took effect (this check runs against the *current* owner_id).
  if (existing.owner_id !== req.user!.id) {
    res.status(403).json({ error: 'not_owner', message: 'Only the project owner can edit this project.' })
    return
  }
  if (status && !VALID_STATUSES.includes(status)) {
    res.status(400).json({ error: `status must be one of ${VALID_STATUSES.join(', ')}` })
    return
  }
  if (ownerId && !(await isValidOwner(orgId, ownerId))) {
    res.status(400).json({ error: 'ownerId must belong to your organization' })
    return
  }

  if (name) {
    await pool.query('UPDATE projects SET name = $1 WHERE id = $2', [name, req.params.id])
    await upsertProject(req.params.id, name)
  }
  if (description !== undefined)
    await pool.query('UPDATE projects SET description = $1 WHERE id = $2', [description, req.params.id])
  // Both branches log to project_history (Postgres, the system of record) and mirror the same
  // event into Neo4j as an Activity node — see graph.ts's "Temporal knowledge graph" section.
  // Only fires on a *real* change (new value differs from the current one), same guard style as
  // meetings.ts's task-reassignment isReassignment check, so a no-op PATCH doesn't fabricate history.
  const now = new Date().toISOString()
  if (status && status !== existing.status) {
    await pool.query('UPDATE projects SET status = $1 WHERE id = $2', [status, req.params.id])
    await pool.query(
      'INSERT INTO project_history (id, org_id, project_id, actor_id, action, from_value, to_value) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [randomUUID(), orgId, req.params.id, req.user!.id, 'status_changed', existing.status, status],
    )
    await recordActivity(randomUUID(), 'status_changed', now, req.user!.id, 'Project', req.params.id)
  }
  if (ownerId && ownerId !== existing.owner_id) {
    await pool.query('UPDATE projects SET owner_id = $1 WHERE id = $2', [ownerId, req.params.id])
    await pool.query(
      'INSERT INTO project_history (id, org_id, project_id, actor_id, action, from_value, to_value) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [randomUUID(), orgId, req.params.id, req.user!.id, 'owner_changed', existing.owner_id, ownerId],
    )
    await recordActivity(randomUUID(), 'owner_changed', now, req.user!.id, 'Project', req.params.id)
    await recordProjectInvolvement(ownerId, req.params.id, now)
  }
  if (gitUrl !== undefined) await pool.query('UPDATE projects SET git_url = $1 WHERE id = $2', [gitUrl, req.params.id])
  if (deploymentUrl !== undefined)
    await pool.query('UPDATE projects SET deployment_url = $1 WHERE id = $2', [deploymentUrl, req.params.id])
  if (username !== undefined)
    await pool.query('UPDATE projects SET env_username = $1 WHERE id = $2', [username, req.params.id])
  if (password !== undefined)
    await pool.query('UPDATE projects SET env_password = $1 WHERE id = $2', [password, req.params.id])
  await pool.query('UPDATE projects SET updated_at = $1 WHERE id = $2', [new Date().toISOString(), req.params.id])
  res.status(204).end()
})
