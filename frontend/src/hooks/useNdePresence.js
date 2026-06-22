import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

/** Returns 'online' | 'offline' for a specific user. */
export function useNdePresence(userId) {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    client.on(`presence:${userId}`, notify)
    return () => client.off(`presence:${userId}`, notify)
  }, [client, userId])
  return useSyncExternalStore(subscribe, () => client.getPresence(userId), () => 'offline')
}
