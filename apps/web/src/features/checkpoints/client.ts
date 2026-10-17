import type {
  CanvasCheckpoint,
  CheckpointDetail,
  CheckpointPage,
  CheckpointRestored,
  CreateCheckpoint,
} from '@plein/protocol'
import { ApiError } from '../../api/client'
import { mediaQuery, mediaRequest } from '../media-library/client'

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
export const checkpointApi = {
  list: (projectId: string, cursor?: string, signal?: AbortSignal) =>
    mediaRequest<CheckpointPage>(
      `/api/projects/${projectId}/checkpoints?${mediaQuery({ cursor })}`,
      { signal },
    ),
  detail: (id: string, signal?: AbortSignal) =>
    mediaRequest<CheckpointDetail>(`/api/checkpoints/${id}`, { signal }),
  create: (canvasId: string, body: CreateCheckpoint, signal?: AbortSignal) =>
    mediaRequest<CanvasCheckpoint>(`/api/canvases/${canvasId}/checkpoints`, {
      ...json(body),
      signal,
    }),
  restore: (id: string) =>
    mediaRequest<CheckpointRestored>(`/api/checkpoints/${id}/restore`, json({})),
  remove: (id: string) => mediaRequest<void>(`/api/checkpoints/${id}`, { method: 'DELETE' }),
}

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const done = () => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(done, 400)
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** 只重试明确未保存的 sync_pending；网络结果未知时不盲目再创建一份。 */
export async function saveSynchronizedCheckpoint(options: {
  canvasId: string
  body: CreateCheckpoint
  signal: AbortSignal
  connected(): boolean
  current(): boolean
  onWaiting(): void
  submit?: typeof checkpointApi.create
}) {
  const { signal } = options
  for (;;) {
    if (signal.aborted) throw signal.reason
    if (!options.current()) throw new Error('画布已切换，请在目标画布重新保存检查点')
    if (!options.connected()) {
      options.onWaiting()
      await pause(signal)
      continue
    }
    try {
      return await (options.submit ?? checkpointApi.create)(options.canvasId, options.body, signal)
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'sync_pending') throw error
      options.onWaiting()
      await pause(signal)
    }
  }
}
