import { useStore } from '../store/index.js'
import { useNdePoll } from '../hooks/useNdePoll.js'
import { useNdeMessageActions } from '../hooks/useNdeMessageActions.js'

export default function PollCard({ msg, convId }) {
  const userId = useStore(s => s.userId)
  const poll   = useNdePoll(convId, msg.ulid)
  const { vote } = useNdeMessageActions(convId)

  if (!poll) return <span className="italic text-gray-500">[poll]</span>

  const { question, options, multi, tally = [], voters = {} } = poll
  const myVotes    = voters[userId] ?? []
  const totalVotes = tally.reduce((a, b) => a + b, 0)

  const handleVote = (idx) => {
    if (msg.deleted || msg.expired) return
    const next = multi
      ? (myVotes.includes(idx) ? myVotes.filter(i => i !== idx) : [...myVotes, idx])
      : (myVotes[0] === idx ? [] : [idx])
    vote(msg.ulid, next)
  }

  return (
    <div className="rounded-lg overflow-hidden min-w-[220px]">
      <div className="text-sm font-medium mb-2">{question}</div>
      {options.map((opt, idx) => {
        const count = tally[idx] ?? 0
        const pct   = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0
        const voted = myVotes.includes(idx)
        return (
          <button key={idx} onClick={() => handleVote(idx)}
            className={`w-full text-left mb-1.5 rounded-md overflow-hidden relative text-sm transition-opacity ${voted ? 'ring-1 ring-green-500' : 'hover:opacity-90'}`}>
            <div className="absolute inset-y-0 left-0 bg-white/10 transition-all" style={{ width: `${pct}%` }} />
            <div className="relative flex justify-between items-center px-3 py-1.5">
              <span>{voted ? '✓ ' : ''}{opt}</span>
              <span className="text-xs text-gray-400">{pct}%</span>
            </div>
          </button>
        )
      })}
      <div className="text-xs text-gray-500 mt-1">
        {totalVotes} vote{totalVotes !== 1 ? 's' : ''}{multi ? ' · multiple choice' : ''}
      </div>
    </div>
  )
}
