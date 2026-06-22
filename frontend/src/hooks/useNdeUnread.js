import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

/** Returns unread message count for a conversation. */
export function useNdeUnread(convId) {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    client.on(`msg:list:${convId}`, notify)
    client.on(`conv:${convId}`, notify)
    return () => {
      client.off(`msg:list:${convId}`, notify)
      client.off(`conv:${convId}`, notify)
    }
  }, [client, convId])
  return useSyncExternalStore(subscribe, () => client.getUnread(convId), () => 0)
}
