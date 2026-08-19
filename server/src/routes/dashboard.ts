import { Router } from 'express'
import { pool } from '../db.ts'
import { requireAuth } from '../auth.ts'

export const dashboardRouter = Router()
dashboardRouter.use(requireAuth)

const MONTH_RE = /^\d{4}-\d{2}$/

// Shared by /summary (implicitly "this month") and the two dedicated /task-calendar,
// /leave-calendar endpoints (arbitrary month, for the Dashboard's prev/next navigation) — one
// computation, no drift between what "this month" shows on load and what navigating back to it
// would show.
function parseMonthParam(month: unknown): { year: number; monthIndex0: number } {
  if (typeof month === 'string' && MONTH_RE.test(month)) {
    const [y, m] = month.split('-').map(Number)
    return { year: y, monthIndex0: m - 1 }
  }
  const now = new Date()
  return { year: now.getFullYear(), monthIndex0: now.getMonth() }
}

// Open (not done) tasks due in the given month, grouped by due date then assignee. "Open" here
// means not done — a forward-looking capacity view of who has what due when, not a historical
// log, so completed tasks are deliberately excluded.
async function getTaskCalendar(orgId: string, year: number, monthIndex0: number) {
  const monthStr = `${year}-${String(monthIndex0 + 1).padStart(2, '0')}`
  const { rows } = await pool.query(
    `SELECT t.due_date AS date, u.id AS user_id, u.name, u.initials, COUNT(*)::int AS count
     FROM meeting_tasks t
     JOIN users u ON u.id = t.assignee_id
     WHERE t.org_id = $1 AND t.done = 0 AND t.due_date IS NOT NULL AND substring(t.due_date, 1, 7) = $2
     GROUP BY t.due_date, u.id
     ORDER BY t.due_date ASC, count DESC`,
    [orgId, monthStr],
  )
  const byDate = new Map<string, { id: string; name: string; initials: string; count: number }[]>()
  for (const r of rows as { date: string; user_id: string; name: string; initials: string; count: number }[]) {
    const list = byDate.get(r.date) ?? []
    list.push({ id: r.user_id, name: r.name, initials: r.initials, count: r.count })
    byDate.set(r.date, list)
  }
  return [...byDate.entries()].map(([date, byAssignee]) => ({ date, byAssignee }))
}

// Approved leave requests overlapping the given month, expanded from a [from_date, to_date]
// span into one entry per day (clipped to the month) — a calendar needs "who's out on the
// 14th", not "who has a request that happens to include the 14th".
async function getLeaveCalendar(orgId: string, year: number, monthIndex0: number) {
  const monthStart = `${year}-${String(monthIndex0 + 1).padStart(2, '0')}-01`
  const monthEndDate = new Date(year, monthIndex0 + 1, 0)
  const monthEnd = `${monthEndDate.getFullYear()}-${String(monthEndDate.getMonth() + 1).padStart(2, '0')}-${String(monthEndDate.getDate()).padStart(2, '0')}`
  const { rows } = await pool.query(
    `SELECT lr.user_id, u.name, u.initials, lr.from_date, lr.to_date, lt.name AS leave_type_name
     FROM leave_requests lr
     JOIN users u ON u.id = lr.user_id
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     WHERE lr.org_id = $1 AND lr.status = 'approved' AND lr.from_date <= $2 AND lr.to_date >= $3`,
    [orgId, monthEnd, monthStart],
  )
  const byDate = new Map<string, { id: string; name: string; initials: string; leaveTypeName: string }[]>()
  for (const r of rows as {
    user_id: string
    name: string
    initials: string
    from_date: string
    to_date: string
    leave_type_name: string
  }[]) {
    let cursor = new Date(
      Math.max(new Date(`${r.from_date}T00:00:00`).getTime(), new Date(`${monthStart}T00:00:00`).getTime()),
    )
    const end = new Date(Math.min(new Date(`${r.to_date}T00:00:00`).getTime(), monthEndDate.getTime()))
    while (cursor <= end) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
      const list = byDate.get(key) ?? []
      list.push({ id: r.user_id, name: r.name, initials: r.initials, leaveTypeName: r.leave_type_name })
      byDate.set(key, list)
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)
    }
  }
  return [...byDate.entries()].map(([date, people]) => ({ date, people }))
}

// Dedicated endpoints, not folded into /summary, so the Dashboard's prev/next month navigation
// (see DashboardPage.tsx) can re-fetch just one calendar's data instead of the entire summary
// payload (projects, task overview, holidays, etc. — none of which are month-scoped) on every click.
dashboardRouter.get('/task-calendar', async (req, res) => {
  const { year, monthIndex0 } = parseMonthParam(req.query.month)
  res.json({ items: await getTaskCalendar(req.user!.org_id, year, monthIndex0) })
})

dashboardRouter.get('/leave-calendar', async (req, res) => {
  const { year, monthIndex0 } = parseMonthParam(req.query.month)
  res.json({ items: await getLeaveCalendar(req.user!.org_id, year, monthIndex0) })
})

dashboardRouter.get('/summary', async (req, res) => {
  const orgId = req.user!.org_id
  const user = req.user!

  const org = (await pool.query('SELECT name FROM organizations WHERE id = $1', [orgId])).rows[0] as {
    name: string
  }

  const projects = (
    await pool.query(
      `SELECT p.id, p.name, p.status, p.updated_at, u.name AS owner_name, u.initials AS owner_initials,
              (SELECT COUNT(*) FROM knowledge_documents kd WHERE kd.project_id = p.id AND kd.deleted_at IS NULL)::int AS doc_count
       FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.org_id = $1 ORDER BY p.updated_at DESC LIMIT 4`,
      [orgId],
    )
  ).rows as {
    id: string
    name: string
    status: string
    updated_at: string
    owner_name: string
    owner_initials: string
    doc_count: number
  }[]

  // Task overview: status breakdown (open / overdue / done) across every meeting in the org.
  // A daily-trend chart (mirroring knowledgeHealth's below) isn't a good fit here — this org's
  // task_activity log is brand new and 364 of 365 seeded tasks have never been touched, so a
  // "completions per day" trend would render as one flat, empty line. Current status split is
  // the metric that's actually meaningful with this data, not a sparse history.
  const taskStats = (
    await pool.query(
      `SELECT COUNT(*)::int AS total,
              SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END)::int AS done_count,
              SUM(CASE WHEN done = 0 AND due_date IS NOT NULL AND due_date::date < CURRENT_DATE THEN 1 ELSE 0 END)::int AS overdue_count
       FROM meeting_tasks WHERE org_id = $1`,
      [orgId],
    )
  ).rows[0] as { total: number; done_count: number; overdue_count: number }

  const openOnTrackCount = taskStats.total - taskStats.done_count - taskStats.overdue_count
  const completionRatePct = taskStats.total ? Math.round((taskStats.done_count / taskStats.total) * 100) : 0
  const taskBreakdown = (
    [
      { status: 'open', count: openOnTrackCount },
      { status: 'overdue', count: taskStats.overdue_count },
      { status: 'done', count: taskStats.done_count },
    ] as const
  ).map((b) => ({ ...b, pct: taskStats.total ? Math.round((b.count / taskStats.total) * 100) : 0 }))

  // "Agent performance" — per-assignee completion, for whoever's actually carrying tasks. Only
  // real assignees (INNER JOIN, not LEFT) — unassigned tasks have no "agent" to attribute
  // performance to, same reasoning as everywhere else this app treats unassigned as ownerless.
  // Every assignee with at least one task, not just a top-N — direct request ("show all agent
  // performance") after the initial top-6 cut.
  const assigneeRows = (
    await pool.query(
      `SELECT u.id, u.name, u.initials, COUNT(*)::int AS total,
              SUM(CASE WHEN t.done = 1 THEN 1 ELSE 0 END)::int AS done_count,
              SUM(CASE WHEN t.done = 0 AND t.due_date IS NOT NULL AND t.due_date::date < CURRENT_DATE THEN 1 ELSE 0 END)::int AS overdue_count
       FROM meeting_tasks t
       JOIN users u ON u.id = t.assignee_id
       WHERE t.org_id = $1
       GROUP BY u.id
       ORDER BY total DESC`,
      [orgId],
    )
  ).rows as { id: string; name: string; initials: string; total: number; done_count: number; overdue_count: number }[]
  const byAssignee = assigneeRows.map((r) => ({
    id: r.id,
    name: r.name,
    initials: r.initials,
    total: r.total,
    doneCount: r.done_count,
    overdueCount: r.overdue_count,
    completionRatePct: r.total ? Math.round((r.done_count / r.total) * 100) : 0,
  }))

  const typeRows = (
    await pool.query(
      'SELECT type, COUNT(*)::int AS n FROM knowledge_documents WHERE org_id = $1 AND deleted_at IS NULL GROUP BY type',
      [orgId],
    )
  ).rows as { type: string; n: number }[]
  const totalDocs = typeRows.reduce((sum, r) => sum + r.n, 0)
  const documentsByType = typeRows
    .map((r) => ({ type: r.type, pct: Math.round((r.n / (totalDocs || 1)) * 100) }))
    .sort((a, b) => b.pct - a.pct)

  // Upcoming company holidays (manually entered — see holidays.ts) — a small forward-looking
  // window is enough since the frontend only needs to check whether one falls within the single
  // week it renders (the week containing nextEvent, or the current week if there's no nextEvent).
  const upcomingHolidays = (
    await pool.query(`SELECT date, name FROM holidays WHERE org_id = $1 AND date::date >= CURRENT_DATE ORDER BY date ASC LIMIT 10`, [
      orgId,
    ])
  ).rows as { date: string; name: string }[]

  const nextEventRow = (
    await pool.query(
      `SELECT m.id, m.title, m.scheduled_at, m.duration_min, p.name AS project_name
       FROM meetings m
       LEFT JOIN projects p ON p.id = m.project_id
       WHERE m.org_id = $1 AND m.scheduled_at > now()
       ORDER BY m.scheduled_at ASC LIMIT 1`,
      [orgId],
    )
  ).rows[0] as
    | { id: string; title: string; scheduled_at: string; duration_min: number; project_name: string | null }
    | undefined

  // "Today's meeting update" — the most recently logged meeting activity (by created_at,
  // not necessarily scheduled today), regardless of past/future.
  const latestMeetingRow = (
    await pool.query(
      `SELECT m.id, m.title, m.summary, m.scheduled_at, m.sync_status, p.name AS project_name
       FROM meetings m
       LEFT JOIN projects p ON p.id = m.project_id
       WHERE m.org_id = $1
       ORDER BY m.created_at DESC LIMIT 1`,
      [orgId],
    )
  ).rows[0] as
    | { id: string; title: string; summary: string; scheduled_at: string; sync_status: string; project_name: string | null }
    | undefined

  // Most popular knowledge base content — highest view_count (bumped each time
  // Ask The Record cites the doc as a source, see chat.ts). Null until anything's been viewed.
  const popularDocRow = (
    await pool.query(
      `SELECT kd.id, kd.title, kd.type, kd.view_count, p.name AS project_name
       FROM knowledge_documents kd
       LEFT JOIN projects p ON p.id = kd.project_id
       WHERE kd.org_id = $1 AND kd.view_count > 0 AND kd.deleted_at IS NULL
       ORDER BY kd.view_count DESC LIMIT 1`,
      [orgId],
    )
  ).rows[0] as
    | { id: string; title: string; type: string; view_count: number; project_name: string | null }
    | undefined

  res.json({
    user: { name: user.name },
    org: { name: org.name },
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      updatedAt: p.updated_at,
      docCount: p.doc_count,
      owner: { name: p.owner_name, initials: p.owner_initials },
    })),
    taskOverview: {
      totalItems: taskStats.total,
      completionRatePct,
      overdueCount: taskStats.overdue_count,
      breakdown: taskBreakdown,
      byAssignee,
    },
    documentsByType: { totalItems: totalDocs, breakdown: documentsByType },
    upcomingHolidays,
    nextEvent: nextEventRow
      ? {
          id: nextEventRow.id,
          title: nextEventRow.title,
          project: nextEventRow.project_name,
          scheduledAt: nextEventRow.scheduled_at,
          durationMin: nextEventRow.duration_min,
        }
      : null,
    todaysMeetingUpdate: latestMeetingRow
      ? {
          id: latestMeetingRow.id,
          title: latestMeetingRow.title,
          summary: latestMeetingRow.summary,
          project: latestMeetingRow.project_name,
          scheduledAt: latestMeetingRow.scheduled_at,
          syncStatus: latestMeetingRow.sync_status,
        }
      : null,
    mostPopularContent: popularDocRow
      ? {
          id: popularDocRow.id,
          title: popularDocRow.title,
          type: popularDocRow.type,
          project: popularDocRow.project_name,
          viewCount: popularDocRow.view_count,
        }
      : null,
  })
})
