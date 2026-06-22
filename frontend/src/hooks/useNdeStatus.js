import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

export function useNdeStatus() {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    client.on('status', notify)
    return () => client.off('status', notify)
  }, [client])
  return useSyncExternalStore(subscribe, () => client.getStatus(), () => 'closed')
}
