import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

/** Returns the full presence Map<userId, 'online'|'offline'>. */
export function useNdePresenceBulk() {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    client.on('presence:bulk', notify)
    return () => client.off('presence:bulk', notify)
  }, [client])
  // presence Map is replaced on each update → Object.is detects change
  return useSyncExternalStore(subscribe, () => client.presence, () => new Map())
}
