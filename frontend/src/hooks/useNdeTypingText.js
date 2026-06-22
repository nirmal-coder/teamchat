import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

/** Returns a human-readable typing string, e.g. "Alice is typing…", or null. */
export function useNdeTypingText(convId) {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    client.on(`typing:${convId}`, notify)
    return () => client.off(`typing:${convId}`, notify)
  }, [client, convId])
  return useSyncExternalStore(subscribe, () => {
    const now = Date.now()
    const typists = [...client.getTyping(convId).entries()]
      .filter(([uid, exp]) => uid !== client.userId && exp > now)
      .map(([uid]) => uid)
    if (!typists.length) return null
    if (typists.length === 1) return `${typists[0]} is typing…`
    if (typists.length === 2) return `${typists[0]} and ${typists[1]} are typing…`
    return `${typists[0]} and ${typists.length - 1} others are typing…`
  }, () => null)
}
