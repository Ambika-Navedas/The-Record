import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { api, ApiError, type ReminderItem } from '../lib/api'

function formatDueDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function RemindersPage() {
  const { user } = useAuth()

  const [reminders, setReminders] = useState<ReminderItem[] | null>(null)
  const [text, setText] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function fetchReminders() {
    api
      .get<{ items: ReminderItem[] }>('/reminders')
      .then((res) => setReminders(res.items))
      .catch(() => {})
  }

  useEffect(fetchReminders, [])

  if (!user) return null

  async function handleAdd(e: FormEvent) {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed) return
    setError(null)
    setAdding(true)
    try {
      // dueAt is a "YYYY-MM-DDTHH:mm" local-time string from the datetime-local input, or ''
      // if left blank — a plain note with no due date, which never auto-notifies.
      await api.post('/reminders', { text: trimmed, dueAt: dueAt ? new Date(dueAt).toISOString() : undefined })
      setText('')
      setDueAt('')
      fetchReminders()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that reminder.')
    } finally {
      setAdding(false)
    }
  }

  async function handleDelete(id: string) {
    await api.delete(`/reminders/${id}`).catch(() => {})
    fetchReminders()
  }

  return (
    <>
      <div className="mb-7">
        <h1 className="font-display text-[28px] font-bold">Reminders</h1>
        <p className="mt-1 text-sm text-muted">
          Personal — only visible to you. Add a due date to get a notification once it's time; leave it blank for a plain note.
        </p>
      </div>

      <div className="flex max-w-xl flex-col gap-5">
        <div className="rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-3 font-display text-base font-bold">Your reminders</h2>
          {!reminders ? (
            <div className="text-sm text-muted">Loading…</div>
          ) : reminders.length === 0 ? (
            <div className="text-sm text-muted">No reminders yet.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {reminders.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between rounded-lg border border-border bg-page px-3 py-2.5"
                >
                  <div>
                    <div className="text-sm font-semibold text-ink">{r.text}</div>
                    {r.dueAt && <div className="mt-0.5 text-xs text-muted">Due {formatDueDate(r.dueAt)}</div>}
                  </div>
                  <button
                    onClick={() => handleDelete(r.id)}
                    className="text-xs font-semibold text-muted hover:text-red-700"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-3 font-display text-base font-bold">Add a reminder</h2>
          <form onSubmit={handleAdd}>
            <label className="mb-1.5 block text-[13px] font-semibold text-muted">What do you want to remember?</label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              placeholder="e.g. Follow up with the vendor"
              className="mb-3.5 w-full resize-none rounded-lg border border-border bg-white px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            />
            <label className="mb-1.5 block text-[13px] font-semibold text-muted">Due date &amp; time (optional)</label>
            <input
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              className="mb-3.5 w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            />
            {error && <div className="mb-3.5 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>}
            <button
              type="submit"
              disabled={adding || !text.trim()}
              className="rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {adding ? 'Adding…' : 'Add reminder'}
            </button>
          </form>
        </div>
      </div>
    </>
  )
}
