import { Router } from 'express'
import { randomUUID, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import bcrypt from 'bcryptjs'
import { pool } from '../db.ts'
import { requireAdmin, requireAuth } from '../auth.ts'
import { notify } from '../notifications.ts'
import { isDbBlob, isRemoteUrl, localFilePath, readDbBlob } from '../storage.ts'

export const usersRouter = Router()
usersRouter.use(requireAuth)

// Admin-only roster for the "Team roles" settings section — deliberately separate from GET / above
// (which returns a minimal {id,name,initials} shape used by participant/assignee pickers all over
// the app) so this doesn't risk changing that shared, widely-consumed response shape.
usersRouter.get('/roles', requireAdmin, async (req, res) => {
  const orgId = req.user!.org_id
  const { rows } = await pool.query(
    `SELECT id, name, email, role, (disabled_at IS NULL) AS active FROM users
     WHERE org_id = $1 ORDER BY (role = 'admin') DESC, name ASC`,
    [orgId],
  )
  res.json({ items: rows as { id: string; name: string; email: string; role: 'admin' | 'member'; active: boolean }[] })
})

// Full profile for the "Team roles" page's employee detail view — admin-only, same fields a
// person sees about themselves on Profile Settings (auth.ts's toAuthedUser()), just fetchable
// for someone else. Registered after the static '/roles' path above so that literal route isn't
// swallowed by this ':id' pattern matching it as an id.
usersRouter.get('/:id', requireAdmin, async (req, res) => {
  const orgId = req.user!.org_id
  const row = (
    await pool.query(
      `SELECT id, name, email, initials, role, designation, department, employee_id AS "employeeId",
              avatar_path, (disabled_at IS NULL) AS active
       FROM users WHERE org_id = $1 AND id = $2`,
      [orgId, req.params.id],
    )
  ).rows[0] as
    | {
        id: string
        name: string
        email: string
        initials: string
        role: 'admin' | 'member'
        designation: string
        department: string
        employeeId: string
        avatar_path: string | null
        active: boolean
      }
    | undefined
  if (!row) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const { avatar_path, ...rest } = row
  res.json({ ...rest, avatarUrl: avatar_path ? `/users/${rest.id}/avatar` : null })
})

// Promote/demote a member — the org's admins are the only ones who can grant or revoke admin
// access. Guards against demoting the org's last remaining admin, since that would leave nobody
// able to use this endpoint (or any other admin-only feature) to fix it afterward.
usersRouter.patch('/:id/role', requireAdmin, async (req, res) => {
  const orgId = req.user!.org_id
  const { role } = req.body as { role?: string }
  if (role !== 'admin' && role !== 'member') {
    res.status(400).json({ error: 'role must be "admin" or "member"' })
    return
  }

  const target = (
    await pool.query('SELECT id, name, role FROM users WHERE org_id = $1 AND id = $2', [orgId, req.params.id])
  ).rows[0] as { id: string; name: string; role: 'admin' | 'member' } | undefined
  if (!target) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  if (target.role === role) {
    res.json({ id: target.id, name: target.name, role })
    return
  }

  if (target.role === 'admin' && role === 'member') {
    const { rows: adminCountRows } = await pool.query(
      "SELECT COUNT(*)::int AS count FROM users WHERE org_id = $1 AND role = 'admin'",
      [orgId],
    )
    if ((adminCountRows[0] as { count: number }).count <= 1) {
      res.status(409).json({ error: 'This org needs at least one admin — promote someone else first.' })
      return
    }
  }

  await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, target.id])
  await notify(
    orgId,
    target.id,
    role === 'admin' ? 'You were made an admin.' : 'Your admin access was removed — you are now a regular member.',
  )
  res.json({ id: target.id, name: target.name, role })
})

// Deactivate/reactivate — a soft removal, not a real DELETE (see db.ts's comment on
// users.disabled_at: too much else references this row — tasks, meetings, documents, leave — for
// a hard delete to be safe). Deactivating blocks login immediately, including any session they're
// already using (auth.ts's getUserForToken checks disabled_at on every request, not just at
// login), and drops them out of every assignee/participant picker (users.ts's GET / above).
usersRouter.patch('/:id/status', requireAdmin, async (req, res) => {
  const orgId = req.user!.org_id
  const { active } = req.body as { active?: boolean }
  if (typeof active !== 'boolean') {
    res.status(400).json({ error: 'active must be a boolean' })
    return
  }

  if (!active && req.params.id === req.user!.id) {
    res.status(400).json({ error: "You can't deactivate your own account." })
    return
  }

  const target = (
    await pool.query('SELECT id, name, role, disabled_at FROM users WHERE org_id = $1 AND id = $2', [
      orgId,
      req.params.id,
    ])
  ).rows[0] as { id: string; name: string; role: 'admin' | 'member'; disabled_at: string | null } | undefined
  if (!target) {
    res.status(404).json({ error: 'not_found' })
    return
  }

  const isCurrentlyActive = !target.disabled_at
  if (isCurrentlyActive === active) {
    res.json({ id: target.id, name: target.name, active })
    return
  }

  if (!active && target.role === 'admin') {
    const { rows: adminCountRows } = await pool.query(
      "SELECT COUNT(*)::int AS count FROM users WHERE org_id = $1 AND role = 'admin' AND disabled_at IS NULL",
      [orgId],
    )
    if ((adminCountRows[0] as { count: number }).count <= 1) {
      res.status(409).json({ error: 'This org needs at least one active admin — promote or reactivate someone else first.' })
      return
    }
  }

  await pool.query('UPDATE users SET disabled_at = $1 WHERE id = $2', [active ? null : new Date(), target.id])
  if (!active) {
    // No point notifying them of the deactivation itself — they're immediately locked out and
    // won't see it. Sessions aren't strictly needed to be cleared (getUserForToken already blocks
    // a disabled user's existing session on their next request), but dropping them now avoids
    // leaving valid-but-unusable rows sitting in the table.
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [target.id])
  } else {
    await notify(orgId, target.id, 'Your account was reactivated — you can log in again.')
  }
  res.json({ id: target.id, name: target.name, active })
})

// True hard delete — deliberately narrow. Verified against the live schema (every FK column
// that REFERENCES users(id)) which real data blocks this on: projects.owner_id,
// knowledge_documents.owner_id, meeting_assets.uploaded_by, task_activity.actor_id/assignee_id,
// meeting_tasks.assignee_id, leave_requests.user_id/reviewed_by, and meetings.participants (a
// JSON array, not FK-enforced, checked separately). Any of those existing means this person's
// account is woven into shared org history — deleting the row would either violate a NOT NULL FK
// outright or silently erase real collaborative data (whose project this was, who approved whose
// leave, who did what). Only truly personal, nobody-else's-problem data (sessions, notifications,
// reminders, oauth connections, leave balances, holiday picks) is cleaned up automatically here;
// everything else blocks the delete with a specific reason instead of guessing what to do with it.
// Also requires the account to already be deactivated first — a deliberate two-step "deactivate,
// confirm nothing broke, then delete" flow rather than a one-click irreversible action on someone
// who might still be actively logging in.
usersRouter.delete('/:id', requireAdmin, async (req, res) => {
  const orgId = req.user!.org_id
  const targetId = req.params.id

  if (targetId === req.user!.id) {
    res.status(400).json({ error: "You can't delete your own account." })
    return
  }

  const target = (
    await pool.query('SELECT id, name, role, disabled_at FROM users WHERE org_id = $1 AND id = $2', [orgId, targetId])
  ).rows[0] as { id: string; name: string; role: 'admin' | 'member'; disabled_at: string | null } | undefined
  if (!target) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  if (!target.disabled_at) {
    res.status(409).json({ error: 'Deactivate this member first, then delete them once nothing depends on their account.' })
    return
  }

  if (target.role === 'admin') {
    const { rows: adminCountRows } = await pool.query(
      "SELECT COUNT(*)::int AS count FROM users WHERE org_id = $1 AND role = 'admin' AND disabled_at IS NULL",
      [orgId],
    )
    if ((adminCountRows[0] as { count: number }).count === 0) {
      res.status(409).json({ error: 'This org needs at least one active admin — promote someone else first.' })
      return
    }
  }

  const blockingChecks: { label: string; sql: string }[] = [
    { label: 'own a project', sql: 'SELECT COUNT(*)::int AS count FROM projects WHERE owner_id = $1' },
    { label: 'authored a knowledge document', sql: 'SELECT COUNT(*)::int AS count FROM knowledge_documents WHERE owner_id = $1' },
    { label: 'uploaded a meeting asset', sql: 'SELECT COUNT(*)::int AS count FROM meeting_assets WHERE uploaded_by = $1' },
    { label: 'have task activity history', sql: 'SELECT COUNT(*)::int AS count FROM task_activity WHERE actor_id = $1 OR assignee_id = $1' },
    { label: 'are assigned an open task', sql: 'SELECT COUNT(*)::int AS count FROM meeting_tasks WHERE assignee_id = $1' },
    { label: 'have leave request history', sql: 'SELECT COUNT(*)::int AS count FROM leave_requests WHERE user_id = $1 OR reviewed_by = $1' },
    { label: 'appear as a meeting participant', sql: "SELECT COUNT(*)::int AS count FROM meetings WHERE participants LIKE '%' || $1 || '%'" },
  ]
  const blockingReasons: string[] = []
  for (const check of blockingChecks) {
    const { rows } = await pool.query(check.sql, [targetId])
    if ((rows[0] as { count: number }).count > 0) blockingReasons.push(check.label)
  }
  if (blockingReasons.length > 0) {
    res.status(409).json({
      error: `${target.name} can't be permanently deleted — they ${blockingReasons.join(', ')}. That's real org history other people's records depend on. They stay deactivated instead.`,
    })
    return
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM sessions WHERE user_id = $1', [targetId])
    await client.query('DELETE FROM notifications WHERE user_id = $1', [targetId])
    await client.query('DELETE FROM reminders WHERE user_id = $1', [targetId])
    await client.query('DELETE FROM oauth_connections WHERE user_id = $1', [targetId])
    await client.query('DELETE FROM leave_balances WHERE user_id = $1', [targetId])
    await client.query('DELETE FROM holiday_selections WHERE user_id = $1', [targetId])
    await client.query('DELETE FROM users WHERE id = $1', [targetId])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  res.json({ id: targetId, deleted: true })
})

// Deactivated members are excluded here — this is what every participant/assignee picker in the
// app (meetings, tasks, worknest, etc.) draws from, so a deactivated person stops being assignable
// to anything new the moment they're deactivated, without those pages needing their own filter.
usersRouter.get('/', async (req, res) => {
  const orgId = req.user!.org_id
  const { rows } = await pool.query(
    'SELECT id, name, initials FROM users WHERE org_id = $1 AND disabled_at IS NULL ORDER BY name ASC',
    [orgId],
  )
  res.json({ items: rows as { id: string; name: string; initials: string }[] })
})

// Serves the raw image file so it can be used directly as an <img src> — org-scoped, not a
// public URL, but no Content-Disposition (unlike meetings.ts's asset /download route), since
// this needs to render inline rather than force a download.
usersRouter.get('/:id/avatar', async (req, res) => {
  const orgId = req.user!.org_id
  const row = (
    await pool.query('SELECT avatar_path FROM users WHERE org_id = $1 AND id = $2', [orgId, req.params.id])
  ).rows[0] as { avatar_path: string | null } | undefined
  if (!row?.avatar_path) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  // Blob-backed avatars are already a public URL — redirect rather than proxying the bytes
  // through this server. Postgres- and local-disk-backed avatars still serve the bytes directly,
  // exactly as before — the frontend's `/users/:id/avatar` URL never changes either way, only
  // what's behind it.
  if (isRemoteUrl(row.avatar_path)) {
    res.redirect(row.avatar_path)
    return
  }
  if (isDbBlob(row.avatar_path)) {
    const { data, mimeType } = await readDbBlob(row.avatar_path)
    res.set('Content-Type', mimeType)
    res.send(data)
    return
  }
  const filePath = localFilePath(row.avatar_path)
  if (!existsSync(filePath)) {
    res.status(404).json({ error: 'file_missing' })
    return
  }
  res.sendFile(filePath)
})

// POST /api/users/invite — adds a new real user directly into the inviter's org (not
// domain-matched like /auth/signup — this is a deliberate invite, so it works regardless of
// the invitee's email domain, e.g. an external contractor). There's no email-sending
// infrastructure in this demo, so instead of a real invite-link email, the generated
// temporary password is returned directly in the response for the inviter to share manually.
usersRouter.post('/invite', requireAdmin, async (req, res) => {
  const orgId = req.user!.org_id
  const { email, name } = req.body as { email?: string; name?: string }
  if (!email || !name) {
    res.status(400).json({ error: 'email and name are required' })
    return
  }
  const existing = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0]
  if (existing) {
    res.status(409).json({ error: 'An account with that email already exists' })
    return
  }
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  const temporaryPassword = randomBytes(6).toString('base64url')
  const passwordHash = bcrypt.hashSync(temporaryPassword, 10)
  const id = randomUUID()
  await pool.query(
    'INSERT INTO users (id, org_id, email, password_hash, name, initials) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, orgId, email, passwordHash, name, initials],
  )
  res.status(201).json({ id, email, name, initials, temporaryPassword })
})
