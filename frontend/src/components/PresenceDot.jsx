export default function PresenceDot({ userId }) {
  // presence is tracked in store but PresenceDot is a pure display component
  // Parent passes isOnline
  return null
}

export function Dot({ online }) {
  return (
    <span className={`inline-block w-2.5 h-2.5 rounded-full border-2 border-[#111b21] ${online ? 'bg-green-400' : 'bg-gray-500'}`} />
  )
}
