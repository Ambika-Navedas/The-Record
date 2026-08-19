import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  api,
  type DashboardSummary,
  type LeaveCalendarDay,
  type ProjectItem,
  type TaskCalendarDay,
  type TaskItem,
  type TasksResponse,
} from '../lib/api'

const statusLabel: Record<string, string> = {
  on_track: 'On track',
  attention: 'Needs attention',
  blocked: 'Blocked',
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl border border-border bg-card p-5 transition-all hover:-translate-y-0.5 hover:shadow-[0_20px_40px_-24px_rgba(27,28,34,0.22)] ${className}`}
    >
      {children}
    </div>
  )
}

// Plain label + value, not a disabled <input> — nothing on this panel is ever editable (Dashboard
// has no editing entry point at all, unlike the Projects page's own view/edit drawer), so a real
// form control here would be a dishonest affordance suggesting an interaction that doesn't exist.
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-3.5">
      <div className="mb-1 text-[13px] font-semibold text-muted">{label}</div>
      <div className="rounded-lg border border-border bg-page px-3 py-2.5 text-sm text-ink">{value || '—'}</div>
    </div>
  )
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const hours = diffMs / 3_600_000
  if (hours < 1) return 'just now'
  if (hours < 24) return `${Math.round(hours)}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Returns the 7 dates (Sun–Sat) of the week containing `date`. */
function getWeekDates(date: Date): Date[] {
  const start = new Date(date)
  start.setDate(date.getDate() - date.getDay())
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

// Returns a Sun–Sat grid of the month containing `date`, padded with `null` before day 1 and
// after the last day so the grid always divides evenly into full weeks (rows of 7).
function getMonthGridDates(date: Date): (Date | null)[] {
  const year = date.getFullYear()
  const month = date.getMonth()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const leadingBlanks = new Date(year, month, 1).getDay()
  const cells: (Date | null)[] = Array(leadingBlanks).fill(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d))
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

// Local-date 'YYYY-MM-DD' — deliberately not toISOString().slice(0, 10), which converts to UTC
// first and can shift the date by one near midnight in timezones behind UTC. Holiday dates are
// stored as plain 'YYYY-MM-DD' with no timezone, so this is what has to match them.
function toDateOnly(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Same reasoning as toDateOnly, in reverse — build the Date from the 'YYYY-MM-DD' parts rather
// than parsing the string directly, which reads as UTC midnight and can display as the previous
// day in timezones behind UTC.
function formatHolidayDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Same "build the Date from the string's parts" reasoning as formatHolidayDate — avoids the
// UTC-shift bug parsing 'YYYY-MM-DD' directly would risk near midnight.
function formatCalendarDate(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

// 'YYYY-MM' for the task-calendar/leave-calendar endpoints' ?month= param.
function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function shiftMonth(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1)
}

/** Greeting based on the viewer's local system clock, not a fixed "morning". */
function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export function DashboardPage() {
  const [data, setData] = useState<DashboardSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Date clicked on the Task calendar — 'YYYY-MM-DD' or null when the day-detail modal is closed.
  const [selectedTaskDate, setSelectedTaskDate] = useState<string | null>(null)
  const [dateTasks, setDateTasks] = useState<TaskItem[] | null>(null)

  // Each calendar tracks its own displayed month independently — no reason navigating one
  // should move the other. Always the 1st of the month, so monthKey()/getMonthGridDates() have
  // a stable reference point regardless of which day was "today" when the page loaded.
  const [taskCalendarMonth, setTaskCalendarMonth] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const [taskCalendarDays, setTaskCalendarDays] = useState<TaskCalendarDay[] | null>(null)
  const [leaveCalendarMonth, setLeaveCalendarMonth] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const [leaveCalendarDays, setLeaveCalendarDays] = useState<LeaveCalendarDay[] | null>(null)

  // Project clicked on "Your projects" — 'YYYY-...' id or null when the view panel is closed.
  // Direct request: clicking a project here should show its details without leaving the
  // Dashboard (an earlier version navigated to /app/projects, which the user asked to undo) —
  // always read-only, since there's no editing entry point on this page at all.
  const [viewProjectId, setViewProjectId] = useState<string | null>(null)
  const [viewProject, setViewProject] = useState<ProjectItem | null>(null)

  useEffect(() => {
    api
      .get<DashboardSummary>('/dashboard/summary')
      .then(setData)
      .catch(() => setError('Could not reach the API. Is the backend running on :4000?'))
  }, [])

  useEffect(() => {
    if (!viewProjectId) {
      setViewProject(null)
      return
    }
    api
      .get<ProjectItem>(`/projects/${viewProjectId}`)
      .then(setViewProject)
      .catch(() => setViewProject(null))
  }, [viewProjectId])

  useEffect(() => {
    setTaskCalendarDays(null)
    api
      .get<{ items: TaskCalendarDay[] }>(`/dashboard/task-calendar?month=${monthKey(taskCalendarMonth)}`)
      .then((res) => setTaskCalendarDays(res.items))
      .catch(() => setTaskCalendarDays([]))
  }, [taskCalendarMonth])

  useEffect(() => {
    setLeaveCalendarDays(null)
    api
      .get<{ items: LeaveCalendarDay[] }>(`/dashboard/leave-calendar?month=${monthKey(leaveCalendarMonth)}`)
      .then((res) => setLeaveCalendarDays(res.items))
      .catch(() => setLeaveCalendarDays([]))
  }, [leaveCalendarMonth])

  // Re-fetches the real task list (title, assignee, meeting) for the clicked date — the
  // calendar's own data only has per-assignee counts, not enough to list actual tasks, and
  // `/tasks` already supports exact-day filtering via dueFrom=dueTo=date (see tasks.ts), so this
  // reuses that endpoint rather than growing taskCalendar's payload for a rarely-opened detail view.
  useEffect(() => {
    if (!selectedTaskDate) {
      setDateTasks(null)
      return
    }
    setDateTasks(null)
    api
      .get<TasksResponse>(`/tasks?filter=open&dueFrom=${selectedTaskDate}&dueTo=${selectedTaskDate}`)
      .then((res) => setDateTasks(res.items))
      .catch(() => setDateTasks([]))
  }, [selectedTaskDate])

  if (error) return <div className="text-sm text-red-700">{error}</div>
  if (!data) return <div className="text-sm text-muted">Loading dashboard…</div>

  return (
    <>
      <div className="mb-7">
        <h1 className="font-display text-[28px] font-bold">{getGreeting()}, {data.user.name.split(' ')[0]}</h1>
        <p className="mt-1 text-sm text-muted">Here's what's moving across {data.org.name} this week.</p>
      </div>

      <div className="mb-3.5 flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wide text-muted">Your projects</span>
        <Link to="/app/projects" className="text-sm font-semibold text-accent">
          See all →
        </Link>
      </div>
      <div className="mb-9 flex gap-3.5 overflow-x-auto">
        {data.projects.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setViewProjectId(p.id)}
            className="min-w-[196px] flex-shrink-0 rounded-xl border border-border bg-card p-4 text-left transition-all hover:-translate-y-1 hover:shadow-[0_12px_24px_-14px_rgba(27,28,34,0.18)]"
          >
            <div className="mb-2 flex items-center gap-2">
              <span
                className={`h-2 w-2 flex-shrink-0 rounded-full ${
                  p.status === 'on_track' ? 'bg-green shadow-[0_0_0_4px_var(--color-green-tint)]' : 'bg-[#C6C7D0] shadow-[0_0_0_4px_#F0F0F3]'
                }`}
              />
              <span className="text-sm font-bold">{p.name}</span>
            </div>
            <div className="mb-2.5 text-xs text-lmuted">{p.docCount} docs · updated {timeAgo(p.updatedAt)}</div>
            <div className="mb-2.5 flex items-center gap-1.5 text-xs text-muted">
              <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-[#4B4C58] text-[8px] font-bold text-white">
                {p.owner.initials}
              </span>
              {p.owner.name}
            </div>
            <div className={`text-xs font-semibold ${p.status === 'on_track' ? 'text-green' : 'text-muted'}`}>
              {statusLabel[p.status]}
            </div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <div className="mb-4 flex items-start justify-between">
            <div>
              <div className="font-display text-[15px] font-bold">Task overview</div>
              <div className="mt-0.5 text-xs text-muted">Status across all meetings</div>
            </div>
            <Link to="/app/tasks" className="text-xs font-semibold text-accent">
              See all →
            </Link>
          </div>

          <div className="mb-2.5 flex h-3 w-full overflow-hidden rounded-full bg-page">
            {data.taskOverview.breakdown
              .filter((b) => b.pct > 0)
              .map((b) => (
                <div
                  key={b.status}
                  style={{ width: `${b.pct}%` }}
                  className={
                    b.status === 'done' ? 'bg-green' : b.status === 'overdue' ? 'bg-red-600' : 'bg-[#C6C7D0]'
                  }
                />
              ))}
          </div>
          <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1">
            {data.taskOverview.breakdown.map((b) => (
              <div key={b.status} className="flex items-center gap-1.5 text-xs text-muted">
                <span
                  className={`h-2 w-2 rounded-full ${
                    b.status === 'done' ? 'bg-green' : b.status === 'overdue' ? 'bg-red-600' : 'bg-[#C6C7D0]'
                  }`}
                />
                <span className="font-semibold text-ink">{b.count}</span>
                {b.status === 'open' ? 'Open' : b.status === 'overdue' ? 'Overdue' : 'Done'}
              </div>
            ))}
          </div>

          <div className="flex gap-2.5">
            <div className="flex-1 rounded-lg border border-border bg-page px-3 py-2.5">
              <div className="font-display text-lg font-bold">{data.taskOverview.completionRatePct}%</div>
              <div className="mt-0.5 text-[11px] text-muted">Completion rate</div>
            </div>
            <div className="flex-1 rounded-lg border border-border bg-page px-3 py-2.5">
              <div className="font-display text-lg font-bold">{data.taskOverview.overdueCount}</div>
              <div className="mt-0.5 text-[11px] text-muted">Overdue</div>
            </div>
          </div>

          {data.taskOverview.byAssignee.length > 0 && (
            <div className="mt-4 border-t border-border pt-3.5">
              <div className="mb-2.5 text-[11px] font-bold uppercase tracking-wide text-muted">Agent performance</div>
              {/* Fixed to ~3 rows tall (row height + gap-2, times 3) so this section stays a
                  dashboard summary instead of growing with the org's headcount — the rest
                  scroll into view inside this box rather than pushing the whole card taller. */}
              <div className="flex max-h-[92px] flex-col gap-2 overflow-y-auto pr-1">
                {data.taskOverview.byAssignee.map((a) => (
                  <div key={a.id} className="flex items-center gap-2.5">
                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[#4B4C58] text-[10px] font-bold text-white">
                      {a.initials}
                    </span>
                    <span className="w-20 flex-shrink-0 truncate text-xs font-semibold text-ink">{a.name}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-page">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2"
                        style={{ width: `${a.completionRatePct}%` }}
                      />
                    </div>
                    <span className="w-14 flex-shrink-0 text-right text-[11px] text-muted">
                      {a.doneCount}/{a.total}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        <Card>
          <div className="mb-3 text-xs text-muted">Next event</div>
          {(() => {
            // No meeting to anchor the strip on? Fall back to today's week, so an upcoming
            // holiday still has somewhere to show even with nothing scheduled.
            const referenceDate = data.nextEvent ? new Date(data.nextEvent.scheduledAt) : new Date()
            const weekDates = getWeekDates(referenceDate)
            const holidayByDate = new Map(data.upcomingHolidays.map((h) => [h.date, h.name]))
            const weekHoliday = weekDates.map((d) => holidayByDate.get(toDateOnly(d))).find((n) => n)

            if (!data.nextEvent && !weekHoliday) {
              return <div className="text-sm text-muted">No upcoming meetings scheduled.</div>
            }

            return (
              <>
                <div className="mb-1.5 grid grid-cols-7 gap-1.5">
                  {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                    <span key={i} className="text-center text-[10px] font-semibold text-lmuted">
                      {d}
                    </span>
                  ))}
                </div>
                <div className="mb-4 grid grid-cols-7 gap-1.5">
                  {weekDates.map((d, i) => {
                    const isEventDay = !!data.nextEvent && d.toDateString() === referenceDate.toDateString()
                    const holidayName = holidayByDate.get(toDateOnly(d))
                    return (
                      <div
                        key={i}
                        title={holidayName}
                        className={`mx-auto flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold ${
                          isEventDay
                            ? 'bg-gradient-to-br from-accent-2 to-accent text-white'
                            : holidayName
                              ? 'border-[1.5px] border-amber-400 text-amber-700'
                              : 'border-[1.5px] border-border text-muted'
                        }`}
                      >
                        {d.getDate()}
                      </div>
                    )
                  })}
                </div>
                {data.nextEvent ? (
                  <>
                    <div className="font-display text-sm font-bold leading-tight">{data.nextEvent.title}</div>
                    <div className="mt-1 text-xs text-muted">
                      {data.nextEvent.project && <>{data.nextEvent.project} · </>}
                      {referenceDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ·{' '}
                      {referenceDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} ·{' '}
                      {data.nextEvent.durationMin}m
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-muted">No upcoming meetings scheduled.</div>
                )}
                {weekHoliday && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-amber-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                    {weekHoliday}
                  </div>
                )}
              </>
            )
          })()}

          {/* Always shown, independent of the week-strip above — most company holidays won't
              fall in "this week" or "next event's week" on any given day, so that alone isn't
              enough for a holiday calendar to actually be visible most of the time. */}
          {data.upcomingHolidays.length > 0 && (
            <div className="mt-4 border-t border-border pt-3.5">
              <div className="mb-2.5 text-[11px] font-bold uppercase tracking-wide text-muted">Upcoming holidays</div>
              <div className="flex flex-col gap-1.5">
                {data.upcomingHolidays.slice(0, 3).map((h) => (
                  <div key={h.date} className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-ink">{h.name}</span>
                    <span className="text-muted">{formatHolidayDate(h.date)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        <Card>
          <div className="mb-4 flex items-start justify-between">
            <div>
              <div className="font-display text-[15px] font-bold">Task calendar</div>
              <div className="mt-0.5 text-xs text-muted">Open tasks due this month, by assignee</div>
            </div>
            <Link to="/app/tasks" className="text-xs font-semibold text-accent">
              See all →
            </Link>
          </div>
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setTaskCalendarMonth((m) => shiftMonth(m, -1))}
              className="flex h-6 w-6 items-center justify-center rounded-lg border border-border text-muted hover:bg-page hover:text-ink"
            >
              ‹
            </button>
            <span className="text-xs font-bold text-ink">
              {taskCalendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
            </span>
            <button
              type="button"
              onClick={() => setTaskCalendarMonth((m) => shiftMonth(m, 1))}
              className="flex h-6 w-6 items-center justify-center rounded-lg border border-border text-muted hover:bg-page hover:text-ink"
            >
              ›
            </button>
          </div>
          {(() => {
            const today = new Date()
            const cells = getMonthGridDates(taskCalendarMonth)
            const byDate = new Map((taskCalendarDays ?? []).map((d) => [d.date, d.byAssignee]))
            const todayKey = toDateOnly(today)
            return (
              <>
                <div className="mb-1.5 grid grid-cols-7 gap-1.5">
                  {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                    <span key={i} className="text-center text-[10px] font-semibold text-lmuted">
                      {d}
                    </span>
                  ))}
                </div>
                {taskCalendarDays === null ? (
                  <div className="py-6 text-center text-sm text-muted">Loading…</div>
                ) : (
                  <div className="grid grid-cols-7 gap-1.5">
                    {cells.map((d, i) => {
                      if (!d) return <div key={i} />
                      const dateKey = toDateOnly(d)
                      const assignees = byDate.get(dateKey) ?? []
                      const isToday = dateKey === todayKey
                      const hasTasks = assignees.length > 0
                      return (
                        <button
                          key={i}
                          type="button"
                          disabled={!hasTasks}
                          onClick={() => setSelectedTaskDate(dateKey)}
                          title={assignees.map((a) => `${a.name}: ${a.count}`).join('\n')}
                          className={`min-h-[62px] rounded-lg border p-1 text-left ${
                            isToday ? 'border-accent bg-accent-tint' : 'border-border bg-page'
                          } ${hasTasks ? 'cursor-pointer hover:border-accent hover:shadow-sm' : 'cursor-default'}`}
                        >
                          <div className={`mb-1 text-[11px] font-semibold ${isToday ? 'text-accent' : 'text-muted'}`}>
                            {d.getDate()}
                          </div>
                          <div className="flex flex-col gap-0.5">
                            {assignees.slice(0, 2).map((a) => (
                              <div
                                key={a.id}
                                className="truncate rounded bg-white px-1 py-0.5 text-[9.5px] font-semibold text-ink"
                              >
                                {a.initials} ×{a.count}
                              </div>
                            ))}
                            {assignees.length > 2 && (
                              <div className="text-[9px] text-muted">+{assignees.length - 2} more</div>
                            )}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </>
            )
          })()}
        </Card>

        <Card>
          <div className="mb-4 flex items-start justify-between">
            <div>
              <div className="font-display text-[15px] font-bold">Leave calendar</div>
              <div className="mt-0.5 text-xs text-muted">Who's on approved leave this month</div>
            </div>
            <Link to="/app/worknest#team-on-leave" className="text-xs font-semibold text-accent">
              See all →
            </Link>
          </div>
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setLeaveCalendarMonth((m) => shiftMonth(m, -1))}
              className="flex h-6 w-6 items-center justify-center rounded-lg border border-border text-muted hover:bg-page hover:text-ink"
            >
              ‹
            </button>
            <span className="text-xs font-bold text-ink">
              {leaveCalendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
            </span>
            <button
              type="button"
              onClick={() => setLeaveCalendarMonth((m) => shiftMonth(m, 1))}
              className="flex h-6 w-6 items-center justify-center rounded-lg border border-border text-muted hover:bg-page hover:text-ink"
            >
              ›
            </button>
          </div>
          {(() => {
            const today = new Date()
            const cells = getMonthGridDates(leaveCalendarMonth)
            const byDate = new Map((leaveCalendarDays ?? []).map((d) => [d.date, d.people]))
            const todayKey = toDateOnly(today)
            return (
              <>
                <div className="mb-1.5 grid grid-cols-7 gap-1.5">
                  {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                    <span key={i} className="text-center text-[10px] font-semibold text-lmuted">
                      {d}
                    </span>
                  ))}
                </div>
                {leaveCalendarDays === null ? (
                  <div className="py-6 text-center text-sm text-muted">Loading…</div>
                ) : (
                  <div className="grid grid-cols-7 gap-1.5">
                    {cells.map((d, i) => {
                      if (!d) return <div key={i} />
                      const dateKey = toDateOnly(d)
                      const people = byDate.get(dateKey) ?? []
                      const isToday = dateKey === todayKey
                      return (
                        <div
                          key={i}
                          title={people.map((p) => `${p.name} (${p.leaveTypeName})`).join('\n')}
                          className={`min-h-[62px] rounded-lg border p-1 ${
                            isToday ? 'border-accent bg-accent-tint' : 'border-border bg-page'
                          }`}
                        >
                          <div className={`mb-1 text-[11px] font-semibold ${isToday ? 'text-accent' : 'text-muted'}`}>
                            {d.getDate()}
                          </div>
                          <div className="flex flex-wrap gap-0.5">
                            {people.slice(0, 3).map((p) => (
                              <span
                                key={p.id}
                                className="flex h-4 w-4 items-center justify-center rounded-full bg-[#4B4C58] text-[8px] font-bold text-white"
                              >
                                {p.initials}
                              </span>
                            ))}
                            {people.length > 3 && <span className="text-[9px] text-muted">+{people.length - 3}</span>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )
          })()}
        </Card>
      </div>

      {selectedTaskDate && (
        <>
          <div className="fixed inset-0 z-[200] bg-ink/25" onClick={() => setSelectedTaskDate(null)} />
          <div className="fixed left-1/2 top-1/2 z-[201] w-[440px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-[0_30px_80px_-30px_rgba(27,28,34,0.35)]">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="font-display text-lg font-bold">{formatCalendarDate(selectedTaskDate)}</h2>
                <p className="mt-0.5 text-xs text-muted">Open tasks due this day</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTaskDate(null)}
                className="text-lg leading-none text-muted hover:text-ink"
              >
                ✕
              </button>
            </div>
            {!dateTasks ? (
              <div className="text-sm text-muted">Loading…</div>
            ) : dateTasks.length === 0 ? (
              <div className="text-sm text-muted">No open tasks due this day.</div>
            ) : (
              <div className="flex max-h-[360px] flex-col gap-2 overflow-y-auto pr-1">
                {dateTasks.map((t) => (
                  <div key={t.id} className="rounded-lg border border-border bg-page px-3 py-2.5">
                    <div className="text-sm font-semibold text-ink">{t.title}</div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                      {t.assignee ? (
                        <>
                          <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-[#4B4C58] text-[8px] font-bold text-white">
                            {t.assignee.initials}
                          </span>
                          {t.assignee.name}
                        </>
                      ) : (
                        'Unassigned'
                      )}
                      <span>· {t.meetingTitle}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Read-only project details, opened without leaving the Dashboard — direct request:
          clicking a project used to navigate to /app/projects, which the user asked to undo in
          favor of staying on this page. Same right-drawer convention as ProjectsPage.tsx's own
          drawer (always mounted, translate-x toggled by whether a project is selected), but
          nothing here is ever editable — no form fields, no Save button, just plain values and
          a Close button. Editing still only happens from the Projects page itself. */}
      <div
        onClick={() => setViewProjectId(null)}
        className={`fixed inset-0 z-[200] bg-ink/25 transition-opacity ${
          viewProjectId ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <div
        role="dialog"
        aria-label="Project details"
        className={`fixed right-0 top-0 z-[201] flex h-full w-[480px] max-w-[92vw] flex-col bg-white shadow-[-16px_0_40px_-20px_rgba(27,28,34,0.35)] transition-transform duration-250 ease-out ${
          viewProjectId ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-start justify-between border-b border-border px-6 py-5">
          <div>
            <h2 className="mb-1 font-display text-lg font-bold">{viewProject?.name ?? 'Project details'}</h2>
            <p className="text-sm text-muted">Viewing only — edit this project from the Projects page.</p>
          </div>
          <button
            type="button"
            onClick={() => setViewProjectId(null)}
            className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-lg border border-border text-sm text-muted hover:bg-page"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          {!viewProject ? (
            <div className="text-sm text-muted">Loading…</div>
          ) : (
            <>
              <div className="mb-3.5 flex items-center gap-2">
                <span
                  className={`whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-bold ${
                    viewProject.status === 'on_track' ? 'bg-green-tint text-green' : 'bg-[#F0F0F3] text-muted'
                  }`}
                >
                  {statusLabel[viewProject.status]}
                </span>
                <span className="text-xs text-muted">
                  {viewProject.docCount} docs · updated {timeAgo(viewProject.updatedAt)}
                </span>
              </div>
              <DetailRow label="Description" value={viewProject.description} />
              <div className="mb-3.5">
                <div className="mb-1 text-[13px] font-semibold text-muted">Owner</div>
                <div className="flex items-center gap-2 rounded-lg border border-border bg-page px-3 py-2.5 text-sm text-ink">
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[#4B4C58] text-[9px] font-bold text-white">
                    {viewProject.owner.initials}
                  </span>
                  {viewProject.owner.name}
                </div>
              </div>
              <DetailRow label="Git URL" value={viewProject.gitUrl} />
              <DetailRow label="Deployment URL" value={viewProject.deploymentUrl} />
              <div className="grid grid-cols-2 gap-3">
                <DetailRow label="Username" value={viewProject.username} />
                <DetailRow label="Password" value={viewProject.password} />
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
