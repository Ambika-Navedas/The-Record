import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { pool } from '../db.ts'
import { requireAuth } from '../auth.ts'
import { upsertDocument } from '../graph.ts'
import { deleteFile, isDbBlob, isRemoteUrl, localFilePath, readDbBlob } from '../storage.ts'

export const knowledgeRouter = Router()
knowledgeRouter.use(requireAuth)

interface DocRow {
  id: string
  type: string
  title: string
  excerpt: string
  updated_at: string
  deleted_at: string | null
  owner_name: string
  project_name: string | null
  file_name: string | null
  size_bytes: number | null
}

// A document counts as "fresh" if it was updated within the last 24 hours —
// replaces the frontend mock's hardcoded string-matching hack.
const FRESH_WINDOW_HOURS = 24

function serialize(row: DocRow) {
  // updated_at is a TIMESTAMPTZ column — pg returns it as a real JS Date already, so no
  // SQLite-era "+ 'Z'" string patch is needed to parse it correctly.
  const isFresh = Date.now() - new Date(row.updated_at).getTime() < FRESH_WINDOW_HOURS * 60 * 60 * 1000
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    excerpt: row.excerpt,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    isFresh,
    owner: row.owner_name,
    project: row.project_name,
    hasFile: row.file_name !== null,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
  }
}

// A real filter (excludes rows outright), not the decorative "Sort" dropdown it originally
// replaced — narrows by kd.updated_at rather than just reordering what's already there. Applied
// to both the item list and the type counts below, so picking a range actually changes what
// every chip reports, not just the row order. `from`/`to` (plain 'YYYY-MM-DD' strings from the
// frontend's DateRangePicker) are bound params, not string-interpolated, even though they're
// expected to already be date-shaped — never trust a query param straight into SQL text.
// Placeholder numbers are derived from the running params array length so this composes with
// whatever base params were already pushed before this runs.
function applyDateFilter(sql: string, params: string[], from: string | undefined, to: string | undefined): string {
  if (from) {
    params.push(from)
    sql += ` AND kd.updated_at::date >= $${params.length}::date`
  }
  if (to) {
    params.push(to)
    sql += ` AND kd.updated_at::date <= $${params.length}::date`
  }
  return sql
}

knowledgeRouter.get('/', async (req, res) => {
  const orgId = req.user!.org_id
  const type = req.query.type as string | undefined
  const from = req.query.from as string | undefined
  const to = req.query.to as string | undefined

  let sql = `
    SELECT kd.id, kd.type, kd.title, kd.excerpt, kd.updated_at, kd.deleted_at, kd.file_name, kd.size_bytes,
           u.name AS owner_name, p.name AS project_name
    FROM knowledge_documents kd
    JOIN users u ON u.id = kd.owner_id
    LEFT JOIN projects p ON p.id = kd.project_id
    WHERE kd.org_id = $1 AND kd.deleted_at IS NULL
  `
  const params: string[] = [orgId]
  if (type && type !== 'all') {
    params.push(type)
    sql += ` AND kd.type = $${params.length}`
  }
  sql = applyDateFilter(sql, params, from, to)
  sql += ' ORDER BY kd.updated_at DESC'

  const rows = (await pool.query(sql, params)).rows as DocRow[]

  let countSql =
    'SELECT type, COUNT(*)::int as n FROM knowledge_documents kd WHERE kd.org_id = $1 AND kd.deleted_at IS NULL'
  const countParams: string[] = [orgId]
  countSql = applyDateFilter(countSql, countParams, from, to)
  countSql += ' GROUP BY type'
  const countRows = (await pool.query(countSql, countParams)).rows as { type: string; n: number }[]
  const counts: Record<string, number> = { all: 0, sop: 0, meeting_note: 0, decision: 0, faq: 0, email: 0, file: 0 }
  for (const r of countRows) {
    counts[r.type] = r.n
    counts.all += r.n
  }
  // Trash isn't affected by the date filter — it's a separate view of what's been removed, not
  // part of the "browse active docs by date" facet.
  const trashCount = (
    await pool.query('SELECT COUNT(*)::int AS n FROM knowledge_documents WHERE org_id = $1 AND deleted_at IS NOT NULL', [
      orgId,
    ])
  ).rows[0] as { n: number }
  counts.trash = trashCount.n

  res.json({ items: rows.map(serialize), counts })
})

// Registered before '/:id' so it isn't swallowed by the :id param route.
knowledgeRouter.get('/trash', async (req, res) => {
  const orgId = req.user!.org_id
  const rows = (
    await pool.query(
      `SELECT kd.id, kd.type, kd.title, kd.excerpt, kd.updated_at, kd.deleted_at, kd.file_name, kd.size_bytes,
              u.name AS owner_name, p.name AS project_name
       FROM knowledge_documents kd
       JOIN users u ON u.id = kd.owner_id
       LEFT JOIN projects p ON p.id = kd.project_id
       WHERE kd.org_id = $1 AND kd.deleted_at IS NOT NULL
       ORDER BY kd.deleted_at DESC`,
      [orgId],
    )
  ).rows as DocRow[]
  res.json({ items: rows.map(serialize) })
})

knowledgeRouter.get('/:id', async (req, res) => {
  const orgId = req.user!.org_id
  const row = (
    await pool.query(
      `SELECT kd.id, kd.type, kd.title, kd.excerpt, kd.updated_at, kd.deleted_at, kd.file_name, kd.size_bytes,
              u.name AS owner_name, p.name AS project_name
       FROM knowledge_documents kd
       JOIN users u ON u.id = kd.owner_id
       LEFT JOIN projects p ON p.id = kd.project_id
       WHERE kd.org_id = $1 AND kd.id = $2`,
      [orgId, req.params.id],
    )
  ).rows[0] as DocRow | undefined
  if (!row) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  res.json(serialize(row))
})

// Registered before '/:id' isn't necessary here since Express matches '/:id/download' as a more
// specific pattern than '/:id' regardless of declaration order, but kept near '/:id' for
// readability. Same res.download() pattern as meetings.ts's asset download route.
knowledgeRouter.get('/:id/download', async (req, res) => {
  const orgId = req.user!.org_id
  const row = (
    await pool.query('SELECT storage_path, file_name, mime_type FROM knowledge_documents WHERE org_id = $1 AND id = $2', [
      orgId,
      req.params.id,
    ])
  ).rows[0] as { storage_path: string | null; file_name: string | null; mime_type: string | null } | undefined
  if (!row || !row.storage_path) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  if (isRemoteUrl(row.storage_path)) {
    res.redirect(row.storage_path)
    return
  }
  if (isDbBlob(row.storage_path)) {
    const { data } = await readDbBlob(row.storage_path)
    res.set('Content-Type', row.mime_type ?? 'application/octet-stream')
    res.set('Content-Disposition', `attachment; filename="${row.file_name ?? 'document'}"`)
    res.send(data)
    return
  }
  const filePath = localFilePath(row.storage_path)
  if (!existsSync(filePath)) {
    res.status(404).json({ error: 'file_missing' })
    return
  }
  res.download(filePath, row.file_name ?? 'document')
})

knowledgeRouter.post('/', async (req, res) => {
  const orgId = req.user!.org_id
  const { type, title, excerpt, projectId, keywords } = req.body as {
    type?: string
    title?: string
    excerpt?: string
    projectId?: string
    keywords?: string[]
  }
  if (!type || !title) {
    res.status(400).json({ error: 'type and title are required' })
    return
  }
  const id = randomUUID()
  await pool.query(
    `INSERT INTO knowledge_documents (id, org_id, project_id, type, title, excerpt, owner_id, keywords)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, orgId, projectId ?? null, type, title, excerpt ?? '', req.user!.id, JSON.stringify(keywords ?? [])],
  )
  await upsertDocument(id, title, type, projectId ?? null, null)
  res.status(201).json({ id, title })
})

knowledgeRouter.patch('/:id', async (req, res) => {
  const orgId = req.user!.org_id
  const { title, excerpt } = req.body as { title?: string; excerpt?: string }
  const existing = (
    await pool.query('SELECT id FROM knowledge_documents WHERE org_id = $1 AND id = $2', [orgId, req.params.id])
  ).rows[0]
  if (!existing) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  if (title) await pool.query('UPDATE knowledge_documents SET title = $1 WHERE id = $2', [title, req.params.id])
  if (excerpt) await pool.query('UPDATE knowledge_documents SET excerpt = $1 WHERE id = $2', [excerpt, req.params.id])
  await pool.query('UPDATE knowledge_documents SET updated_at = $1 WHERE id = $2', [
    new Date().toISOString(),
    req.params.id,
  ])
  res.status(204).end()
})

// Soft delete — moves a document to trash. It stays in the database (still readable via
// GET /:id or the /trash list) but disappears from the normal list, dashboard, global search,
// and Ask The Record's retrieval corpus, since all of those filter on deleted_at IS NULL.
knowledgeRouter.post('/:id/trash', async (req, res) => {
  const orgId = req.user!.org_id
  const existing = (
    await pool.query('SELECT id, deleted_at FROM knowledge_documents WHERE org_id = $1 AND id = $2', [
      orgId,
      req.params.id,
    ])
  ).rows[0] as { id: string; deleted_at: string | null } | undefined
  if (!existing) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  if (existing.deleted_at) {
    res.status(204).end()
    return
  }
  await pool.query('UPDATE knowledge_documents SET deleted_at = $1 WHERE id = $2', [
    new Date().toISOString(),
    req.params.id,
  ])
  res.status(204).end()
})

// Restore from trash — clears deleted_at, making the document active again everywhere.
knowledgeRouter.post('/:id/restore', async (req, res) => {
  const orgId = req.user!.org_id
  const existing = (
    await pool.query('SELECT id FROM knowledge_documents WHERE org_id = $1 AND id = $2', [orgId, req.params.id])
  ).rows[0]
  if (!existing) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  await pool.query('UPDATE knowledge_documents SET deleted_at = NULL WHERE id = $1', [req.params.id])
  res.status(204).end()
})

// Permanent delete — only allowed from trash (deleted_at must already be set), so the only
// way to actually remove a row from the database is trash first, then delete from there.
knowledgeRouter.delete('/:id', async (req, res) => {
  const orgId = req.user!.org_id
  const existing = (
    await pool.query('SELECT id, deleted_at, storage_path FROM knowledge_documents WHERE org_id = $1 AND id = $2', [
      orgId,
      req.params.id,
    ])
  ).rows[0] as { id: string; deleted_at: string | null; storage_path: string | null } | undefined
  if (!existing) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  if (!existing.deleted_at) {
    res.status(400).json({ error: 'not_trashed', message: 'Move to trash before permanently deleting.' })
    return
  }
  await pool.query('DELETE FROM knowledge_documents WHERE id = $1', [req.params.id])
  // A type='file' row's actual content lives on disk or Blob, not in this row — remove it too,
  // same "delete the DB row and its file together" pattern as meetings.ts's asset delete.
  if (existing.storage_path) await deleteFile(existing.storage_path)
  res.status(204).end()
})
