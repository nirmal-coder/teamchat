import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const getDeviceId = () => {
  let id = localStorage.getItem('deviceId')
  if (!id) { id = 'dev-' + Math.random().toString(36).slice(2, 8); localStorage.setItem('deviceId', id) }
  return id
}

export const useStore = create(persist((set) => ({
  // ── Auth (persisted) ──
  userId:   null,
  username: null,
  token:    null,
  deviceId: getDeviceId(),
  wsUrl:    'ws://localhost:8090',
  httpUrl:  'http://localhost:3000',

  setAuth: ({ userId, username, token }) => set({ userId, username, token }),
  clearAuth: () => set({ userId: null, username: null, token: null, activeConvId: null }),

  // ── UI state ──
  activeConvId: null,
  setActiveConv: (convId) => set({ activeConvId: convId }),

  // ── Toasts ──
  toasts: [],
  addToast: (msg, kind = 'info') => {
    const id = Date.now()
    set((s) => ({ toasts: [...s.toasts, { id, msg, kind }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter(t => t.id !== id) })), 4000)
  },
}), {
  name: 'nde-sync-store',
  partialize: (s) => ({
    userId: s.userId, username: s.username, token: s.token,
    deviceId: s.deviceId, wsUrl: s.wsUrl, httpUrl: s.httpUrl,
  }),
}))
