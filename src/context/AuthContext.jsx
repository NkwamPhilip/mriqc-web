/**
 * AuthContext — optional user accounts for WebMRIQC.
 *
 * Guests use the app fully without an account. When a user logs in, their
 * JWT is stored in localStorage (under the same key api.js reads) so that
 * MRIQC / DICOM submissions are automatically attributed to them and appear
 * on the "My Submissions" dashboard.
 */

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import {
  TOKEN_KEY, getToken,
  registerUser, loginUser, fetchMe,
} from '../lib/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(null)
  const [loading, setLoading] = useState(true)   // true while restoring session

  // Restore session on first load: if a token exists, fetch the user.
  useEffect(() => {
    const token = getToken()
    if (!token) { setLoading(false); return }
    fetchMe(token)
      .then((data) => setUser(data.user))
      .catch(() => localStorage.removeItem(TOKEN_KEY))   // stale/invalid token
      .finally(() => setLoading(false))
  }, [])

  const persist = useCallback((data) => {
    localStorage.setItem(TOKEN_KEY, data.token)
    setUser(data.user)
    return data.user
  }, [])

  const login = useCallback(async (creds) => {
    return persist(await loginUser(creds))
  }, [persist])

  const register = useCallback(async (info) => {
    return persist(await registerUser(info))
  }, [persist])

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
