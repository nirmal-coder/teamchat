import { createContext, useContext } from 'react'

export const NdeClientContext = createContext(null)

export function useNdeClient() {
  const client = useContext(NdeClientContext)
  if (!client) throw new Error('useNdeClient must be used inside <NdeChatProvider>')
  return client
}
