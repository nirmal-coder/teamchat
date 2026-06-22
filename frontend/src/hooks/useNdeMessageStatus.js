import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

/** Returns 'pending'|'sent'|'delivered'|'read'|'received' for a specific message. */
export function useNdeMessageStatus(convId, ulid) {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    client.on(`msgstatus:${convId}:${ulid}`, notify)
    client.on(`msg:${convId}:${ulid}`, notify)
    return () => {
      client.off(`msgstatus:${convId}:${ulid}`, notify)
      client.off(`msg:${convId}:${ulid}`, notify)
    }
  }, [client, convId, ulid])
  return useSyncExternalStore(
    subscribe,
    () => client.getMessage(convId, ulid)?.status ?? null,
    () => null,
  )
}
