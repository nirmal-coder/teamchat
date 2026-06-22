import { useNdeTypingText } from '../hooks/useNdeTypingText.js'

export default function TypingIndicator({ convId }) {
  const text = useNdeTypingText(convId)
  if (!text) return null
  return (
    <div className="flex items-center gap-2 px-4 py-1 text-xs text-gray-400">
      <span className="flex gap-0.5">
        {[0, 1, 2].map(i => (
          <span key={i} className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce"
            style={{ animationDelay: `${i * 0.15}s` }} />
        ))}
      </span>
      <span>{text}</span>
    </div>
  )
}
