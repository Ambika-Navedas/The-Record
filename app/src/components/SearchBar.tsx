import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type SearchResponse } from '../lib/api'

const statusLabel: Record<string, string> = {
  on_track: 'On track',
  attention: 'Needs attention',
  blocked: 'Blocked',
}

const typeLabel: Record<string, string> = {
  sop: 'SOP',
  meeting_note: 'Meeting note',
  decision: 'Decision',
  faq: 'FAQ',
}

const EMPTY: SearchResponse = { projects: [], meetings: [], documents: [] }

export function SearchBar() {
  const navigate = useNavigate()
  const containerRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<SearchResponse>(EMPTY)

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setResults(EMPTY)
      setLoading(false)
      return
    }
    setLoading(true)
    const timer = setTimeout(() => {
      api
        .get<SearchResponse>(`/search?q=${encodeURIComponent(trimmed)}`)
        .then(setResults)
        .catch(() => setResults(EMPTY))
        .finally(() => setLoading(false))
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function goTo(path: string) {
    navigate(path)
    setOpen(false)
    setQuery('')
  }

  const hasAnyResults = results.projects.length + results.meetings.length + results.documents.length > 0
  const trimmed = query.trim()

  return (
    <div ref={containerRef} className="relative ml-5 w-[300px]">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-page px-3 py-2.5 text-[13px] text-muted transition-shadow focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--color-accent-tint)]">
        🔍
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder="Search projects, docs, meetings…"
          className="w-full bg-transparent text-ink outline-none placeholder:text-muted"
        />
      </div>

      {open && trimmed && (
        <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 max-h-[420px] overflow-y-auto rounded-lg border border-border bg-white shadow-[0_20px_50px_-20px_rgba(27,28,34,0.25)]">
          {loading ? (
            <div className="px-4 py-3 text-[13px] text-muted">Searching…</div>
          ) : !hasAnyResults ? (
            <div className="px-4 py-3 text-[13px] text-muted">No results for "{trimmed}"</div>
          ) : (
            <>
              {results.projects.length > 0 && (
                <div className="border-b border-border py-2">
                  <div className="px-4 pb-1 text-[11px] font-bold uppercase tracking-wide text-lmuted">Projects</div>
                  {results.projects.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => goTo('/app/projects')}
                      className="flex w-full items-center justify-between px-4 py-2 text-left text-[13px] hover:bg-page"
                    >
                      <span className="font-semibold">{p.name}</span>
                      <span className="text-xs text-muted">{statusLabel[p.status] ?? p.status}</span>
                    </button>
                  ))}
                </div>
              )}
              {results.meetings.length > 0 && (
                <div className="border-b border-border py-2 last:border-b-0">
                  <div className="px-4 pb-1 text-[11px] font-bold uppercase tracking-wide text-lmuted">Meetings</div>
                  {results.meetings.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => goTo('/app/meetings')}
                      className="flex w-full items-center justify-between px-4 py-2 text-left text-[13px] hover:bg-page"
                    >
                      <span className="font-semibold">{m.title}</span>
                      <span className="text-xs text-muted">{new Date(m.scheduledAt).toLocaleDateString()}</span>
                    </button>
                  ))}
                </div>
              )}
              {results.documents.length > 0 && (
                <div className="py-2">
                  <div className="px-4 pb-1 text-[11px] font-bold uppercase tracking-wide text-lmuted">Knowledge Base</div>
                  {results.documents.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => goTo('/app/knowledge')}
                      className="flex w-full items-center justify-between px-4 py-2 text-left text-[13px] hover:bg-page"
                    >
                      <span className="font-semibold">{d.title}</span>
                      <span className="text-xs text-muted">{typeLabel[d.type] ?? d.type}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
