import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

/** Returns total unread count across all conversations (excludes muted convs). */
export function useNdeTotalUnread() {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    client.on('conv:list', notify)
    return () => client.off('conv:list', notify)
  }, [client])

  return useSyncExternalStore(
    subscribe,
    () => {
      let total = 0
      for (const conv of client.conversations.values()) {
        if (!client.getConvPrefs(conv.convId)?.muted) {
          total += client.getUnread(conv.convId)
        }
      }
      return total
    },
    () => 0,
  )
}
