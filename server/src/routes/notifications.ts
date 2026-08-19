import { Router } from 'express'
import { pool } from '../db.ts'
import { requireAuth } from '../auth.ts'
import { checkDueReminders } from '../reminders.ts'

export const notificationsRouter = Router()
notificationsRouter.use(requireAuth)

interface NotificationRow {
  id: string
  message: string
  read_at: string | null
  created_at: string
}

// GET /api/notifications — caller's own, newest first, capped at 50 (demo-scale; no pagination).
// unreadCount is a separate COUNT query rather than derived from the capped list, so it stays
// correct even if unread notifications exist beyond the 50 most recent.
//
// Checks for newly-due reminders first (see server/src/reminders.ts) — the bell is fetched on
// every page load via AppLayout.tsx, so this is what makes "a reminder becomes a notification
// once it's due" actually happen without a real background job/cron.
notificationsRouter.get('/', async (req, res) => {
  const orgId = req.user!.org_id
  const userId = req.user!.id
  await checkDueReminders(orgId, userId)
  const { rows } = await pool.query(
    'SELECT id, message, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
    [userId],
  )
  const { rows: countRows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  )
  res.json({
    items: (rows as NotificationRow[]).map((r) => ({
      id: r.id,
      message: r.message,
      read: r.read_at !== null,
      createdAt: r.created_at,
    })),
    unreadCount: countRows[0].n,
  })
})

// Bulk mark-all-read, not per-notification — matches "opening the panel marks them read"
// (the frontend calls this right after fetching the list to display), not an explicit
// per-item dismiss action.
notificationsRouter.post('/read-all', async (req, res) => {
  await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [
    req.user!.id,
  ])
  res.status(204).end()
})
