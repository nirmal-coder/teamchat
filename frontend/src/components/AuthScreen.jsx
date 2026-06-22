import { useState } from 'react'
import { useStore } from '../store/index.js'

export default function AuthScreen() {
  const [tab, setTab]         = useState('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)
  const { httpUrl, setAuth }  = useStore()

  const submit = async (e) => {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const res = await fetch(`${httpUrl}/${tab}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Failed'); return }
      setAuth({ userId: data.userId, username: data.username, token: data.token })
    } catch (e) {
      setError('Cannot reach server. Is it running?')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#111b21] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-4xl mb-3">💬</div>
          <h1 className="text-2xl font-bold text-white">TeamChat</h1>
          <p className="text-gray-500 text-sm mt-1">Real-time group messaging</p>
        </div>

        <div className="bg-[#202c33] rounded-2xl p-6 shadow-xl">
          {/* Tab toggle */}
          <div className="flex rounded-lg bg-[#111b21] p-1 mb-6">
            {['login', 'register'].map(t => (
              <button key={t} onClick={() => { setTab(t); setError('') }}
                className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${tab === t ? 'bg-green-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                {t === 'login' ? 'Sign In' : 'Create Account'}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Username</label>
              <input
                value={username} onChange={e => setUsername(e.target.value)}
                placeholder="Enter username"
                autoComplete="username"
                required
                className="w-full bg-[#2a3942] rounded-lg px-4 py-2.5 text-sm outline-none placeholder-gray-600 focus:ring-1 focus:ring-green-600"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Password</label>
              <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder="Enter password"
                autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
                required
                className="w-full bg-[#2a3942] rounded-lg px-4 py-2.5 text-sm outline-none placeholder-gray-600 focus:ring-1 focus:ring-green-600"
              />
            </div>

            {error && <p className="text-red-400 text-xs">{error}</p>}

            <button type="submit" disabled={loading}
              className="w-full bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg text-sm transition-colors">
              {loading ? 'Please wait…' : tab === 'login' ? 'Sign In' : 'Create Account'}
            </button>
          </form>
        </div>

        <p className="text-center text-gray-600 text-xs mt-6">
          Server: {httpUrl}
        </p>
      </div>
    </div>
  )
}
