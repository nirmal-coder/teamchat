import { useState, useRef } from 'react'
import { useNdeSendMessage } from '../hooks/useNdeSendMessage.js'
import { useNdeConversation } from '../hooks/useNdeConversation.js'

const TIMER_OPTIONS = [
  { label: 'Off', value: 0 },
  { label: '30s', value: 30 },
  { label: '5m', value: 300 },
  { label: '1h', value: 3600 },
  { label: '24h', value: 86400 },
  { label: '7d', value: 604800 },
]

export default function Composer({ convId, replyTo, onClearReply }) {
  const { sendMessage, sendTyping, createPoll } = useNdeSendMessage(convId)
  const conv = useNdeConversation(convId)
  const [text, setText]         = useState('')
  const [ttl, setTtl]           = useState(0)
  const [showMore, setShowMore] = useState(false)
  const [pollMode, setPollMode] = useState(false)
  const [pollQ, setPollQ]       = useState('')
  const [pollOpts, setPollOpts] = useState(['', ''])
  const [pollMulti, setPollMulti] = useState(false)
  const inputRef = useRef()

  const handleSend = () => {
    const t = text.trim()
    if (!t) return
    const effectiveTtl = ttl || (conv?.timer ?? 0)
    sendMessage(t, replyTo?.ulid ?? null, effectiveTtl)
    setText('')
    onClearReply?.()
    inputRef.current?.focus()
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  const handleInput = (e) => {
    setText(e.target.value)
    if (e.target.value) sendTyping()
  }

  const handlePollSend = () => {
    const opts = pollOpts.filter(o => o.trim())
    if (!pollQ.trim() || opts.length < 2) return
    createPoll(pollQ.trim(), opts, pollMulti)
    setPollMode(false); setPollQ(''); setPollOpts(['', '']); setPollMulti(false)
  }

  if (pollMode) {
    return (
      <div className="bg-[#202c33] border-t border-white/5 p-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium flex-1">Create Poll</span>
          <button onClick={() => setPollMode(false)} className="text-gray-400 hover:text-white">×</button>
        </div>
        <input value={pollQ} onChange={e => setPollQ(e.target.value)} placeholder="Question…"
          className="w-full bg-[#2a3942] rounded px-3 py-1.5 text-sm outline-none" />
        {pollOpts.map((opt, i) => (
          <div key={i} className="flex gap-2">
            <input value={opt} onChange={e => { const a = [...pollOpts]; a[i] = e.target.value; setPollOpts(a) }}
              placeholder={`Option ${i + 1}`}
              className="flex-1 bg-[#2a3942] rounded px-3 py-1.5 text-sm outline-none" />
            {pollOpts.length > 2 && (
              <button onClick={() => setPollOpts(pollOpts.filter((_, j) => j !== i))} className="text-red-400 text-sm">×</button>
            )}
          </div>
        ))}
        {pollOpts.length < 12 && (
          <button onClick={() => setPollOpts([...pollOpts, ''])} className="text-green-400 text-xs">+ Add option</button>
        )}
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-400">
            <input type="checkbox" checked={pollMulti} onChange={e => setPollMulti(e.target.checked)} />
            Multiple choice
          </label>
          <button onClick={handlePollSend} className="ml-auto bg-green-600 hover:bg-green-500 text-white text-sm px-4 py-1.5 rounded-lg">
            Send Poll
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-[#202c33] border-t border-white/5">
      {replyTo && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5 text-sm">
          <div className="border-l-2 border-green-500 pl-2 flex-1 truncate text-gray-400">
            Replying to <span className="text-white">{replyTo.senderId}</span>: {replyTo.payload?.slice(0, 60)}
          </div>
          <button onClick={onClearReply} className="text-gray-500 hover:text-white">×</button>
        </div>
      )}
      <div className="flex items-end gap-2 px-3 py-2">
        <button onClick={() => setShowMore(v => !v)} className="text-gray-400 hover:text-white p-1.5 rounded-full hover:bg-white/10 text-xl self-end mb-1">
          +
        </button>
        <textarea
          ref={inputRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Type a message"
          rows={1}
          className="flex-1 bg-[#2a3942] rounded-lg px-4 py-2.5 text-sm outline-none resize-none overflow-hidden min-h-[40px] max-h-32"
          style={{ height: 'auto' }}
          onInput={e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px' }}
        />
        <button onClick={handleSend} disabled={!text.trim()}
          className="bg-green-600 hover:bg-green-500 disabled:opacity-30 text-white w-10 h-10 rounded-full flex items-center justify-center self-end text-lg transition-colors">
          ➤
        </button>
      </div>
      {showMore && (
        <div className="flex items-center gap-2 px-4 pb-2 flex-wrap">
          <button onClick={() => { setPollMode(true); setShowMore(false) }}
            className="flex items-center gap-1 text-xs bg-[#2a3942] hover:bg-[#3a4952] rounded-full px-3 py-1.5">
            📊 Poll
          </button>
          <div className="flex items-center gap-1 text-xs bg-[#2a3942] rounded-full px-3 py-1.5">
            <span>⏱ TTL:</span>
            <select value={ttl} onChange={e => setTtl(+e.target.value)}
              className="bg-transparent outline-none text-xs ml-1">
              {TIMER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <button className="flex items-center gap-1 text-xs bg-[#2a3942] hover:bg-[#3a4952] rounded-full px-3 py-1.5">
            📎 Attach
          </button>
        </div>
      )}
    </div>
  )
}
