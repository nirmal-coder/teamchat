import { useMemo } from 'react'
import { useNdeClient } from './useNdeClient.js'
import { useStore } from '../store/index.js'

/**
 * Returns stable action handlers for conversation/group management.
 * Object reference is stable while convId and client don't change.
 */
export function useNdeGroupActions(convId) {
  const client = useNdeClient()
  const userId = useStore(s => s.userId)
  return useMemo(() => ({
    setSubject:  (field, value) => client.setSubject(convId, field, value),
    setConvTimer: (seconds)    => client.setConvTimer(convId, seconds),
    groupOp:     (op, target)  => client.groupOp(convId, op, target),
    joinConv:    (members)     => client.joinConv(convId, members ?? [userId]),
  }), [client, convId, userId])
}
