import { useState, useRef, useEffect } from 'react'
import { useStore } from '../store/index.js'
import { useNdeMessageActions } from '../hooks/useNdeMessageActions.js'
import { useNdeClient } from '../hooks/useNdeClient.js'
import { CT } from '../ws/frames.js'
import PollCard from './PollCard.jsx'

const COMMON_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

function StatusTick({ status }) {
  if (status === 'pending')   return <span className="text-gray-600 text-xs">●</span>
  if (status === 'sent')      return <span className="text-gray-400 text-xs">✓</span>
  if (status === 'delivered') return <span className="text-gray-400 text-xs">✓✓</span>
  if (status === 'read')      return <span className="text-blue-400 text-xs">✓✓</span>
  return null
}

function ReactionBar({ reactions, onToggle }) {
  const grouped = {}
  Object.entries(reactions ?? {}).forEach(([, emoji]) => {
    grouped[emoji] = (grouped[emoji] ?? 0) + 1
  })
  if (!Object.keys(grouped).length) return null
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {Object.entries(grouped).map(([emoji, count]) => (
        <button key={emoji} onClick={() => onToggle(emoji)}
          className="flex items-center gap-0.5 bg-white/10 hover:bg-white/20 rounded-full px-2 py-0.5 text-xs">
          {emoji} {count > 1 && count}
        </button>
      ))}
    </div>
  )
}

export default function MessageBubble({ msg, convId, senderName, userMap, onReplySelect }) {
  const userId = useStore(s => s.userId)
  const client = useNdeClient()
  const { editMessage, deleteMessage, toggleReact, pinMessage, consumeViewOnce } = useNdeMessageActions(convId)
  const replyMsg = msg.replyTo ? client.getMessage(convId, msg.replyTo) : null
  const isMine = msg.senderId === userId
  const [showMenu, setShowMenu]           = useState(false)
  const [editing, setEditing]             = useState(false)
  const [editText, setEditText]           = useState(msg.payload ?? '')
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const menuRef = useRef()

  useEffect(() => {
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setShowMenu(false); setShowEmojiPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const canEdit   = isMine && !msg.deleted && !msg.expired && (Date.now() - msg.ts < 15 * 60 * 1000)
  const canDelete = isMine && !msg.deleted && !msg.expired && (Date.now() - msg.ts < 48.5 * 60 * 60 * 1000)

  const handleEdit = () => {
    if (!editText.trim() || editText === msg.payload) { setEditing(false); return }
    editMessage(msg.ulid, editText)
    setEditing(false)
  }

  const renderContent = () => {
    if (msg.expired) return <span className="italic text-gray-500 text-sm">⏱ Message expired</span>
    if (msg.deleted) return <span className="italic text-gray-500 text-sm">🗑 Message deleted</span>

    if (msg.contentType === CT.POLL) return <PollCard msg={msg} convId={convId} />

    if (msg.contentType === CT.VIEW_ONCE) {
      const viewed = msg.viewedBy?.includes(userId)
      return viewed
        ? <span className="italic text-gray-500 text-sm">👁 Viewed</span>
        : (
          <button onClick={() => consumeViewOnce(msg.ulid)}
            className="flex items-center gap-2 bg-white/10 hover:bg-white/20 rounded-lg px-3 py-2 text-sm">
            👁 View once media — tap to open
          </button>
        )
    }

    if (msg.contentType === CT.SYSTEM) {
      return <span className="text-xs text-gray-400 italic">{msg.payload}</span>
    }

    if (msg.contentType === CT.IMAGE || msg.contentType === CT.VIDEO || msg.contentType === CT.AUDIO || msg.contentType === CT.DOC) {
      return (
        <div className="flex items-center gap-2 text-sm bg-white/10 rounded-lg px-3 py-2">
          <span>{msg.contentType === CT.IMAGE ? '🖼' : msg.contentType === CT.VIDEO ? '🎬' : msg.contentType === CT.AUDIO ? '🎵' : '📄'}</span>
          <span className="text-gray-300">{msg.meta?.media?.filename ?? 'Media attachment'}</span>
        </div>
      )
    }

    if (editing) {
      return (
        <div className="flex gap-2" onClick={e => e.stopPropagation()}>
          <input value={editText} onChange={e => setEditText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleEdit(); if (e.key === 'Escape') setEditing(false) }}
            className="flex-1 bg-white/10 rounded px-2 py-1 text-sm outline-none border border-white/30" autoFocus />
          <button onClick={handleEdit} className="text-green-400 text-xs">Save</button>
          <button onClick={() => setEditing(false)} className="text-gray-400 text-xs">Cancel</button>
        </div>
      )
    }

    return (
      <div className="text-sm whitespace-pre-wrap break-words">
        {msg.fwd > 0 && <span className="text-xs text-gray-400 block mb-0.5">↪ Forwarded</span>}
        {msg.replyTo && (
          <div className="border-l-2 border-green-500 pl-2 mb-1 rounded-sm bg-white/5 py-1 pr-2 cursor-pointer"
            onClick={() => onReplySelect?.(replyMsg)}>
            <div className="text-xs font-medium text-green-400 mb-0.5">
              {replyMsg ? (userMap?.get(replyMsg.senderId) ?? replyMsg.senderId?.slice(0, 8)) : '…'}
            </div>
            <div className="text-xs text-gray-400 truncate">
              {replyMsg
                ? (replyMsg.deleted ? '🗑 Deleted message'
                  : replyMsg.expired ? '⏱ Expired message'
                  : replyMsg.contentType === CT.IMAGE ? '🖼 Photo'
                  : replyMsg.contentType === CT.VIDEO ? '🎬 Video'
                  : replyMsg.contentType === CT.AUDIO ? '🎵 Audio'
                  : replyMsg.contentType === CT.DOC   ? '📄 Document'
                  : replyMsg.contentType === CT.POLL  ? '📊 Poll'
                  : replyMsg.payload?.slice(0, 80) ?? '…')
                : 'Message not loaded'}
            </div>
          </div>
        )}
        {msg.payload}
        {msg.ttl > 0 && <span className="text-xs text-gray-500 ml-1">⏱{msg.ttl}s</span>}
        {msg.edited && <span className="text-xs text-gray-500 ml-1">(edited)</span>}
      </div>
    )
  }

  if (msg.contentType === CT.SYSTEM) {
    return (
      <div className="flex justify-center my-2">
        <span className="bg-[#182229] text-gray-400 text-xs px-3 py-1 rounded-full">{msg.payload}</span>
      </div>
    )
  }

  return (
    <div className={`flex ${isMine ? 'justify-end' : 'justify-start'} px-4 mb-1 group relative`}>
      <div className="max-w-[72%] relative">
        {msg.pinned && <div className="text-xs text-yellow-400 mb-0.5">📌 Pinned</div>}
        {!isMine && <div className="text-xs text-green-400 mb-0.5">{senderName ?? msg.senderId?.slice(0, 8)}</div>}

        <div
          className={`rounded-lg px-3 py-2 relative ${isMine ? 'bg-[#005c4b]' : 'bg-[#202c33]'}`}
          onContextMenu={(e) => { e.preventDefault(); setShowMenu(true) }}
        >
          {renderContent()}
          <ReactionBar reactions={msg.reactions} onToggle={(emoji) => toggleReact(msg.ulid, emoji)} />
          {!msg.expired && !msg.deleted && (
            <div className="flex items-center justify-end gap-1 mt-0.5">
              <span className="text-xs text-gray-500">{new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              {isMine && <StatusTick status={msg.status} />}
            </div>
          )}
        </div>

        {showMenu && (
          <div ref={menuRef} className={`absolute ${isMine ? 'right-0' : 'left-0'} top-full mt-1 z-20 bg-[#233138] shadow-xl rounded-lg overflow-hidden min-w-[160px]`}>
            <div className="flex gap-1 px-3 py-2 border-b border-white/10">
              {COMMON_EMOJIS.map(e => (
                <button key={e} onClick={() => { toggleReact(msg.ulid, e); setShowMenu(false) }}
                  className="text-lg hover:scale-125 transition-transform">{e}</button>
              ))}
            </div>
            <button onClick={() => { onReplySelect(msg); setShowMenu(false) }}
              className="w-full text-left text-sm px-4 py-2 hover:bg-white/10">Reply</button>
            {canEdit && (
              <button onClick={() => { setEditing(true); setShowMenu(false) }}
                className="w-full text-left text-sm px-4 py-2 hover:bg-white/10">Edit</button>
            )}
            {canDelete && (
              <button onClick={() => { deleteMessage(msg.ulid); setShowMenu(false) }}
                className="w-full text-left text-sm px-4 py-2 hover:bg-white/10 text-red-400">Delete</button>
            )}
            <button onClick={() => { pinMessage(msg.ulid, msg.pinned ? 0 : 1); setShowMenu(false) }}
              className="w-full text-left text-sm px-4 py-2 hover:bg-white/10">
              {msg.pinned ? 'Unpin' : 'Pin'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
