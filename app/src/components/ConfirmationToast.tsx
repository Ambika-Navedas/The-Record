import { useEffect } from 'react'

const AUTO_DISMISS_MS = 2200

interface ConfirmationToastProps {
  message: string
  onDone: () => void
}

// Centered, auto-dismissing replacement for window.alert() — same reasoning as ReasonModal:
// a native alert() renders docked to the top of the browser chrome, no CSS can move it. No
// dimming overlay here (unlike ReasonModal) since this is a passive confirmation, not a decision
// that should block the page — the task list underneath stays interactive while it's showing.
export function ConfirmationToast({ message, onDone }: ConfirmationToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDone, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [message, onDone])

  return (
    <div className="fixed left-1/2 top-1/2 z-[201] w-[360px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-ink px-5 py-4 text-center text-white shadow-[0_30px_80px_-30px_rgba(27,28,34,0.5)]">
      <span className="mr-1.5">✓</span>
      {message}
    </div>
  )
}
