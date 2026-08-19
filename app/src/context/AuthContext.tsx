import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, type AuthedUser } from '../lib/api'

interface AuthContextValue {
  user: AuthedUser | null
  loading: boolean
  logout: () => Promise<void>
  updateUser: (user: AuthedUser) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthedUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .get<AuthedUser>('/auth/me')
      .then(setUser)
      .catch((err) => {
        if (!(err instanceof ApiError)) console.error(err)
        setUser(null)
      })
      .finally(() => setLoading(false))
  }, [])

  async function logout() {
    await api.post('/auth/logout')
    setUser(null)
  }

  // Called after a successful profile edit so the header's initials/name update immediately,
  // without needing a full page reload or a redundant GET /auth/me round trip.
  function updateUser(next: AuthedUser) {
    setUser(next)
  }

  return <AuthContext.Provider value={{ user, loading, logout, updateUser }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
