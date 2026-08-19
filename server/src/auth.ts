import { randomUUID } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import { pool } from './db.ts'

export const SESSION_COOKIE = 'record_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface AuthedUser {
  id: string
  org_id: string
  org_name: string
  email: string
  name: string
  initials: string
  role: 'admin' | 'member'
  designation: string
  department: string
  employee_id: string
  avatar_url: string | null
}

// Row shape shared by every query that needs a full AuthedUser (session lookup, PATCH /me,
// avatar upload/remove) — avatar_path is the raw storage path, never sent to the client
// directly; toAuthedUser() turns it into a servable URL instead.
export interface AuthedUserRow {
  id: string
  org_id: string
  org_name: string
  email: string
  name: string
  initials: string
  role: 'admin' | 'member'
  designation: string
  department: string
  employee_id: string
  avatar_path: string | null
}

export const USER_SELECT_COLUMNS =
  'u.id, u.org_id, o.name AS org_name, u.email, u.name, u.initials, u.role, u.designation, u.department, u.employee_id, u.avatar_path'

export function toAuthedUser(row: AuthedUserRow): AuthedUser {
  const { avatar_path, ...rest } = row
  // Path only, no '/api' prefix — API_BASE_URL on the frontend already includes it (same
  // convention as every other ${API_BASE_URL}/<path> usage in this app, e.g. asset downloads).
  return { ...rest, avatar_url: avatar_path ? `/users/${rest.id}/avatar` : null }
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: string }> {
  const token = randomUUID()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  await pool.query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [token, userId, expiresAt])
  return { token, expiresAt }
}

export async function destroySession(token: string) {
  await pool.query('DELETE FROM sessions WHERE id = $1', [token])
}

export async function getUserForToken(token: string): Promise<AuthedUser | null> {
  const { rows } = await pool.query(
    `SELECT ${USER_SELECT_COLUMNS}
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN organizations o ON o.id = u.org_id
     WHERE s.id = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [token],
  )
  const row = rows[0] as AuthedUserRow | undefined
  return row ? toAuthedUser(row) : null
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE]
  const user = token ? await getUserForToken(token) : null
  if (!user) {
    res.status(401).json({ error: 'not_authenticated' })
    return
  }
  req.user = user
  next()
}

// Chain after requireAuth. First real role check in this app — everything before this was
// scoped to "the person a thing belongs to" (task assignee, etc.), not a role, since nothing
// prior was org-wide-but-nobody's. A company holiday list is (see holidays.ts).
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user!.role !== 'admin') {
    res.status(403).json({ error: 'admin_required', message: 'Only an admin can do that.' })
    return
  }
  next()
}
