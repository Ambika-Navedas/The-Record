import { useEffect, useState, type FormEvent } from 'react'
import { useLocation } from 'react-router-dom'
import { DateRangePicker, type DateRangeValue } from '../components/DateRangePicker'
import { useAuth } from '../context/AuthContext'
import {
  api,
  ApiError,
  type LeaveBalance,
  type LeaveRequest,
  type LeaveType,
  type OnLeaveEntry,
  type TeamMemberBalances,
} from '../lib/api'

const statusStyle: Record<LeaveRequest['status'], string> = {
  pending: 'bg-[#F0F0F3] text-muted',
  approved: 'bg-green-tint text-green',
  rejected: 'bg-red-50 text-red-700',
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

interface BalanceUpdateDetails {
  memberName: string
  employeeId: string
  leaveTypeName: string
  previousBalance: number
  newBalance: number
}

// Mirrors server/src/routes/worknest.ts's daysBetweenInclusive() exactly — same inclusive
// day count, so what the frontend warns about matches what the backend will actually reject.
function daysBetweenInclusive(fromDate: string, toDate: string): number {
  const from = new Date(`${fromDate}T00:00:00`)
  const to = new Date(`${toDate}T00:00:00`)
  return Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1
}

export function WorkNestPage() {
  const { user } = useAuth()
  const location = useLocation()

  const isAdmin = user?.role === 'admin'

  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([])
  const [balances, setBalances] = useState<LeaveBalance[] | null>(null)
  const [leaveHistory, setLeaveHistory] = useState<LeaveRequest[] | null>(null)
  const [onLeave, setOnLeave] = useState<OnLeaveEntry[] | null>(null)
  const [teamBalances, setTeamBalances] = useState<TeamMemberBalances[] | null>(null)
  const [balanceUpdate, setBalanceUpdate] = useState<BalanceUpdateDetails | null>(null)

  const [logLeaveType, setLogLeaveType] = useState('')
  const [logRange, setLogRange] = useState<DateRangeValue | null>(null)
  const [logReason, setLogReason] = useState('')
  const [logging, setLogging] = useState(false)
  const [logError, setLogError] = useState<string | null>(null)

  function fetchLeaveData() {
    api.get<{ items: LeaveType[] }>('/worknest/leave-types').then((res) => setLeaveTypes(res.items)).catch(() => {})
    api.get<{ items: LeaveBalance[] }>('/worknest/leave-balances').then((res) => setBalances(res.items)).catch(() => {})
    api.get<{ items: LeaveRequest[] }>('/worknest/leave-requests').then((res) => setLeaveHistory(res.items)).catch(() => {})
    api.get<{ items: OnLeaveEntry[] }>('/worknest/on-leave').then((res) => setOnLeave(res.items)).catch(() => {})
  }

  useEffect(fetchLeaveData, [])

  // Admin-only, fetched separately — no other org member should even trigger this request,
  // and there's no reason to pay for it on every page load for a member who'll never see it.
  useEffect(() => {
    if (!isAdmin) return
    api
      .get<{ items: TeamMemberBalances[] }>('/worknest/leave-balances/team')
      .then((res) => setTeamBalances(res.items))
      .catch(() => {})
  }, [isAdmin])

  // Jumps straight to the "Team on leave" info card when arriving via a #team-on-leave link
  // (the Dashboard's Leave calendar "See all" — see dashboard/frontend.md). Waits on
  // `balances`/`onLeave` rather than firing on mount — everything above this card is still in
  // its shorter "Loading…" state at mount, so an immediate scrollIntoView lands short once that
  // content finishes loading and pushes the card further down the page.
  useEffect(() => {
    if (location.hash !== '#team-on-leave' || !balances || !onLeave) return
    document.querySelector(location.hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [location.hash, balances, onLeave])

  if (!user) return null

  // Proactive check, computed on every render from state already in scope — not a separate
  // fetch. Mirrors the backend's own insufficient_balance check (same daysBetweenInclusive(),
  // same comparison) so the frontend warns about exactly what the server would reject, rather
  // than a looser or stricter approximation of it.
  const selectedType = leaveTypes.find((lt) => lt.id === logLeaveType)
  const selectedTypeBalance = balances?.find((b) => b.leaveTypeId === logLeaveType)?.balance ?? null
  const requestedDays = logRange ? daysBetweenInclusive(logRange.from, logRange.to) : null
  const exceedsBalance =
    requestedDays !== null && selectedTypeBalance !== null && requestedDays > selectedTypeBalance

  async function handleLog(e: FormEvent) {
    e.preventDefault()
    setLogError(null)
    if (!logRange) {
      setLogError('Pick a date range.')
      return
    }
    setLogging(true)
    try {
      await api.post('/worknest/leave-requests', {
        leaveTypeId: logLeaveType,
        fromDate: logRange.from,
        toDate: logRange.to,
        reason: logReason.trim(),
      })
      setLogLeaveType('')
      setLogRange(null)
      setLogReason('')
      fetchLeaveData()
    } catch (err) {
      setLogError(err instanceof ApiError ? err.message : 'Could not log that leave.')
    } finally {
      setLogging(false)
    }
  }

  // Fires on blur, not on every keystroke — one request per actual edit, not per digit typed.
  // Sets the balance to an absolute value (whatever's in the input), not a delta.
  async function handleBalanceEdit(userId: string, leaveTypeId: string, rawValue: string) {
    const balance = Number(rawValue)
    if (!Number.isFinite(balance) || balance < 0) return
    // Looked up before the request, from state as it stands right now — this one cell is what's
    // being edited, so nothing about it can have changed out from under this specific save.
    // previousBalance in particular has to come from here, not from anywhere post-request — the
    // PATCH response is a bare 204 with no body to read it back from.
    const member = teamBalances?.find((m) => m.userId === userId)
    const existing = member?.balances.find((b) => b.leaveTypeId === leaveTypeId)
    try {
      await api.patch(`/worknest/leave-balances/${userId}`, { leaveTypeId, balance })
      setTeamBalances((prev) =>
        prev
          ? prev.map((m) =>
              m.userId === userId
                ? { ...m, balances: m.balances.map((b) => (b.leaveTypeId === leaveTypeId ? { ...b, balance } : b)) }
                : m,
            )
          : prev,
      )
      setBalanceUpdate({
        memberName: member?.userName ?? 'Member',
        employeeId: member?.employeeId ?? '',
        leaveTypeName: existing?.name ?? 'Leave',
        previousBalance: existing?.balance ?? 0,
        newBalance: balance,
      })
      // If the admin just edited their own balance, the "Leave balance" card above needs the
      // same refresh — it reads from a separate endpoint (the caller's own, not the team list).
      if (userId === user?.id) fetchLeaveData()
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not update that balance.')
    }
  }

  return (
    <>
      <div className="mb-7">
        <h1 className="font-display text-[28px] font-bold">WorkNest</h1>
        <p className="mt-1 text-sm text-muted">Leave balance, team status, and your leave history.</p>
      </div>

      {/* grid, not flex, with `fr` tracks — fr units split available width *after* subtracting
          gap-5, so this is a true 70/30 of the usable space, not 70%/30% of the full container
          width plus a gap on top (which is what flex-basis percentages would give here). */}
      <div className="grid grid-cols-[7fr_3fr] items-start gap-5">
        <div className="flex flex-col gap-5">
          <div className="rounded-2xl border border-border bg-card p-5">
            <h2 className="mb-3 font-display text-base font-bold">Leave balance</h2>
            {!balances ? (
              <div className="text-sm text-muted">Loading…</div>
            ) : (
              <div className="grid grid-cols-5 gap-2.5">
                {balances.map((b) => (
                  <div key={b.leaveTypeId} className="rounded-lg border border-border bg-page px-3 py-2.5 text-center">
                    <div className="font-display text-lg font-bold">{b.balance}</div>
                    <div className="mt-0.5 text-[11px] text-muted">{b.name}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Self-service, no approval step — direct follow-up once removing the
              request/approval system left no way to actually inform the team: "without the
              request/approval, all rest should be there." Submitting immediately creates an
              already-`approved` leave_requests row and deducts the balance right away (see
              worknest/backend.md) — there's no pending state, no one to review it, so the button
              says "Log leave," not "Submit request." */}
          <form onSubmit={handleLog} className="rounded-2xl border border-border bg-card p-5">
            <h2 className="mb-3 font-display text-base font-bold">Log leave</h2>
            <label className="mb-1.5 block text-[13px] font-semibold text-muted">Leave type</label>
            <select
              value={logLeaveType}
              onChange={(e) => setLogLeaveType(e.target.value)}
              required
              className="mb-3.5 w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <option value="" disabled>
                Select a leave type
              </option>
              {leaveTypes.map((lt) => (
                <option key={lt.id} value={lt.id}>
                  {lt.name}
                </option>
              ))}
            </select>
            <label className="mb-1.5 block text-[13px] font-semibold text-muted">Dates</label>
            <div className="mb-3.5">
              <DateRangePicker value={logRange} onChange={setLogRange} placeholder="Select dates" />
            </div>
            <label className="mb-1.5 block text-[13px] font-semibold text-muted">Reason</label>
            <textarea
              value={logReason}
              onChange={(e) => setLogReason(e.target.value)}
              rows={2}
              required
              className="mb-3.5 w-full resize-none rounded-lg border border-border bg-white px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            />
            {/* Proactive — shown as soon as a type + range are picked, before any submit
                attempt, so the button visibly disabling itself is the first sign of a problem,
                not a server error after the fact. Same wording shape as the backend's own
                insufficient_balance message for consistency. */}
            {exceedsBalance && requestedDays !== null && (
              <div className="mb-3.5 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">
                Not enough {selectedType?.name ?? 'leave'} balance — requesting {requestedDays} day
                {requestedDays === 1 ? '' : 's'}, {selectedTypeBalance} available.
              </div>
            )}
            {logError && <div className="mb-3.5 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{logError}</div>}
            <button
              type="submit"
              disabled={logging || !logLeaveType || !logRange || !logReason.trim() || exceedsBalance}
              className="rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {logging ? 'Logging…' : 'Log leave'}
            </button>
          </form>

          {/* Read-only info — direct request: "on the leave apply section, there should not be
              any request. Its only the info to the team that the person is on leave." Visible to
              everyone, not admin-gated, and has no Approve/Reject actions — this is who's out,
              not a queue to act on. */}
          <div id="team-on-leave" className="rounded-2xl border border-border bg-card p-5">
            <h2 className="mb-3 font-display text-base font-bold">Team on leave</h2>
            {!onLeave ? (
              <div className="text-sm text-muted">Loading…</div>
            ) : onLeave.length === 0 ? (
              <div className="text-sm text-muted">No one's on leave right now.</div>
            ) : (
              <div className="flex flex-col gap-2">
                {onLeave.map((entry, i) => (
                  <div
                    key={`${entry.userId}-${entry.fromDate}-${i}`}
                    className="flex items-center gap-2.5 rounded-lg border border-border bg-page px-3 py-2.5"
                  >
                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[#4B4C58] text-[10px] font-bold text-white">
                      {entry.userInitials}
                    </span>
                    <div>
                      <div className="text-sm font-semibold text-ink">{entry.userName}</div>
                      <div className="mt-0.5 text-xs text-muted">
                        {entry.leaveTypeName} · {formatDate(entry.fromDate)} – {formatDate(entry.toDate)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Admin-only — direct request: "the admin need to have the option to modify the
              leave balance of each member." Deliberately separate from the (removed)
              approve/reject workflow: this isn't reviewing anyone's request, it's a standing
              admin capability to allocate/correct balances directly at any time. Uncontrolled
              inputs (defaultValue, not value) with an onBlur save — editing doesn't need to
              re-render the whole table on every keystroke, and this matches the "fires once you
              leave the field" pattern rather than autosaving mid-type. */}
          {isAdmin && (
            <div className="rounded-2xl border border-border bg-card p-5">
              <h2 className="mb-1 font-display text-base font-bold">Team leave balances</h2>
              <p className="mb-3 text-xs text-muted">Admin only. Edit a value and click away to save.</p>
              {!teamBalances ? (
                <div className="text-sm text-muted">Loading…</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        <th className="p-2 text-left text-xs font-semibold text-muted">Member</th>
                        {teamBalances[0]?.balances.map((b) => (
                          <th key={b.leaveTypeId} className="p-2 text-center text-xs font-semibold text-muted">
                            {b.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {teamBalances.map((m) => (
                        <tr key={m.userId} className="border-t border-border">
                          <td className="whitespace-nowrap p-2 font-semibold text-ink">{m.userName}</td>
                          {m.balances.map((b) => (
                            <td key={b.leaveTypeId} className="p-2 text-center">
                              <input
                                type="number"
                                min={0}
                                defaultValue={b.balance}
                                onBlur={(e) => handleBalanceEdit(m.userId, b.leaveTypeId, e.target.value)}
                                className="w-16 rounded-lg border border-border bg-white px-1.5 py-1 text-center text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right-hand rail, direct request — "leave requests and its status needs to be
            visible on the right hand side section of the page" (matches the reference
            screenshot's Notifications panel). Sticky so it stays visible while the left
            column scrolls. Width comes from the parent grid's 3fr track (see above) — a fixed
            70/30 split, not "grow to fill leftover space" like the flex-1 version this replaced.
            Relabeled from "My requests" to "Leave history" once the apply/approve workflow was
            removed — same data (GET /worknest/leave-requests, now always scoped to the caller,
            no ?scope=team anymore), just framed as a read-only log instead of an actionable list. */}
        <div className="sticky top-7 rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-3 font-display text-base font-bold">Leave history</h2>
          {!leaveHistory ? (
            <div className="text-sm text-muted">Loading…</div>
          ) : leaveHistory.length === 0 ? (
            <div className="text-sm text-muted">No leave history yet.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {leaveHistory.map((r) => (
                <div key={r.id} className="rounded-lg border border-border bg-page px-3 py-2.5">
                  <div className="text-sm font-semibold text-ink">
                    {r.days} day{r.days === 1 ? '' : 's'} of {r.leaveTypeName}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {formatDate(r.fromDate)} – {formatDate(r.toDate)}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">{r.reason}</div>
                  <span
                    className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-bold capitalize ${statusStyle[r.status]}`}
                  >
                    {r.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Details modal, not an auto-dismissing toast — direct correction: "It should be visible
          as a pop up window with the modification details." Same overlay+centered-card pattern
          as ReasonModal.tsx (dimmed backdrop, click-outside or an explicit button to close), but
          this one shows structured before/after values rather than collecting input. Stays open
          until the admin dismisses it — no timer — since the whole point is giving them time to
          actually read what changed, not a passing confirmation. */}
      {balanceUpdate && (
        <>
          <div className="fixed inset-0 z-[200] bg-ink/25" onClick={() => setBalanceUpdate(null)} />
          <div className="fixed left-1/2 top-1/2 z-[201] w-[380px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-[0_30px_80px_-30px_rgba(27,28,34,0.35)]">
            <h2 className="mb-1 font-display text-lg font-bold">Balance updated</h2>
            <p className="mb-4 text-sm text-muted">This change has been saved.</p>
            <div className="mb-5 flex flex-col gap-2 rounded-lg border border-border bg-page p-3.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted">Member</span>
                <span className="font-semibold text-ink">{balanceUpdate.memberName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">Employee ID</span>
                <span className="font-semibold text-ink">{balanceUpdate.employeeId || '—'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">Leave type</span>
                <span className="font-semibold text-ink">{balanceUpdate.leaveTypeName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">Previous balance</span>
                <span className="font-semibold text-ink">{balanceUpdate.previousBalance}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">New balance</span>
                <span className="font-semibold text-green">{balanceUpdate.newBalance}</span>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setBalanceUpdate(null)}
                className="rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-2 text-sm font-semibold text-white"
              >
                Done
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
