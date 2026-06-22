import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

/**
 * Returns receipt aggregate { delivered, read, total } for a specific seq,
 * or null if not yet received.
 */
export function useNdeReceipts(convId, seq) {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    client.on(`receipts:${convId}:${seq}`, notify)
    return () => client.off(`receipts:${convId}:${seq}`, notify)
  }, [client, convId, seq])
  return useSyncExternalStore(
    subscribe,
    () => client.getMessageBySeq(convId, seq)?.receiptAgg ?? null,
    () => null,
  )
}
