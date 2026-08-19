import { useState } from 'react'
import { api, ApiError, type InviteUserResult } from '../lib/api'

interface InviteMemberButtonProps {
  triggerLabel?: string
  triggerClassName?: string
  onInvited?: () => void
}

// Self-contained trigger + modal, shared by MeetingDetailPage (where it originated) and
// TeamRolesPage — both just want a button that adds a real user to the org and hands back a
// temporary password to share manually (no email-sending in this app).
export function InviteMemberButton({
  triggerLabel = '+ Invite teammate',
  triggerClassName = 'text-[12px] font-semibold text-accent hover:underline',
  onInvited,
}: InviteMemberButtonProps) {
  const [showModal, setShowModal] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [result, setResult] = useState<InviteUserResult | null>(null)

  function open() {
    setName('')
    setEmail('')
    setInviteError(null)
    setResult(null)
    setShowModal(true)
  }

  function close() {
    if (inviting) return
    setShowModal(false)
    if (result) onInvited?.()
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !email.trim()) return
    setInviting(true)
    setInviteError(null)
    try {
      const res = await api.post<InviteUserResult>('/users/invite', { name: name.trim(), email: email.trim() })
      setResult(res)
    } catch (err) {
      setInviteError(err instanceof ApiError ? err.message : 'Could not invite this person.')
    } finally {
      setInviting(false)
    }
  }

  return (
    <>
      <button type="button" onClick={open} className={triggerClassName}>
        {triggerLabel}
      </button>

      {showModal && (
        <>
          <div className="fixed inset-0 z-[200] bg-ink/25" onClick={close} />
          <div className="fixed left-1/2 top-1/2 z-[201] w-[400px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-[0_30px_80px_-30px_rgba(27,28,34,0.35)]">
            {!result ? (
              <>
                <h2 className="mb-1 font-display text-lg font-bold">Invite teammate</h2>
                <p className="mb-4 text-sm text-muted">
                  Adds them as a real user in your org, so they can be assigned tasks. There's no email sending in this
                  demo — you'll get a password to share with them directly.
                </p>
                <form onSubmit={handleInvite}>
                  <label className="mb-1.5 block text-[13px] font-semibold">Name</label>
                  <input
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Sarmista Devi"
                    className="mb-3.5 w-full rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  />
                  <label className="mb-1.5 block text-[13px] font-semibold">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="sdevi@navedas.com"
                    className="mb-3.5 w-full rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  />
                  {inviteError && (
                    <div className="mb-3.5 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{inviteError}</div>
                  )}
                  <div className="mt-1 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={close}
                      disabled={inviting}
                      className="rounded-lg border border-border px-4 py-2 text-sm font-semibold disabled:opacity-60"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={inviting || !name.trim() || !email.trim()}
                      className="rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      {inviting ? 'Inviting…' : 'Invite'}
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <>
                <h2 className="mb-1 font-display text-lg font-bold">{result.name} added</h2>
                <p className="mb-4 text-sm text-muted">
                  Share these login details with them directly — there's no email sent automatically.
                </p>
                <div className="mb-4 rounded-lg border border-border bg-page p-3.5 text-sm">
                  <div className="mb-2">
                    <span className="font-semibold text-muted">Email: </span>
                    {result.email}
                  </div>
                  <div>
                    <span className="font-semibold text-muted">Temporary password: </span>
                    <span className="font-mono">{result.temporaryPassword}</span>
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={close}
                    className="rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-2 text-sm font-semibold text-white"
                  >
                    Done
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </>
  )
}
