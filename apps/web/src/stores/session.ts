import type { SessionInfo } from '@plein/protocol'
import { create } from 'zustand'
import { api, setUnauthorizedHandler } from '../api/client'
import { queryClient } from '../api/query'

type Status = 'loading' | 'ready' | 'offline'

interface SessionStore {
  status: Status
  info: SessionInfo | null
  error: string | null
  signingOut: boolean
  logout(): Promise<void>
  refresh(): Promise<void>
}

let logoutPending: Promise<void> | null = null
let refreshVersion = 0

export const useSession = create<SessionStore>((set, get) => ({
  status: 'loading',
  info: null,
  error: null,
  signingOut: false,
  logout() {
    if (logoutPending) return logoutPending
    refreshVersion++
    set({ signingOut: true })
    logoutPending = (async () => {
      await api.logout()
      queryClient.clear()
      await get().refresh()
    })().finally(() => {
      logoutPending = null
      set({ signingOut: false })
    })
    return logoutPending
  },
  async refresh() {
    const version = ++refreshVersion
    try {
      const info = await api.session()
      if (version === refreshVersion) set({ info, status: 'ready', error: null })
    } catch (err) {
      if (version === refreshVersion) set({ status: 'offline', error: (err as Error).message })
    }
  },
}))

setUnauthorizedHandler(() => {
  void useSession.getState().refresh()
})
