import { Router } from 'express'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import { pool } from '../db.ts'
import { requireAuth } from '../auth.ts'
import { notify } from '../notifications.ts'
import {
  attendMeeting,
  linkDocumentToMeeting,
  linkTaskToProject,
  recordActivity,
  recordProjectInvolvement,
  recordTaskAssignment,
  upsertDocument,
  upsertMeeting,
  upsertTask,
} from '../graph.ts'
import { UPLOADS_ROOT } from '../uploadsPath.ts'

export const integrationsRouter = Router()
// requireAuth is applied per-route below, NOT globally — /zoom/callback and /google/callback
// are hit by a redirect FROM Zoom/Google, which may land on a different domain than the one
// the session cookie was set on (e.g. an ngrok/ssh tunnel used for local OAuth testing, where
// the app itself is served from localhost but the callback is reached via the tunnel's own
// domain). Those two routes authenticate via the `state` param (createState/consumeState)
// instead, which is what OAuth `state` exists for in the first place.

type Provider = 'zoom' | 'google' | 'gmail'

// Read lazily (at request time), not into top-level consts — index.ts loads .env via
// process.loadEnvFile() in its own top-level code, but ESM evaluates every static import
// (including this file) before that runs. Top-level consts here would permanently capture
// empty strings; reading process.env inside functions means it's read after .env is loaded.
function config() {
  return {
    zoomClientId: process.env.ZOOM_CLIENT_ID ?? '',
    zoomClientSecret: process.env.ZOOM_CLIENT_SECRET ?? '',
    zoomRedirectUri: process.env.ZOOM_REDIRECT_URI ?? 'http://localhost:4000/api/integrations/zoom/callback',
    // Gmail reuses the same Google Cloud OAuth app/credentials as Calendar — just a different
    // scope and a separate connect/callback pair, so a user can grant one without the other.
    googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    googleRedirectUri: process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:4000/api/integrations/google/callback',
    gmailRedirectUri: process.env.GMAIL_REDIRECT_URI ?? 'http://localhost:4000/api/integrations/gmail/callback',
    frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  }
}

function isConfigured(provider: Provider): boolean {
  const c = config()
  return provider === 'zoom' ? !!c.zoomClientId && !!c.zoomClientSecret : !!c.googleClientId && !!c.googleClientSecret
}

// CSRF state for the OAuth redirect round trip. Short-lived and in-memory — this is a
// single-process demo backend, so there's no need for a shared/persistent store.
const pendingStates = new Map<string, { userId: string; orgId: string; provider: Provider; expiresAt: number }>()

function createState(userId: string, orgId: string, provider: Provider): string {
  const state = randomBytes(16).toString('hex')
  pendingStates.set(state, { userId, orgId, provider, expiresAt: Date.now() + 5 * 60_000 })
  return state
}

function consumeState(state: string, provider: Provider) {
  const entry = pendingStates.get(state)
  pendingStates.delete(state)
  if (!entry || entry.provider !== provider || entry.expiresAt < Date.now()) return null
  return entry
}

interface ConnectionRow {
  provider: string
  connected_at: string
  sync_query: string
}

async function upsertConnection(
  orgId: string,
  userId: string,
  provider: Provider,
  accessToken: string,
  refreshToken: string,
  expiresInSec: number,
) {
  const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString()
  const existing = (
    await pool.query('SELECT id FROM oauth_connections WHERE user_id = $1 AND provider = $2', [userId, provider])
  ).rows[0] as { id: string } | undefined
  if (existing) {
    await pool.query(
      'UPDATE oauth_connections SET access_token = $1, refresh_token = $2, expires_at = $3, connected_at = $4 WHERE id = $5',
      [accessToken, refreshToken, expiresAt, new Date().toISOString(), existing.id],
    )
  } else {
    await pool.query(
      `INSERT INTO oauth_connections (id, org_id, user_id, provider, access_token, refresh_token, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), orgId, userId, provider, accessToken, refreshToken, expiresAt],
    )
  }
}

// GET /api/integrations — connection status per provider, plus whether this server even
// has OAuth app credentials configured (so the frontend can show "not configured" instead
// of a broken "Connect" button when ZOOM_CLIENT_ID/GOOGLE_CLIENT_ID are unset).
integrationsRouter.get('/', requireAuth, async (req, res) => {
  const rows = (
    await pool.query('SELECT provider, connected_at, sync_query FROM oauth_connections WHERE user_id = $1', [
      req.user!.id,
    ])
  ).rows as ConnectionRow[]
  const connected: Record<string, ConnectionRow> = {}
  for (const r of rows) connected[r.provider] = r

  res.json({
    zoom: { configured: isConfigured('zoom'), connected: !!connected.zoom, connectedAt: connected.zoom?.connected_at ?? null },
    google: { configured: isConfigured('google'), connected: !!connected.google, connectedAt: connected.google?.connected_at ?? null },
    gmail: {
      configured: isConfigured('gmail'),
      connected: !!connected.gmail,
      connectedAt: connected.gmail?.connected_at ?? null,
      query: connected.gmail?.sync_query ?? '',
    },
  })
})

integrationsRouter.get('/zoom/connect', requireAuth, (req, res) => {
  if (!isConfigured('zoom')) {
    res.status(503).json({ error: 'Zoom integration is not configured on this server.' })
    return
  }
  const c = config()
  const state = createState(req.user!.id, req.user!.org_id, 'zoom')
  const url = new URL('https://zoom.us/oauth/authorize')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', c.zoomClientId)
  url.searchParams.set('redirect_uri', c.zoomRedirectUri)
  url.searchParams.set('state', state)
  res.redirect(url.toString())
})

integrationsRouter.get('/zoom/callback', async (req, res) => {
  const c = config()
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string }
  const entry = state ? consumeState(state, 'zoom') : null
  if (error || !code || !entry) {
    // Logged (not silent) — a bare redirect here used to swallow the reason, making this
    // exact failure mode (state map wiped by a backend restart between /connect and
    // /callback, e.g. while switching tunnel URLs during local dev) impossible to diagnose.
    console.error('Zoom OAuth callback rejected', {
      hasError: !!error,
      error,
      hasCode: !!code,
      hasState: !!state,
      stateMatched: !!entry,
    })
    res.redirect(`${c.frontendUrl}/app/meetings?integration=zoom&status=error`)
    return
  }
  try {
    const tokenRes = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${c.zoomClientId}:${c.zoomClientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: c.zoomRedirectUri }),
    })
    if (!tokenRes.ok) {
      const bodyText = await tokenRes.text().catch(() => '')
      console.error('Zoom token exchange failed', tokenRes.status, bodyText)
      throw new Error(`Zoom token exchange failed: ${tokenRes.status}`)
    }
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in: number }
    await upsertConnection(entry.orgId, entry.userId, 'zoom', tokens.access_token, tokens.refresh_token, tokens.expires_in)
    res.redirect(`${c.frontendUrl}/app/meetings?integration=zoom&status=connected`)
  } catch (err) {
    console.error('Zoom OAuth callback failed', err)
    res.redirect(`${c.frontendUrl}/app/meetings?integration=zoom&status=error`)
  }
})

integrationsRouter.get('/google/connect', requireAuth, (req, res) => {
  if (!isConfigured('google')) {
    res.status(503).json({ error: 'Google integration is not configured on this server.' })
    return
  }
  const c = config()
  const state = createState(req.user!.id, req.user!.org_id, 'google')
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', c.googleClientId)
  url.searchParams.set('redirect_uri', c.googleRedirectUri)
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar.readonly')
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', state)
  res.redirect(url.toString())
})

integrationsRouter.get('/google/callback', async (req, res) => {
  const c = config()
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string }
  const entry = state ? consumeState(state, 'google') : null
  if (error || !code || !entry) {
    res.redirect(`${c.frontendUrl}/app/meetings?integration=google&status=error`)
    return
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: c.googleRedirectUri,
        client_id: c.googleClientId,
        client_secret: c.googleClientSecret,
      }),
    })
    if (!tokenRes.ok) throw new Error(`Google token exchange failed: ${tokenRes.status}`)
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token?: string; expires_in: number }
    // Google only returns refresh_token on the FIRST consent (access_type=offline, prompt=consent
    // forces this every time, but if it's ever missing, fall back to the existing stored one).
    const existing = (
      await pool.query('SELECT refresh_token FROM oauth_connections WHERE user_id = $1 AND provider = $2', [
        entry.userId,
        'google',
      ])
    ).rows[0] as { refresh_token: string } | undefined
    const refreshToken = tokens.refresh_token ?? existing?.refresh_token ?? ''
    await upsertConnection(entry.orgId, entry.userId, 'google', tokens.access_token, refreshToken, tokens.expires_in)
    res.redirect(`${c.frontendUrl}/app/meetings?integration=google&status=connected`)
  } catch (err) {
    console.error('Google OAuth callback failed', err)
    res.redirect(`${c.frontendUrl}/app/meetings?integration=google&status=error`)
  }
})

integrationsRouter.delete('/:provider', requireAuth, async (req, res) => {
  const provider = req.params.provider
  if (provider !== 'zoom' && provider !== 'google' && provider !== 'gmail') {
    res.status(400).json({ error: 'invalid provider' })
    return
  }
  await pool.query('DELETE FROM oauth_connections WHERE user_id = $1 AND provider = $2', [req.user!.id, provider])
  res.status(204).end()
})

integrationsRouter.get('/gmail/connect', requireAuth, (req, res) => {
  if (!isConfigured('gmail')) {
    res.status(503).json({ error: 'Gmail integration is not configured on this server.' })
    return
  }
  const c = config()
  const state = createState(req.user!.id, req.user!.org_id, 'gmail')
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', c.googleClientId)
  url.searchParams.set('redirect_uri', c.gmailRedirectUri)
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.readonly')
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', state)
  res.redirect(url.toString())
})

integrationsRouter.get('/gmail/callback', async (req, res) => {
  const c = config()
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string }
  const entry = state ? consumeState(state, 'gmail') : null
  if (error || !code || !entry) {
    console.error('Gmail OAuth callback rejected', { hasError: !!error, error, hasCode: !!code, hasState: !!state, stateMatched: !!entry })
    res.redirect(`${c.frontendUrl}/app/knowledge?integration=gmail&status=error`)
    return
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: c.gmailRedirectUri,
        client_id: c.googleClientId,
        client_secret: c.googleClientSecret,
      }),
    })
    if (!tokenRes.ok) {
      const bodyText = await tokenRes.text().catch(() => '')
      console.error('Gmail token exchange failed', tokenRes.status, bodyText)
      throw new Error(`Gmail token exchange failed: ${tokenRes.status}`)
    }
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token?: string; expires_in: number }
    const existing = (
      await pool.query("SELECT refresh_token FROM oauth_connections WHERE user_id = $1 AND provider = 'gmail'", [
        entry.userId,
      ])
    ).rows[0] as { refresh_token: string } | undefined
    const refreshToken = tokens.refresh_token ?? existing?.refresh_token ?? ''
    await upsertConnection(entry.orgId, entry.userId, 'gmail', tokens.access_token, refreshToken, tokens.expires_in)
    res.redirect(`${c.frontendUrl}/app/knowledge?integration=gmail&status=connected`)
  } catch (err) {
    console.error('Gmail OAuth callback failed', err)
    res.redirect(`${c.frontendUrl}/app/knowledge?integration=gmail&status=error`)
  }
})

// PUT /api/integrations/gmail/query — sets the Gmail search query that scopes what gets
// imported. Required before /gmail/sync will do anything — an inbox has no natural bounds
// the way a calendar does, so unlike meetings/recordings there's no reasonable "sync
// everything" default here. Reuses Gmail's own search syntax (e.g. "label:clients",
// "from:*@acme.com") rather than inventing separate filter UI.
integrationsRouter.put('/gmail/query', requireAuth, async (req, res) => {
  const { query } = req.body as { query?: string }
  const existing = (
    await pool.query("SELECT id FROM oauth_connections WHERE user_id = $1 AND provider = 'gmail'", [req.user!.id])
  ).rows[0] as { id: string } | undefined
  if (!existing) {
    res.status(400).json({ error: 'not_connected', message: 'Connect Gmail before setting a sync query.' })
    return
  }
  await pool.query('UPDATE oauth_connections SET sync_query = $1 WHERE id = $2', [query ?? '', existing.id])
  res.status(204).end()
})

interface ExternalMeeting {
  externalId: string
  title: string
  summary: string
  participantEmails: string[]
  scheduledAt: string
  durationMin: number
}

interface ZoomMeetingDetail {
  agenda: string
  inviteeEmails: string[]
}

// Zoom's meeting-LIST endpoint (below) doesn't include the agenda/description or invitees —
// only the single-meeting detail endpoint does. One extra request per meeting; failures are
// swallowed (fall back to empty) so one bad lookup doesn't fail the whole sync.
async function fetchZoomMeetingDetail(accessToken: string, meetingId: string): Promise<ZoomMeetingDetail> {
  try {
    const res = await fetch(`https://api.zoom.us/v2/meetings/${meetingId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return { agenda: '', inviteeEmails: [] }
    const data = (await res.json()) as {
      agenda?: string
      settings?: { meeting_invitees?: { email: string }[] }
    }
    return { agenda: data.agenda ?? '', inviteeEmails: (data.settings?.meeting_invitees ?? []).map((i) => i.email) }
  } catch {
    return { agenda: '', inviteeEmails: [] }
  }
}

async function fetchZoomMeetings(accessToken: string): Promise<ExternalMeeting[]> {
  const res = await fetch('https://api.zoom.us/v2/users/me/meetings?type=scheduled&page_size=50', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Zoom API error: ${res.status}`)
  const data = (await res.json()) as {
    meetings: { id: number; topic: string; start_time: string; duration: number }[]
  }
  return Promise.all(
    data.meetings.map(async (m) => {
      const detail = await fetchZoomMeetingDetail(accessToken, String(m.id))
      return {
        externalId: String(m.id),
        title: m.topic,
        summary: detail.agenda,
        participantEmails: detail.inviteeEmails,
        scheduledAt: m.start_time,
        durationMin: m.duration,
      }
    }),
  )
}

async function fetchGoogleMeetings(accessToken: string): Promise<ExternalMeeting[]> {
  const timeMin = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
  url.searchParams.set('timeMin', timeMin)
  url.searchParams.set('maxResults', '50')
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('orderBy', 'startTime')
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`Google Calendar API error: ${res.status}`)
  const data = (await res.json()) as {
    items: {
      id: string
      summary?: string
      description?: string
      hangoutLink?: string
      conferenceData?: { conferenceSolution?: { name?: string } }
      start?: { dateTime?: string; date?: string }
      end?: { dateTime?: string; date?: string }
      attendees?: { email: string }[]
    }[]
  }
  return data.items
    .filter((e) => e.hangoutLink || e.conferenceData?.conferenceSolution?.name === 'Google Meet')
    .map((e) => {
      const startIso = e.start?.dateTime ?? e.start?.date ?? new Date().toISOString()
      const endIso = e.end?.dateTime ?? e.end?.date
      const durationMin = endIso ? Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000) : 30
      return {
        externalId: e.id,
        title: e.summary ?? '(untitled meeting)',
        // Google's event list response already includes the description and attendees —
        // unlike Zoom, no extra per-meeting request is needed to get either.
        summary: e.description ?? '',
        participantEmails: (e.attendees ?? []).map((a) => a.email),
        scheduledAt: startIso,
        durationMin: durationMin > 0 ? durationMin : 30,
      }
    })
}

interface GmailMessage {
  externalId: string
  subject: string
  from: string
  bodyText: string
  date: string // ISO
}

interface GmailPart {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailPart[]
}

function decodeGmailBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
}

// Gmail's plain-text MIME alternative renders every HTML hyperlink as its anchor text
// followed by a line that's just "<the raw href>" — a generic plain-text-email convention,
// not specific to any one sender. Those link-only lines aren't readable content (a bare
// tracking URL says nothing on its own); they're markup noise left over from HTML-to-text
// conversion, so strip any line that, once trimmed, is nothing but a bracketed URL.
const LINK_ONLY_LINE_RE = /^<https?:\/\/\S+>$/

function stripLinkOnlyLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !LINK_ONLY_LINE_RE.test(line.trim()))
    .join('\n')
    .replace(/(\r?\n){3,}/g, '\n\n')
}

// Gmail bodies are base64url-encoded and may be split across nested `parts` (multipart
// messages — HTML + plain-text alternatives, inline images, etc.). Recurses depth-first and
// returns the first text/plain part found; falls back to '' if the message is HTML-only.
function extractGmailPlainText(payload: GmailPart): string {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return stripLinkOnlyLines(decodeGmailBase64Url(payload.body.data))
  }
  for (const part of payload.parts ?? []) {
    const text = extractGmailPlainText(part)
    if (text) return text
  }
  return ''
}

// Unlike meetings (bounded by a calendar) or recordings (bounded by "meetings that happened"),
// a Gmail inbox has no natural limit — `query` is mandatory and reuses Gmail's own search
// syntax (e.g. "label:clients", "from:*@acme.com") so scope is the user's explicit choice,
// not "sync everything."
async function fetchGmailMessages(accessToken: string, query: string): Promise<GmailMessage[]> {
  const listUrl = new URL('https://www.googleapis.com/gmail/v1/users/me/messages')
  listUrl.searchParams.set('q', query)
  listUrl.searchParams.set('maxResults', '25')
  const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!listRes.ok) throw new Error(`Gmail API error: ${listRes.status}`)
  const listData = (await listRes.json()) as { messages?: { id: string }[] }
  const stubs = listData.messages ?? []

  const messages: GmailMessage[] = []
  for (const stub of stubs) {
    const res = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${stub.id}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) continue
    const data = (await res.json()) as { payload: GmailPart & { headers?: { name: string; value: string }[] }; internalDate: string }
    const headers = data.payload.headers ?? []
    const subject = headers.find((h) => h.name === 'Subject')?.value ?? '(no subject)'
    const from = headers.find((h) => h.name === 'From')?.value ?? ''
    messages.push({
      externalId: stub.id,
      subject,
      from,
      bodyText: extractGmailPlainText(data.payload),
      date: new Date(Number(data.internalDate)).toISOString(),
    })
  }
  return messages
}

// 500 chars made sense while this was purely a search-index preview; now that Knowledge Base
// has a real detail view (KnowledgeDetailPage.tsx) that actually renders it for reading, this
// is effectively "how much of the email body we keep," not just a snippet — bumped up so most
// real emails aren't cut off mid-sentence. Still capped, not unlimited, to avoid one pathological
// huge message ballooning the row.
const EMAIL_EXCERPT_MAX_CHARS = 8000

// Upserts into knowledge_documents (type='email'), reusing the exact same table Knowledge
// Base's manually-created SOPs/decisions/FAQs use — search, view_count, and project-linking
// all work on synced emails for free. Dedup is by external_id (Gmail message id), same
// check-before-insert pattern as the Zoom recording sync.
async function upsertGmailMessage(orgId: string, userId: string, m: GmailMessage): Promise<string> {
  const existing = (
    await pool.query('SELECT id FROM knowledge_documents WHERE org_id = $1 AND external_id = $2', [
      orgId,
      m.externalId,
    ])
  ).rows[0] as { id: string } | undefined
  const excerpt = m.bodyText.slice(0, EMAIL_EXCERPT_MAX_CHARS)
  if (existing) {
    // updated_at is set to the EMAIL's own date (m.date), not "now" — an email is immutable
    // once sent, so re-syncing the same message isn't a real content update at sync time, just
    // a re-fetch of unchanged content. Using new Date() here (a bug, now fixed) stamped every
    // re-synced email with the sync's execution time, clustering everything at "just now" and
    // destroying the real chronological order "Recently updated" is supposed to reflect.
    await pool.query('UPDATE knowledge_documents SET title = $1, excerpt = $2, updated_at = $3 WHERE id = $4', [
      m.subject,
      excerpt,
      m.date,
      existing.id,
    ])
    await upsertDocument(existing.id, m.subject, 'email', null, null)
    return existing.id
  }
  const id = randomUUID()
  await pool.query(
    `INSERT INTO knowledge_documents (id, org_id, project_id, type, title, excerpt, owner_id, keywords, external_id, created_at, updated_at)
     VALUES ($1, $2, NULL, 'email', $3, $4, $5, $6, $7, $8, $9)`,
    [id, orgId, m.subject, excerpt, userId, JSON.stringify([m.from]), m.externalId, m.date, m.date],
  )
  await upsertDocument(id, m.subject, 'email', null, null)
  return id
}

// --- Auto-task extraction from Zoom AI Companion "Next steps" summary emails ---
//
// There's no LLM anywhere in this app, so this is a heuristic text parser tailored to the
// exact template Zoom's AI Companion uses (observed directly in synced data), not a general
// NLP solution — it will miss or misparse content that doesn't match this shape. Direct
// request: after a meeting-summary email syncs, extract its "Next steps <Name> / - <item>"
// sections into real tasks, matching assignees to registered users and resolving relative due
// dates ("Thursday") against the email's own date, rather than leaving that content buried in
// a big excerpt no one reads.

// "Fwd: Meeting assets for Navedas Intelligence - GTM (Weekdays) - All (Tue & Thurs) are ready!"
// -> "Navedas Intelligence - GTM (Weekdays) - All (Tue & Thurs)". Falls back to the whole
// (Fwd:-stripped) subject if it doesn't match this exact template.
function extractMeetingNameFromSubject(subject: string): string {
  const stripped = subject.replace(/^(fwd:\s*)+/i, '').trim()
  const match = stripped.match(/^Meeting assets for (.+?) (?:is|are) ready!?$/i)
  return match ? match[1].trim() : stripped
}

interface NextStepBlock {
  name: string
  items: string[]
}

// One or two capitalized words — "Ambika", "Deepika Sharma" — used to recognize a per-person
// heading in the "Next steps" section. Deliberately narrow: this is what stops the parser at
// "Collaboration" and "Summary <Title>", the template's other section headings, which is the
// whole point (see the loop below for how each is actually handled).
const NAME_HEADING_RE = /^[A-Z][a-zA-Z'.-]*(\s[A-Z][a-zA-Z'.-]*)?$/
// Bullets are indented 3 spaces in the source ("   - item"), but block-level trimming (below)
// strips that leading whitespace from whichever line lands at the start of a block — so this
// tolerates 0+ leading spaces rather than requiring exactly 3.
const BULLET_LINE_RE = /^\s*-\s/
const MAX_NEXT_STEP_BLOCKS = 20 // safety bound against runaway parsing on unexpected content

// The template alternates blank-line-separated blocks: a person's name on its own, then their
// bullet list, then the next name, then its bullets, and so on — "Next steps Ambika\n\n   -
// item\n\nDeepika\n\n   - item\n\n...". Stops at the first heading whose following block isn't
// purely bullet-formatted (that's where the free-form "Summary <Title>" prose sections start).
function parseNextStepsBlocks(bodyText: string): NextStepBlock[] {
  const marker = 'Next steps '
  const idx = bodyText.indexOf(marker)
  if (idx === -1) return []

  const blocks = bodyText
    .slice(idx + marker.length)
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter(Boolean)

  const result: NextStepBlock[] = []
  for (let i = 0; i + 1 < blocks.length && result.length < MAX_NEXT_STEP_BLOCKS; i += 2) {
    const heading = blocks[i].split('\n')[0].trim()
    const bulletsBlock = blocks[i + 1]
    if (!NAME_HEADING_RE.test(heading)) break

    const bulletLines = bulletsBlock.split(/\n(?=\s*- )/).map((s) => s.trim())
    if (!bulletLines.every((line) => BULLET_LINE_RE.test(line))) break // e.g. "Summary ..." followed by prose, not bullets

    const items = bulletLines.map((b) =>
      b
        .replace(/^\s*-\s*/, '')
        .split('\n')
        .map((l) => l.trim())
        .join(' ')
        .trim(),
    )
    result.push({ name: heading, items })
  }
  return result
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

// Resolves a relative date phrase ("today", "tomorrow", a weekday name) found in a task's own
// text against the email's date (the closest thing to "when this was said" available — there's
// no meeting transcript timestamp to anchor to). Returns a YYYY-MM-DD string or null if the
// text doesn't mention a recognizable relative date.
function resolveDueDate(text: string, anchorIso: string): string | null {
  const lower = text.toLowerCase()
  const anchor = new Date(anchorIso)
  if (/\btoday\b/.test(lower)) return anchor.toISOString().slice(0, 10)
  if (/\btomorrow\b/.test(lower)) {
    const d = new Date(anchor)
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
  }
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(lower)) {
      const d = new Date(anchor)
      const delta = ((i - d.getDay() + 7) % 7) || 7 // same weekday mentioned -> assume next week, not "today"
      d.setDate(d.getDate() + delta)
      return d.toISOString().slice(0, 10)
    }
  }
  return null
}

// Zoom AI Companion has transcribed the same real person's name two different ways across
// meetings before ("Pulak" vs "Pullak", "Lupita" vs "Lopita") — exact-match lookup below treats
// each spelling as a different person and auto-creates a duplicate account for the one it hasn't
// seen. These are known misspellings for real people already in this org; redirect them to the
// correct account instead of matching (or creating) on the literal text. Not a general fuzzy-match
// system — deliberately a short, known list, not an attempt to guess at unknown typos.
const NAME_ALIASES: Record<string, string> = {
  pulak: 'Pullak',
  lupita: 'Lopita',
}

// Matches a bare first name ("Ambika") against this org's registered users — exact first-name
// match, or "Ambika <anything>" for full names. On more than one hit, returns null rather than
// guessing: an ambiguous match is worse than an unassigned task, since silently assigning to the
// wrong person is a real mistake and an auto-created duplicate account is a worse one.
//
// On zero hits, auto-creates a lightweight account for that name rather than leaving the task
// unassigned — direct request, since a task assignee has to be a real registered user (same rule
// as manual task assignment), and most people named in these summaries (a coworker mentioned by
// first name, not the person who owns the Gmail inbox being synced) have never signed up. There's
// no email in the source text to invite them properly with (see /users/invite), so this generates
// a synthetic, unusable one — the account exists purely so the name has somewhere real to point
// to, not so that person can actually log in. Subsequent calls for the same name find and reuse
// this same row via the SELECT above, so one person mentioned across many meetings gets one
// account, not one per meeting.
async function findOrCreateAssigneeByFirstName(orgId: string, name: string): Promise<string | null> {
  const rawFirstName = name.trim().split(/\s+/)[0]
  if (!rawFirstName) return null
  const firstName = NAME_ALIASES[rawFirstName.toLowerCase()] ?? rawFirstName
  // ILIKE, not "= ... COLLATE NOCASE" / "LIKE ... COLLATE NOCASE" — Postgres has no COLLATE
  // NOCASE; ILIKE with no wildcards is the direct equivalent for the exact-match branch too.
  const matches = (
    await pool.query(`SELECT id FROM users WHERE org_id = $1 AND (name ILIKE $2 OR name ILIKE $3)`, [
      orgId,
      firstName,
      `${firstName} %`,
    ])
  ).rows as { id: string }[]
  if (matches.length === 1) return matches[0].id
  if (matches.length > 1) return null

  const id = randomUUID()
  const email = `${firstName.toLowerCase().replace(/[^a-z0-9]/g, '')}.auto-${randomBytes(4).toString('hex')}@placeholder.internal`
  const passwordHash = bcrypt.hashSync(randomBytes(16).toString('base64url'), 10)
  const initials = firstName.slice(0, 2).toUpperCase()
  await pool.query('INSERT INTO users (id, org_id, email, password_hash, name, initials) VALUES ($1, $2, $3, $4, $5, $6)', [
    id,
    orgId,
    email,
    passwordHash,
    firstName,
    initials,
  ])
  return id
}

// Finds the meeting a summary email is about, or creates one. Prefers a real meeting (any
// source) with a matching title on the same calendar day — this is how tasks correctly attach
// to an actual Zoom/Google Meet-synced meeting when one exists. Falls back to reusing a meeting
// this function already auto-created for this exact email on a prior sync (dedup by
// source='email_sync' + external_id), and only creates a new one if neither is found.
async function findOrCreateMeetingForEmail(orgId: string, m: GmailMessage): Promise<string> {
  const meetingName = extractMeetingNameFromSubject(m.subject)

  const matched = (
    await pool.query(
      `SELECT id FROM meetings WHERE org_id = $1 AND title ILIKE $2 AND scheduled_at::date = $3::date`,
      [orgId, meetingName, m.date],
    )
  ).rows[0] as { id: string } | undefined
  if (matched) return matched.id

  const existing = (
    await pool.query(`SELECT id FROM meetings WHERE org_id = $1 AND source = 'email_sync' AND external_id = $2`, [
      orgId,
      m.externalId,
    ])
  ).rows[0] as { id: string } | undefined
  if (existing) return existing.id

  const id = randomUUID()
  await pool.query(
    `INSERT INTO meetings (id, org_id, project_id, title, summary, participants, scheduled_at, duration_min, sync_status, source, external_id)
     VALUES ($1, $2, NULL, $3, '', '[]', $4, 30, 'synced', 'email_sync', $5)`,
    [id, orgId, meetingName, m.date, m.externalId],
  )
  await upsertMeeting(id, meetingName, null)
  return id
}

// Runs after every Gmail sync (insert or update) of a message — a no-op if the email doesn't
// contain a "Next steps" section. Idempotent: each extracted task gets a deterministic
// `${gmailMessageId}:${bulletIndex}` external_id, so re-syncing the same email never recreates
// the same tasks (the bullet order from parseNextStepsBlocks is stable across runs on the same
// immutable email content).
// syncedByUserId — the real person whose Gmail connection triggered this sync (from the caller's
// req.user!.id). Used as task_activity.actor_id / recordActivity's actor for anything this
// function auto-assigns — there's no other honest "who did this" for a background sync; better
// than fabricating a system account, and it's a real, meaningful fact (who authorized the sync).
async function syncTasksFromSummaryEmail(orgId: string, m: GmailMessage, docId: string, syncedByUserId: string) {
  const blocks = parseNextStepsBlocks(m.bodyText)
  if (blocks.length === 0) return

  const meetingId = await findOrCreateMeetingForEmail(orgId, m)

  // Backfills knowledge_documents.source_meeting_id now that we know which meeting this
  // summary email is about — closes a gap noted in knowledge-base/backend.md: the column
  // existed but nothing ever populated it.
  await pool.query(`UPDATE knowledge_documents SET source_meeting_id = $1 WHERE id = $2 AND source_meeting_id IS NULL`, [
    meetingId,
    docId,
  ])
  await linkDocumentToMeeting(docId, meetingId)

  const meetingProjectId = (
    await pool.query('SELECT project_id FROM meetings WHERE id = $1', [meetingId])
  ).rows[0]?.project_id as string | null | undefined

  let bulletIndex = 0
  for (const block of blocks) {
    const isCollaboration = block.name === 'Collaboration' // the template's shared/multi-person section, not a real name
    const assigneeId = isCollaboration ? null : await findOrCreateAssigneeByFirstName(orgId, block.name)
    // Loosely "attended" — really "assigned an action item from this meeting's summary," the
    // only per-person signal this auto-extraction has. Once per resolved name per email (not
    // per bullet item) — MERGE is idempotent, so no harm in a person appearing in multiple
    // "Next steps" bullets under the same block.
    if (assigneeId) await attendMeeting(meetingId, assigneeId)
    for (const item of block.items) {
      const externalId = `${m.externalId}:${bulletIndex}`
      bulletIndex++
      const already = (
        await pool.query(`SELECT id, assignee_id FROM meeting_tasks WHERE org_id = $1 AND external_id = $2`, [
          orgId,
          externalId,
        ])
      ).rows[0] as { id: string; assignee_id: string | null } | undefined
      if (already) {
        // Repairs a task extracted before auto-account-creation existed (or one whose name was
        // ambiguous at the time but has since resolved to a single account) — but only while it's
        // still Unassigned, so a person's own manual reassignment is never overwritten.
        if (assigneeId && !isCollaboration && already.assignee_id === null) {
          await pool.query('UPDATE meeting_tasks SET assignee_id = $1, title = $2 WHERE id = $3', [
            assigneeId,
            item,
            already.id,
          ])
          const now = new Date().toISOString()
          const activityId = randomUUID()
          await pool.query(
            'INSERT INTO task_activity (id, org_id, task_id, actor_id, action, assignee_id, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [activityId, orgId, already.id, syncedByUserId, 'assigned', assigneeId, 'Resolved from a previously ambiguous name'],
          )
          await recordTaskAssignment(already.id, assigneeId, now, null)
          await recordActivity(activityId, 'assigned', now, syncedByUserId, 'Task', already.id)
          if (meetingProjectId) await recordProjectInvolvement(assigneeId, meetingProjectId, now)
        }
        continue
      }
      // assigneeId is only null here for an ambiguous name match (2+ existing users share it —
      // findOrCreateAssigneeByFirstName deliberately won't guess) or the "Collaboration" block.
      // Keep the parsed name in the title in that case so who it was for isn't lost just because
      // "Unassigned" is showing in the assignee field.
      const title = assigneeId || isCollaboration ? item : `${block.name}: ${item}`
      const dueDate = resolveDueDate(item, m.date)
      const taskId = randomUUID()
      await pool.query(
        `INSERT INTO meeting_tasks (id, meeting_id, org_id, title, assignee_id, due_date, external_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [taskId, meetingId, orgId, title, assigneeId, dueDate, externalId],
      )
      await upsertTask(taskId, title, meetingId)
      if (meetingProjectId) await linkTaskToProject(taskId, meetingProjectId)
      if (assigneeId) {
        // Same gap-closing as meetings.ts's manual task creation — this auto-extraction path
        // previously assigned a task at creation without ever logging it as an event.
        const now = new Date().toISOString()
        const activityId = randomUUID()
        await pool.query(
          'INSERT INTO task_activity (id, org_id, task_id, actor_id, action, assignee_id, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [activityId, orgId, taskId, syncedByUserId, 'assigned', assigneeId, 'Assigned at creation (auto-extracted)'],
        )
        await recordTaskAssignment(taskId, assigneeId, now, null)
        await recordActivity(activityId, 'assigned', now, syncedByUserId, 'Task', taskId)
        if (meetingProjectId) await recordProjectInvolvement(assigneeId, meetingProjectId, now)
      }
    }
  }
}

interface ParticipantDescriptor {
  userId: string | null
  name: string
  initials: string | null
  email: string | null
}

// External invitees are just email addresses — some match an org member (enrich with
// name/initials/userId so the UI can show a real avatar), others are outside guests (kept
// as email-only entries). The connecting user is always included, since Zoom/Google's
// invitee list is typically "everyone else," not the host themselves.
//
// Returns the raw descriptor array, not a stringified JSON — upsertSyncedMeeting stringifies
// it for storage but also needs the raw array to know which real userIds to notify.
async function buildParticipants(orgId: string, connectingUserId: string, emails: string[]): Promise<ParticipantDescriptor[]> {
  const descriptors: ParticipantDescriptor[] = []
  const seenUserIds = new Set<string>()
  const seenEmails = new Set<string>()

  function addUser(user: { id: string; name: string; initials: string; email: string }) {
    if (seenUserIds.has(user.id)) return
    seenUserIds.add(user.id)
    seenEmails.add(user.email.toLowerCase())
    descriptors.push({ userId: user.id, name: user.name, initials: user.initials, email: user.email })
  }

  const connectingUser = (
    await pool.query('SELECT id, name, initials, email FROM users WHERE id = $1', [connectingUserId])
  ).rows[0] as { id: string; name: string; initials: string; email: string } | undefined
  if (connectingUser) addUser(connectingUser)

  for (const email of emails) {
    const lower = email.toLowerCase()
    if (seenEmails.has(lower)) continue
    const match = (
      await pool.query('SELECT id, name, initials, email FROM users WHERE org_id = $1 AND lower(email) = $2', [
        orgId,
        lower,
      ])
    ).rows[0] as { id: string; name: string; initials: string; email: string } | undefined
    if (match) {
      addUser(match)
    } else {
      seenEmails.add(lower)
      descriptors.push({ userId: null, name: email, initials: null, email })
    }
  }

  return descriptors
}

async function upsertSyncedMeeting(
  orgId: string,
  userId: string,
  source: 'zoom' | 'google_meet',
  m: ExternalMeeting,
): Promise<string> {
  const existing = (
    await pool.query('SELECT id FROM meetings WHERE org_id = $1 AND source = $2 AND external_id = $3', [
      orgId,
      source,
      m.externalId,
    ])
  ).rows[0] as { id: string } | undefined
  const scheduledAtIso = new Date(m.scheduledAt).toISOString()
  const participants = await buildParticipants(orgId, userId, m.participantEmails)
  const participantsJson = JSON.stringify(participants)
  if (existing) {
    await pool.query(
      "UPDATE meetings SET title = $1, summary = $2, participants = $3, scheduled_at = $4, duration_min = $5, sync_status = 'synced' WHERE id = $6",
      [m.title, m.summary, participantsJson, scheduledAtIso, m.durationMin, existing.id],
    )
    // Graph is kept current on every sync, not just creation (unlike the notification below) —
    // it's data mirroring, not an event log, so a title change or a newly-added participant
    // should show up whether this meeting is brand new or the third time it's been synced.
    await upsertMeeting(existing.id, m.title, null)
    for (const p of participants) {
      if (p.userId) await attendMeeting(existing.id, p.userId)
    }
    return existing.id
  }
  const id = randomUUID()
  await pool.query(
    `INSERT INTO meetings (id, org_id, project_id, title, summary, participants, scheduled_at, duration_min, sync_status, source, external_id, created_at)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, 'synced', $8, $9, $10)`,
    [
      id,
      orgId,
      m.title,
      m.summary,
      participantsJson,
      scheduledAtIso,
      m.durationMin,
      source,
      m.externalId,
      new Date().toISOString(),
    ],
  )
  await upsertMeeting(id, m.title, null)
  for (const p of participants) {
    if (p.userId) await attendMeeting(id, p.userId)
  }
  // Only on genuine creation, not on re-sync updates — otherwise every "Sync now" click would
  // re-notify the same participants about a meeting they already know exists. Skips the
  // connecting user (they just ran the sync) and any descriptor with no matching org account
  // (an outside guest has no notifications inbox to write to).
  for (const p of participants) {
    if (p.userId && p.userId !== userId) {
      await notify(orgId, p.userId, `You were added to a meeting: ${m.title}.`)
    }
  }
  return id
}

interface ZoomRecordingFile {
  id: string
  fileType: string // 'MP4' | 'M4A' | 'TRANSCRIPT' | 'CHAT' | 'CC' | ...
  fileExtension: string
  recordingType: string // e.g. 'shared_screen_with_speaker_view', 'audio_only', 'audio_transcript', 'chat_file'
  downloadUrl: string
  fileSize: number
}

// After a cloud-recorded Zoom meeting ends, Zoom processes the recording asynchronously and
// makes it available via this endpoint — separate from the meeting-list/meeting-detail calls
// used elsewhere in this file. 404s (no recording yet, or recording disabled/local-only on
// this Zoom account) are treated as "nothing to import," not an error.
async function fetchZoomRecordings(accessToken: string, zoomMeetingId: string): Promise<ZoomRecordingFile[]> {
  const res = await fetch(`https://api.zoom.us/v2/meetings/${zoomMeetingId}/recordings`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`Zoom recordings API error: ${res.status}`)
  const data = (await res.json()) as {
    recording_files?: {
      id: string
      file_type: string
      file_extension: string
      recording_type: string
      download_url: string
      file_size: number
    }[]
  }
  return (data.recording_files ?? []).map((f) => ({
    id: f.id,
    fileType: f.file_type,
    fileExtension: f.file_extension,
    recordingType: f.recording_type,
    downloadUrl: f.download_url,
    fileSize: f.file_size,
  }))
}

const RECORDING_MIME_TYPES: Record<string, string> = {
  MP4: 'video/mp4',
  M4A: 'audio/mp4',
  TRANSCRIPT: 'text/vtt',
  CC: 'text/vtt',
  CHAT: 'text/plain',
}

function labelForRecording(file: ZoomRecordingFile): string {
  const label = file.recordingType.replace(/_/g, ' ')
  return `Zoom ${label} (${file.fileType}).${file.fileExtension.toLowerCase()}`
}

// Downloads a single Zoom recording file into the same server/uploads/<meetingId>/ tree that
// manual asset uploads use (see meetings.ts), and inserts a matching meeting_assets row.
// Dedup is by (meeting_id, external_id) — re-running sync won't re-download the same file.
async function storeZoomRecording(
  orgId: string,
  meetingId: string,
  userId: string,
  accessToken: string,
  file: ZoomRecordingFile,
) {
  const existing = (
    await pool.query('SELECT id FROM meeting_assets WHERE meeting_id = $1 AND external_id = $2', [meetingId, file.id])
  ).rows[0] as { id: string } | undefined
  if (existing) return

  const res = await fetch(file.downloadUrl, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`Zoom recording download failed: ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())

  const filename = labelForRecording(file)
  const dir = path.join(UPLOADS_ROOT, meetingId)
  mkdirSync(dir, { recursive: true })
  const diskFilename = `${randomUUID()}-${filename}`
  writeFileSync(path.join(dir, diskFilename), buffer)

  await pool.query(
    `INSERT INTO meeting_assets (id, meeting_id, org_id, filename, mime_type, size_bytes, storage_path, uploaded_by, external_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(),
      meetingId,
      orgId,
      filename,
      RECORDING_MIME_TYPES[file.fileType] ?? 'application/octet-stream',
      buffer.length || file.fileSize,
      path.join(meetingId, diskFilename),
      userId,
      file.id,
    ],
  )
}

async function syncZoomRecordingsForMeeting(
  orgId: string,
  meetingId: string,
  userId: string,
  accessToken: string,
  zoomMeetingId: string,
): Promise<number> {
  const files = await fetchZoomRecordings(accessToken, zoomMeetingId)
  let stored = 0
  for (const file of files) {
    try {
      await storeZoomRecording(orgId, meetingId, userId, accessToken, file)
      stored++
    } catch (err) {
      console.error(`Failed to store Zoom recording ${file.id} for meeting ${zoomMeetingId}`, err)
    }
  }
  return stored
}

// POST /api/integrations/sync — pulls meetings from every MEETING provider (zoom, google)
// this user has connected and upserts them into the shared `meetings` table (deduped on
// org_id+source+external_id). Gmail is deliberately excluded from this query — it's a
// different kind of sync (email → knowledge_documents, not meetings) with its own trigger,
// its own dedicated endpoint below, and a mandatory search-query gate a meeting sync doesn't need.
// Includes each meeting's agenda/description as `summary` (Zoom: one extra per-meeting request;
// Google: already in the calendar list response). For Zoom meetings, also checks for a
// finished cloud recording and downloads any new files (video/audio/transcript/chat) into
// meeting_assets — see syncZoomRecordingsForMeeting. Requires the recording:read scope on the
// Zoom app in addition to meeting:read; a 404 (no recording yet, or cloud recording isn't
// enabled on the connected Zoom account/plan) is treated as "nothing to import," not a failure.
integrationsRouter.post('/sync', requireAuth, async (req, res) => {
  const orgId = req.user!.org_id
  const userId = req.user!.id
  const connections = (
    await pool.query(
      "SELECT provider, access_token FROM oauth_connections WHERE user_id = $1 AND provider IN ('zoom','google')",
      [userId],
    )
  ).rows as { provider: 'zoom' | 'google'; access_token: string }[]

  if (connections.length === 0) {
    res.status(400).json({ error: 'no_connections', message: 'Connect Zoom or Google Meet before syncing.' })
    return
  }

  const results: Record<string, { imported: number; recordingsImported: number; error: string | null }> = {}

  for (const conn of connections) {
    try {
      const externalMeetings =
        conn.provider === 'zoom' ? await fetchZoomMeetings(conn.access_token) : await fetchGoogleMeetings(conn.access_token)
      const source = conn.provider === 'zoom' ? 'zoom' : 'google_meet'
      let recordingsImported = 0
      for (const m of externalMeetings) {
        const meetingId = await upsertSyncedMeeting(orgId, userId, source, m)
        if (conn.provider === 'zoom') {
          recordingsImported += await syncZoomRecordingsForMeeting(orgId, meetingId, userId, conn.access_token, m.externalId)
        }
      }
      results[conn.provider] = { imported: externalMeetings.length, recordingsImported, error: null }
    } catch (err) {
      console.error(`${conn.provider} sync failed`, err)
      results[conn.provider] = { imported: 0, recordingsImported: 0, error: err instanceof Error ? err.message : 'sync_failed' }
    }
  }

  res.json({ results })
})

// POST /api/integrations/gmail/sync — separate from the meetings /sync above: imports matching
// emails into knowledge_documents (type='email') instead of meetings. 400s if not connected,
// and 400s again with a distinct error if no search query has been set yet — there's no
// reasonable "sync everything" default for an inbox, so this is a hard requirement, not a
// soft nudge.
integrationsRouter.post('/gmail/sync', requireAuth, async (req, res) => {
  const orgId = req.user!.org_id
  const userId = req.user!.id
  const conn = (
    await pool.query("SELECT access_token, sync_query FROM oauth_connections WHERE user_id = $1 AND provider = 'gmail'", [
      userId,
    ])
  ).rows[0] as { access_token: string; sync_query: string } | undefined
  if (!conn) {
    res.status(400).json({ error: 'no_connections', message: 'Connect Gmail before syncing.' })
    return
  }
  if (!conn.sync_query.trim()) {
    res.status(400).json({ error: 'no_query', message: 'Set a Gmail search query before syncing.' })
    return
  }
  try {
    const messages = await fetchGmailMessages(conn.access_token, conn.sync_query)
    for (const m of messages) {
      const docId = await upsertGmailMessage(orgId, userId, m)
      await syncTasksFromSummaryEmail(orgId, m, docId, userId)
    }
    res.json({ imported: messages.length })
  } catch (err) {
    console.error('Gmail sync failed', err)
    res.status(500).json({ error: 'sync_failed', message: err instanceof Error ? err.message : 'Gmail sync failed' })
  }
})
