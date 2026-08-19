import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DayPicker, type DateRange } from 'react-day-picker'
import 'react-day-picker/style.css'

export interface DateRangeValue {
  from: string // 'YYYY-MM-DD'
  to: string // 'YYYY-MM-DD'
}

interface Props {
  value: DateRangeValue | null
  onChange: (range: DateRangeValue | null) => void
  placeholder: string
}

// Local-date 'YYYY-MM-DD' formatting — deliberately not toISOString().slice(0, 10), which
// converts to UTC first and can shift the date by one near midnight in timezones behind UTC.
// This is what the day the user actually clicked should read as, in their own timezone.
function toDateOnly(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fromDateOnly(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d)
  copy.setDate(copy.getDate() + days)
  return copy
}

function formatDisplay(s: string): string {
  const d = fromDateOnly(s)
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
}

function presets(): { label: string; range: DateRangeValue }[] {
  const today = new Date()
  const t = toDateOnly(today)
  const yesterday = toDateOnly(addDays(today, -1))
  return [
    { label: 'Today', range: { from: t, to: t } },
    { label: 'Yesterday', range: { from: yesterday, to: yesterday } },
    { label: 'Last 7 days', range: { from: toDateOnly(addDays(today, -6)), to: t } },
    { label: 'Last 30 days', range: { from: toDateOnly(addDays(today, -29)), to: t } },
    { label: 'Last 3 months', range: { from: toDateOnly(addDays(today, -89)), to: t } },
  ]
}

// Reusable calendar-dropdown range picker — trigger button + popover with a preset sidebar and
// a two-month react-day-picker range calendar. Built after a direct request to replace the
// native <input type="date"> pairs used for date filtering (Knowledge Base's Date filter, and
// Tasks' Meeting date / Due date ranges) with a real calendar UI across all three. `value`/
// `onChange` use the same 'YYYY-MM-DD' string shape those call sites already worked with — this
// component only converts to/from real Date objects internally, for react-day-picker's benefit.
export function DateRangePicker({ value, onChange, placeholder }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // A fixed left/right alignment overflows off-screen for *some* trigger position no matter
  // which side is picked — guessing ahead of render off an estimated popover width isn't
  // reliable (three date filters packed into one row, as on the Tasks page, leaves too little
  // room on both sides for any fixed rule to work). Instead, render at `left: 0` first, then
  // measure the popover's real rendered position and nudge it by exactly however many pixels it
  // takes to stay fully inside the viewport, on whichever side it's actually overflowing.
  const [shiftX, setShiftX] = useState(0)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useLayoutEffect(() => {
    if (!open || !popoverRef.current) return
    setShiftX(0) // reset before measuring, in case the range/month changed the popover's own width since last open
    const margin = 8
    const rect = popoverRef.current.getBoundingClientRect()
    if (rect.right > window.innerWidth - margin) {
      setShiftX(window.innerWidth - margin - rect.right)
    } else if (rect.left < margin) {
      setShiftX(margin - rect.left)
    }
  }, [open])

  const selected: DateRange | undefined = value
    ? { from: fromDateOnly(value.from), to: fromDateOnly(value.to) }
    : undefined

  function handleSelect(range: DateRange | undefined) {
    if (!range?.from) {
      onChange(null)
      return
    }
    // While a range is mid-drag (only `from` picked yet), react-day-picker reports `to` as
    // undefined — treat that as a same-day range so the calendar highlights something sensible
    // rather than erroring, and finalize to the real range once `to` lands.
    onChange({ from: toDateOnly(range.from), to: toDateOnly(range.to ?? range.from) })
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-lg border border-border bg-page px-3 py-1.5 text-[13px] font-semibold text-ink hover:border-accent"
      >
        📅
        {value ? (
          <span>
            {formatDisplay(value.from)} <span className="text-muted">→</span> {formatDisplay(value.to)}
          </span>
        ) : (
          <span className="font-normal text-muted">{placeholder}</span>
        )}
      </button>

      {open && (
        <div
          ref={popoverRef}
          style={{ transform: shiftX ? `translateX(${shiftX}px)` : undefined }}
          className="absolute left-0 top-[calc(100%+6px)] z-50 flex w-max rounded-xl border border-border bg-white shadow-[0_20px_50px_-20px_rgba(27,28,34,0.35)]"
        >
          <div className="flex w-[160px] flex-shrink-0 flex-col rounded-l-xl border-r border-border bg-page py-2">
            <button
              onClick={() => {
                onChange(null)
                setOpen(false)
              }}
              className="px-4 py-2 text-left text-[13px] font-semibold text-muted hover:bg-white hover:text-accent"
            >
              All time
            </button>
            {presets().map((p) => (
              <button
                key={p.label}
                onClick={() => {
                  onChange(p.range)
                  setOpen(false)
                }}
                className="px-4 py-2 text-left text-[13px] text-ink hover:bg-white hover:text-accent"
              >
                {p.label}
              </button>
            ))}
          </div>
          <DayPicker
            mode="range"
            numberOfMonths={2}
            selected={selected}
            onSelect={handleSelect}
            defaultMonth={value ? fromDateOnly(value.from) : undefined}
            className="flex-shrink-0 p-3.5 text-[13px]"
            style={
              {
                '--rdp-day-width': '34px',
                '--rdp-day-height': '34px',
                '--rdp-day_button-width': '32px',
                '--rdp-day_button-height': '32px',
                '--rdp-months-gap': '1.25rem',
                '--rdp-nav-height': '2rem',
                '--rdp-nav_button-width': '1.75rem',
                '--rdp-nav_button-height': '1.75rem',
                // Every day in a selected range gets react-day-picker's default 2px accent-ring
                // border (`.rdp-selected .rdp-day_button`), not just the start/end — that's what
                // made the range look like a chain of individually outlined circles instead of a
                // single flat bar. Killing the ring here and relying on range_start/range_end's
                // solid fill (below) to mark the endpoints is what actually simplifies it.
                '--rdp-selected-border': 'none',
              } as React.CSSProperties
            }
            classNames={{
              // react-day-picker's base CSS sets BOTH `font-weight: bold` AND `font-size: large` on
              // every "selected" day (`.rdp-selected { ... }`) — every day in a range counts as
              // selected, start/end included, not just the middle. A plain `font-normal`/text-size
              // class loses this fight on CSS source order (react-day-picker's stylesheet is
              // injected after Tailwind's, so `.rdp-selected` wins at equal specificity regardless
              // of what's in the element's own class list — verified via computed style, not
              // assumed) — the `!` important-modifier forces these to actually win.
              range_start: 'rdp-range_start bg-accent text-white rounded-l-full !font-normal !text-[13px]',
              range_end: 'rdp-range_end bg-accent text-white rounded-r-full !font-normal !text-[13px]',
              range_middle: 'bg-accent-tint text-ink !font-normal !text-[13px]',
              today: 'font-bold text-accent',
              month_caption: 'text-[14px] font-bold',
            }}
          />
        </div>
      )}
    </div>
  )
}
