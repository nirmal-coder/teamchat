import { useState, useEffect } from 'react'
import { useStore } from '../store/index.js'

export function useUsers() {
  const [users, setUsers] = useState([])
  const token     = useStore(s => s.token)
  const httpUrl   = useStore(s => s.httpUrl)
  const clearAuth = useStore(s => s.clearAuth)

  useEffect(() => {
    if (!token || !httpUrl) return
    fetch(`${httpUrl}/users`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => {
        if (r.status === 401) { clearAuth(); return null }
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(data => { if (data && Array.isArray(data)) setUsers(data) })
      .catch(e => console.warn('[useUsers]', e.message))
  }, [token, httpUrl])

  return users
}
