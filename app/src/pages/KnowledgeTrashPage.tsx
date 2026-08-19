import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type KnowledgeDocItem } from '../lib/api'

const typeIcon: Record<string, string> = {
  sop: '📋',
  meeting_note: '🎙️',
  decision: '⚖️',
  faq: '❓',
  email: '📧',
}

const typeLabel: Record<string, string> = {
  sop: 'SOP',
  meeting_note: 'Meeting note',
  decision: 'Decision',
  faq: 'FAQ',
  email: 'Email',
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const hours = diffMs / 3_600_000
  if (hours < 1) return 'just now'
  if (hours < 24) return `${Math.round(hours)}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function KnowledgeTrashPage() {
  const [items, setItems] = useState<KnowledgeDocItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  function fetchTrash() {
    setError(null)
    api
      .get<{ items: KnowledgeDocItem[] }>('/knowledge/trash')
      .then((res) => setItems(res.items))
      .catch(() => setError('Could not reach the API. Is the backend running on :4000?'))
  }

  useEffect(fetchTrash, [])

  async function handleRestore(id: string) {
    setBusyId(id)
    try {
      await api.post(`/knowledge/${id}/restore`)
      fetchTrash()
    } finally {
      setBusyId(null)
    }
  }

  async function handleDeleteForever(id: string, title: string) {
    if (!window.confirm(`Permanently delete "${title}"? This can't be undone.`)) return
    setBusyId(id)
    try {
      await api.delete(`/knowledge/${id}`)
      fetchTrash()
    } finally {
      setBusyId(null)
    }
  }

  if (error) return <div className="text-sm text-red-700">{error}</div>

  return (
    <>
      <Link to="/app/knowledge" className="mb-5 inline-block text-sm font-semibold text-muted hover:text-accent">
        ← Back to Knowledge Base
      </Link>

      <div className="mb-7">
        <h1 className="font-display text-[28px] font-bold">Trash</h1>
        <p className="mt-1 text-sm text-muted">
          {items ? `${items.length} item${items.length === 1 ? '' : 's'} in trash.` : 'Loading…'} Restore an item or delete it
          permanently — trashed items don't count toward your Knowledge Base or show up in Ask The Record.
        </p>
      </div>

      {!items ? (
        <div className="text-sm text-muted">Loading trash…</div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card px-4.5 py-6 text-sm text-muted">Trash is empty.</div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {items.map((doc) => (
            <div
              key={doc.id}
              className="flex items-center gap-3.5 rounded-2xl border border-border bg-card px-4.5 py-3.5"
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
              <div className="flex-shrink-0 text-[11.5px] text-muted">
                Deleted {doc.deletedAt ? timeAgo(doc.deletedAt) : ''}
              </div>
              <button
                onClick={() => handleRestore(doc.id)}
                disabled={busyId === doc.id}
                className="flex-shrink-0 rounded-lg border border-border px-3 py-1.5 text-[13px] font-semibold text-muted hover:border-accent hover:text-accent disabled:opacity-40"
              >
                Restore
              </button>
              <button
                onClick={() => handleDeleteForever(doc.id, doc.title)}
                disabled={busyId === doc.id}
                className="flex-shrink-0 rounded-lg border border-border px-3 py-1.5 text-[13px] font-semibold text-red-700 hover:border-red-700 disabled:opacity-40"
              >
                Delete forever
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
