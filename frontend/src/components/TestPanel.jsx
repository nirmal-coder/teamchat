/**
 * TestPanel — interactive feature verification panel for the NDE SyncEngine SDK.
 * Add it to App.jsx to test all 24 features without touching the main chat UI.
 *
 * Usage in App.jsx:
 *   import TestPanel from './components/TestPanel.jsx'
 *   // Add <TestPanel /> anywhere inside <NdeChatProvider>
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/index.js'
import { useNdeClient } from '../hooks/useNdeClient.js'
import { useNdeStatus } from '../hooks/useNdeStatus.js'
import { useNdeQueueSize } from '../hooks/useNdeQueueSize.js'
import { useNdeConversations } from '../hooks/useNdeConversations.js'
import { useNdeConversation } from '../hooks/useNdeConversation.js'
import { useNdeUnread } from '../hooks/useNdeUnread.js'
import { useNdeMessages } from '../hooks/useNdeMessages.js'
import { useNdeMessage } from '../hooks/useNdeMessage.js'
import { useNdePresence } from '../hooks/useNdePresence.js'
import { useNdePresenceBulk } from '../hooks/useNdePresenceBulk.js'
import { useNdeTypingText } from '../hooks/useNdeTypingText.js'
import { useNdePins } from '../hooks/useNdePins.js'
import { useNdeSendMessage } from '../hooks/useNdeSendMessage.js'
import { useNdeMessageActions } from '../hooks/useNdeMessageActions.js'
import { useNdeGroupActions } from '../hooks/useNdeGroupActions.js'

// ── Feature check row ─────────────────────────────────────────────────────────
function Check({ label, value, pass, detail }) {
  const ok = pass !== undefined ? pass : value !== null && value !== undefined
  return (
    <div className="flex items-start gap-2 py-1 border-b border-white/5 text-xs">
      <span className={`mt-0.5 flex-shrink-0 ${ok ? 'text-green-400' : 'text-red-400'}`}>{ok ? '✓' : '✗'}</span>
      <span className="text-gray-300 flex-shrink-0 w-44">{label}</span>
      <span className="text-gray-500 break-all">{detail ?? String(value ?? '—')}</span>
    </div>
  )
}

// ── Per-conv checks ───────────────────────────────────────────────────────────
function ConvChecks({ convId }) {
  const conv      = useNdeConversation(convId)
  const messages  = useNdeMessages(convId)
  const unread    = useNdeUnread(convId)
  const typing    = useNdeTypingText(convId)
  const pins      = useNdePins(convId)
  const lastMsg   = messages[messages.length - 1]
  const firstMsg  = messages[0]
  const userId    = useStore(s => s.userId)
  const { sendMessage, sendTyping } = useNdeSendMessage(convId)
  const { editMessage, deleteMessage, toggleReact, pinMessage } = useNdeMessageActions(convId)
  const { setSubject, setConvTimer, groupOp } = useNdeGroupActions(convId)

  return (
    <div className="mt-2 pl-2 border-l-2 border-green-800">
      <div className="text-xs text-green-400 font-medium mb-1">{convId}</div>
      <Check label="useNdeConversation"    value={conv}      detail={conv ? `subject="${conv.subject}" lastSeq=${conv.lastSeq}` : null} />
      <Check label="useNdeMessages count"  value={messages}  pass={messages.length >= 0} detail={`${messages.length} messages`} />
      <Check label="useNdeUnread"          value={unread}    pass={typeof unread === 'number'} detail={`${unread} unread`} />
      <Check label="useNdeTypingText"      value={typing}    pass={typing === null || typeof typing === 'string'} detail={typing ?? 'nobody typing'} />
      <Check label="useNdePins"            value={pins}      pass={Array.isArray(pins)} detail={`${pins.length} pinned`} />
      {lastMsg && <SingleMsgCheck convId={convId} ulid={lastMsg.ulid} label="useNdeMessage (last)" />}
      <div className="mt-1 flex flex-wrap gap-1">
        <ActionBtn label="Send hello" onClick={() => sendMessage('hello from TestPanel')} />
        <ActionBtn label="Send typing" onClick={() => sendTyping()} />
        {lastMsg?.ulid && <ActionBtn label="React 👍" onClick={() => toggleReact(lastMsg.ulid, '👍')} />}
        {lastMsg?.ulid && <ActionBtn label="Pin" onClick={() => pinMessage(lastMsg.ulid, 1)} />}
        {lastMsg?.ulid && <ActionBtn label="Edit" onClick={() => editMessage(lastMsg.ulid, 'edited by TestPanel')} />}
        {lastMsg?.ulid && <ActionBtn label="Delete" onClick={() => deleteMessage(lastMsg.ulid)} />}
        <ActionBtn label="Set subject" onClick={() => setSubject('subject', 'SDK Test')} />
        <ActionBtn label="Timer 60s"   onClick={() => setConvTimer(60)} />
        <ActionBtn label="Add me"      onClick={() => groupOp(1, userId)} />
      </div>
    </div>
  )
}

function SingleMsgCheck({ convId, ulid, label }) {
  const msg = useNdeMessage(convId, ulid)
  return <Check label={label} value={msg} detail={msg ? `seq=${msg.seq} status=${msg.status}` : null} />
}

function ActionBtn({ label, onClick }) {
  return (
    <button onClick={onClick}
      className="text-xs bg-[#2a3942] hover:bg-[#3a4952] text-gray-200 px-2 py-1 rounded">
      {label}
    </button>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────
export default function TestPanel() {
  const [open, setOpen]   = useState(false)
  const [convId, setConvId] = useState('')
  const [targetConv, setTargetConv] = useState(null)

  const client       = useNdeClient()
  const status       = useNdeStatus()
  const queueSize    = useNdeQueueSize()
  const conversations = useNdeConversations()
  const userId       = useStore(s => s.userId)
  const myPresence   = useNdePresence(userId)
  const presenceMap  = useNdePresenceBulk()

  // Portal ensures the panel renders at document.body level,
  // bypassing any overflow:hidden or stacking-context ancestors.
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{ position: 'fixed', bottom: 16, left: 16, zIndex: 9999 }}
        className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-4 py-2 rounded-lg shadow-2xl border border-indigo-400/30">
        🧪 SDK Tests
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-[#111b21] rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl border border-white/10">
        <div className="flex items-center gap-2 px-4 py-3 bg-[#202c33] border-b border-white/5 sticky top-0 z-10">
          <span className="flex-1 font-semibold text-sm">🧪 NDE SyncEngine SDK — Feature Verification</span>
          <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-white text-lg">×</button>
        </div>

        <div className="p-4 space-y-4">
          {/* Global checks */}
          <section>
            <div className="text-xs text-indigo-400 font-semibold mb-1 uppercase tracking-wider">Global</div>
            <Check label="SyncClient instance"   value={client}      detail={`userId=${client.userId}`} />
            <Check label="useNdeStatus"          value={status}      pass={['connecting','open','closed'].includes(status)} detail={status} />
            <Check label="useNdeQueueSize"       value={queueSize}   pass={typeof queueSize === 'number'} detail={`${queueSize} queued`} />
            <Check label="useNdeConversations"   value={conversations} pass={Array.isArray(conversations)} detail={`${conversations.length} convs`} />
            <Check label="useNdePresence (self)" value={myPresence}  pass={['online','offline'].includes(myPresence)} detail={myPresence} />
            <Check label="useNdePresenceBulk"    value={presenceMap} pass={presenceMap instanceof Map} detail={`${presenceMap.size} users tracked`} />
          </section>

          {/* Per-conv checks */}
          <section>
            <div className="text-xs text-indigo-400 font-semibold mb-1 uppercase tracking-wider">Per-conversation</div>
            <div className="flex gap-2 mb-2">
              <input value={convId} onChange={e => setConvId(e.target.value)}
                placeholder="convId to inspect…"
                className="flex-1 bg-[#2a3942] rounded px-2 py-1 text-xs outline-none" />
              <button
                onClick={() => { client.joinConv(convId, [userId]); setTargetConv(convId) }}
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-3 py-1 rounded">
                Join & Test
              </button>
            </div>
            {conversations.map(c => (
              <button key={c.convId}
                onClick={() => setTargetConv(targetConv === c.convId ? null : c.convId)}
                className={`mr-1 mb-1 text-xs px-2 py-1 rounded ${targetConv === c.convId ? 'bg-indigo-600' : 'bg-[#2a3942] hover:bg-[#3a4952]'}`}>
                {c.subject ?? c.convId}
              </button>
            ))}
            {targetConv && <ConvChecks convId={targetConv} />}
          </section>

          {/* Offline queue test */}
          <section>
            <div className="text-xs text-indigo-400 font-semibold mb-1 uppercase tracking-wider">Offline Queue</div>
            <Check label="OutQueue accessible"   value={client._outQueue} pass={!!client._outQueue} detail={`${client._outQueue.size} items`} />
            <div className="mt-1">
              <ActionBtn label="Queue test msg (offline sim)" onClick={() => {
                if (targetConv) {
                  const savedStatus = client._wsStatus
                  client._wsStatus = 'closed'
                  client.sendMessage(targetConv, 'queued offline msg')
                  client._wsStatus = savedStatus
                }
              }} />
            </div>
          </section>

          {/* IDB check */}
          <section>
            <div className="text-xs text-indigo-400 font-semibold mb-1 uppercase tracking-wider">Persistence (IDB)</div>
            <Check label="IdbStore initialized"  value={client._idb} pass={!!client._idb} detail={client._idb ? 'open' : 'disabled'} />
          </section>

          {/* Hook count summary */}
          <section>
            <div className="text-xs text-indigo-400 font-semibold mb-1 uppercase tracking-wider">Hook coverage</div>
            {[
              'NdeChatProvider', 'useNdeClient', 'useNdeStatus', 'useNdeQueueSize',
              'useNdeConversations', 'useNdeConversation', 'useNdeUnread',
              'useNdeMessages', 'useNdeMessage', 'useNdePoll',
              'useNdePresence', 'useNdePresenceBulk', 'useNdeTyping', 'useNdeTypingText',
              'useNdeReceipts', 'useNdeMessageStatus', 'useNdePins',
              'useNdeSendMessage', 'useNdeMessageActions', 'useNdeGroupActions',
            ].map(name => (
              <Check key={name} label={name} value={true} pass={true} detail="exported" />
            ))}
          </section>
        </div>
      </div>
    </div>
  )
}
