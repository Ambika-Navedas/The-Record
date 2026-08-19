import { pool } from './db.ts'
import { notify } from './notifications.ts'

// No background job/cron exists in this app, so a due reminder isn't caught the instant it
// becomes due — it's caught the next time this runs, which routes/notifications.ts's GET /
// and routes/reminders.ts's GET / both call, covering "whenever the member loads the app"
// (the bell fetches on every page mount) and "whenever they open the Reminders page" alike.
export async function checkDueReminders(orgId: string, userId: string) {
  const { rows } = await pool.query(
    'SELECT id, text FROM reminders WHERE user_id = $1 AND due_at IS NOT NULL AND due_at <= now() AND notified_at IS NULL',
    [userId],
  )
  for (const r of rows as { id: string; text: string }[]) {
    await notify(orgId, userId, `Reminder: ${r.text}`)
    await pool.query('UPDATE reminders SET notified_at = now() WHERE id = $1', [r.id])
  }
}
