import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { api, ApiError, type OrgUser, type ProjectItem, type ProjectsResponse } from '../lib/api'

const statusLabel: Record<string, string> = {
  on_track: 'On track',
  attention: 'Needs attention',
  blocked: 'Blocked',
}

const statusOptions = [
  { value: 'on_track', label: 'On track' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'blocked', label: 'Blocked' },
] as const

const filters = [
  { key: 'all', label: 'All' },
  { key: 'on_track', label: 'On track' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'blocked', label: 'Blocked' },
] as const

const sortOptions = [
  { key: 'updated_desc', label: 'Recently updated' },
  { key: 'name_asc', label: 'Name (A-Z)' },
  { key: 'status', label: 'Status' },
] as const

// Needs-attention/blocked projects surface before on-track ones when sorting by status.
const statusSortWeight: Record<string, number> = { attention: 0, blocked: 1, on_track: 2 }

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const hours = diffMs / 3_600_000
  if (hours < 1) return 'just now'
  if (hours < 24) return `Updated ${Math.round(hours)}h ago`
  return `Updated ${Math.round(hours / 24)}d ago`
}

interface ProjectFormState {
  name: string
  description: string
  status: string
  ownerId: string
  gitUrl: string
  deploymentUrl: string
  username: string
  password: string
}

const EMPTY_FORM: ProjectFormState = {
  name: '',
  description: '',
  status: 'on_track',
  ownerId: '',
  gitUrl: '',
  deploymentUrl: '',
  username: '',
  password: '',
}

export function ProjectsPage() {
  const { user } = useAuth()
  const [filter, setFilter] = useState<(typeof filters)[number]['key']>('all')
  const [sort, setSort] = useState<(typeof sortOptions)[number]['key']>('updated_desc')
  const [data, setData] = useState<ProjectsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [users, setUsers] = useState<OrgUser[]>([])

  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null)
  // Mirrors modalMode but only ever updates to a non-null value — modalMode itself drives the
  // drawer's open/closed transform (see below), while this drives which content it shows. Without
  // this, the drawer's title/fields would flip to their fallback branch the instant modalMode goes
  // null on close, which — now that the panel is always mounted for the slide-out transition to
  // play — would be visible as a flicker during the close animation instead of invisible.
  const [displayMode, setDisplayMode] = useState<'create' | 'edit' | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  // Who owns the project currently open in the drawer — captured at open time, independent of
  // `form.ownerId` (which the read-only view keeps disabled, but this is what decides *whether*
  // it's disabled in the first place, so it can't depend on the field it's gating).
  const [editingOwnerId, setEditingOwnerId] = useState<string | null>(null)
  const [form, setForm] = useState<ProjectFormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  // Create-only — attaches documents at project-creation time (see handleSubmit). Not offered
  // on edit, direct request was specifically "while creating the project details." Array, not a
  // single File — direct follow-up: "there is no option to add multiple doc."
  const [docFiles, setDocFiles] = useState<File[]>([])

  // View-only when opened on someone else's project — direct request: "it can't be editable
  // except the owner." Always editable while creating (there's no owner yet to defer to).
  const canEdit = displayMode === 'create' || editingOwnerId === user?.id

  function fetchProjects() {
    api
      .get<ProjectsResponse>(`/projects?status=${filter}`)
      .then(setData)
      .catch(() => setError('Could not reach the API. Is the backend running on :4000?'))
  }

  useEffect(() => {
    setData(null)
    fetchProjects()
  }, [filter])

  useEffect(() => {
    if (modalMode) setDisplayMode(modalMode)
  }, [modalMode])

  useEffect(() => {
    api
      .get<{ items: OrgUser[] }>('/users')
      .then((res) => setUsers(res.items))
      .catch(() => {})
  }, [])

  function openCreate() {
    setForm(EMPTY_FORM)
    setDocFiles([])
    setFormError(null)
    setModalMode('create')
  }

  function openEdit(p: ProjectItem) {
    setEditingId(p.id)
    setEditingOwnerId(p.owner.id)
    setForm({
      name: p.name,
      description: p.description,
      status: p.status,
      ownerId: p.owner.id,
      gitUrl: p.gitUrl,
      deploymentUrl: p.deploymentUrl,
      username: p.username,
      password: p.password,
    })
    setFormError(null)
    setModalMode('edit')
  }

  function closeModal() {
    if (saving) return
    setModalMode(null)
    setEditingId(null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canEdit) return
    const trimmedName = form.name.trim()
    if (!trimmedName) return
    setSaving(true)
    setFormError(null)
    try {
      if (modalMode === 'create') {
        // Multipart, not JSON — the optional document file has to ride along in the same
        // request as the rest of the fields (see projects.ts's POST '/', which now expects
        // multipart for exactly this reason). All fields still go through as plain strings,
        // multer parses them into req.body the same way JSON would have.
        const formData = new FormData()
        formData.append('name', trimmedName)
        formData.append('description', form.description.trim())
        formData.append('status', form.status)
        if (form.ownerId) formData.append('ownerId', form.ownerId)
        formData.append('gitUrl', form.gitUrl.trim())
        formData.append('deploymentUrl', form.deploymentUrl.trim())
        formData.append('username', form.username.trim())
        formData.append('password', form.password)
        docFiles.forEach((f) => formData.append('files', f))
        await api.upload('/projects', formData)
      } else if (modalMode === 'edit' && editingId) {
        await api.patch(`/projects/${editingId}`, {
          name: trimmedName,
          description: form.description.trim(),
          status: form.status,
          ownerId: form.ownerId || undefined,
          gitUrl: form.gitUrl.trim(),
          deploymentUrl: form.deploymentUrl.trim(),
          username: form.username.trim(),
          password: form.password,
        })
      }
      setModalMode(null)
      setEditingId(null)
      setDocFiles([])
      fetchProjects()
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Is the API server running?')
    } finally {
      setSaving(false)
    }
  }

  const sortedItems = data
    ? [...data.items].sort((a, b) => {
        if (sort === 'name_asc') return a.name.localeCompare(b.name)
        if (sort === 'status') return statusSortWeight[a.status] - statusSortWeight[b.status]
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      })
    : []

  if (error) return <div className="text-sm text-red-700">{error}</div>

  return (
    <>
      <div className="mb-7 flex items-start justify-between">
        <div>
          <h1 className="font-display text-[28px] font-bold">All projects</h1>
          <p className="mt-1 text-sm text-muted">
            {data ? `${data.counts.all} projects across your org — ${data.counts.on_track ?? 0} on track, ${
              data.counts.attention ?? 0
            } need attention, ${data.counts.blocked ?? 0} blocked.` : 'Loading…'}
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-2.5 text-[13px] font-semibold text-white shadow-[0_6px_16px_-6px_rgba(52,87,213,0.5)] transition-transform hover:-translate-y-px"
        >
          + New project
        </button>
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
              {f.label} · {data?.counts[f.key] ?? 0}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-sm text-muted">
          Sort:
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as (typeof sortOptions)[number]['key'])}
            className="cursor-pointer bg-transparent font-semibold text-muted focus-visible:outline-none"
          >
            {sortOptions.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!data ? (
        <div className="text-sm text-muted">Loading projects…</div>
      ) : (
        <div className="grid grid-cols-4 gap-4">
          {sortedItems.map((p) => (
            <button
              key={p.id}
              onClick={() => openEdit(p)}
              className="rounded-2xl border border-border bg-card p-5 text-left transition-all hover:-translate-y-0.5 hover:shadow-[0_20px_40px_-24px_rgba(27,28,34,0.22)]"
            >
              <div className="mb-3 flex items-start justify-between">
                <div className="font-display text-[15px] font-bold">{p.name}</div>
                <span
                  className={`whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-bold ${
                    p.status === 'on_track' ? 'bg-green-tint text-green' : 'bg-[#F0F0F3] text-muted'
                  }`}
                >
                  {statusLabel[p.status]}
                </span>
              </div>
              {p.description && (
                <div className="mb-3 line-clamp-2 text-xs leading-relaxed text-muted">{p.description}</div>
              )}
              <div className="mb-3.5 flex items-center justify-between text-xs text-muted">
                <span>
                  <strong className="font-bold text-ink">{p.docCount}</strong> docs
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#4B4C58] text-[9px] font-bold text-white">
                    {p.owner.initials}
                  </span>
                  {p.owner.name}
                </div>
              </div>
              <div className="flex items-center gap-1.5 border-t border-border pt-3">
                <span className={`h-2 w-2 rounded-full ${p.status === 'on_track' ? 'bg-green' : 'bg-[#C6C7D0]'}`} />
                <span className="text-xs font-semibold text-muted">{timeAgo(p.updatedAt)}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Right-side drawer, not a centered modal — direct request. Always mounted (unlike the
          old conditionally-rendered modal) so the slide-in/out transform actually has something
          to animate; visibility is driven by translate-x/opacity classes keyed on `modalMode`,
          same pattern as ChatDrawer.tsx's own right-side panel. */}
      <div
        onClick={closeModal}
        className={`fixed inset-0 z-[200] bg-ink/25 transition-opacity ${
          modalMode ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <div
        role="dialog"
        aria-label={displayMode === 'create' ? 'New project' : 'Edit project'}
        className={`fixed right-0 top-0 z-[201] flex h-full w-[480px] max-w-[92vw] flex-col bg-white shadow-[-16px_0_40px_-20px_rgba(27,28,34,0.35)] transition-transform duration-250 ease-out ${
          modalMode ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="border-b border-border px-6 py-5">
          <h2 className="mb-1 font-display text-lg font-bold">
            {displayMode === 'create' ? 'New project' : canEdit ? 'Edit project' : 'View project'}
          </h2>
          <p className="text-sm text-muted">
            {displayMode === 'create'
              ? 'Give it a name, a bit of context, an owner, and a status.'
              : canEdit
                ? 'Update any of the details below.'
                : 'Only the project owner can make changes here.'}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <form onSubmit={handleSubmit}>
            <label className="mb-1.5 block text-[13px] font-semibold">Project name</label>
            <input
              autoFocus
              disabled={!canEdit}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Vendor Onboarding"
              className="mb-3.5 w-full rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-70"
            />

            <label className="mb-1.5 block text-[13px] font-semibold">Description</label>
            <textarea
              disabled={!canEdit}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="What is this project about?"
              rows={3}
              className="mb-3.5 w-full resize-none rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-70"
            />

            {displayMode === 'create' && (
              <>
                <label className="mb-1.5 block text-[13px] font-semibold">Attach documents (optional)</label>
                <input
                  type="file"
                  multiple
                  onChange={(e) => {
                    const picked = Array.from(e.target.files ?? [])
                    e.target.value = '' // lets the same file be re-picked later, and resets the native "N files" label
                    setDocFiles((prev) => [...prev, ...picked])
                  }}
                  className="mb-2 w-full rounded-lg border border-border bg-page px-3 py-2 text-[13px] file:mr-3 file:rounded-md file:border-0 file:bg-white file:px-2.5 file:py-1 file:text-[12px] file:font-semibold file:text-ink"
                />
                {docFiles.length > 0 && (
                  <div className="mb-3.5 flex flex-col gap-1">
                    {docFiles.map((f, i) => (
                      <div
                        key={`${f.name}-${f.size}-${i}`}
                        className="flex items-center justify-between gap-2 rounded-lg border border-border bg-page px-3 py-1.5 text-[12.5px]"
                      >
                        <span className="truncate">{f.name}</span>
                        <button
                          type="button"
                          onClick={() => setDocFiles((prev) => prev.filter((_, idx) => idx !== i))}
                          className="flex-shrink-0 text-muted hover:text-red-700"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            <div className="mb-3.5 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-[13px] font-semibold">Status</label>
                <select
                  disabled={!canEdit}
                  value={form.status}
                  onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {statusOptions.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-[13px] font-semibold">Owner</label>
                <select
                  disabled={!canEdit}
                  value={form.ownerId}
                  onChange={(e) => setForm((f) => ({ ...f, ownerId: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-70"
                >
                  <option value="">Me</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <label className="mb-1.5 block text-[13px] font-semibold">Git URL</label>
            <input
              disabled={!canEdit}
              value={form.gitUrl}
              onChange={(e) => setForm((f) => ({ ...f, gitUrl: e.target.value }))}
              placeholder="https://github.com/org/repo"
              className="mb-3.5 w-full rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-70"
            />

            <label className="mb-1.5 block text-[13px] font-semibold">Deployment URL</label>
            <input
              disabled={!canEdit}
              value={form.deploymentUrl}
              onChange={(e) => setForm((f) => ({ ...f, deploymentUrl: e.target.value }))}
              placeholder="https://staging.example.com"
              className="mb-3.5 w-full rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-70"
            />

            <div className="mb-3.5 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-[13px] font-semibold">Username</label>
                <input
                  disabled={!canEdit}
                  value={form.username}
                  onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-70"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[13px] font-semibold">Password</label>
                <input
                  type="text"
                  disabled={!canEdit}
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-70"
                />
              </div>
            </div>

            {formError && <div className="mb-3.5 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{formError}</div>}

            <div className="mt-1 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeModal}
                disabled={saving}
                className="rounded-lg border border-border px-4 py-2 text-sm font-semibold disabled:opacity-60"
              >
                {canEdit ? 'Cancel' : 'Close'}
              </button>
              {canEdit && (
                <button
                  type="submit"
                  disabled={saving || !form.name.trim()}
                  className="rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {saving ? 'Saving…' : displayMode === 'create' ? 'Create project' : 'Save changes'}
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
