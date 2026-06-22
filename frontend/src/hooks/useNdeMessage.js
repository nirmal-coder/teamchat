import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

/**
 * Returns a single MsgDoc by ulid.
 * Performance: causes exactly 1 re-render when this specific message changes.
 */
export function useNdeMessage(convId, ulid) {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    const ev = `msg:${convId}:${ulid}`
    client.on(ev, notify)
    return () => client.off(ev, notify)
  }, [client, convId, ulid])
  return useSyncExternalStore(
    subscribe,
    () => client.getMessage(convId, ulid),
    () => null,
  )
}
