import type { MotionParams } from '@plein/nodes'
import { request } from '../../api/client'

export interface MotionInputs {
  image?: string
  video?: string
}

export interface MotionPreviewSession {
  id: string
  url: string
  origin: string
  nonce: string
  expiresAt: number
  width?: number
  height?: number
  duration?: number
}

export async function createMotionPreview(
  params: MotionParams,
  inputs: MotionInputs,
  signal: AbortSignal,
): Promise<MotionPreviewSession> {
  const session = await request<MotionPreviewSession>('/api/motion/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params, inputs }),
    signal,
  })
  const url = new URL(session.url)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.origin !== session.origin ||
    url.origin === location.origin ||
    url.hostname === location.hostname ||
    !session.id ||
    !session.nonce
  ) {
    void releaseMotionPreview(session.id)
    throw new Error('动态合成预览地址未隔离，无法打开')
  }
  return session
}

export const releaseMotionPreview = (id: string) =>
  request<void>(`/api/motion/preview/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(
    () => {},
  )
