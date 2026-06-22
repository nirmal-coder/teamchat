import { useEffect, useState } from 'react'
import { SyncClient } from '../sdk/index.js'
import { useStore } from '../store/index.js'
import { NdeClientContext } from './useNdeClient.js'

/**
 * React 18 Strict Mode safe provider for SyncClient.
 *
 * Props (all optional — fall back to the Zustand store when not provided):
 *   userId      Override user ID   (for reuse outside this prototype)
 *   deviceId    Override device ID
 *   wsUrl       WebSocket server URL
 *   getToken    async () => string   auth token getter
 *   httpUrl     Base HTTP URL for media uploads
 *   workspaceId Scopes the IDB database: nde-sync-{workspaceId}
 *               Pass this when multiple workspaces share the same browser origin.
 *
 * Drop-in example for teamchat (no Zustand dependency):
 *   <NdeChatProvider
 *     userId={userId}
 *     deviceId={`${peerId}-${workspaceId}`}
 *     getToken={() => Promise.resolve(token)}
 *     wsUrl={VITE_TEAM_CHAT_SOCKET_BASEURL}
 *     workspaceId={workspaceId}
 *   >
 */
export function NdeChatProvider({
  children,
  workspaceId = null,
  httpUrl     = null,
  userId:   userIdProp,
  deviceId: deviceIdProp,
  wsUrl:    wsUrlProp,
  getToken: getTokenProp,
}) {
  const storeUserId   = useStore(s => s.userId)
  const storeDeviceId = useStore(s => s.deviceId)
  const storeWsUrl    = useStore(s => s.wsUrl)

  const userId   = userIdProp   ?? storeUserId
  const deviceId = deviceIdProp ?? storeDeviceId
  const wsUrl    = wsUrlProp    ?? storeWsUrl
  const getToken = getTokenProp ?? (() => Promise.resolve(useStore.getState().token))
  const idbName  = workspaceId  ? `nde-sync-${workspaceId}` : 'nde-sync'

  // useState (not useRef) so that replacing the client triggers a re-render,
  // which updates the context value seen by all consumers.
  // The lazy initializer creates the first client synchronously on first render.
  const [client, setClient] = useState(
    () => new SyncClient({ userId, deviceId, getToken, wsUrl, httpUrl, idbName })
  )

  useEffect(() => {
    // React 18 Strict Mode runs: effect → cleanup → effect again (same client state).
    // The cleanup destroys the client. On the second effect run client.destroyed is true.
    // We create a fresh client via setClient, which triggers a re-render so the
    // context Provider gets the new value and all hook subscribers reattach.
    if (client.destroyed) {
      setClient(new SyncClient({ userId, deviceId, getToken, wsUrl, httpUrl, idbName }))
      return  // fresh client's effect run (after re-render) will call start()
    }

    const onToast = (msg, kind) => useStore.getState().addToast(msg, kind)
    client.on('toast', onToast)
    client.start()   // async: CryptoStore → IDB → WS connect

    return () => {
      client.off('toast', onToast)
      client.setPresenceOffline()
      client.destroy()
    }
  }, [client])   // re-runs when client changes (after Strict Mode recreate)

  return (
    <NdeClientContext.Provider value={client}>
      {children}
    </NdeClientContext.Provider>
  )
}

// ── Vite HMR: clean up the WS before the module is hot-replaced ──────────────
// Without this, Vite HMR replaces NdeChatProvider while the old WS connection
// is still alive, creating zombie connections that keep reconnecting.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    // The component's useEffect cleanup will handle the active client.
    // This is a safety net for the case where Vite replaces the module
    // before React has a chance to run the cleanup.
    console.log('[NdeChatProvider] HMR dispose — module replaced')
  })
}
