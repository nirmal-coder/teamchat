import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

export function useNdeQueueSize() {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    client.on('queue:size', notify)
    return () => client.off('queue:size', notify)
  }, [client])
  return useSyncExternalStore(subscribe, () => client.getQueueSize(), () => 0)
}
