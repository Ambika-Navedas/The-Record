import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, API_BASE_URL, type KnowledgeDocItem } from '../lib/api'

const typeIcon: Record<string, string> = {
  sop: '📋',
  meeting_note: '🎙️',
  decision: '⚖️',
  faq: '❓',
  email: '📧',
  file: '📎',
}

const typeLabel: Record<string, string> = {
  sop: 'SOP',
  meeting_note: 'Meeting note',
  decision: 'Decision',
  faq: 'FAQ',
  email: 'Email',
  file: 'File',
}

// Matches meeting assets' MeetingDetailPage.tsx convention: bytes → the largest unit that keeps
// the number readable, one decimal place past KB.
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// A line that should start its own displayed line rather than get folded into the
// previous one — a bullet, a mail header field ("From: ...", "Subject: ..."), or a
// forwarded-message divider ("---------- Forwarded message ---------").
function startsNewLine(line: string): boolean {
  // "Next steps <Name>" is a literal marker in these synced emails (see meetings/backend.md's
  // auto-task-extraction, which keys off the same string) — like the mail-header fields, it
  // isn't preceded by a blank line in the source, but is meant to read as its own line.
  return /^-\s/.test(line) || /^-{3,}/.test(line) || /^[A-Z][\w '-]*:\s?\S/.test(line) || /^Next steps\b/.test(line)
}

// Synced email excerpts are plain-text bodies Gmail hard-wrapped at ~72 characters — every
// visual line ends in a real '\n' (and often a trailing '\r'), regardless of the page's actual
// width. Rendering that verbatim with `whitespace-pre-wrap` reproduces the same ~72-character
// column no matter how wide its container is, which is what left the right side of this page
// looking blank. Reflowing collapses each hard-wrapped line back into the sentence it was part
// of — except bullets and header fields, which are semantically separate lines even when the
// source has no blank line between them (mail headers) or continue onto an unmarked next line
// (a wrapped bullet) — so those still break where they should.
function reflow(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: string[] = []
  let current: string[] = []

  function flush() {
    if (current.length > 0) {
      blocks.push(current.join(' '))
      current = []
    }
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') {
      flush()
      continue
    }
    if (startsNewLine(line)) flush()
    current.push(line)
  }
  flush()

  return blocks.join('\n\n')
}

export function KnowledgeDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [doc, setDoc] = useState<KnowledgeDocItem | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    setDoc(null)
    api
      .get<KnowledgeDocItem>(`/knowledge/${id}`)
      .then(setDoc)
      .catch(() => setError('Could not load this document. Is the backend running on :4000?'))
  }, [id])

  if (error) return <div className="text-sm text-red-700">{error}</div>
  if (!doc) return <div className="text-sm text-muted">Loading…</div>

  return (
    <>
      <Link to="/app/knowledge" className="mb-5 inline-block text-sm font-semibold text-muted hover:text-accent">
        ← Back to Knowledge Base
      </Link>

      <div className="mb-2 flex items-start justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-page text-base text-muted">
            {typeIcon[doc.type]}
          </div>
          <div>
            <h1 className="font-display text-[22px] font-bold leading-tight">{doc.title}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
              <span className="font-semibold">{typeLabel[doc.type]}</span>
              {doc.project && (
                <span className="rounded-full border border-border bg-page px-2 py-0.5 font-semibold">{doc.project}</span>
              )}
              <span>· {doc.owner}</span>
              <span className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${doc.isFresh ? 'bg-green' : 'bg-[#C6C7D0]'}`} />
                Updated{' '}
                {new Date(doc.updatedAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-border bg-card p-6">
        {doc.hasFile ? (
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-page text-base text-muted">
              📎
            </div>
            <div className="flex-1">
              <div className="text-sm font-semibold text-ink">{doc.fileName}</div>
              {doc.sizeBytes !== null && <div className="text-xs text-muted">{formatFileSize(doc.sizeBytes)}</div>}
            </div>
            <a
              href={`${API_BASE_URL}/knowledge/${doc.id}/download`}
              className="rounded-lg border border-border bg-white px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-page"
            >
              Download
            </a>
          </div>
        ) : doc.excerpt ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{reflow(doc.excerpt)}</p>
        ) : (
          <p className="text-[13px] text-muted">No content on this document.</p>
        )}
      </div>
    </>
  )
}
