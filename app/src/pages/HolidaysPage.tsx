import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { api, ApiError, type Holiday } from '../lib/api'

// Matches the backend's MAX_OPTIONAL_SELECTIONS (server/src/routes/holidays.ts) — this year's
// rule, not pulled into settings since nothing yet suggests it needs to vary per org/year.
const MAX_OPTIONAL_SELECTIONS = 2

function formatHolidayDate(iso: string): string {
  // 'YYYY-MM-DD' has no time component — parsing it directly would read as UTC midnight and
  // could display as the previous day in timezones behind UTC, so build the Date from parts.
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function HolidaysPage() {
  const { user } = useAuth()

  const [holidays, setHolidays] = useState<Holiday[] | null>(null)
  const [holidayDate, setHolidayDate] = useState('')
  const [holidayName, setHolidayName] = useState('')
  const [holidayOptional, setHolidayOptional] = useState(false)
  const [addingHoliday, setAddingHoliday] = useState(false)
  const [holidayError, setHolidayError] = useState<string | null>(null)

  function fetchHolidays() {
    api
      .get<{ items: Holiday[] }>('/holidays')
      .then((res) => setHolidays(res.items))
      .catch(() => {})
  }

  useEffect(fetchHolidays, [])

  if (!user) return null
  const isAdmin = user.role === 'admin'

  async function handleAddHoliday(e: FormEvent) {
    e.preventDefault()
    setHolidayError(null)
    setAddingHoliday(true)
    try {
      await api.post('/holidays', { date: holidayDate, name: holidayName.trim(), isOptional: holidayOptional })
      setHolidayDate('')
      setHolidayName('')
      setHolidayOptional(false)
      fetchHolidays()
    } catch (err) {
      setHolidayError(err instanceof ApiError ? err.message : 'Could not add that holiday.')
    } finally {
      setAddingHoliday(false)
    }
  }

  async function handleDeleteHoliday(id: string) {
    await api.delete(`/holidays/${id}`).catch(() => {})
    fetchHolidays()
  }

  async function handleToggleSelect(h: Holiday) {
    try {
      if (h.selectedByMe) {
        await api.delete(`/holidays/${h.id}/select`)
      } else {
        await api.post(`/holidays/${h.id}/select`)
      }
      fetchHolidays()
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not update your selection.')
    }
  }

  function renderList(list: Holiday[], emptyText: string) {
    if (list.length === 0) return <div className="text-sm text-muted">{emptyText}</div>
    return (
      <div className="flex flex-col gap-2">
        {list.map((h) => (
          <div key={h.id} className="flex items-center justify-between rounded-lg border border-border bg-page px-3 py-2">
            <div>
              <span className="text-sm font-semibold text-ink">{h.name}</span>
              <span className="ml-2 text-xs text-muted">{formatHolidayDate(h.date)}</span>
            </div>
            {isAdmin && (
              <button
                onClick={() => handleDeleteHoliday(h.id)}
                className="text-xs font-semibold text-muted hover:text-red-700"
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
    )
  }

  const mandatoryHolidays = holidays?.filter((h) => !h.isOptional) ?? []
  const optionalHolidays = holidays?.filter((h) => h.isOptional) ?? []
  const selectedCount = optionalHolidays.filter((h) => h.selectedByMe).length

  return (
    <>
      <div className="mb-7">
        <h1 className="font-display text-[28px] font-bold">{user.org_name} Holidays</h1>
        <p className="mt-1 text-sm text-muted">
          Visible to everyone. Shown in the "Next event" calendar on the dashboard when one falls in that week.
        </p>
      </div>

      <div className="flex max-w-xl flex-col gap-5">
        <div className="rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-3 font-display text-base font-bold">Holidays</h2>
          {!holidays ? <div className="text-sm text-muted">Loading…</div> : renderList(mandatoryHolidays, 'No holidays added yet.')}
        </div>

        <div className="rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-1 font-display text-base font-bold">Optional Holidays</h2>
          <p className="mb-3.5 text-[13px] text-muted">
            Floating holidays — pick up to {MAX_OPTIONAL_SELECTIONS} of your own this year.
            {holidays && (
              <span className="ml-1 font-semibold text-ink">
                ({selectedCount} of {MAX_OPTIONAL_SELECTIONS} selected)
              </span>
            )}
          </p>
          {!holidays ? (
            <div className="text-sm text-muted">Loading…</div>
          ) : optionalHolidays.length === 0 ? (
            <div className="text-sm text-muted">No optional holidays added yet.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {optionalHolidays.map((h) => (
                <div key={h.id} className="flex items-center justify-between rounded-lg border border-border bg-page px-3 py-2">
                  <label className="flex items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={h.selectedByMe}
                      disabled={!h.selectedByMe && selectedCount >= MAX_OPTIONAL_SELECTIONS}
                      onChange={() => handleToggleSelect(h)}
                      title={
                        !h.selectedByMe && selectedCount >= MAX_OPTIONAL_SELECTIONS
                          ? `You've already selected ${MAX_OPTIONAL_SELECTIONS} optional holidays`
                          : undefined
                      }
                      className="h-3.5 w-3.5 disabled:cursor-not-allowed"
                    />
                    <span>
                      <span className="text-sm font-semibold text-ink">{h.name}</span>
                      <span className="ml-2 text-xs text-muted">{formatHolidayDate(h.date)}</span>
                    </span>
                  </label>
                  {isAdmin && (
                    <button
                      onClick={() => handleDeleteHoliday(h.id)}
                      className="text-xs font-semibold text-muted hover:text-red-700"
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-card p-5">
          {!isAdmin ? (
            <p className="text-[13px] text-muted">Only an admin can add or remove company holidays.</p>
          ) : (
            <>
              <h2 className="mb-3 font-display text-base font-bold">Add a holiday</h2>
              <form onSubmit={handleAddHoliday}>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="mb-1.5 block text-[13px] font-semibold text-muted">Date</label>
                    <input
                      type="date"
                      value={holidayDate}
                      onChange={(e) => setHolidayDate(e.target.value)}
                      required
                      className="w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="mb-1.5 block text-[13px] font-semibold text-muted">Name</label>
                    <input
                      value={holidayName}
                      onChange={(e) => setHolidayName(e.target.value)}
                      placeholder="e.g. Independence Day"
                      required
                      className="w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={addingHoliday || !holidayDate || !holidayName.trim()}
                    className="rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
                  >
                    {addingHoliday ? 'Adding…' : 'Add'}
                  </button>
                </div>
                <label className="mt-2.5 flex items-center gap-1.5 text-[13px] text-muted">
                  <input
                    type="checkbox"
                    checked={holidayOptional}
                    onChange={(e) => setHolidayOptional(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  This is an optional holiday
                </label>
              </form>
              {holidayError && (
                <div className="mt-3.5 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{holidayError}</div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}
