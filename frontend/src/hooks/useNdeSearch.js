import { useState, useCallback } from 'react'
import { useNdeClient } from './useNdeClient.js'

/**
 * Full-text search across all messages stored in IndexedDB.
 *
 * Uses a client-side scan (O(n) over stored records).
 * Results are sorted by most-recent first, limited to 30 by default.
 *
 * Returns:
 *   search(query, limit?)  — async, triggers search
 *   clear()                — reset results
 *   results  MsgDoc[]      — matched messages (with `convId` field)
 *   loading  boolean
 *   query    string        — current query string
 */
export function useNdeSearch() {
  const client  = useNdeClient()
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [query,   setQuery]   = useState('')

  const search = useCallback(async (q, limit = 30) => {
    const trimmed = q?.trim() ?? ''
    setQuery(trimmed)
    if (!trimmed) { setResults([]); return }
    setLoading(true)
    try {
      const found = await client.searchMessages(trimmed, limit)
      setResults(found)
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [client])

  const clear = useCallback(() => { setQuery(''); setResults([]) }, [])

  return { search, clear, results, loading, query }
}
