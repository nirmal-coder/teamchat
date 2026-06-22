import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

/**
 * Per-conversation preferences: mute, archive, favourite, draft text.
 * These are local-only (not synced across devices via the server).
 * Stored in IndexedDB `prefs` store and survive page refresh.
 *
 * Returns:
 *   muted        boolean
 *   mutedUntil   number | null  (timestamp — null means indefinite)
 *   archived     boolean
 *   favourite    boolean
 *   draft        string
 *   setMuted(muted, mutedUntil?)  — pass mutedUntil=null to mute indefinitely
 *   setArchived(bool)
 *   setFavourite(bool)
 *   setDraft(text)
 */
export function useNdeConvPrefs(convId) {
  const client = useNdeClient()

  const subscribe = useCallback((notify) => {
    client.on(`prefs:${convId}`, notify)
    return () => client.off(`prefs:${convId}`, notify)
  }, [client, convId])

  const prefs = useSyncExternalStore(
    subscribe,
    () => client.getConvPrefs(convId),
    () => null
  )

  const setMuted     = useCallback((muted, mutedUntil = null) =>
    client.setConvPref(convId, { muted, mutedUntil }), [client, convId])

  const setArchived  = useCallback((archived) =>
    client.setConvPref(convId, { archived }), [client, convId])

  const setFavourite = useCallback((favourite) =>
    client.setConvPref(convId, { favourite }), [client, convId])

  const setDraft     = useCallback((draft) =>
    client.setConvPref(convId, { draft }), [client, convId])

  return {
    muted:      prefs?.muted      ?? false,
    mutedUntil: prefs?.mutedUntil ?? null,
    archived:   prefs?.archived   ?? false,
    favourite:  prefs?.favourite  ?? false,
    draft:      prefs?.draft      ?? '',
    setMuted, setArchived, setFavourite, setDraft,
  }
}
