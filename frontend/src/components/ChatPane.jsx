import { useEffect, useRef, useState, useMemo } from 'react'
import { useStore } from '../store/index.js'
import { useUsers } from '../hooks/useUsers.js'
import { useNdeMessages } from '../hooks/useNdeMessages.js'
import { useNdeConversation } from '../hooks/useNdeConversation.js'
import { useNdeSendMessage } from '../hooks/useNdeSendMessage.js'
import { useNdeGroupActions } from '../hooks/useNdeGroupActions.js'
import MessageBubble from './MessageBubble.jsx'
import TypingIndicator from './TypingIndicator.jsx'
import Composer from './Composer.jsx'

export default function ChatPane() {
  const activeConvId = useStore(s => s.activeConvId)
  const userId       = useStore(s => s.userId)
  const conv         = useNdeConversation(activeConvId)
  const allUsers     = useUsers()
  const userMap      = useMemo(() => new Map(allUsers.map(u => [u.userId, u.username])), [allUsers])
  const convTitle    = useMemo(() => {
    if (!conv) return activeConvId
    if (conv.subject) return conv.subject
    if (activeConvId?.startsWith('dm:')) {
      const otherId = conv.members?.find(m => m !== userId)
      return otherId ? (userMap.get(otherId) ?? otherId.slice(0, 8)) : activeConvId
    }
    return activeConvId
  }, [conv, activeConvId, userId, userMap])
  const messages     = useNdeMessages(activeConvId)
  const { sendRead } = useNdeSendMessage(activeConvId)
  const bottomRef    = useRef()
  const [replyTo, setReplyTo]   = useState(null)
  const [showInfo, setShowInfo] = useState(false)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  useEffect(() => {
    if (!activeConvId || !messages.length) return
    const last = messages[messages.length - 1]
    if (last && last.seq > 0) sendRead(last.seq)
  }, [activeConvId, messages.length])

  if (!activeConvId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#0b141a]">
        <div className="text-center text-gray-500">
          <div className="text-5xl mb-4">💬</div>
          <div className="text-xl font-light">NDE SyncEngine Prototype</div>
          <div className="text-sm mt-2">Select a conversation to start</div>
        </div>
      </div>
    )
  }

  const pinnedMsgs = messages.filter(m => m.pinned)

  return (
    <div className="flex-1 flex flex-col bg-[#0b141a] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-[#202c33] border-b border-white/5">
        <div className="flex-1">
          <div className="font-medium">{convTitle}</div>
          <div className="text-xs text-gray-400">
            {conv?.members?.length ? `${conv.members.length} members` : 'conversation'}
            {conv?.timer > 0 && ` · ⏱ ${conv.timer}s timer`}
          </div>
        </div>
        <button onClick={() => setShowInfo(v => !v)}
          className="text-gray-400 hover:text-white px-2 py-1 rounded text-sm">
          {showInfo ? 'Close' : 'Info'}
        </button>
      </div>

      {/* Pinned banner */}
      {pinnedMsgs.length > 0 && (
        <div className="bg-[#182229] border-b border-white/5 px-4 py-2 flex items-center gap-2 text-sm">
          <span className="text-yellow-400">📌</span>
          <span className="text-gray-300 truncate">{pinnedMsgs[pinnedMsgs.length - 1].payload ?? '[pinned message]'}</span>
          <span className="text-xs text-gray-500">{pinnedMsgs.length > 1 ? `+${pinnedMsgs.length - 1} more` : ''}</span>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto py-2" id="messages-scroll">
          {messages.length === 0 && (
            <div className="text-center text-gray-600 text-sm mt-16">No messages yet</div>
          )}
          {messages.map((msg) => (
            <MessageBubble key={msg.ulid ?? msg.seq} msg={msg} convId={activeConvId}
              senderName={userMap.get(msg.senderId) ?? msg.senderId?.slice(0, 8)}
              onReplySelect={setReplyTo} />
          ))}
          <TypingIndicator convId={activeConvId} />
          <div ref={bottomRef} />
        </div>

        {showInfo && <ConvInfoPanel convId={activeConvId} conv={conv} onClose={() => setShowInfo(false)} />}
      </div>

      <Composer convId={activeConvId} replyTo={replyTo} onClearReply={() => setReplyTo(null)} />
    </div>
  )
}

function ConvInfoPanel({ convId, conv, onClose }) {
  const { setSubject, setConvTimer, groupOp } = useNdeGroupActions(convId)
  const [subject, setSubjectVal] = useState(conv?.subject ?? '')
  const [timerSec, setTimerSec] = useState(conv?.timer ?? 0)
  const [newMember, setNewMember] = useState('')

  return (
    <div className="w-72 bg-[#111b21] border-l border-white/5 flex flex-col overflow-y-auto">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        <span className="flex-1 font-medium text-sm">Conversation Info</span>
        <button onClick={onClose} className="text-gray-400 hover:text-white text-lg">×</button>
      </div>

      <div className="p-4 space-y-4">
        <div>
          <label className="text-xs text-gray-400 block mb-1">Subject</label>
          <div className="flex gap-2">
            <input value={subject} onChange={e => setSubjectVal(e.target.value)}
              className="flex-1 bg-[#2a3942] rounded px-2 py-1 text-sm outline-none" />
            <button onClick={() => setSubject('subject', subject)}
              className="bg-green-600 hover:bg-green-500 text-white text-xs px-2 rounded">Set</button>
          </div>
        </div>

        <div>
          <label className="text-xs text-gray-400 block mb-1">Disappearing timer (seconds, 0=off)</label>
          <div className="flex gap-2">
            <input type="number" value={timerSec} onChange={e => setTimerSec(+e.target.value)} min={0}
              className="flex-1 bg-[#2a3942] rounded px-2 py-1 text-sm outline-none w-20" />
            <button onClick={() => setConvTimer(timerSec)}
              className="bg-green-600 hover:bg-green-500 text-white text-xs px-2 rounded">Set</button>
          </div>
        </div>

        <div>
          <label className="text-xs text-gray-400 block mb-1">Members ({conv?.members?.length ?? 0})</label>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {(conv?.members ?? []).map(uid => (
              <div key={uid} className="flex items-center justify-between bg-[#2a3942] rounded px-2 py-1">
                <span className="text-sm">{uid}</span>
                <div className="flex gap-1">
                  {conv?.admins?.includes(uid)
                    ? <button onClick={() => groupOp(4, uid)} className="text-xs text-yellow-400">Demote</button>
                    : <button onClick={() => groupOp(3, uid)} className="text-xs text-green-400">Promote</button>
                  }
                  <button onClick={() => groupOp(2, uid)} className="text-xs text-red-400 ml-1">Remove</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs text-gray-400 block mb-1">Add member</label>
          <div className="flex gap-2">
            <input value={newMember} onChange={e => setNewMember(e.target.value)}
              placeholder="userId" className="flex-1 bg-[#2a3942] rounded px-2 py-1 text-sm outline-none" />
            <button onClick={() => { groupOp(1, newMember); setNewMember('') }}
              className="bg-green-600 hover:bg-green-500 text-white text-xs px-2 rounded">Add</button>
          </div>
        </div>
      </div>
    </div>
  )
}
