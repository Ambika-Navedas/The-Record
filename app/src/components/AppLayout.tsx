import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, NavLink, Outlet } from 'react-router-dom'
import { ChatDrawerProvider } from '../context/ChatDrawerContext'
import { useAuth } from '../context/AuthContext'
import { ChatDrawer } from './ChatDrawer'
import { SearchBar } from './SearchBar'
import { api, API_BASE_URL, type NotificationItem } from '../lib/api'

function notificationTime(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const tabs = [
  { to: '/app/dashboard', label: 'Dashboard' },
  { to: '/app/projects', label: 'Projects' },
  { to: '/app/meetings', label: 'Meetings' },
  { to: '/app/knowledge', label: 'Knowledge Base' },
  { to: '/app/tasks', label: 'Tasks' },
]

function LogoMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#1B1C22" strokeWidth={2} className="h-5 w-5">
      <path d="M3 20 L9 8 L13 15 L16 9 L21 20 Z" />
    </svg>
  )
}

export function AppLayout() {
  const { user, loading, logout } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const [notifOpen, setNotifOpen] = useState(false)
  const [notifications, setNotifications] = useState<NotificationItem[] | null>(null)
  const [unreadCount, setUnreadCount] = useState(0)
  const notifRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menuOpen])

  useEffect(() => {
    if (!notifOpen) return
    function handleClick(e: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [notifOpen])

  // Fetches the badge count on mount (so it's visible before the bell is ever clicked) — not
  // polled, so a notification created while the page is already open only appears after a
  // reload or the next time the bell is opened.
  useEffect(() => {
    if (!user) return
    api
      .get<{ items: NotificationItem[]; unreadCount: number }>('/notifications')
      .then((res) => {
        setNotifications(res.items)
        setUnreadCount(res.unreadCount)
      })
      .catch(() => {})
  }, [user])

  // Opening the panel refetches (so anything created since mount shows up) and marks everything
  // read — no per-item dismiss action, matching the "opening the panel marks them read" behavior
  // confirmed when this was scoped.
  function handleToggleNotifications() {
    const opening = !notifOpen
    setNotifOpen(opening)
    if (!opening) return
    api
      .get<{ items: NotificationItem[]; unreadCount: number }>('/notifications')
      .then((res) => setNotifications(res.items))
      .catch(() => {})
    if (unreadCount > 0) {
      api
        .post('/notifications/read-all')
        .then(() => setUnreadCount(0))
        .catch(() => {})
    }
  }

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted">Loading…</div>
  }
  if (!user) {
    return <Navigate to="/" replace />
  }

  return (
    <ChatDrawerProvider>
      <div className="min-h-screen bg-page">
        <div className="flex items-center gap-5 border-b border-border bg-white px-8 py-5">
          <div className="flex items-center gap-2 font-display text-[17px] font-bold">
            <LogoMark /> The Record
          </div>
          <SearchBar />
          <div className="flex-1" />
          <div className="flex items-center gap-3">
            <div ref={notifRef} className="relative">
              <button
                onClick={handleToggleNotifications}
                title="Notifications"
                className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-white transition-shadow hover:shadow-md"
              >
                🔔
                {unreadCount > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </button>
              {notifOpen && (
                <div className="absolute right-0 top-[46px] z-[200] w-80 max-w-[92vw] overflow-hidden rounded-xl border border-border bg-white shadow-[0_20px_50px_-20px_rgba(27,28,34,0.35)]">
                  <div className="border-b border-border px-3.5 py-2.5 text-[13px] font-semibold text-ink">
                    Notifications
                  </div>
                  <div className="max-h-80 overflow-y-auto">
                    {!notifications ? (
                      <div className="px-3.5 py-4 text-center text-[13px] text-muted">Loading…</div>
                    ) : notifications.length === 0 ? (
                      <div className="px-3.5 py-4 text-center text-[13px] text-muted">No notifications yet.</div>
                    ) : (
                      notifications.map((n) => (
                        <div key={n.id} className="border-b border-border px-3.5 py-2.5 last:border-b-0">
                          <div className="text-[13px] text-ink">{n.message}</div>
                          <div className="mt-0.5 text-[11px] text-muted">{notificationTime(n.createdAt)}</div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
            <div ref={menuRef} className="relative">
              <button
                onClick={() => setMenuOpen((open) => !open)}
                title={user.name}
                className="flex h-[30px] w-[30px] items-center justify-center overflow-hidden rounded-full border-2 border-white bg-[#4B4C58] text-[11px] font-bold text-white shadow"
              >
                {user.avatar_url ? (
                  <img src={`${API_BASE_URL}${user.avatar_url}`} alt={user.name} className="h-full w-full object-cover" />
                ) : (
                  user.initials
                )}
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-[38px] z-[200] w-52 overflow-hidden rounded-xl border border-border bg-white py-1.5 shadow-[0_20px_50px_-20px_rgba(27,28,34,0.35)]">
                  <div className="border-b border-border px-3.5 py-2.5">
                    <div className="text-[13px] font-semibold text-ink">{user.name}</div>
                    <div className="text-[12px] text-muted">{user.email}</div>
                  </div>
                  <Link
                    to="/app/profile"
                    onClick={() => setMenuOpen(false)}
                    className="block px-3.5 py-2 text-[13px] font-semibold text-ink hover:bg-page"
                  >
                    Profile settings
                  </Link>
                  <Link
                    to="/app/holidays"
                    onClick={() => setMenuOpen(false)}
                    className="block px-3.5 py-2 text-[13px] font-semibold text-ink hover:bg-page"
                  >
                    {user.org_name} Holidays
                  </Link>
                  <Link
                    to="/app/worknest"
                    onClick={() => setMenuOpen(false)}
                    className="block px-3.5 py-2 text-[13px] font-semibold text-ink hover:bg-page"
                  >
                    WorkNest
                  </Link>
                  <Link
                    to="/app/reminders"
                    onClick={() => setMenuOpen(false)}
                    className="block px-3.5 py-2 text-[13px] font-semibold text-ink hover:bg-page"
                  >
                    Reminders
                  </Link>
                  {user.role === 'admin' && (
                    <Link
                      to="/app/team-roles"
                      onClick={() => setMenuOpen(false)}
                      className="block px-3.5 py-2 text-[13px] font-semibold text-ink hover:bg-page"
                    >
                      Team roles
                    </Link>
                  )}
                  <button
                    onClick={() => {
                      setMenuOpen(false)
                      logout()
                    }}
                    className="block w-full px-3.5 py-2 text-left text-[13px] font-semibold text-red-700 hover:bg-page"
                  >
                    Log out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex gap-1 border-b border-border bg-white px-8 py-2.5">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                `rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-colors ${
                  isActive ? 'bg-accent-tint text-accent' : 'text-muted hover:bg-page hover:text-ink'
                }`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </div>

        <div className="mx-auto max-w-[1280px] px-8 py-7">
          <Outlet />
        </div>

        <ChatDrawer />
      </div>
    </ChatDrawerProvider>
  )
}
