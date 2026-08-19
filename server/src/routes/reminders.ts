import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { pool } from '../db.ts'
import { requireAuth } from '../auth.ts'
import { checkDueReminders } from '../reminders.ts'

export const remindersRouter = Router()
remindersRouter.use(requireAuth)

interface ReminderRow {
  id: string
  text: string
  due_at: string | null
  created_at: string
}

function serialize(r: ReminderRow) {
  return { id: r.id, text: r.text, dueAt: r.due_at, createdAt: r.created_at }
}

// Personal only — no admin/team view exists or is planned; each member only ever sees their
// own. Checks for anything newly due before listing, so a reminder that just came due shows up
// as a real notification (see server/src/reminders.ts) the moment this page is opened, not just
// via the bell.
remindersRouter.get('/', async (req, res) => {
  const orgId = req.user!.org_id
  const userId = req.user!.id
  await checkDueReminders(orgId, userId)
  const { rows } = await pool.query(
    // Dated reminders first (soonest due first), then plain notes (newest first) — a single
    // ORDER BY does both: the boolean split groups dated-vs-not, due_at ASC only affects the
    // dated group (NULLs there have nothing to sort by), created_at DESC only meaningfully
    // affects the undated group as a tiebreaker.
    'SELECT id, text, due_at, created_at FROM reminders WHERE user_id = $1 ORDER BY (due_at IS NULL) ASC, due_at ASC, created_at DESC',
    [userId],
  )
  res.json({ items: (rows as ReminderRow[]).map(serialize) })
})

remindersRouter.post('/', async (req, res) => {
  const orgId = req.user!.org_id
  const userId = req.user!.id
  const { text, dueAt } = req.body as { text?: string; dueAt?: string }
  const trimmed = text?.trim()
  if (!trimmed) {
    res.status(400).json({ error: 'text is required' })
    return
  }
  const id = randomUUID()
  await pool.query('INSERT INTO reminders (id, org_id, user_id, text, due_at) VALUES ($1, $2, $3, $4, $5)', [
    id,
    orgId,
    userId,
    trimmed,
    dueAt || null,
  ])
  res.status(201).json({ id })
})

remindersRouter.delete('/:id', async (req, res) => {
  const existing = (
    await pool.query('SELECT id FROM reminders WHERE id = $1 AND user_id = $2', [req.params.id, req.user!.id])
  ).rows[0]
  if (!existing) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  await pool.query('DELETE FROM reminders WHERE id = $1', [req.params.id])
  res.status(204).end()
})
