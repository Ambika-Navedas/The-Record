import { useState, type FormEvent } from 'react'

interface ReasonModalProps {
  title: string
  description?: string
  confirmLabel?: string
  onCancel: () => void
  onSubmit: (reason: string) => void
}

// Centered modal replacement for window.prompt() — native prompts render docked to the top of
// the browser chrome (no CSS can move them), which read as broken next to the rest of this app's
// centered dialogs (see the "Invite teammate" modal in MeetingDetailPage.tsx, whose overlay/box
// styling this mirrors exactly).
export function ReasonModal({ title, description, confirmLabel = 'Save', onCancel, onSubmit }: ReasonModalProps) {
  const [value, setValue] = useState('')

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!value.trim()) return
    onSubmit(value.trim())
  }

  return (
    <>
      <div className="fixed inset-0 z-[200] bg-ink/25" onClick={onCancel} />
      <div className="fixed left-1/2 top-1/2 z-[201] w-[400px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-[0_30px_80px_-30px_rgba(27,28,34,0.35)]">
        <h2 className="mb-1 font-display text-lg font-bold">{title}</h2>
        {description && <p className="mb-4 text-sm text-muted">{description}</p>}
        <form onSubmit={handleSubmit}>
          <textarea
            autoFocus
            rows={3}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className={`w-full resize-none rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
              description ? 'mb-3.5' : 'mt-3.5 mb-3.5'
            }`}
          />
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" onClick={onCancel} className="rounded-lg border border-border px-4 py-2 text-sm font-semibold">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!value.trim()}
              className="rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
