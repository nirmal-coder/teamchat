import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

/** Returns a specific ConvDoc — re-renders only when that conv changes. */
export function useNdeConversation(convId) {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    client.on(`conv:${convId}`, notify)
    return () => client.off(`conv:${convId}`, notify)
  }, [client, convId])
  return useSyncExternalStore(subscribe, () => client.getConversation(convId), () => null)
}
