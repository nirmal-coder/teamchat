import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

/** Returns pinned ulid[] for a conversation. */
export function useNdePins(convId) {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    client.on(`pins:${convId}`, notify)
    return () => client.off(`pins:${convId}`, notify)
  }, [client, convId])
  return useSyncExternalStore(
    subscribe,
    () => client.getConversation(convId)?.pins ?? [],
    () => [],
  )
}
