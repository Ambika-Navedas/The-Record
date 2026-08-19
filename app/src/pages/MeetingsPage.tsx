import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, type IntegrationsResponse, type MeetingItem, type OrgUser, type SyncResult } from '../lib/api'

interface ProjectOption {
  id: string
  name: string
}

interface MeetingFormState {
  title: string
  summary: string
  projectId: string
  scheduledAt: string
  durationMin: string
}

const EMPTY_MEETING_FORM: MeetingFormState = { title: '', summary: '', projectId: '', scheduledAt: '', durationMin: '30' }

// datetime-local inputs need "YYYY-MM-DDTHH:mm" in local time, with no timezone suffix.
function toDatetimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// Google Calendar's "quick add" URL scheme — no API call, no extra OAuth scope. Prefills
// whatever's currently in the New Meeting form; the user finishes the event (and attaches
// Google Meet, which most accounts auto-add) inside Calendar's own UI. Once that event has
// a Meet link, it shows up here automatically on the next "Sync now" — no separate handoff
// needed on our end.
function buildGoogleCalendarUrl(form: MeetingFormState): string {
  const url = new URL('https://calendar.google.com/calendar/render')
  url.searchParams.set('action', 'TEMPLATE')
  if (form.title.trim()) url.searchParams.set('text', form.title.trim())
  if (form.summary.trim()) url.searchParams.set('details', form.summary.trim())
  if (form.scheduledAt) {
    const start = new Date(form.scheduledAt)
    const end = new Date(start.getTime() + (Number(form.durationMin) || 30) * 60_000)
    const fmt = (d: Date) => `${d.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`
    url.searchParams.set('dates', `${fmt(start)}/${fmt(end)}`)
  }
  return url.toString()
}

const API_BASE = 'http://localhost:4000/api'

const filters = [
  { key: 'all', label: 'All' },
  { key: 'this_week', label: 'This week' },
  { key: 'needs_review', label: 'Needs review' },
] as const

const sourceLabel: Record<string, string> = {
  zoom: 'Zoom',
  google_meet: 'Google Meet',
  email_sync: 'From synced email',
}

function formatWhen(iso: string): { when: string; time: string } {
  const date = new Date(iso)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday = date.toDateString() === yesterday.toDateString()

  const when = isToday
    ? 'Today'
    : isYesterday
      ? 'Yesterday'
      : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return { when, time }
}

export function MeetingsPage() {
  const [filter, setFilter] = useState<(typeof filters)[number]['key']>('all')
  const [items, setItems] = useState<MeetingItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [integrations, setIntegrations] = useState<IntegrationsResponse | null>(null)
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [syncing, setSyncing] = useState(false)

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([])
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [form, setForm] = useState<MeetingFormState>(EMPTY_MEETING_FORM)
  const [participantIds, setParticipantIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  function fetchMeetings() {
    setItems(null)
    api
      .get<{ items: MeetingItem[] }>(`/meetings?filter=${filter}`)
      .then((res) => setItems(res.items))
      .catch(() => setError('Could not reach the API. Is the backend running on :4000?'))
  }

  function fetchIntegrations() {
    api
      .get<IntegrationsResponse>('/integrations')
      .then(setIntegrations)
      .catch(() => {})
  }

  useEffect(fetchMeetings, [filter])
  useEffect(fetchIntegrations, [])

  useEffect(() => {
    api
      .get<{ items: ProjectOption[] }>('/projects?status=all')
      .then((res) => setProjects(res.items))
      .catch(() => {})
  }, [])

  useEffect(() => {
    api
      .get<{ items: OrgUser[] }>('/users')
      .then((res) => setOrgUsers(res.items))
      .catch(() => {})
  }, [])

  function openCreateModal() {
    setForm({ ...EMPTY_MEETING_FORM, scheduledAt: toDatetimeLocal(new Date()) })
    setParticipantIds([])
    setFormError(null)
    setShowCreateModal(true)
  }

  function toggleParticipant(userId: string) {
    setParticipantIds((ids) => (ids.includes(userId) ? ids.filter((id) => id !== userId) : [...ids, userId]))
  }

  async function handleCreateMeeting(e: React.FormEvent) {
    e.preventDefault()
    const trimmedTitle = form.title.trim()
    if (!trimmedTitle) return
    setSaving(true)
    setFormError(null)
    try {
      await api.post('/meetings', {
        title: trimmedTitle,
        summary: form.summary.trim(),
        projectId: form.projectId || undefined,
        scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : undefined,
        durationMin: Number(form.durationMin) || 30,
        participantIds,
      })
      setShowCreateModal(false)
      fetchMeetings()
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Is the API server running?')
    } finally {
      setSaving(false)
    }
  }

  // After the OAuth round trip, the backend redirects back here with ?integration=zoom&status=connected
  // (or status=error). Show it once, then strip the params so a refresh doesn't re-show it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const integration = params.get('integration')
    const status = params.get('status')
    if (!integration || !status) return
    const label = integration === 'zoom' ? 'Zoom' : 'Google Meet'
    setBanner(
      status === 'connected'
        ? { kind: 'success', text: `${label} connected. Click "Sync now" to pull in meetings.` }
        : { kind: 'error', text: `Couldn't connect ${label}. Please try again.` },
    )
    window.history.replaceState({}, '', window.location.pathname)
  }, [])

  async function handleSync() {
    setSyncing(true)
    try {
      const res = await api.post<SyncResult>('/integrations/sync')
      const parts = Object.entries(res.results).map(([provider, r]) => {
        const label = provider === 'zoom' ? 'Zoom' : 'Google Meet'
        if (r.error) return `${label}: failed`
        const recordingsPart = r.recordingsImported > 0 ? `, ${r.recordingsImported} recording${r.recordingsImported === 1 ? '' : 's'}` : ''
        return `${label}: ${r.imported} synced${recordingsPart}`
      })
      setBanner({ kind: 'success', text: parts.join(' · ') })
      fetchMeetings()
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof ApiError ? err.message : 'Sync failed.' })
    } finally {
      setSyncing(false)
    }
  }

  async function handleDisconnect(provider: 'zoom' | 'google') {
    await api.delete(`/integrations/${provider}`).catch(() => {})
    fetchIntegrations()
  }

  if (error) return <div className="text-sm text-red-700">{error}</div>

  const anyConnected = integrations ? integrations.zoom.connected || integrations.google.connected : false

  return (
    <>
      <div className="mb-7 flex items-start justify-between">
        <div>
          <h1 className="font-display text-[28px] font-bold">Meetings</h1>
          <p className="mt-1 text-sm text-muted">Real meeting data from the org's backend — filters run as actual date/status queries.</p>
        </div>
        <button
          onClick={openCreateModal}
          className="flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-2.5 text-[13px] font-semibold text-white shadow-[0_6px_16px_-6px_rgba(52,87,213,0.5)] transition-transform hover:-translate-y-px"
        >
          + New meeting
        </button>
      </div>

      {banner && (
        <div
          className={`mb-4.5 flex items-center justify-between rounded-lg px-3.5 py-2.5 text-[13px] font-semibold ${
            banner.kind === 'success' ? 'bg-green-tint text-green' : 'bg-red-50 text-red-700'
          }`}
        >
          {banner.text}
          <button onClick={() => setBanner(null)} className="text-xs font-bold opacity-70 hover:opacity-100">
            ✕
          </button>
        </div>
      )}

      <div className="mb-4.5 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card p-3.5">
        <span className="mr-1 text-[13px] font-semibold text-muted">Sync meetings from:</span>
        {integrations ? (
          <>
            {(['zoom', 'google'] as const).map((provider) => {
              const status = integrations[provider]
              const label = provider === 'zoom' ? 'Zoom' : 'Google Meet'
              if (!status.configured) {
                return (
                  <span
                    key={provider}
                    title="This server has no OAuth app credentials configured for this provider — see server/.env.example"
                    className="cursor-not-allowed rounded-full border border-border bg-page px-3 py-1.5 text-[13px] font-semibold text-muted opacity-60"
                  >
                    {label} · not configured
                  </span>
                )
              }
              if (status.connected) {
                return (
                  <span
                    key={provider}
                    className="flex items-center gap-1.5 rounded-full border border-border bg-green-tint px-3 py-1.5 text-[13px] font-semibold text-green"
                  >
                    {label} connected
                    <button
                      onClick={() => handleDisconnect(provider)}
                      className="ml-1 text-[11px] font-bold text-green underline decoration-dotted hover:opacity-70"
                    >
                      Disconnect
                    </button>
                  </span>
                )
              }
              return (
                <a
                  key={provider}
                  href={`${API_BASE}/integrations/${provider}/connect`}
                  className="rounded-full border border-border bg-white px-3 py-1.5 text-[13px] font-semibold text-muted transition-colors hover:border-accent hover:text-accent"
                >
                  Connect {label}
                </a>
              )
            })}
            <button
              onClick={handleSync}
              disabled={!anyConnected || syncing}
              className="ml-auto rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-1.5 text-[13px] font-semibold text-white disabled:opacity-40"
            >
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          </>
        ) : (
          <span className="text-[13px] text-muted">Loading…</span>
        )}
      </div>

      <div className="mb-4.5 flex items-center justify-between">
        <div className="flex gap-2">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors ${
                filter === f.key ? 'border-ink bg-ink text-white' : 'border-border bg-white text-muted hover:border-accent hover:text-accent'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="text-sm text-muted">Sort: Most recent ⌄</div>
      </div>

      {!items ? (
        <div className="text-sm text-muted">Loading meetings…</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-muted">No meetings match this filter.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((m) => {
            const { when, time } = formatWhen(m.scheduledAt)
            return (
              <div
                key={m.id}
                className="flex items-center gap-4.5 rounded-2xl border border-border bg-card p-4.5 transition-all hover:-translate-y-0.5 hover:shadow-[0_20px_40px_-24px_rgba(27,28,34,0.22)]"
              >
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-accent-tint text-base text-accent">
                  🎙️
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="font-display text-sm font-bold">{m.title}</span>
                    {m.project && (
                      <span className="rounded-full border border-border bg-page px-2 py-0.5 text-[11px] font-semibold text-muted">
                        {m.project}
                      </span>
                    )}
                    {sourceLabel[m.source] && (
                      <span className="rounded-full border border-border bg-accent-tint px-2 py-0.5 text-[11px] font-semibold text-accent">
                        {sourceLabel[m.source]}
                      </span>
                    )}
                  </div>
                  <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] text-muted">{m.summary}</div>
                </div>
                <div className="flex flex-shrink-0 items-center gap-4">
                  <div className="min-w-[90px] text-right text-xs text-muted">
                    <strong className="block text-[13px] font-semibold text-ink">{when}</strong>
                    {time} · {m.durationMin}m
                  </div>
                  <span
                    className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold ${
                      m.syncStatus === 'synced' ? 'bg-green-tint text-green' : 'bg-[#F0F0F3] text-muted'
                    }`}
                  >
                    {m.syncStatus === 'synced' ? 'Synced' : m.syncStatus === 'processing' ? 'Processing' : 'Failed'}
                  </span>
                  <Link to={`/app/meetings/${m.id}`} className="whitespace-nowrap text-sm font-semibold text-accent">
                    View →
                  </Link>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showCreateModal && (
        <>
          <div className="fixed inset-0 z-[200] bg-ink/25" onClick={() => !saving && setShowCreateModal(false)} />
          <div className="fixed left-1/2 top-1/2 z-[201] w-[440px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-[0_30px_80px_-30px_rgba(27,28,34,0.35)]">
            <h2 className="mb-1 font-display text-lg font-bold">New meeting</h2>
            <p className="mb-4 text-sm text-muted">Log a meeting manually — you can attach assets and tasks after it's created.</p>
            <form onSubmit={handleCreateMeeting}>
              <label className="mb-1.5 block text-[13px] font-semibold">Title</label>
              <input
                autoFocus
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Vendor sync"
                className="mb-3.5 w-full rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              />

              <label className="mb-1.5 block text-[13px] font-semibold">Summary</label>
              <textarea
                value={form.summary}
                onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))}
                placeholder="What was this meeting about?"
                rows={3}
                className="mb-3.5 w-full resize-none rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              />

              <div className="mb-3.5 grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-[13px] font-semibold">Project</label>
                  <select
                    value={form.projectId}
                    onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value }))}
                    className="w-full rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <option value="">None</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-[13px] font-semibold">Duration (min)</label>
                  <input
                    type="number"
                    min={5}
                    step={5}
                    value={form.durationMin}
                    onChange={(e) => setForm((f) => ({ ...f, durationMin: e.target.value }))}
                    className="w-full rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  />
                </div>
              </div>

              <label className="mb-1.5 block text-[13px] font-semibold">Date &amp; time</label>
              <input
                type="datetime-local"
                value={form.scheduledAt}
                onChange={(e) => setForm((f) => ({ ...f, scheduledAt: e.target.value }))}
                className="mb-3.5 w-full rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              />

              {/* Direct request: "the meeting scheduled ... needs to be visible as the
                  notification to the concerned member" — manual creation previously stored no
                  participants at all, so there was no one to notify. Plain checkboxes, not a
                  native multi-select (ctrl/cmd-click is non-obvious), matching this app's
                  hand-rolled-controls convention. */}
              <label className="mb-1.5 block text-[13px] font-semibold">Participants</label>
              <div className="mb-3.5 max-h-32 overflow-y-auto rounded-lg border border-border bg-page p-2">
                {orgUsers.length === 0 ? (
                  <div className="px-1.5 py-1 text-[13px] text-muted">No org members to add.</div>
                ) : (
                  orgUsers.map((u) => (
                    <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-white">
                      <input
                        type="checkbox"
                        checked={participantIds.includes(u.id)}
                        onChange={() => toggleParticipant(u.id)}
                        className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      />
                      {u.name}
                    </label>
                  ))
                )}
              </div>

              {formError && <div className="mb-3.5 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{formError}</div>}

              <a
                href={buildGoogleCalendarUrl(form)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setShowCreateModal(false)}
                className="mb-1 inline-block text-[12.5px] font-semibold text-accent hover:underline"
              >
                Need a Google Meet link instead? Set it up in Google Calendar →
              </a>

              <div className="mt-1 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  disabled={saving}
                  className="rounded-lg border border-border px-4 py-2 text-sm font-semibold disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !form.title.trim()}
                  className="rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {saving ? 'Saving…' : 'Create meeting'}
                </button>
              </div>
            </form>
          </div>
        </>
      )}
    </>
  )
}
