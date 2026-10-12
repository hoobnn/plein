import type { SessionInfo } from '@plein/protocol'
import { create } from 'zustand'
import { api, setUnauthorizedHandler } from '../api/client'

type Status = 'loading' | 'ready' | 'offline'

interface SessionStore {
  status: Status
  info: SessionInfo | null
  error: string | null
  refresh(): Promise<void>
}

export const useSession = create<SessionStore>((set) => ({
  status: 'loading',
  info: null,
  error: null,
  async refresh() {
    try {
      set({ info: await api.session(), status: 'ready', error: null })
    } catch (err) {
      set({ status: 'offline', error: (err as Error).message })
    }
  },
}))

setUnauthorizedHandler(() => {
  void useSession.getState().refresh()
})
