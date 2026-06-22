import { useState, useEffect } from 'react'
import { useStore } from '../store/index.js'

export function useUsers() {
  const [users, setUsers] = useState([])
  const token   = useStore(s => s.token)
  const httpUrl = useStore(s => s.httpUrl)

  useEffect(() => {
    if (!token) return
    fetch(`${httpUrl}/users`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(setUsers)
      .catch(() => {})
  }, [token, httpUrl])

  return users
}
