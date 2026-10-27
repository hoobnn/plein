import { type CanvasElement, elementMedia, primaryResult } from '@plein/doc'
import type { Catalog } from '@plein/protocol'
import { findNode, isPure, promptKey } from '../canvas/nodes'
import { type StaleKind, STALE_TEXT, STALE_HINT } from '../features/runs/stale'

type Status = { label: string; tone: string; hint?: string }

const STATUS: Record<string, Status> = {
  queued: { label: '排队中', tone: '' },
  running: { label: '生成中', tone: 'ui-tag-accent' },
  failed: { label: '失败', tone: 'ui-tag-danger' },
  canceled: { label: '已取消', tone: '' },
}

/** 审片只读主输出的候选，避免副输出或说明文字混入。 */
export function candidatesOf(el: CanvasElement) {
  if (el.kind !== 'node') return []
  const port = el.ports?.outputs[0]?.id ?? primaryResult(el)?.port ?? el.results?.[0]?.port
  return (el.results ?? []).filter((result) => result.port === port)
}

export function statusOf(el: CanvasElement, stale?: StaleKind): Status | undefined {
  if (stale && !['queued', 'running', 'failed'].includes(el.run?.status ?? ''))
    return {
      label: STALE_TEXT[stale],
      hint: STALE_HINT[stale],
      tone: stale === 'kept' ? '' : 'ui-tag-warning',
    }
  if (el.run?.status === 'canceled' && primaryResult(el)?.runId === el.run.id)
    return { label: '已取回', tone: 'ui-tag-accent' }
  return el.run && STATUS[el.run.status]
}

/** 元素当前展示的内容：素材本身，或节点当前采用的结果 */
type Content =
  | { type: 'text'; text: string }
  | { type: 'image' | 'video' | 'audio'; assetId: string }
  | null

export function contentOf(el: CanvasElement, catalog: Catalog | null): Content {
  if (el.kind === 'markdown') return el.text?.trim() ? { type: 'text', text: el.text } : null
  const info = el.kind === 'node' ? findNode(catalog, el.nodeType) : undefined
  // 就地计算的文本参数即正文；历史运行结果可能已经过期。
  if (info && isPure(info) && info.outputs[0]?.type === 'text') {
    const text = el.params?.[promptKey(info) ?? 'text']
    return typeof text === 'string' && text.trim() ? { type: 'text', text } : null
  }
  const v = el.kind === 'node' ? primaryResult(el)?.value : undefined
  if (v?.type === 'text') return v.text.trim() ? { type: 'text', text: v.text } : null
  const m = elementMedia(el)
  return m && { type: m.kind, assetId: m.assetId }
}
