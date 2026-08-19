import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, ApiError, API_BASE_URL } from '../lib/api'

function LogoMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#1B1C22" strokeWidth={2} className="h-[22px] w-[22px]">
      <path d="M3 20 L9 8 L13 15 L16 9 L21 20 Z" />
    </svg>
  )
}

export function LandingPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Google/SSO sign-in is a full-page redirect round trip (Google needs a real browser
  // navigation, not a fetch), so a failure comes back as a query param on this page rather
  // than a thrown error from an awaited request — read it once on mount, then strip it from
  // the URL so a page refresh doesn't keep re-showing a stale error.
  useEffect(() => {
    const errorMessages: Record<string, string> = {
      google_auth_failed: 'Google sign-in failed. Please try again.',
      domain_not_allowed: 'This app is only available to Navedas accounts.',
      account_disabled: 'This account has been deactivated.',
    }
    const errorCode = searchParams.get('error')
    if (errorCode && errorMessages[errorCode]) {
      setError(errorMessages[errorCode])
      setSearchParams((prev) => {
        prev.delete('error')
        return prev
      }, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleGoogleSignIn() {
    window.location.href = `${API_BASE_URL}/auth/google`
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      if (mode === 'signup') {
        await api.post('/auth/signup', { name, email, password })
      } else {
        await api.post('/auth/login', { email, password })
      }
      navigate('/app/dashboard')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Is the API server running?')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="bg-white">
      <nav className="flex items-center justify-between border-b border-border px-10 py-5">
        <div className="flex items-center gap-2.5 font-display text-lg font-bold">
          <LogoMark /> The Record
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-4 text-sm">
          <button
            onClick={() => setMode('login')}
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            Log in
          </button>
        </div>
      </nav>

      <div className="mx-auto grid max-w-[1280px] grid-cols-[60%_40%] gap-10 px-[60px] py-[70px]">
        <div>
          <span className="mb-5 inline-block rounded-full bg-accent-tint px-3.5 py-1.5 text-[13px] font-semibold text-accent">
            Now syncing with Zoom
          </span>
          <h1 className="mb-5 font-display text-[52px] font-bold leading-[1.05] tracking-tight">
            One workspace.
            <br />
            Every <span className="text-accent">answer.</span>
          </h1>
          <p className="mb-7 max-w-[440px] text-[17px] leading-relaxed text-muted">
            Projects, docs, meetings, and decisions — all in one searchable home. Ask The Record a question and get
            an answer with sources, not a folder to dig through.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="h-fit rounded-[18px] bg-white p-8 shadow-[0_20px_50px_-20px_rgba(27,28,34,0.18)]">
          <h2 className="mb-1 font-display text-xl font-bold">
            {mode === 'login' ? 'Log in to The Record' : 'Create your account'}
          </h2>
          <p className="mb-5 text-sm text-muted">
            {mode === 'login' ? 'Welcome back — pick up where your team left off.' : 'Set up your workspace in seconds.'}
          </p>

          <button
            type="button"
            onClick={handleGoogleSignIn}
            className="mb-2.5 flex w-full items-center justify-center gap-2.5 rounded-[9px] border border-border py-2.5 text-sm font-semibold text-lmuted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            🟦 Continue with Google
          </button>
          <button
            type="button"
            onClick={handleGoogleSignIn}
            title="Uses your Google account — no separate enterprise identity provider is configured"
            className="mb-2.5 flex w-full items-center justify-center gap-2.5 rounded-[9px] border border-border py-2.5 text-sm font-semibold text-lmuted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            🏢 Continue with SSO
          </button>

          <div className="my-4.5 flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-border" />
            or continue with email
            <span className="h-px flex-1 bg-border" />
          </div>

          {mode === 'signup' && (
            <>
              <label className="mb-1.5 block text-[13px] font-semibold">Full name</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jamie Chen"
                className="mb-3.5 w-full rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              />
            </>
          )}

          <label className="mb-1.5 block text-[13px] font-semibold">Work email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@yourcompany.com"
            className="mb-3.5 w-full rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          />

          <label className="mb-1.5 block text-[13px] font-semibold">Password</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="mb-3.5 w-full rounded-lg border border-border bg-page px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          />

          {mode === 'login' && (
            <div className="mb-4 flex items-center justify-between text-[13px] text-muted">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" />
                Stay signed in
              </label>
              <a href="#" className="font-medium text-accent">Forgot password?</a>
            </div>
          )}

          {error && <div className="mb-3.5 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-[9px] bg-accent py-3 text-sm font-bold text-white disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {submitting ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
          </button>
          <div className="mt-4 text-center text-[13px] text-muted">
            {mode === 'login' ? (
              <>
                Don't have an account?{' '}
                <button type="button" onClick={() => setMode('signup')} className="font-semibold text-accent">
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{' '}
                <button type="button" onClick={() => setMode('login')} className="font-semibold text-accent">
                  Log in
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
