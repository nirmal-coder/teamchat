import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

/** Returns a stable sorted MsgDoc[] for a conv — re-renders when any message changes. */
export function useNdeMessages(convId) {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    client.on(`msg:list:${convId}`, notify)
    return () => client.off(`msg:list:${convId}`, notify)
  }, [client, convId])
  return useSyncExternalStore(subscribe, () => client.getMessages(convId), () => [])
}
