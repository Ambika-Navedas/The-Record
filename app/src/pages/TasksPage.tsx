import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ConfirmationToast } from '../components/ConfirmationToast'
import { DateRangePicker, type DateRangeValue } from '../components/DateRangePicker'
import { ReasonModal } from '../components/ReasonModal'
import { useAuth } from '../context/AuthContext'
import { api, ApiError, type OrgUser, type TaskActivityEntry, type TaskItem, type TasksResponse } from '../lib/api'

interface PendingReason {
  title: string
  confirmLabel: string
  onSubmit: (reason: string) => void
  onCancel: () => void
}

const activityLabel: Record<TaskActivityEntry['action'], (a: TaskActivityEntry) => string> = {
  assigned: (a) => `${a.actorName} assigned this to ${a.assigneeName}`,
  done: (a) => `${a.actorName} marked this done`,
  reopened: (a) => `${a.actorName} reopened this`,
}

// `key` is the value sent to the backend (`?filter=`); `countKey` is where to read this chip's
// total from `data.counts` — split apart because the wire format matches Meetings' snake_case
// filter convention while counts fields stay camelCase like everything else in this codebase.
const filters = [
  { key: 'all', label: 'All', countKey: 'all' },
  { key: 'open', label: 'Open', countKey: 'open' },
  { key: 'done', label: 'Done', countKey: 'done' },
] as const

// due_date is 'YYYY-MM-DD'; created_at is a SQL 'YYYY-MM-DD HH:MM:SS' timestamp — both parse
// fine as a date-only display, so one helper covers both.
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function isOverdue(t: TaskItem): boolean {
  return !t.done && !!t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10)
}

// task_activity.created_at is SQLite's 'YYYY-MM-DD HH:MM:SS' (UTC, no timezone marker) — needs
// the 'T' + 'Z' treatment to parse as the UTC instant it actually is, not local time.
function formatDateTime(iso: string): string {
  const withZone = iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`
  return new Date(withZone).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function TasksPage() {
  const { user } = useAuth()
  const [filter, setFilter] = useState<(typeof filters)[number]['key']>('all')
  const [assigneeId, setAssigneeId] = useState('')
  const [meetingRange, setMeetingRange] = useState<DateRangeValue | null>(null)
  const [dueRange, setDueRange] = useState<DateRangeValue | null>(null)
  const [users, setUsers] = useState<OrgUser[]>([])
  const [data, setData] = useState<TasksResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [activity, setActivity] = useState<Record<string, TaskActivityEntry[]>>({})
  const [pendingReason, setPendingReason] = useState<PendingReason | null>(null)
  const [confirmation, setConfirmation] = useState<string | null>(null)

  function fetchTasks() {
    setData(null)
    const params = new URLSearchParams({ filter })
    if (assigneeId) params.set('assigneeId', assigneeId)
    if (meetingRange) {
      params.set('meetingFrom', meetingRange.from)
      params.set('meetingTo', meetingRange.to)
    }
    if (dueRange) {
      params.set('dueFrom', dueRange.from)
      params.set('dueTo', dueRange.to)
    }
    api
      .get<TasksResponse>(`/tasks?${params}`)
      .then(setData)
      .catch(() => setError('Could not reach the API. Is the backend running on :4000?'))
  }

  useEffect(fetchTasks, [filter, assigneeId, meetingRange, dueRange])
  useEffect(() => {
    api
      .get<{ items: OrgUser[] }>('/users')
      .then((res) => setUsers(res.items))
      .catch(() => {})
  }, [])

  // Only the task's assignee can mark it done. Unassigned tasks have no "concerned person" yet,
  // so they're locked until someone assigns them — the backend enforces this for real; this is
  // what keeps the checkbox from even being clickable for someone who'd just get rejected.
  function canToggle(task: TaskItem): boolean {
    return !!task.assignee && task.assignee.id === user?.id
  }

  async function submitDone(task: TaskItem, note: string) {
    setPendingReason(null)
    try {
      await api.patch(`/meetings/${task.meetingId}/tasks/${task.id}`, { done: true, note })
      setConfirmation('Task marked done.')
      fetchTasks()
      if (expanded.has(task.id)) loadActivity(task)
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not update the task.')
      fetchTasks()
    }
  }

  async function handleToggle(task: TaskItem, done: boolean) {
    if (done) {
      // A checkbox's native `checked` flips the instant it's clicked, before onChange runs — since
      // opening the modal doesn't itself change any state, cancelling needs an explicit fetchTasks()
      // to force a re-render that snaps the (controlled) checkbox back to its real, unchanged value.
      setPendingReason({
        title: 'What did you do to complete this task?',
        confirmLabel: 'Mark done',
        onSubmit: (note) => submitDone(task, note),
        onCancel: () => {
          setPendingReason(null)
          fetchTasks()
        },
      })
      return
    }
    try {
      await api.patch(`/meetings/${task.meetingId}/tasks/${task.id}`, { done })
      fetchTasks()
      if (expanded.has(task.id)) loadActivity(task)
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not update the task.')
      fetchTasks()
    }
  }

  async function submitAssign(task: TaskItem, assigneeName: string, newAssigneeId: string, reason: string) {
    setPendingReason(null)
    try {
      await api.patch(`/meetings/${task.meetingId}/tasks/${task.id}`, { assigneeId: newAssigneeId, reason })
      setConfirmation(`Task assigned to ${assigneeName}.`)
      fetchTasks()
      if (expanded.has(task.id)) loadActivity(task)
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not update the assignee.')
      fetchTasks()
    }
  }

  async function handleAssign(task: TaskItem, newAssigneeId: string) {
    if (newAssigneeId === (task.assignee?.id ?? '')) return // no real change
    if (!newAssigneeId) {
      // Clearing an assignee needs no justification — nothing to explain.
      try {
        await api.patch(`/meetings/${task.meetingId}/tasks/${task.id}`, { assigneeId: null })
        fetchTasks()
      } catch (err) {
        window.alert(err instanceof ApiError ? err.message : 'Could not update the assignee.')
        fetchTasks()
      }
      return
    }
    const assigneeName = users.find((u) => u.id === newAssigneeId)?.name ?? 'them'
    setPendingReason({
      title: `Why are you assigning this task to ${assigneeName}?`,
      confirmLabel: 'Assign',
      onSubmit: (reason) => submitAssign(task, assigneeName, newAssigneeId, reason),
      onCancel: () => {
        setPendingReason(null)
        fetchTasks() // cancelled — snap the dropdown back to the real, unchanged assignee
      },
    })
  }

  function loadActivity(task: TaskItem) {
    api
      .get<{ items: TaskActivityEntry[] }>(`/meetings/${task.meetingId}/tasks/${task.id}/activity`)
      .then((res) => setActivity((prev) => ({ ...prev, [task.id]: res.items })))
      .catch(() => {})
  }

  function toggleHistory(task: TaskItem) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(task.id)) {
        next.delete(task.id)
      } else {
        next.add(task.id)
        if (!activity[task.id]) loadActivity(task)
      }
      return next
    })
  }

  if (error) return <div className="text-sm text-red-700">{error}</div>

  return (
    <>
      <div className="mb-7">
        <h1 className="font-display text-[28px] font-bold">Tasks</h1>
        <p className="mt-1 text-sm text-muted">
          {data ? `${data.counts.all} task${data.counts.all === 1 ? '' : 's'} across your meetings.` : 'Loading…'}
        </p>
      </div>

      <div className="mb-4.5 flex flex-wrap items-center gap-2">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors ${
              filter === f.key ? 'border-ink bg-ink text-white' : 'border-border bg-white text-muted hover:border-accent hover:text-accent'
            }`}
          >
            {f.label} · {data?.counts[f.countKey] ?? 0}
          </button>
        ))}
        <label className="ml-2 flex items-center gap-1.5 text-sm text-muted">
          Assignee:
          <select
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            className="cursor-pointer rounded-lg border border-border bg-page px-2 py-1 text-[13px] font-semibold text-ink"
          >
            <option value="">Everyone</option>
            <option value="unassigned">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.initials} · {u.name.split(' ')[0]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-muted">
          Meeting date:
          <DateRangePicker value={meetingRange} onChange={setMeetingRange} placeholder="All time" />
        </label>
        <label className="flex items-center gap-1.5 text-sm text-muted">
          Due date:
          <DateRangePicker value={dueRange} onChange={setDueRange} placeholder="All time" />
        </label>
        {(assigneeId || meetingRange || dueRange) && (
          <button
            onClick={() => {
              setAssigneeId('')
              setMeetingRange(null)
              setDueRange(null)
            }}
            className="text-sm font-semibold text-muted hover:text-accent"
          >
            Clear
          </button>
        )}
      </div>

      {!data ? (
        <div className="text-sm text-muted">Loading tasks…</div>
      ) : data.items.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card px-4.5 py-6 text-sm text-muted">No tasks here.</div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {data.items.map((t) => (
            <div key={t.id} className="rounded-2xl border border-border bg-card px-4.5 py-3.5">
              <div className="flex items-center gap-3.5">
                <input
                  type="checkbox"
                  checked={t.done}
                  disabled={!canToggle(t)}
                  title={
                    canToggle(t)
                      ? undefined
                      : t.assignee
                        ? `Only ${t.assignee.name} can mark this done`
                        : 'Assign this task before it can be marked done'
                  }
                  onChange={(e) => handleToggle(t, e.target.checked)}
                  className="h-4 w-4 flex-shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
                />
                <div className="min-w-0 flex-1">
                  <div className={`text-[13.5px] font-semibold ${t.done ? 'text-muted line-through' : ''}`}>{t.title}</div>
                  <div className="text-[11.5px] text-muted">
                    <Link to={`/app/meetings/${t.meetingId}`} className="font-semibold text-muted hover:text-accent">
                      {t.meetingTitle}
                    </Link>
                    {' · '}
                    <select
                      value={t.assignee?.id ?? ''}
                      onChange={(e) => handleAssign(t, e.target.value)}
                      title={t.assignee ? undefined : 'Assign this task before it can be marked done'}
                      className={`cursor-pointer rounded border-0 bg-transparent p-0 text-[11.5px] font-semibold hover:underline ${
                        t.assignee ? 'text-muted' : 'text-red-700'
                      }`}
                    >
                      <option value="">Unassigned</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.initials} · {u.name.split(' ')[0]}
                        </option>
                      ))}
                    </select>
                    {' · '}
                    {t.dueDate ? (
                      <span className={isOverdue(t) ? 'font-semibold text-red-700' : undefined}>
                        Due {formatDate(t.dueDate)}
                      </span>
                    ) : (
                      `Meeting ${formatDate(t.meetingScheduledAt)}`
                    )}
                  </div>
                  {t.done && t.completionNote && (
                    <div className="mt-1 text-[11.5px] italic text-muted">✓ {t.completionNote}</div>
                  )}
                </div>
                <button
                  onClick={() => toggleHistory(t)}
                  className="flex-shrink-0 text-[12px] font-semibold text-muted hover:text-accent"
                >
                  History {expanded.has(t.id) ? '▴' : '▾'}
                </button>
              </div>
              {expanded.has(t.id) && (
                <div className="mt-3 border-t border-border pt-3 pl-[calc(1rem+0.875rem)]">
                  {!activity[t.id] ? (
                    <div className="text-[11.5px] text-muted">Loading history…</div>
                  ) : activity[t.id].length === 0 ? (
                    <div className="text-[11.5px] text-muted">No activity yet.</div>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {activity[t.id].map((a) => (
                        <li key={a.id} className="text-[11.5px] text-muted">
                          <span className="font-semibold text-ink">{activityLabel[a.action](a)}</span>
                          {' · '}
                          {formatDateTime(a.createdAt)}
                          {a.reason && <div className="italic">"{a.reason}"</div>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {pendingReason && (
        <ReasonModal
          title={pendingReason.title}
          confirmLabel={pendingReason.confirmLabel}
          onSubmit={pendingReason.onSubmit}
          onCancel={pendingReason.onCancel}
        />
      )}

      {confirmation && <ConfirmationToast message={confirmation} onDone={() => setConfirmation(null)} />}
    </>
  )
}
