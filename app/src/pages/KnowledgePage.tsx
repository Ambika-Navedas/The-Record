import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { DateRangePicker, type DateRangeValue } from '../components/DateRangePicker'
import { api, ApiError, type GmailSyncResult, type IntegrationsResponse, type KnowledgeDocItem } from '../lib/api'

const API_BASE = 'http://localhost:4000/api'

const typeIcon: Record<string, string> = {
  sop: '📋',
  meeting_note: '🎙️',
  decision: '⚖️',
  faq: '❓',
  email: '📧',
  file: '📎',
}

const filters = [
  { key: 'all', label: 'All' },
  { key: 'meeting_note', label: 'Meeting notes' },
  { key: 'email', label: 'Emails' },
  { key: 'file', label: 'Files' },
] as const

const typeLabel: Record<string, string> = {
  sop: 'SOP',
  meeting_note: 'Meeting note',
  decision: 'Decision',
  faq: 'FAQ',
  email: 'Email',
  file: 'File',
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function KnowledgePage() {
  const [filter, setFilter] = useState<(typeof filters)[number]['key']>('all')
  const [dateRange, setDateRange] = useState<DateRangeValue | null>(null)
  const [data, setData] = useState<{ items: KnowledgeDocItem[]; counts: Record<string, number> } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [integrations, setIntegrations] = useState<IntegrationsResponse | null>(null)
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [gmailQuery, setGmailQuery] = useState('')
  const [savingQuery, setSavingQuery] = useState(false)
  const [syncing, setSyncing] = useState(false)

  function fetchKnowledge() {
    setData(null)
    const params = new URLSearchParams({ type: filter })
    if (dateRange) {
      params.set('from', dateRange.from)
      params.set('to', dateRange.to)
    }
    api
      .get<{ items: KnowledgeDocItem[]; counts: Record<string, number> }>(`/knowledge?${params}`)
      .then(setData)
      .catch(() => setError('Could not reach the API. Is the backend running on :4000?'))
  }

  function fetchIntegrations() {
    api
      .get<IntegrationsResponse>('/integrations')
      .then((res) => {
        setIntegrations(res)
        setGmailQuery(res.gmail.query)
      })
      .catch(() => {})
  }

  useEffect(fetchKnowledge, [filter, dateRange])
  useEffect(fetchIntegrations, [])

  // After the OAuth round trip, the backend redirects back here with ?integration=gmail&status=connected
  // (or status=error) — same pattern as the Zoom/Google Meet sync bar on the Meetings page.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const integration = params.get('integration')
    const status = params.get('status')
    if (!integration || !status) return
    setBanner(
      status === 'connected'
        ? { kind: 'success', text: 'Gmail connected. Set a search query below, then click "Sync now".' }
        : { kind: 'error', text: "Couldn't connect Gmail. Please try again." },
    )
    window.history.replaceState({}, '', window.location.pathname)
  }, [])

  async function handleSaveQuery() {
    setSavingQuery(true)
    try {
      await api.put('/integrations/gmail/query', { query: gmailQuery.trim() })
      setBanner({ kind: 'success', text: 'Search query saved.' })
      fetchIntegrations()
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save the query.' })
    } finally {
      setSavingQuery(false)
    }
  }

  async function handleSync() {
    setSyncing(true)
    try {
      const res = await api.post<GmailSyncResult>('/integrations/gmail/sync')
      setBanner({ kind: 'success', text: `Gmail: ${res.imported} email${res.imported === 1 ? '' : 's'} synced` })
      fetchKnowledge()
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof ApiError ? err.message : 'Gmail sync failed.' })
    } finally {
      setSyncing(false)
    }
  }

  async function handleDisconnect() {
    await api.delete('/integrations/gmail').catch(() => {})
    fetchIntegrations()
  }

  async function handleTrash(e: React.MouseEvent, id: string) {
    e.preventDefault() // the row itself is a <Link> to the detail page — don't navigate
    e.stopPropagation()
    await api.post(`/knowledge/${id}/trash`).catch(() => {})
    fetchKnowledge()
  }

  if (error) return <div className="text-sm text-red-700">{error}</div>

  const gmail = integrations?.gmail

  return (
    <>
      <div className="mb-7">
        <h1 className="font-display text-[28px] font-bold">Knowledge Base</h1>
        <p className="mt-1 text-sm text-muted">{data ? `${data.counts.all} items across your org.` : 'Loading…'}</p>
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
        <span className="mr-1 text-[13px] font-semibold text-muted">Sync emails from:</span>
        {!gmail ? (
          <span className="text-[13px] text-muted">Loading…</span>
        ) : !gmail.configured ? (
          <span
            title="This server has no OAuth app credentials configured for Gmail — see server/.env.example"
            className="cursor-not-allowed rounded-full border border-border bg-page px-3 py-1.5 text-[13px] font-semibold text-muted opacity-60"
          >
            Gmail · not configured
          </span>
        ) : !gmail.connected ? (
          <a
            href={`${API_BASE}/integrations/gmail/connect`}
            className="rounded-full border border-border bg-white px-3 py-1.5 text-[13px] font-semibold text-muted transition-colors hover:border-accent hover:text-accent"
          >
            Connect Gmail
          </a>
        ) : (
          <>
            <span className="flex items-center gap-1.5 rounded-full border border-border bg-green-tint px-3 py-1.5 text-[13px] font-semibold text-green">
              Gmail connected
              <button
                onClick={handleDisconnect}
                className="ml-1 text-[11px] font-bold text-green underline decoration-dotted hover:opacity-70"
              >
                Disconnect
              </button>
            </span>
            <input
              value={gmailQuery}
              onChange={(e) => setGmailQuery(e.target.value)}
              placeholder='Gmail search query, e.g. label:clients or from:*@acme.com'
              className="min-w-[280px] flex-1 rounded-lg border border-border bg-page px-3 py-1.5 text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            />
            <button
              onClick={handleSaveQuery}
              disabled={savingQuery || gmailQuery.trim() === gmail.query}
              className="rounded-lg border border-border px-3 py-1.5 text-[13px] font-semibold text-muted disabled:opacity-40"
            >
              {savingQuery ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={handleSync}
              disabled={syncing || !gmail.query.trim()}
              className="ml-auto rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-1.5 text-[13px] font-semibold text-white disabled:opacity-40"
              title={!gmail.query.trim() ? 'Save a search query first' : undefined}
            >
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          </>
        )}
      </div>

      <div className="mb-4.5 flex items-center justify-between">
        <div className="flex flex-wrap gap-2">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors ${
                filter === f.key ? 'border-ink bg-ink text-white' : 'border-border bg-white text-muted hover:border-accent hover:text-accent'
              }`}
            >
              {f.label} · {data?.counts[f.key === 'all' ? 'all' : f.key] ?? 0}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <Link to="/app/knowledge/trash" className="text-sm font-semibold text-muted hover:text-accent">
            🗑 Trash{data && data.counts.trash > 0 ? ` · ${data.counts.trash}` : ''}
          </Link>
          <DateRangePicker value={dateRange} onChange={setDateRange} placeholder="All time" />
        </div>
      </div>

      {!data ? (
        <div className="text-sm text-muted">Loading knowledge base…</div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {data.items.map((doc) => (
            <Link
              key={doc.id}
              to={`/app/knowledge/${doc.id}`}
              className="flex items-center gap-3.5 rounded-2xl border border-border bg-card px-4.5 py-3.5 transition-all hover:-translate-y-0.5 hover:shadow-[0_20px_40px_-24px_rgba(27,28,34,0.22)]"
            >
              <div className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-lg bg-page text-sm text-muted">
                {typeIcon[doc.type]}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-semibold">{doc.title}</div>
                <div className="text-[11.5px] text-muted">
                  <span className="font-semibold text-muted">{typeLabel[doc.type]}</span>
                  {doc.project && <> · {doc.project}</>} · {doc.owner}
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1.5 text-[11.5px] text-muted">
                <span className={`h-2 w-2 rounded-full ${doc.isFresh ? 'bg-green' : 'bg-[#C6C7D0]'}`} />
                {formatDate(doc.updatedAt)}
              </div>
              <button
                onClick={(e) => handleTrash(e, doc.id)}
                title="Move to trash"
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted hover:bg-red-50 hover:text-red-700"
              >
                🗑
              </button>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
