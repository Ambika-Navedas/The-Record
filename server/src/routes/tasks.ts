import { Router } from 'express'
import { pool } from '../db.ts'
import { requireAuth } from '../auth.ts'

export const tasksRouter = Router()
tasksRouter.use(requireAuth)

interface TaskRow {
  id: string
  meeting_id: string
  meeting_title: string
  meeting_scheduled_at: string
  title: string
  assignee_id: string | null
  assignee_name: string | null
  assignee_initials: string | null
  due_date: string | null
  done: number
  completion_note: string | null
  created_at: string
}

function serialize(row: TaskRow) {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    meetingTitle: row.meeting_title,
    meetingScheduledAt: row.meeting_scheduled_at,
    title: row.title,
    assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name, initials: row.assignee_initials } : null,
    dueDate: row.due_date,
    done: !!row.done,
    completionNote: row.completion_note,
    createdAt: row.created_at,
  }
}

// Shared by both the item-list query and the counts query below, so every extra filter (pick a
// specific assignee, narrow by meeting date or due date) is a real narrowing of the whole view —
// every chip's count changes with it, not just which rows render. Bound params, not
// string-interpolated, even though these are expected to already be id/date-shaped. Placeholder
// numbers are derived from the running params array length so this composes with whatever base
// params (e.g. orgId) were already pushed before this runs.
function applyExtraFilters(
  sql: string,
  params: string[],
  assigneeId: string | undefined,
  meetingFrom: string | undefined,
  meetingTo: string | undefined,
  dueFrom: string | undefined,
  dueTo: string | undefined,
): string {
  if (assigneeId === 'unassigned') {
    sql += ' AND t.assignee_id IS NULL'
  } else if (assigneeId) {
    params.push(assigneeId)
    sql += ` AND t.assignee_id = $${params.length}`
  }
  if (meetingFrom) {
    params.push(meetingFrom)
    sql += ` AND m.scheduled_at::date >= $${params.length}::date`
  }
  if (meetingTo) {
    params.push(meetingTo)
    sql += ` AND m.scheduled_at::date <= $${params.length}::date`
  }
  // Due-date range only matches tasks that actually have a due date — a task with none isn't
  // "in range," it's just undated.
  if (dueFrom) {
    params.push(dueFrom)
    sql += ` AND t.due_date IS NOT NULL AND t.due_date::date >= $${params.length}::date`
  }
  if (dueTo) {
    params.push(dueTo)
    sql += ` AND t.due_date IS NOT NULL AND t.due_date::date <= $${params.length}::date`
  }
  return sql
}

// Aggregates meeting_tasks across every meeting in the org into one flat list — the
// per-meeting task endpoints (POST/PATCH/DELETE /meetings/:id/tasks/:taskId) already exist
// and are reused as-is for mutations, since each task here carries its meetingId. This is
// read-only: no new write path, just a cross-meeting view of data that already exists.
tasksRouter.get('/', async (req, res) => {
  const orgId = req.user!.org_id
  const filter = req.query.filter as string | undefined
  const assigneeId = req.query.assigneeId as string | undefined
  const meetingFrom = req.query.meetingFrom as string | undefined
  const meetingTo = req.query.meetingTo as string | undefined
  const dueFrom = req.query.dueFrom as string | undefined
  const dueTo = req.query.dueTo as string | undefined

  let sql = `
    SELECT t.id, t.meeting_id, m.title AS meeting_title, m.scheduled_at AS meeting_scheduled_at, t.title,
           t.assignee_id, u.name AS assignee_name, u.initials AS assignee_initials,
           t.due_date, t.done, t.completion_note, t.created_at
    FROM meeting_tasks t
    JOIN meetings m ON m.id = t.meeting_id
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.org_id = $1
  `
  const params: string[] = [orgId]

  if (filter === 'open') {
    sql += ' AND t.done = 0'
  } else if (filter === 'done') {
    sql += ' AND t.done = 1'
  }
  sql = applyExtraFilters(sql, params, assigneeId, meetingFrom, meetingTo, dueFrom, dueTo)
  // Most recently created first — open tasks still surface above done ones, but within each
  // group the newest task leads rather than whichever has the soonest due date.
  sql += ' ORDER BY t.done ASC, t.created_at DESC'

  const rows = (await pool.query(sql, params)).rows as TaskRow[]

  // Counts reflect the whole org under the current assignee/date-range filters (but not the
  // active chip filter itself) so every chip can show its own total at once — same pattern as
  // knowledge.ts's type counts. Needs the same meetings join as the main query since
  // meetingFrom/meetingTo filter on m.scheduled_at.
  let countSql = `
    SELECT t.done
    FROM meeting_tasks t
    JOIN meetings m ON m.id = t.meeting_id
    WHERE t.org_id = $1
  `
  const countParams: string[] = [orgId]
  countSql = applyExtraFilters(countSql, countParams, assigneeId, meetingFrom, meetingTo, dueFrom, dueTo)
  const allRows = (await pool.query(countSql, countParams)).rows as { done: number }[]
  const counts = {
    all: allRows.length,
    open: allRows.filter((r) => !r.done).length,
    done: allRows.filter((r) => r.done).length,
  }

  res.json({ items: rows.map(serialize), counts })
})
