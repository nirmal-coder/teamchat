import { useMemo } from 'react'
import { useNdeClient } from './useNdeClient.js'

/**
 * Returns stable action handlers for sending messages in a conversation.
 * Object reference is stable while convId and client don't change.
 */
export function useNdeSendMessage(convId) {
  const client = useNdeClient()
  return useMemo(() => ({
    sendMessage:  (text, replyTo, ttl)      => client.sendMessage(convId, text, replyTo, ttl),
    sendRead:     (seq)                     => client.sendRead(convId, seq),
    sendTyping:   ()                        => client.sendTyping(convId),
    createPoll:   (question, options, multi) => client.createPoll(convId, question, options, multi),
    setConvTimer: (seconds)                 => client.setConvTimer(convId, seconds),
  }), [client, convId])
}
