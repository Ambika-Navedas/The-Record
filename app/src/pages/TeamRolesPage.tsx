import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { ConfirmationToast } from '../components/ConfirmationToast'
import { InviteMemberButton } from '../components/InviteMemberModal'
import { useAuth } from '../context/AuthContext'
import { api, ApiError, API_BASE_URL, type TeamMemberProfile, type TeamRoleItem } from '../lib/api'

export function TeamRolesPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [teamRoles, setTeamRoles] = useState<TeamRoleItem[] | null>(null)
  const [roleError, setRoleError] = useState<string | null>(null)
  const [savingRoleFor, setSavingRoleFor] = useState<string | null>(null)
  const [savingStatusFor, setSavingStatusFor] = useState<string | null>(null)

  const [detail, setDetail] = useState<TeamMemberProfile | null>(null)
  const [detailLoadingFor, setDetailLoadingFor] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

  const [pendingDelete, setPendingDelete] = useState<TeamRoleItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [confirmation, setConfirmation] = useState<string | null>(null)

  function fetchTeamRoles() {
    api.get<{ items: TeamRoleItem[] }>('/users/roles').then((r) => setTeamRoles(r.items))
  }

  useEffect(() => {
    if (!isAdmin) return
    fetchTeamRoles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin])

  async function handleRoleChange(member: TeamRoleItem, newRole: 'admin' | 'member') {
    if (newRole === member.role) return
    setRoleError(null)
    setSavingRoleFor(member.id)
    try {
      const updated = await api.patch<{ id: string; name: string; role: 'admin' | 'member' }>(
        `/users/${member.id}/role`,
        { role: newRole },
      )
      setTeamRoles((prev) => prev?.map((m) => (m.id === updated.id ? { ...m, role: updated.role } : m)) ?? null)
      setConfirmation(`${updated.name} is now ${updated.role === 'admin' ? 'an admin' : 'a member'}.`)
    } catch (err) {
      setRoleError(err instanceof ApiError ? err.message : `Could not update ${member.name}'s role.`)
    } finally {
      setSavingRoleFor(null)
    }
  }

  async function handleStatusChange(member: TeamRoleItem, active: boolean) {
    setRoleError(null)
    setSavingStatusFor(member.id)
    try {
      const updated = await api.patch<{ id: string; name: string; active: boolean }>(`/users/${member.id}/status`, {
        active,
      })
      setTeamRoles((prev) => prev?.map((m) => (m.id === updated.id ? { ...m, active: updated.active } : m)) ?? null)
      setConfirmation(`${updated.name} was ${updated.active ? 'reactivated' : 'deactivated'}.`)
    } catch (err) {
      setRoleError(err instanceof ApiError ? err.message : `Could not update ${member.name}'s status.`)
    } finally {
      setSavingStatusFor(null)
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await api.delete(`/users/${pendingDelete.id}`)
      setTeamRoles((prev) => prev?.filter((m) => m.id !== pendingDelete.id) ?? null)
      setConfirmation(`${pendingDelete.name} was permanently deleted.`)
      setPendingDelete(null)
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : `Could not delete ${pendingDelete.name}.`)
    } finally {
      setDeleting(false)
    }
  }

  async function openDetail(member: TeamRoleItem) {
    setDetailError(null)
    setDetailLoadingFor(member.id)
    try {
      const profile = await api.get<TeamMemberProfile>(`/users/${member.id}`)
      setDetail(profile)
    } catch (err) {
      setDetailError(err instanceof ApiError ? err.message : `Could not load ${member.name}'s details.`)
    } finally {
      setDetailLoadingFor(null)
    }
  }

  if (!user) return null
  if (!isAdmin) return <Navigate to="/app/dashboard" replace />

  const query = search.trim().toLowerCase()
  const filteredRoles =
    teamRoles && query
      ? teamRoles.filter((m) => m.name.toLowerCase().includes(query) || m.email.toLowerCase().includes(query))
      : (teamRoles ?? [])

  return (
    <>
      <div className="mb-7 flex items-start justify-between">
        <div>
          <h1 className="font-display text-[28px] font-bold">Team roles</h1>
          <p className="mt-1 text-sm text-muted">
            Admins can access org-wide settings like team leave balances. Every org needs at least one active.
          </p>
        </div>
        <InviteMemberButton
          triggerLabel="+ Add member"
          triggerClassName="rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-2 text-sm font-semibold text-white"
          onInvited={fetchTeamRoles}
        />
      </div>

      <div className="rounded-2xl border border-border bg-card p-5">
        {roleError && <div className="mb-3.5 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{roleError}</div>}
        {detailError && <div className="mb-3.5 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{detailError}</div>}
        {teamRoles && teamRoles.length > 0 && (
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search members by name or email…"
            className="mb-3.5 w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          />
        )}
        {!teamRoles ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : filteredRoles.length === 0 ? (
          <p className="text-sm text-muted">No members match "{search}".</p>
        ) : (
          <div className="divide-y divide-border">
            {filteredRoles.map((member) => {
              const isSelf = member.id === user.id
              return (
                <div key={member.id} className="flex items-center justify-between py-2.5">
                  <button
                    type="button"
                    onClick={() => openDetail(member)}
                    disabled={detailLoadingFor === member.id}
                    className={`text-left text-sm font-semibold text-accent hover:underline disabled:opacity-60 ${!member.active ? 'opacity-50' : ''}`}
                  >
                    {detailLoadingFor === member.id ? 'Loading…' : member.name}
                    {!member.active && <span className="ml-1.5 text-[11px] font-normal text-muted">(deactivated)</span>}
                  </button>
                  <div className="flex items-center gap-2">
                    <select
                      value={member.role}
                      onChange={(e) => handleRoleChange(member, e.target.value as 'admin' | 'member')}
                      disabled={savingRoleFor === member.id || !member.active}
                      className="cursor-pointer rounded-lg border border-border bg-white px-2.5 py-1.5 text-[13px] font-semibold text-ink disabled:opacity-60"
                    >
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => handleStatusChange(member, !member.active)}
                      disabled={savingStatusFor === member.id || (member.active && isSelf)}
                      title={member.active && isSelf ? "You can't deactivate your own account" : undefined}
                      className={`rounded-lg border px-2.5 py-1.5 text-[13px] font-semibold disabled:opacity-40 ${
                        member.active
                          ? 'border-border bg-white text-red-700 hover:bg-red-50'
                          : 'border-border bg-white text-green-700 hover:bg-green-50'
                      }`}
                    >
                      {savingStatusFor === member.id ? '…' : member.active ? 'Deactivate' : 'Reactivate'}
                    </button>
                    {!member.active && (
                      <button
                        type="button"
                        onClick={() => {
                          setDeleteError(null)
                          setPendingDelete(member)
                        }}
                        className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-[13px] font-semibold text-red-700 hover:bg-red-50"
                      >
                        Delete permanently
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {detail && (
        <>
          <div className="fixed inset-0 z-[200] bg-ink/25" onClick={() => setDetail(null)} />
          <div className="fixed left-1/2 top-1/2 z-[201] w-[380px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-[0_30px_80px_-30px_rgba(27,28,34,0.35)]">
            <div className="mb-4 flex items-center gap-3.5">
              {detail.avatarUrl ? (
                <img
                  src={`${API_BASE_URL}${detail.avatarUrl}`}
                  alt={detail.name}
                  className="h-14 w-14 rounded-full border border-border object-cover"
                />
              ) : (
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#4B4C58] text-base font-bold text-white">
                  {detail.initials}
                </div>
              )}
              <div>
                <div className="font-display text-base font-bold">{detail.name}</div>
                <div className="text-[13px] text-muted">{detail.email}</div>
              </div>
            </div>
            <div className="space-y-2.5 text-[13px]">
              <div className="flex justify-between">
                <span className="text-muted">Status</span>
                <span className={`font-semibold ${detail.active ? 'text-green-700' : 'text-red-700'}`}>
                  {detail.active ? 'Active' : 'Deactivated'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Role</span>
                <span className="font-semibold text-ink capitalize">{detail.role}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Designation</span>
                <span className="font-semibold text-ink">{detail.designation || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Department</span>
                <span className="font-semibold text-ink">{detail.department || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Employee ID</span>
                <span className="font-semibold text-ink">{detail.employeeId || '—'}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setDetail(null)}
              className="mt-5 w-full rounded-lg border border-border bg-white px-4 py-2 text-sm font-semibold text-ink hover:bg-page"
            >
              Close
            </button>
          </div>
        </>
      )}

      {pendingDelete && (
        <>
          <div className="fixed inset-0 z-[200] bg-ink/25" onClick={() => !deleting && setPendingDelete(null)} />
          <div className="fixed left-1/2 top-1/2 z-[201] w-[400px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-[0_30px_80px_-30px_rgba(27,28,34,0.35)]">
            <h2 className="mb-1 font-display text-lg font-bold">Delete {pendingDelete.name} permanently?</h2>
            <p className="mb-4 text-sm text-muted">
              This removes their account for good — it can't be undone. If they own or created anything real, this will
              be refused instead of silently breaking it.
            </p>
            {deleteError && <div className="mb-3.5 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{deleteError}</div>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                className="rounded-lg border border-border px-4 py-2 text-sm font-semibold disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {deleting ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </>
      )}

      {confirmation && <ConfirmationToast message={confirmation} onDone={() => setConfirmation(null)} />}
    </>
  )
}
