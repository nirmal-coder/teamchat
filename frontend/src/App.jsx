import { NdeChatProvider } from './hooks/NdeChatProvider.jsx'
import Sidebar from './components/Sidebar.jsx'
import ChatPane from './components/ChatPane.jsx'
import AuthScreen from './components/AuthScreen.jsx'
import { useStore } from './store/index.js'

export default function App() {
  const userId = useStore(s => s.userId)
  if (!userId) return <AuthScreen />
  return (
    <NdeChatProvider>
      <div className="flex w-full h-screen overflow-hidden">
        <Sidebar />
        <ChatPane />
      </div>
    </NdeChatProvider>
  )
}
