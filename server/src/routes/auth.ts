import { Router } from 'express'
import { randomUUID, randomBytes } from 'node:crypto'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import multer from 'multer'
import { pool } from '../db.ts'
import {
  createSession,
  destroySession,
  requireAuth,
  SESSION_COOKIE,
  toAuthedUser,
  USER_SELECT_COLUMNS,
  type AuthedUserRow,
} from '../auth.ts'
import { deleteFile, saveFile } from '../storage.ts'

export const authRouter = Router()

// Read lazily at request time, not into a top-level const — same ESM-import-hoisting reason as
// googleLoginConfig() below. Unset (the default) means unrestricted, matching this app's usual
// "optional config degrades to off, not to an error" pattern (Zoom/Google integrations, Neo4j).
// Set once here and reused by both account-creation paths below, so a new signup domain
// restriction can never accidentally cover one path but not the other.
function isAllowedSignupDomain(domain: string): boolean {
  const allowed = process.env.ALLOWED_SIGNUP_DOMAIN
  return !allowed || domain.toLowerCase() === allowed.toLowerCase()
}

async function getAuthedUserRow(userId: string): Promise<AuthedUserRow> {
  const { rows } = await pool.query(
    `SELECT ${USER_SELECT_COLUMNS} FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = $1`,
    [userId],
  )
  return rows[0] as AuthedUserRow
}

// Memory storage, not diskStorage — the buffer goes to storage.ts's saveFile(), which picks
// local disk or Vercel Blob depending on what's configured (see storage.ts). fileFilter silently
// drops non-image files (checked via req.file below) rather than erroring through multer's own
// error path — simpler for a demo-scale upload.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB — a profile photo, not a recording
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
})

// Production (Vercel, or any real deploy) needs sameSite:'none' + secure:true, not just
// secure:true alone — frontend and backend will very likely be on different *.vercel.app
// subdomains, which count as genuinely different "sites" for cookie purposes (vercel.app is on
// the public suffix list, same as github.io), and SameSite=Lax blocks a cookie from being sent
// on cross-site fetch/XHR calls (it only allows top-level navigations through). Without this,
// login would appear to succeed but every subsequent API call would look logged out — the
// cookie silently never leaves the browser. Local dev is unaffected: localhost:5173 and
// localhost:4000 are different origins but the *same site* (site = scheme + registrable domain,
// port doesn't count), so sameSite:'lax' has always worked there and keeps working.
const isProduction = process.env.NODE_ENV === 'production'
const cookieOpts = {
  httpOnly: true,
  sameSite: isProduction ? ('none' as const) : ('lax' as const),
  secure: isProduction,
  maxAge: 30 * 24 * 60 * 60 * 1000,
}

authRouter.post('/signup', async (req, res) => {
  const { email, password, name, orgDomain } = req.body as {
    email?: string
    password?: string
    name?: string
    orgDomain?: string
  }
  if (!email || !password || !name) {
    res.status(400).json({ error: 'email, password, and name are required' })
    return
  }

  const existing = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0]
  if (existing) {
    res.status(409).json({ error: 'An account with that email already exists' })
    return
  }

  const domain = orgDomain || email.split('@')[1] || 'unknown'
  if (!isAllowedSignupDomain(domain)) {
    res.status(403).json({ error: `Sign-up is restricted to @${process.env.ALLOWED_SIGNUP_DOMAIN} accounts.` })
    return
  }
  let org = (await pool.query('SELECT id FROM organizations WHERE domain = $1', [domain])).rows[0] as
    | { id: string }
    | undefined
  // Whoever creates the org becomes its admin — the only person who could reasonably start out
  // with that role, since nobody else exists in the org yet to have granted it. Anyone signing
  // up into an org that already exists joins as a regular member.
  const isNewOrg = !org
  if (!org) {
    const orgId = randomUUID()
    await pool.query('INSERT INTO organizations (id, name, domain) VALUES ($1, $2, $3)', [orgId, domain, domain])
    org = { id: orgId }
  }

  const userId = randomUUID()
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  const passwordHash = bcrypt.hashSync(password, 10)
  const role = isNewOrg ? 'admin' : 'member'
  await pool.query(
    'INSERT INTO users (id, org_id, email, password_hash, name, initials, role) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [userId, org.id, email, passwordHash, name, initials, role],
  )

  const { token, expiresAt } = await createSession(userId)
  res.cookie(SESSION_COOKIE, token, cookieOpts)
  res.status(201).json({ id: userId, email, name, initials, orgId: org.id, expiresAt })
})

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string }
  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' })
    return
  }

  const user = (
    await pool.query(
      'SELECT id, org_id, email, name, initials, password_hash, disabled_at FROM users WHERE email = $1',
      [email],
    )
  ).rows[0] as
    | {
        id: string
        org_id: string
        email: string
        name: string
        initials: string
        password_hash: string
        disabled_at: string | null
      }
    | undefined

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid email or password' })
    return
  }
  if (user.disabled_at) {
    res.status(403).json({ error: 'This account has been deactivated.' })
    return
  }

  const { token } = await createSession(user.id)
  res.cookie(SESSION_COOKIE, token, cookieOpts)
  res.json({ id: user.id, email: user.email, name: user.name, initials: user.initials, orgId: user.org_id })
})

authRouter.post('/logout', async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE]
  if (token) await destroySession(token)
  res.clearCookie(SESSION_COOKIE)
  res.status(204).end()
})

// --- "Continue with Google" / "Continue with SSO" (both routes here — SSO reuses the same
// Google OAuth flow rather than pointing at a separate identity provider, since there's no
// specific enterprise IdP configured for this app). Distinct from integrations.ts's Google
// Calendar/Gmail OAuth: those authorize a per-user *data sync* for an already-logged-in user
// (state carries userId/orgId); this authenticates the login itself, so there's no user yet —
// state here is a bare CSRF nonce, and success creates a session the same way /login does.

// Read lazily at request time, not into top-level consts — same ESM-import-hoisting reason
// documented in integrations.ts's config(): index.ts's process.loadEnvFile() runs after every
// static import (including this file) has already evaluated its top-level code.
function googleLoginConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    redirectUri: process.env.GOOGLE_LOGIN_REDIRECT_URI ?? 'http://localhost:4000/api/auth/google/callback',
    frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  }
}

// Backed by the oauth_states table (db.ts), not memory — the "start" and "callback" legs of
// this redirect are separate HTTP requests, and nothing guarantees they land on the same
// serverless instance. No userId/orgId to carry (nobody's logged in yet); this is purely an
// anti-CSRF nonce proving the callback is completing a flow this server actually started.
const LOGIN_STATE_TTL_MS = 5 * 60_000

async function createLoginState(): Promise<string> {
  const state = randomBytes(16).toString('hex')
  await pool.query('INSERT INTO oauth_states (id, expires_at) VALUES ($1, $2)', [
    state,
    new Date(Date.now() + LOGIN_STATE_TTL_MS),
  ])
  return state
}

async function consumeLoginState(state: string): Promise<boolean> {
  const { rows } = await pool.query('DELETE FROM oauth_states WHERE id = $1 AND expires_at > now() RETURNING id', [
    state,
  ])
  return rows.length > 0
}

authRouter.get('/google', async (_req, res) => {
  const c = googleLoginConfig()
  if (!c.clientId || !c.clientSecret) {
    res.status(503).json({ error: 'Google sign-in is not configured on this server.' })
    return
  }
  const state = await createLoginState()
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', c.clientId)
  url.searchParams.set('redirect_uri', c.redirectUri)
  // openid+email+profile only — this is authentication, not a data-access grant, so it asks
  // for identity, not Calendar/Gmail scopes the way integrations.ts's Google flows do.
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  res.redirect(url.toString())
})

authRouter.get('/google/callback', async (req, res) => {
  const c = googleLoginConfig()
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string }
  if (error || !code || !state || !(await consumeLoginState(state))) {
    console.error('Google login callback rejected', { hasError: !!error, error, hasCode: !!code, hasState: !!state })
    res.redirect(`${c.frontendUrl}/?error=google_auth_failed`)
    return
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: c.redirectUri,
        client_id: c.clientId,
        client_secret: c.clientSecret,
      }),
    })
    if (!tokenRes.ok) throw new Error(`Google token exchange failed: ${tokenRes.status}`)
    const tokens = (await tokenRes.json()) as { access_token: string }

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (!profileRes.ok) throw new Error(`Google userinfo fetch failed: ${profileRes.status}`)
    const profile = (await profileRes.json()) as {
      email?: string
      email_verified?: boolean
      name?: string
    }
    if (!profile.email || !profile.email_verified) {
      throw new Error('Google account has no verified email')
    }

    const existing = (
      await pool.query(
        'SELECT id, disabled_at FROM users WHERE email = $1',
        [profile.email],
      )
    ).rows[0] as { id: string; disabled_at: string | null } | undefined

    if (existing?.disabled_at) {
      res.redirect(`${c.frontendUrl}/?error=account_disabled`)
      return
    }

    let userId: string
    if (existing) {
      userId = existing.id
    } else {
      // Same find-or-create-org-by-domain, auto-create-account logic as /signup — a Google
      // sign-in with no matching account is treated as a first-time signup, not rejected. The
      // account gets no usable password (real bcrypt hash of a random value, same pattern as
      // integrations.ts's auto-created Gmail-summary assignee accounts) — this user can only
      // ever log in via Google going forward, not via the email/password form.
      const domain = profile.email.split('@')[1] ?? 'unknown'
      if (!isAllowedSignupDomain(domain)) {
        res.redirect(`${c.frontendUrl}/?error=domain_not_allowed`)
        return
      }
      let org = (await pool.query('SELECT id FROM organizations WHERE domain = $1', [domain])).rows[0] as
        | { id: string }
        | undefined
      const isNewOrg = !org
      if (!org) {
        const orgId = randomUUID()
        await pool.query('INSERT INTO organizations (id, name, domain) VALUES ($1, $2, $3)', [orgId, domain, domain])
        org = { id: orgId }
      }
      const name = profile.name?.trim() || profile.email.split('@')[0]
      const initials = name
        .split(' ')
        .filter(Boolean)
        .map((p) => p[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
      const passwordHash = bcrypt.hashSync(randomBytes(16).toString('base64url'), 10)

      // A placeholder account (integrations.ts's findOrCreateAssigneeByFirstName — auto-created
      // by name matching during Gmail sync, no real email) may already exist for this exact
      // person, holding real task/notification/leave-balance history. The name a meeting summary
      // uses for someone isn't reliably their first name — "Mohammed Salim" was extracted as
      // "Salim" (observed live: his placeholder was created as "Salim", but his Google profile's
      // first word is "Mohammed", so matching only the first word missed it and created a
      // duplicate). Checking both the first and last word of the Google profile name against
      // placeholder names covers that case without widening the match to anything fuzzier. If
      // exactly one placeholder in this org matches either token, promote it in place — same id,
      // so everything already attributed to that name becomes correctly theirs with no
      // reassignment step. Ambiguous (0 or 2+ matches, including the same placeholder matching via
      // both tokens) falls back to a normal new account, since guessing wrong would silently hand
      // someone else's task history to a stranger.
      const nameParts = name.split(' ').filter(Boolean)
      const nameTokens = [...new Set([nameParts[0], nameParts[nameParts.length - 1]].filter(Boolean))]
      const placeholderMatches = nameTokens.length
        ? ((
            await pool.query(
              `SELECT DISTINCT id FROM users WHERE org_id = $1 AND email LIKE '%@placeholder.internal' AND name ILIKE ANY($2)`,
              [org.id, nameTokens],
            )
          ).rows as { id: string }[])
        : []

      if (placeholderMatches.length === 1) {
        userId = placeholderMatches[0].id
        await pool.query('UPDATE users SET email = $1, name = $2, initials = $3, password_hash = $4 WHERE id = $5', [
          profile.email,
          name,
          initials,
          passwordHash,
          userId,
        ])
      } else {
        const role = isNewOrg ? 'admin' : 'member'
        userId = randomUUID()
        await pool.query(
          'INSERT INTO users (id, org_id, email, password_hash, name, initials, role) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [userId, org.id, profile.email, passwordHash, name, initials, role],
        )
      }
    }

    const { token } = await createSession(userId)
    res.cookie(SESSION_COOKIE, token, cookieOpts)
    res.redirect(`${c.frontendUrl}/app/dashboard`)
  } catch (err) {
    console.error('Google login callback failed', err)
    res.redirect(`${c.frontendUrl}/?error=google_auth_failed`)
  }
})

authRouter.get('/me', requireAuth, (req, res) => {
  res.json(req.user)
})

authRouter.patch('/me', requireAuth, async (req, res) => {
  const { name, currentPassword, newPassword, designation, department, employeeId } = req.body as {
    name?: string
    currentPassword?: string
    newPassword?: string
    designation?: string
    department?: string
    employeeId?: string
  }

  if (
    name === undefined &&
    newPassword === undefined &&
    designation === undefined &&
    department === undefined &&
    employeeId === undefined
  ) {
    res.status(400).json({ error: 'Nothing to update' })
    return
  }

  let trimmedName: string | undefined
  if (name !== undefined) {
    trimmedName = name.trim()
    if (!trimmedName) {
      res.status(400).json({ error: 'Name cannot be empty' })
      return
    }
  }

  // Validate both fields before writing either, so a bad password doesn't leave the name
  // half-updated (no real transaction here, just ordering — same pattern the rest of this
  // codebase uses for multi-field PATCHes, see meetings.ts).
  if (newPassword !== undefined) {
    if (!currentPassword) {
      res.status(400).json({ error: 'Current password is required to set a new one' })
      return
    }
    if (newPassword.length < 6) {
      res.status(400).json({ error: 'New password must be at least 6 characters' })
      return
    }
    const row = (await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user!.id])).rows[0] as {
      password_hash: string
    }
    if (!bcrypt.compareSync(currentPassword, row.password_hash)) {
      res.status(401).json({ error: 'Current password is incorrect' })
      return
    }
  }

  if (trimmedName !== undefined) {
    // Same first-letter-of-each-word convention as signup, above.
    const initials = trimmedName
      .split(' ')
      .filter(Boolean)
      .map((p) => p[0])
      .join('')
      .slice(0, 2)
      .toUpperCase()
    await pool.query('UPDATE users SET name = $1, initials = $2 WHERE id = $3', [
      trimmedName,
      initials,
      req.user!.id,
    ])
  }
  if (newPassword !== undefined) {
    const passwordHash = bcrypt.hashSync(newPassword, 10)
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, req.user!.id])
  }
  // designation/department/employeeId are free-text HR fields, not identity-bearing like
  // name/password — no validation beyond trimming, blank is a valid "not set yet" value.
  if (designation !== undefined) {
    await pool.query('UPDATE users SET designation = $1 WHERE id = $2', [designation.trim(), req.user!.id])
  }
  if (department !== undefined) {
    await pool.query('UPDATE users SET department = $1 WHERE id = $2', [department.trim(), req.user!.id])
  }
  if (employeeId !== undefined) {
    await pool.query('UPDATE users SET employee_id = $1 WHERE id = $2', [employeeId.trim(), req.user!.id])
  }

  res.json(toAuthedUser(await getAuthedUserRow(req.user!.id)))
})

// --- Profile picture (avatar) ---

authRouter.post('/me/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'An image file (jpg/png/webp) is required' })
    return
  }
  const prior = (await pool.query('SELECT avatar_path FROM users WHERE id = $1', [req.user!.id])).rows[0] as
    | { avatar_path: string | null }
    | undefined
  const storedPath = await saveFile(
    req.file.buffer,
    path.join('avatars', req.user!.id),
    `${randomUUID()}-${req.file.originalname}`,
    req.file.mimetype,
  )
  await pool.query('UPDATE users SET avatar_path = $1 WHERE id = $2', [storedPath, req.user!.id])
  if (prior?.avatar_path) await deleteFile(prior.avatar_path)
  res.json(toAuthedUser(await getAuthedUserRow(req.user!.id)))
})

authRouter.delete('/me/avatar', requireAuth, async (req, res) => {
  const prior = (await pool.query('SELECT avatar_path FROM users WHERE id = $1', [req.user!.id])).rows[0] as
    | { avatar_path: string | null }
    | undefined
  if (prior?.avatar_path) await deleteFile(prior.avatar_path)
  await pool.query('UPDATE users SET avatar_path = NULL WHERE id = $1', [req.user!.id])
  res.json(toAuthedUser(await getAuthedUserRow(req.user!.id)))
})
