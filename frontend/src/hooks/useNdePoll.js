import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

/** Returns live poll state (question, options, tally, voters) for a poll message. */
export function useNdePoll(convId, pollUlid) {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    client.on(`poll:${convId}:${pollUlid}`, notify)
    client.on(`msg:${convId}:${pollUlid}`, notify)
    return () => {
      client.off(`poll:${convId}:${pollUlid}`, notify)
      client.off(`msg:${convId}:${pollUlid}`, notify)
    }
  }, [client, convId, pollUlid])
  return useSyncExternalStore(
    subscribe,
    () => client.getMessage(convId, pollUlid)?.poll ?? null,
    () => null,
  )
}
