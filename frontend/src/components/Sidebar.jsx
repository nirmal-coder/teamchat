import { useState, useMemo } from 'react'
import { useStore } from '../store/index.js'
import { useNdeConversations } from '../hooks/useNdeConversations.js'
import { useNdeStatus } from '../hooks/useNdeStatus.js'
import { useNdeUnread } from '../hooks/useNdeUnread.js'
import { useUsers } from '../hooks/useUsers.js'
import { Dot } from './PresenceDot.jsx'
import NewChatModal from './NewChatModal.jsx'

export default function Sidebar() {
  const conversations = useNdeConversations()
  const wsStatus      = useNdeStatus()
  const userId        = useStore(s => s.userId)
  const username      = useStore(s => s.username)
  const activeConvId  = useStore(s => s.activeConvId)
  const setActiveConv = useStore(s => s.setActiveConv)
  const toasts        = useStore(s => s.toasts)
  const clearAuth     = useStore(s => s.clearAuth)
  const [showNewChat, setShowNewChat] = useState(false)
  const allUsers = useUsers()
  const userMap  = useMemo(() => new Map(allUsers.map(u => [u.userId, u.username])), [allUsers])

  return (
    <div className="w-80 flex flex-col bg-[#111b21] border-r border-white/5">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-[#202c33]">
        <div className="w-8 h-8 rounded-full bg-green-600 flex items-center justify-center text-sm font-bold flex-shrink-0">
          {(username || userId)?.[0]?.toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{username || userId}</div>
          <div className="flex items-center gap-1">
            <Dot online={wsStatus === 'open'} />
            <span className="text-xs text-gray-500">{wsStatus}</span>
          </div>
        </div>
        <button onClick={clearAuth} title="Sign out"
          className="text-gray-400 hover:text-white text-sm px-2 py-1 rounded hover:bg-white/10 transition-colors">
          Sign out
        </button>
      </div>

      {/* New Chat button */}
      <div className="px-3 py-2">
        <button onClick={() => setShowNewChat(true)}
          className="w-full flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 text-white rounded-lg px-3 py-2 text-sm font-medium transition-colors">
          + New Chat
        </button>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 && (
          <div className="text-center text-gray-600 text-sm mt-8 px-4">
            Start a conversation using "New Chat"
          </div>
        )}
        {conversations.map((conv) => (
          <ConvRow
            key={conv.convId}
            conv={conv}
            userId={userId}
            userMap={userMap}
            isActive={conv.convId === activeConvId}
            onSelect={setActiveConv}
          />
        ))}
      </div>

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 space-y-2 z-50">
        {toasts.map(t => (
          <div key={t.id} className={`px-4 py-2 rounded-lg text-sm shadow-xl max-w-sm ${t.kind === 'error' ? 'bg-red-700' : t.kind === 'warn' ? 'bg-yellow-700' : 'bg-gray-700'}`}>
            {t.msg}
          </div>
        ))}
      </div>

      {showNewChat && <NewChatModal onClose={() => setShowNewChat(false)} />}
    </div>
  )
}

function ConvRow({ conv, userId, userMap, isActive, onSelect }) {
  const unread = useNdeUnread(conv.convId)
  const lastMsg = conv.lastMsg
  const otherMemberId = conv.convId.startsWith('dm:')
    ? conv.members?.find(m => m !== userId)
    : null
  const displayName = conv.subject
    ?? (otherMemberId ? (userMap.get(otherMemberId) ?? otherMemberId.slice(0, 8)) : conv.convId)

  return (
    <button onClick={() => onSelect(conv.convId)}
      className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${isActive ? 'bg-[#2a3942]' : 'hover:bg-[#182229]'}`}>
      <div className="relative w-10 h-10 flex-shrink-0">
        <div className="w-10 h-10 rounded-full bg-[#2a3942] flex items-center justify-center text-sm font-bold">
          {conv.convId.startsWith('dm:') ? '👤' : (conv.subject?.[0]?.toUpperCase() ?? '#')}
        </div>
        {unread > 0 && !isActive && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-green-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex justify-between items-baseline">
          <span className={`text-sm truncate ${unread > 0 && !isActive ? 'font-semibold text-white' : 'font-medium'}`}>
            {displayName}
          </span>
          {lastMsg && (
            <span className="text-xs text-gray-500 flex-shrink-0 ml-2">
              {new Date(lastMsg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        <div className={`text-xs truncate ${unread > 0 && !isActive ? 'text-gray-300' : 'text-gray-500'}`}>
          {lastMsg
            ? (lastMsg.deleted ? 'Deleted message'
              : lastMsg.expired ? 'Expired message'
              : lastMsg.contentType === 8 ? '📊 Poll'
              : lastMsg.payload?.slice(0, 50) ?? '…')
            : 'No messages'}
        </div>
      </div>
    </button>
  )
}
