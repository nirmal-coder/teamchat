import { useState, useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

/**
 * Paginated message loading for a conversation.
 *
 * Loads the most-recent `pageSize` messages immediately (from IDB / in-memory).
 * Call `loadMore()` to prepend older pages — fetches from IDB first, then asks
 * the server if IDB is exhausted.
 *
 * Returns:
 *   messages   MsgDoc[]     — full list (newest at the end)
 *   loadMore   () => void   — load one more page of history
 *   hasMore    boolean      — false when server+IDB both returned nothing
 *   loading    boolean
 */
export function useNdePaginatedMessages(convId, { pageSize = 50 } = {}) {
  const client   = useNdeClient()
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)

  const subscribe = useCallback((notify) => {
    if (!convId) return () => {}
    client.on(`msg:list:${convId}`, notify)
    return () => client.off(`msg:list:${convId}`, notify)
  }, [client, convId])

  const messages = useSyncExternalStore(
    subscribe,
    () => client.getMessages(convId),
    () => []
  )

  const loadMore = useCallback(async () => {
    if (!convId || loading || !hasMore) return
    setLoading(true)
    try {
      // Find the oldest confirmed (seq > 0) message currently in memory
      const msgs   = client.getMessages(convId)
      const oldest = msgs.find(m => m.seq > 0)?.seq
      if (!oldest || oldest <= 1) { setHasMore(false); return }

      const loaded = await client.loadMoreMessages(convId, oldest, pageSize)
      // If server returned nothing (loaded === 0) and we also got nothing from IDB,
      // mark as exhausted. The server response (T.MSG frames) will still emit
      // 'msg:list:{convId}' and update `messages` via useSyncExternalStore.
      if (loaded === 0) {
        // Wait briefly for the server response before marking as exhausted
        setTimeout(() => {
          const current = client.getMessages(convId)
          if (current.length === msgs.length) setHasMore(false)
        }, 3_000)
      }
    } finally {
      setLoading(false)
    }
  }, [client, convId, hasMore, loading, pageSize])

  return { messages, loadMore, hasMore, loading }
}
