import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ConfirmationToast } from '../components/ConfirmationToast'
import { InviteMemberButton } from '../components/InviteMemberModal'
import { ReasonModal } from '../components/ReasonModal'
import { useAuth } from '../context/AuthContext'
import { api, ApiError, API_BASE_URL, type MeetingDetail, type MeetingTask, type OrgUser, type TaskActivityEntry } from '../lib/api'

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

// task_activity.created_at is SQLite's 'YYYY-MM-DD HH:MM:SS' (UTC, no timezone marker) — needs
// the 'T' + 'Z' treatment to parse as the UTC instant it actually is, not local time.
function formatDateTime(iso: string): string {
  const withZone = iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`
  return new Date(withZone).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const sourceLabel: Record<string, string> = {
  zoom: 'Zoom',
  google_meet: 'Google Meet',
  email_sync: 'From synced email',
}

export function MeetingDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [users, setUsers] = useState<OrgUser[]>([])

  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const [taskTitle, setTaskTitle] = useState('')
  const [taskAssignee, setTaskAssignee] = useState('')
  const [taskDueDate, setTaskDueDate] = useState('')
  const [addingTask, setAddingTask] = useState(false)
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set())
  const [taskActivity, setTaskActivity] = useState<Record<string, TaskActivityEntry[]>>({})
  const [pendingReason, setPendingReason] = useState<PendingReason | null>(null)
  const [confirmation, setConfirmation] = useState<string | null>(null)

  function fetchMeeting() {
    if (!id) return
    api
      .get<MeetingDetail>(`/meetings/${id}`)
      .then(setMeeting)
      .catch(() => setError('Could not load this meeting. Is the backend running on :4000?'))
  }

  function fetchUsers() {
    api
      .get<{ items: OrgUser[] }>('/users')
      .then((res) => setUsers(res.items))
      .catch(() => {})
  }

  useEffect(fetchMeeting, [id])
  useEffect(fetchUsers, [])

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !id) return
    setUploading(true)
    setUploadError(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      await api.upload(`/meetings/${id}/assets`, formData)
      fetchMeeting()
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : 'Upload failed.')
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  async function handleDeleteAsset(assetId: string) {
    if (!id) return
    await api.delete(`/meetings/${id}/assets/${assetId}`).catch(() => {})
    fetchMeeting()
  }

  async function handleAddTask(e: React.FormEvent) {
    e.preventDefault()
    if (!id || !taskTitle.trim()) return
    setAddingTask(true)
    try {
      await api.post(`/meetings/${id}/tasks`, {
        title: taskTitle.trim(),
        assigneeId: taskAssignee || undefined,
        dueDate: taskDueDate || undefined,
      })
      setTaskTitle('')
      setTaskAssignee('')
      setTaskDueDate('')
      fetchMeeting()
    } finally {
      setAddingTask(false)
    }
  }

  // Only the task's assignee can mark it done — unassigned tasks are locked until someone
  // assigns them. Same rule as TasksPage.tsx's canToggle(), enforced for real on the backend.
  function canToggleTask(task: MeetingTask): boolean {
    return !!task.assignee && task.assignee.id === user?.id
  }

  async function submitTaskDone(taskId: string, note: string) {
    if (!id) return
    setPendingReason(null)
    try {
      await api.patch(`/meetings/${id}/tasks/${taskId}`, { done: true, note })
      setConfirmation('Task marked done.')
      fetchMeeting()
      if (expandedTasks.has(taskId)) loadTaskActivity(taskId)
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not update the task.')
      fetchMeeting()
    }
  }

  async function handleToggleTask(taskId: string, done: boolean) {
    if (!id) return
    if (done) {
      // A checkbox's native `checked` flips the instant it's clicked, before onChange runs — since
      // opening the modal doesn't itself change any state, cancelling needs an explicit fetchMeeting()
      // to force a re-render that snaps the (controlled) checkbox back to its real, unchanged value.
      setPendingReason({
        title: 'What did you do to complete this task?',
        confirmLabel: 'Mark done',
        onSubmit: (note) => submitTaskDone(taskId, note),
        onCancel: () => {
          setPendingReason(null)
          fetchMeeting()
        },
      })
      return
    }
    try {
      await api.patch(`/meetings/${id}/tasks/${taskId}`, { done })
      fetchMeeting()
      if (expandedTasks.has(taskId)) loadTaskActivity(taskId)
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not update the task.')
      fetchMeeting()
    }
  }

  function loadTaskActivity(taskId: string) {
    if (!id) return
    api
      .get<{ items: TaskActivityEntry[] }>(`/meetings/${id}/tasks/${taskId}/activity`)
      .then((res) => setTaskActivity((prev) => ({ ...prev, [taskId]: res.items })))
      .catch(() => {})
  }

  function toggleTaskHistory(taskId: string) {
    setExpandedTasks((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) {
        next.delete(taskId)
      } else {
        next.add(taskId)
        if (!taskActivity[taskId]) loadTaskActivity(taskId)
      }
      return next
    })
  }

  if (error) return <div className="text-sm text-red-700">{error}</div>
  if (!meeting) return <div className="text-sm text-muted">Loading meeting…</div>

  return (
    <>
      <Link to="/app/meetings" className="mb-5 inline-block text-sm font-semibold text-muted hover:text-accent">
        ← Back to meetings
      </Link>

      <div className="mb-7 flex items-start justify-between">
        <div>
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <h1 className="font-display text-[26px] font-bold">{meeting.title}</h1>
            {meeting.project && (
              <span className="rounded-full border border-border bg-page px-2.5 py-1 text-[11px] font-semibold text-muted">
                {meeting.project}
              </span>
            )}
            {sourceLabel[meeting.source] && (
              <span className="rounded-full border border-border bg-accent-tint px-2.5 py-1 text-[11px] font-semibold text-accent">
                {sourceLabel[meeting.source]}
              </span>
            )}
          </div>
          <p className="text-sm text-muted">
            {new Date(meeting.scheduledAt).toLocaleString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}{' '}
            · {meeting.durationMin}m
          </p>
        </div>
        <span
          className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold ${
            meeting.syncStatus === 'synced' ? 'bg-green-tint text-green' : 'bg-[#F0F0F3] text-muted'
          }`}
        >
          {meeting.syncStatus === 'synced' ? 'Synced' : meeting.syncStatus === 'processing' ? 'Processing' : 'Failed'}
        </span>
      </div>

      {meeting.summary && <p className="mb-6 max-w-2xl text-sm leading-relaxed text-muted">{meeting.summary}</p>}

      {meeting.participants.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-2 text-[13px] font-semibold text-muted">Participants</h2>
          <div className="flex flex-wrap gap-2">
            {meeting.participants.map((p, i) => (
              <span
                key={p.userId ?? p.email ?? i}
                className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[12.5px] font-semibold"
                title={p.email ?? undefined}
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#4B4C58] text-[9px] font-bold text-white">
                  {p.initials ?? p.name.charAt(0).toUpperCase()}
                </span>
                {p.name}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-6">
        <section className="rounded-2xl border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-base font-bold">Assets</h2>
            <label className="cursor-pointer rounded-lg border border-border px-3 py-1.5 text-[13px] font-semibold text-muted transition-colors hover:border-accent hover:text-accent">
              {uploading ? 'Uploading…' : '+ Upload recording'}
              <input type="file" className="hidden" onChange={handleUpload} disabled={uploading} />
            </label>
          </div>
          {uploadError && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{uploadError}</div>}
          {meeting.assets.length === 0 ? (
            <p className="text-[13px] text-muted">No assets yet — upload a recording or other file from this meeting.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {meeting.assets.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold">{a.filename}</div>
                    <div className="text-[11px] text-muted">
                      {formatBytes(a.sizeBytes)} · {a.uploadedBy.name}
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-3">
                    <a
                      href={`${API_BASE_URL}/meetings/${id}/assets/${a.id}/download`}
                      className="text-[12px] font-semibold text-accent"
                    >
                      Download
                    </a>
                    <button
                      onClick={() => handleDeleteAsset(a.id)}
                      className="text-[12px] font-semibold text-muted hover:text-red-700"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-4 font-display text-base font-bold">Tasks</h2>
          <form onSubmit={handleAddTask} className="mb-4 flex flex-col gap-2">
            <input
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              placeholder="New task…"
              className="rounded-lg border border-border bg-page px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                value={taskAssignee}
                onChange={(e) => setTaskAssignee(e.target.value)}
                className="rounded-lg border border-border bg-page px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.initials} · {u.name.split(' ')[0]}
                  </option>
                ))}
              </select>
              <input
                type="date"
                value={taskDueDate}
                onChange={(e) => setTaskDueDate(e.target.value)}
                className="rounded-lg border border-border bg-page px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              />
            </div>
            <div className="flex items-center justify-between">
              {isAdmin ? <InviteMemberButton onInvited={fetchUsers} /> : <div />}
              <button
                type="submit"
                disabled={addingTask || !taskTitle.trim()}
                className="rounded-lg bg-gradient-to-br from-accent to-accent-2 px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
              >
                {addingTask ? 'Adding…' : 'Add task'}
              </button>
            </div>
          </form>
          {meeting.tasks.length === 0 ? (
            <p className="text-[13px] text-muted">No tasks yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {meeting.tasks.map((t) => (
                <li key={t.id} className="rounded-lg border border-border px-3 py-2.5">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={t.done}
                      disabled={!canToggleTask(t)}
                      title={
                        canToggleTask(t)
                          ? undefined
                          : t.assignee
                            ? `Only ${t.assignee.name} can mark this done`
                            : 'Assign this task before it can be marked done'
                      }
                      onChange={(e) => handleToggleTask(t.id, e.target.checked)}
                      className="h-4 w-4 flex-shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
                    />
                    <div className="min-w-0 flex-1">
                      <div className={`text-[13px] font-semibold ${t.done ? 'text-muted line-through' : ''}`}>{t.title}</div>
                      <div className="text-[11px] text-muted">
                        {t.assignee ? t.assignee.name : 'Unassigned'}
                        {t.dueDate && ` · Due ${new Date(t.dueDate).toLocaleDateString()}`}
                      </div>
                      {t.done && t.completionNote && <div className="mt-1 text-[11px] italic text-muted">✓ {t.completionNote}</div>}
                    </div>
                    <button
                      onClick={() => toggleTaskHistory(t.id)}
                      className="flex-shrink-0 text-[11px] font-semibold text-muted hover:text-accent"
                    >
                      History {expandedTasks.has(t.id) ? '▴' : '▾'}
                    </button>
                  </div>
                  {expandedTasks.has(t.id) && (
                    <div className="mt-2.5 border-t border-border pt-2.5 pl-[calc(1rem+0.75rem)]">
                      {!taskActivity[t.id] ? (
                        <div className="text-[11px] text-muted">Loading history…</div>
                      ) : taskActivity[t.id].length === 0 ? (
                        <div className="text-[11px] text-muted">No activity yet.</div>
                      ) : (
                        <ul className="flex flex-col gap-1.5">
                          {taskActivity[t.id].map((a) => (
                            <li key={a.id} className="text-[11px] text-muted">
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
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

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
