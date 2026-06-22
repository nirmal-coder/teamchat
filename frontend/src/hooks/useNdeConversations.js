import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

/** Returns a stable sorted ConvDoc[] — re-renders only when the list changes. */
export function useNdeConversations() {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    client.on('conv:list', notify)
    return () => client.off('conv:list', notify)
  }, [client])
  return useSyncExternalStore(subscribe, () => client.getConversations(), () => [])
}
