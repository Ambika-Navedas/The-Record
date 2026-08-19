import { randomUUID } from 'node:crypto'
import { pool } from './db.ts'

// Shared by every producer (worknest.ts, meetings.ts, integrations.ts) so the INSERT isn't
// duplicated three times — see docs/use-cases/notifications/backend.md for the table/endpoint
// design this writes into.
export async function notify(orgId: string, userId: string, message: string) {
  await pool.query('INSERT INTO notifications (id, org_id, user_id, message) VALUES ($1, $2, $3, $4)', [
    randomUUID(),
    orgId,
    userId,
    message,
  ])
}
