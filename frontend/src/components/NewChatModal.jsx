import { useState } from 'react'
import { useStore } from '../store/index.js'
import { useNdeClient } from '../hooks/useNdeClient.js'
import { useUsers } from '../hooks/useUsers.js'

export default function NewChatModal({ onClose }) {
  const [tab, setTab]         = useState('dm')
  const [search, setSearch]   = useState('')
  const [groupName, setGroupName] = useState('')
  const [selected, setSelected]   = useState(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  const client        = useNdeClient()
  const userId        = useStore(s => s.userId)
  const token         = useStore(s => s.token)
  const httpUrl       = useStore(s => s.httpUrl)
  const setActiveConv = useStore(s => s.setActiveConv)
  const allUsers = useUsers().filter(u => u.userId !== userId)
  const filtered = allUsers.filter(u =>
    u.username.toLowerCase().includes(search.toLowerCase())
  )

  const createConv = async (type, targetUserId = null) => {
    setError(''); setLoading(true)
    try {
      const body = type === 'dm'
        ? { type: 'dm', targetUserId }
        : { type: 'group', name: groupName.trim(), memberIds: [...selected] }
      const res = await fetch(`${httpUrl}/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Failed'); return }

      const members = data.members.map(m => m.userId)
      client.joinConv(data.convId, members, data.subject)
      setActiveConv(data.convId)
      onClose()
    } catch (e) {
      setError('Request failed')
    } finally {
      setLoading(false)
    }
  }

  const toggleUser = (uid) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(uid) ? next.delete(uid) : next.add(uid)
      return next
    })
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-[#202c33] rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <h2 className="font-semibold text-white">New Chat</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-white/5">
          {[['dm', 'Direct Message'], ['group', 'New Group']].map(([key, label]) => (
            <button key={key} onClick={() => { setTab(key); setSearch(''); setSelected(new Set()); setError('') }}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${tab === key ? 'text-green-400 border-b-2 border-green-500' : 'text-gray-400 hover:text-white'}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="p-4 space-y-3">
          {tab === 'group' && (
            <input value={groupName} onChange={e => setGroupName(e.target.value)}
              placeholder="Group name"
              className="w-full bg-[#2a3942] rounded-lg px-4 py-2.5 text-sm outline-none placeholder-gray-500" />
          )}

          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search users…"
            className="w-full bg-[#2a3942] rounded-lg px-4 py-2.5 text-sm outline-none placeholder-gray-500" />

          {/* User list */}
          <div className="max-h-64 overflow-y-auto space-y-1 -mx-1 px-1">
            {filtered.length === 0 && (
              <p className="text-gray-500 text-sm text-center py-4">No users found</p>
            )}
            {filtered.map(u => (
              <button key={u.userId} onClick={() => tab === 'dm' ? createConv('dm', u.userId) : toggleUser(u.userId)}
                disabled={loading}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                  tab === 'group' && selected.has(u.userId)
                    ? 'bg-green-700/30 text-green-300'
                    : 'hover:bg-[#2a3942] text-white'
                }`}>
                <div className="w-9 h-9 rounded-full bg-[#2a3942] flex items-center justify-center text-sm font-bold flex-shrink-0">
                  {u.username[0].toUpperCase()}
                </div>
                <span className="text-sm">{u.username}</span>
                {tab === 'group' && selected.has(u.userId) && (
                  <span className="ml-auto text-green-400 text-lg">✓</span>
                )}
              </button>
            ))}
          </div>

          {error && <p className="text-red-400 text-xs">{error}</p>}

          {tab === 'group' && (
            <button onClick={() => createConv('group')}
              disabled={loading || !groupName.trim() || selected.size === 0}
              className="w-full bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white font-medium py-2.5 rounded-lg text-sm transition-colors">
              {loading ? 'Creating…' : `Create Group${selected.size > 0 ? ` (${selected.size + 1})` : ''}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
