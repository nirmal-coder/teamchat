import { useMemo } from 'react'
import { useNdeClient } from './useNdeClient.js'

/**
 * Returns stable action handlers for mutating messages in a conversation.
 * Object reference is stable while convId and client don't change.
 */
export function useNdeMessageActions(convId) {
  const client = useNdeClient()
  return useMemo(() => ({
    editMessage:     (targetUlid, newText)   => client.editMessage(convId, targetUlid, newText),
    deleteMessage:   (targetUlid)            => client.deleteMessage(convId, targetUlid),
    toggleReact:     (targetUlid, emoji)     => client.toggleReact(convId, targetUlid, emoji),
    pinMessage:      (targetUlid, on)        => client.pinMessage(convId, targetUlid, on),
    consumeViewOnce: (targetUlid)            => client.consumeViewOnce(convId, targetUlid),
    vote:            (pollUlid, optionIdxs)  => client.vote(convId, pollUlid, optionIdxs),
  }), [client, convId])
}
