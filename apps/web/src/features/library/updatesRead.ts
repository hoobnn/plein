import type { LibraryCardUpdate, LibrarySyncField, LibraryUpdates } from '@plein/protocol'
import type { Dispatch, SetStateAction } from 'react'
import { api } from '../../api/client'

export interface UpdatesRead {
  data: LibraryUpdates | null
  source: string | null
  loading: boolean
  error: string
}
export const emptyUpdatesRead: UpdatesRead = { data: null, source: null, loading: false, error: '' }
export const pendingUpdatesRead = (state: UpdatesRead): UpdatesRead => ({
  ...state,
  loading: true,
  error: '',
})
export const updatesReadReady = (state: UpdatesRead, source: string) =>
  !!state.data && state.source === source && !state.loading && !state.error
export const libraryCardKey = (card: Pick<LibraryCardUpdate, 'canvasId' | 'nodeId'>) =>
  `${card.canvasId}:${card.nodeId}`
export const defaultUpdatesSelection = (data: LibraryUpdates): Record<string, LibrarySyncField[]> =>
  Object.fromEntries(
    data.cards.map(
      (card) =>
        [
          libraryCardKey(card),
          card.pinned ? [] : card.changes.map((change) => change.field),
        ] as const,
    ),
  )

/** 读失败保留旧差异用于说明，但旧来源、读取中和错误状态都不允许写入。 */
export function readLibraryUpdates(
  id: string,
  source: string,
  set: Dispatch<SetStateAction<UpdatesRead>>,
  receive: (data: LibraryUpdates) => void,
) {
  let active = true
  set(pendingUpdatesRead)
  void api.libraryUpdates(id).then(
    (data) => {
      if (!active) return
      set({ data, source, loading: false, error: '' })
      receive(data)
    },
    (error: unknown) => {
      if (active) set((state) => ({ ...state, loading: false, error: (error as Error).message }))
    },
  )
  return () => {
    active = false
  }
}
