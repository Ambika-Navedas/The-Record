import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { pool } from '../db.ts'
import { requireAdmin, requireAuth } from '../auth.ts'
import { notify } from '../notifications.ts'

export const worknestRouter = Router()
worknestRouter.use(requireAuth)

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function daysBetweenInclusive(fromDate: string, toDate: string): number {
  const from = new Date(`${fromDate}T00:00:00`)
  const to = new Date(`${toDate}T00:00:00`)
  return Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1
}

// ---- Leave types ----

worknestRouter.get('/leave-types', async (req, res) => {
  const orgId = req.user!.org_id
  const { rows } = await pool.query('SELECT id, name FROM leave_types WHERE org_id = $1 ORDER BY name ASC', [orgId])
  res.json({ items: rows })
})

// ---- Leave balances ----
// LEFT JOIN so a leave type with no balance row yet (never allocated to this user) still shows
// up at 0 rather than being silently missing from the list.
worknestRouter.get('/leave-balances', async (req, res) => {
  const orgId = req.user!.org_id
  const { rows } = await pool.query(
    `SELECT lt.id AS leave_type_id, lt.name, COALESCE(lb.balance, 0) AS balance
     FROM leave_types lt
     LEFT JOIN leave_balances lb ON lb.leave_type_id = lt.id AND lb.user_id = $1
     WHERE lt.org_id = $2
     ORDER BY lt.name ASC`,
    [req.user!.id, orgId],
  )
  res.json({
    items: (rows as { leave_type_id: string; name: string; balance: number }[]).map((r) => ({
      leaveTypeId: r.leave_type_id,
      name: r.name,
      balance: r.balance,
    })),
  })
})

// ---- Team balances (admin-only) ----
// Direct request: "the admin need to have the option to modify the leave balance of each
// member." Deliberately separate from the (removed) approve/reject workflow — this isn't a
// review step in some request flow, it's a standing admin capability to allocate/correct
// balances directly, same permission level as generating a payslip used to be.

interface TeamBalanceRow {
  user_id: string
  user_name: string
  employee_id: string
  leave_type_id: string
  leave_type_name: string
  balance: number
}

worknestRouter.get('/leave-balances/team', requireAdmin, async (req, res) => {
  const orgId = req.user!.org_id
  const { rows } = await pool.query(
    `SELECT u.id AS user_id, u.name AS user_name, u.employee_id, lt.id AS leave_type_id, lt.name AS leave_type_name,
            COALESCE(lb.balance, 0) AS balance
     FROM users u
     CROSS JOIN leave_types lt
     LEFT JOIN leave_balances lb ON lb.user_id = u.id AND lb.leave_type_id = lt.id
     WHERE u.org_id = $1 AND lt.org_id = $1
     ORDER BY u.name ASC, lt.name ASC`,
    [orgId],
  )
  const byUser = new Map<
    string,
    { userId: string; userName: string; employeeId: string; balances: { leaveTypeId: string; name: string; balance: number }[] }
  >()
  for (const r of rows as TeamBalanceRow[]) {
    if (!byUser.has(r.user_id)) {
      byUser.set(r.user_id, { userId: r.user_id, userName: r.user_name, employeeId: r.employee_id, balances: [] })
    }
    byUser.get(r.user_id)!.balances.push({ leaveTypeId: r.leave_type_id, name: r.leave_type_name, balance: r.balance })
  }
  res.json({ items: [...byUser.values()] })
})

// Sets (not adjusts by delta) one member's balance for one leave type — an absolute value the
// admin types in, same "real number in, real number out" spirit as payslips used to be, not an
// increment/decrement API.
worknestRouter.patch('/leave-balances/:userId', requireAdmin, async (req, res) => {
  const orgId = req.user!.org_id
  const userId = req.params.userId as string
  const { leaveTypeId, balance } = req.body as { leaveTypeId?: string; balance?: number }
  if (!leaveTypeId) {
    res.status(400).json({ error: 'leaveTypeId is required' })
    return
  }
  if (typeof balance !== 'number' || Number.isNaN(balance) || balance < 0) {
    res.status(400).json({ error: 'balance must be a non-negative number' })
    return
  }
  const user = (await pool.query('SELECT id FROM users WHERE org_id = $1 AND id = $2', [orgId, userId])).rows[0]
  if (!user) {
    res.status(404).json({ error: 'not_found', message: 'Unknown user.' })
    return
  }
  const leaveType = (
    await pool.query('SELECT id, name FROM leave_types WHERE org_id = $1 AND id = $2', [orgId, leaveTypeId])
  ).rows[0] as { id: string; name: string } | undefined
  if (!leaveType) {
    res.status(404).json({ error: 'not_found', message: 'Unknown leave type.' })
    return
  }
  const existing = (
    await pool.query('SELECT id FROM leave_balances WHERE user_id = $1 AND leave_type_id = $2', [userId, leaveTypeId])
  ).rows[0] as { id: string } | undefined
  if (existing) {
    await pool.query('UPDATE leave_balances SET balance = $1 WHERE id = $2', [balance, existing.id])
  } else {
    await pool.query(
      'INSERT INTO leave_balances (id, org_id, user_id, leave_type_id, balance) VALUES ($1, $2, $3, $4, $5)',
      [randomUUID(), orgId, userId, leaveTypeId, balance],
    )
  }
  // Notifies the affected member, not the admin who made the change — direct request: "The
  // same modification needs to be visible as the notification ... to the particular member."
  await notify(orgId, userId, `Your ${leaveType.name} leave balance was updated to ${balance}.`)
  res.status(204).end()
})

// ---- Leave requests ----

interface LeaveRequestRow {
  id: string
  user_id: string
  user_name: string
  leave_type_id: string
  leave_type_name: string
  from_date: string
  to_date: string
  days: number
  reason: string
  status: string
  reviewed_by: string | null
  reviewer_name: string | null
  reviewed_at: string | null
  created_at: string
}

function serializeRequest(r: LeaveRequestRow) {
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    leaveTypeId: r.leave_type_id,
    leaveTypeName: r.leave_type_name,
    fromDate: r.from_date,
    toDate: r.to_date,
    days: r.days,
    reason: r.reason,
    status: r.status,
    reviewerName: r.reviewer_name,
    reviewedAt: r.reviewed_at,
    createdAt: r.created_at,
  }
}

// Leave history — always scoped to the caller, nobody sees anyone else's. There's no
// request/approval workflow anymore (removed by direct request — "There should be no leave
// request and approval system"), so this is a read-only log of whatever leave_requests rows
// already exist (all real data predates the removal, and no new rows can ever be created), not
// an actionable queue. Kept as GET /leave-requests (not renamed) since it's the same shape/data,
// just a different frontend label ("Leave history" in place of the old "My requests").
worknestRouter.get('/leave-requests', async (req, res) => {
  const orgId = req.user!.org_id
  const { rows } = await pool.query(
    `SELECT r.id, r.user_id, u.name AS user_name, r.leave_type_id, lt.name AS leave_type_name,
            r.from_date, r.to_date, r.days, r.reason, r.status,
            r.reviewed_by, reviewer.name AS reviewer_name, r.reviewed_at, r.created_at
     FROM leave_requests r
     JOIN users u ON u.id = r.user_id
     JOIN leave_types lt ON lt.id = r.leave_type_id
     LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
     WHERE r.org_id = $1 AND r.user_id = $2
     ORDER BY r.created_at DESC`,
    [orgId, req.user!.id],
  )
  res.json({ items: (rows as LeaveRequestRow[]).map(serializeRequest) })
})

// Self-service leave logging — no approval step. Direct follow-up once removing the
// request/approval system left no way for anyone to actually inform the team they're taking
// leave: "without the request/approval, all rest should be there." Reinstates a way to create a
// leave_requests row, but collapses what used to be two steps (file, then get approved) into
// one: the row is inserted as already `'approved'` and the balance is deducted immediately,
// rather than staying `'pending'` until someone else reviews it. `reviewed_by`/`reviewed_at`
// stay NULL — nobody actually reviewed this, so it would be dishonest to backfill a reviewer.
worknestRouter.post('/leave-requests', async (req, res) => {
  const orgId = req.user!.org_id
  const { leaveTypeId, fromDate, toDate, reason } = req.body as {
    leaveTypeId?: string
    fromDate?: string
    toDate?: string
    reason?: string
  }
  if (!leaveTypeId) {
    res.status(400).json({ error: 'leaveTypeId is required' })
    return
  }
  if (!fromDate || !DATE_RE.test(fromDate) || !toDate || !DATE_RE.test(toDate)) {
    res.status(400).json({ error: 'fromDate and toDate must be YYYY-MM-DD' })
    return
  }
  if (toDate < fromDate) {
    res.status(400).json({ error: 'toDate cannot be before fromDate' })
    return
  }
  const leaveType = (
    await pool.query('SELECT id, name FROM leave_types WHERE org_id = $1 AND id = $2', [orgId, leaveTypeId])
  ).rows[0] as { id: string; name: string } | undefined
  if (!leaveType) {
    res.status(404).json({ error: 'not_found', message: 'Unknown leave type.' })
    return
  }
  const days = daysBetweenInclusive(fromDate, toDate)
  const balanceRow = (
    await pool.query('SELECT balance FROM leave_balances WHERE user_id = $1 AND leave_type_id = $2', [
      req.user!.id,
      leaveTypeId,
    ])
  ).rows[0] as { balance: number } | undefined
  const balance = balanceRow?.balance ?? 0
  if (days > balance) {
    res.status(400).json({
      error: 'insufficient_balance',
      message: `Not enough ${leaveType.name} balance — requested ${days} day${days === 1 ? '' : 's'}, ${balance} available.`,
    })
    return
  }

  const id = randomUUID()
  await pool.query(
    `INSERT INTO leave_requests (id, org_id, user_id, leave_type_id, from_date, to_date, days, reason, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'approved')`,
    [id, orgId, req.user!.id, leaveTypeId, fromDate, toDate, days, reason?.trim() ?? ''],
  )
  const newBalance = balance - days
  if (balanceRow) {
    await pool.query('UPDATE leave_balances SET balance = $1 WHERE user_id = $2 AND leave_type_id = $3', [
      newBalance,
      req.user!.id,
      leaveTypeId,
    ])
  } else {
    await pool.query(
      'INSERT INTO leave_balances (id, org_id, user_id, leave_type_id, balance) VALUES ($1, $2, $3, $4, $5)',
      [randomUUID(), orgId, req.user!.id, leaveTypeId, newBalance],
    )
  }

  res.status(201).json({ id })
})

// GET /on-leave — pure info ("who's currently out"), visible to every org member, distinct
// from /leave-requests above (that's each person's own history; this is everyone's current
// status). "On leave" means an approved request whose range hasn't fully ended yet.
worknestRouter.get('/on-leave', async (req, res) => {
  const orgId = req.user!.org_id
  const { rows } = await pool.query(
    `SELECT r.user_id, u.name AS user_name, u.initials AS user_initials, lt.name AS leave_type_name,
            r.from_date, r.to_date, r.days
     FROM leave_requests r
     JOIN users u ON u.id = r.user_id
     JOIN leave_types lt ON lt.id = r.leave_type_id
     WHERE r.org_id = $1 AND r.status = 'approved' AND r.to_date::date >= CURRENT_DATE
     ORDER BY r.from_date ASC`,
    [orgId],
  )
  res.json({
    items: (
      rows as {
        user_id: string
        user_name: string
        user_initials: string
        leave_type_name: string
        from_date: string
        to_date: string
        days: number
      }[]
    ).map((r) => ({
      userId: r.user_id,
      userName: r.user_name,
      userInitials: r.user_initials,
      leaveTypeName: r.leave_type_name,
      fromDate: r.from_date,
      toDate: r.to_date,
      days: r.days,
    })),
  })
})

