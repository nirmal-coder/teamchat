import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

/** Returns Map<userId, expiresAt> for a conv — replaced ref on each update. */
export function useNdeTyping(convId) {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    client.on(`typing:${convId}`, notify)
    return () => client.off(`typing:${convId}`, notify)
  }, [client, convId])
  return useSyncExternalStore(subscribe, () => client.getTyping(convId), () => new Map())
}
