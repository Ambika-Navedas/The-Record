import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { pool } from '../db.ts'
import { requireAdmin, requireAuth } from '../auth.ts'

export const holidaysRouter = Router()
holidaysRouter.use(requireAuth)

interface HolidayRow {
  id: string
  date: string
  name: string
  is_optional: number
  selected_by_me: boolean
}

function serialize(row: HolidayRow) {
  return {
    id: row.id,
    date: row.date,
    name: row.name,
    isOptional: !!row.is_optional,
    selectedByMe: !!row.selected_by_me,
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// This year's rule ("everyone allowed to have only 2 optional holidays" — direct request). Not
// pulled into a per-org/per-year settings table, since nothing so far suggests it needs to vary;
// revisit if a future year's number actually differs.
const MAX_OPTIONAL_SELECTIONS = 2

holidaysRouter.get('/', async (req, res) => {
  const orgId = req.user!.org_id
  const { rows } = await pool.query(
    `SELECT h.id, h.date, h.name, h.is_optional,
            EXISTS(SELECT 1 FROM holiday_selections hs WHERE hs.holiday_id = h.id AND hs.user_id = $1) AS selected_by_me
     FROM holidays h
     WHERE h.org_id = $2
     ORDER BY h.date ASC`,
    [req.user!.id, orgId],
  )
  res.json({ items: (rows as HolidayRow[]).map(serialize) })
})

// GET stays open to any org member — a holiday calendar is useful info for everyone. Only
// mutation is admin-gated, since it's org-wide and (unlike a task) belongs to no one person.
holidaysRouter.post('/', requireAdmin, async (req, res) => {
  const orgId = req.user!.org_id
  const { date, name, isOptional } = req.body as { date?: string; name?: string; isOptional?: boolean }
  if (!date || !DATE_RE.test(date)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' })
    return
  }
  if (!name?.trim()) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  const existing = (await pool.query('SELECT id FROM holidays WHERE org_id = $1 AND date = $2', [orgId, date]))
    .rows[0]
  if (existing) {
    res.status(409).json({ error: 'A holiday is already set for that date' })
    return
  }
  const id = randomUUID()
  await pool.query('INSERT INTO holidays (id, org_id, date, name, is_optional) VALUES ($1, $2, $3, $4, $5)', [
    id,
    orgId,
    date,
    name.trim(),
    isOptional ? 1 : 0,
  ])
  res.status(201).json({ id, date, name: name.trim(), isOptional: !!isOptional })
})

holidaysRouter.delete('/:id', requireAdmin, async (req, res) => {
  const orgId = req.user!.org_id
  const id = req.params.id as string
  const existing = (await pool.query('SELECT id FROM holidays WHERE org_id = $1 AND id = $2', [orgId, id])).rows[0]
  if (!existing) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  // holiday_selections.holiday_id references this row with FK enforcement on — clear any picks
  // first, same reasoning as task_activity's cleanup before a task delete.
  await pool.query('DELETE FROM holiday_selections WHERE holiday_id = $1', [id])
  await pool.query('DELETE FROM holidays WHERE id = $1', [id])
  res.status(204).end()
})

// Personal, not admin-gated — every member picks their own 2, same as no one but the assignee
// can mark a task done. Mandatory holidays apply to everyone automatically; there's nothing to
// "select" about them, so only isOptional holidays are selectable here.
holidaysRouter.post('/:id/select', async (req, res) => {
  const orgId = req.user!.org_id
  const holidayId = req.params.id as string
  const holiday = (
    await pool.query('SELECT id, is_optional FROM holidays WHERE org_id = $1 AND id = $2', [orgId, holidayId])
  ).rows[0] as { id: string; is_optional: number } | undefined
  if (!holiday) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  if (!holiday.is_optional) {
    res.status(400).json({ error: 'not_optional', message: 'Only optional holidays can be selected.' })
    return
  }
  const already = (
    await pool.query('SELECT id FROM holiday_selections WHERE user_id = $1 AND holiday_id = $2', [
      req.user!.id,
      holidayId,
    ])
  ).rows[0]
  if (already) {
    res.status(409).json({ error: 'already_selected' })
    return
  }
  const { count } = (
    await pool.query('SELECT COUNT(*) AS count FROM holiday_selections WHERE user_id = $1', [req.user!.id])
  ).rows[0] as { count: string }
  if (Number(count) >= MAX_OPTIONAL_SELECTIONS) {
    res.status(400).json({
      error: 'limit_reached',
      message: `You can only select ${MAX_OPTIONAL_SELECTIONS} optional holidays this year.`,
    })
    return
  }
  await pool.query('INSERT INTO holiday_selections (id, org_id, user_id, holiday_id) VALUES ($1, $2, $3, $4)', [
    randomUUID(),
    orgId,
    req.user!.id,
    holidayId,
  ])
  res.status(204).end()
})

holidaysRouter.delete('/:id/select', async (req, res) => {
  const holidayId = req.params.id as string
  const existing = (
    await pool.query('SELECT id FROM holiday_selections WHERE user_id = $1 AND holiday_id = $2', [
      req.user!.id,
      holidayId,
    ])
  ).rows[0]
  if (!existing) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  await pool.query('DELETE FROM holiday_selections WHERE user_id = $1 AND holiday_id = $2', [
    req.user!.id,
    holidayId,
  ])
  res.status(204).end()
})
