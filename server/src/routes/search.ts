import { Router } from 'express'
import { pool } from '../db.ts'
import { requireAuth } from '../auth.ts'

export const searchRouter = Router()
searchRouter.use(requireAuth)

const RESULT_LIMIT = 5

searchRouter.get('/', async (req, res) => {
  const orgId = req.user!.org_id
  const q = (req.query.q as string | undefined)?.trim()

  if (!q) {
    res.json({ projects: [], meetings: [], documents: [] })
    return
  }

  const like = `%${q}%`

  // ILIKE, not LIKE — SQLite's LIKE is case-insensitive for ASCII by default; Postgres's LIKE is
  // case-sensitive, so ILIKE is the direct equivalent here, not a behavior change.
  const projects = (
    await pool.query(
      `SELECT id, name, status FROM projects
       WHERE org_id = $1 AND name ILIKE $2
       ORDER BY updated_at DESC LIMIT $3`,
      [orgId, like, RESULT_LIMIT],
    )
  ).rows as { id: string; name: string; status: string }[]

  const meetings = (
    await pool.query(
      `SELECT id, title, scheduled_at FROM meetings
       WHERE org_id = $1 AND (title ILIKE $2 OR summary ILIKE $3)
       ORDER BY scheduled_at DESC LIMIT $4`,
      [orgId, like, like, RESULT_LIMIT],
    )
  ).rows as { id: string; title: string; scheduled_at: string }[]

  const documents = (
    await pool.query(
      `SELECT id, title, type FROM knowledge_documents
       WHERE org_id = $1 AND deleted_at IS NULL AND (title ILIKE $2 OR excerpt ILIKE $3)
       ORDER BY updated_at DESC LIMIT $4`,
      [orgId, like, like, RESULT_LIMIT],
    )
  ).rows as { id: string; title: string; type: string }[]

  res.json({
    projects: projects.map((p) => ({ id: p.id, name: p.name, status: p.status })),
    meetings: meetings.map((m) => ({ id: m.id, title: m.title, scheduledAt: m.scheduled_at })),
    documents: documents.map((d) => ({ id: d.id, title: d.title, type: d.type })),
  })
})
