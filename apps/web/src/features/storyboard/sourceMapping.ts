import type { PleinDoc } from '@plein/doc'
import { sourceLinkState, type SourceMapRecord, type SourceUnit } from '@plein/doc'

export function sourceUnitStatus(
  doc: PleinDoc,
  boardId: string,
  record: SourceMapRecord,
  unit: SourceUnit,
) {
  if (!record.readSnapshotIds.includes(unit.snapshotId)) return '未读'
  if (unit.disposition === 'out_of_scope') return '范围外'
  const links = record.links.filter((l) => l.unitId === unit.id)
  if (!links.length) return '未映射'
  if (links.some((l) => sourceLinkState(doc, boardId, l) !== 'current')) return '待复核'
  return '已映射'
}

/** 列表仅显示有界摘录，完整原文始终留在固定快照中。 */
export function sourceExcerpt(text: string, start: number, end: number, limit = 160) {
  const excerpt = text.slice(start, Math.min(end, start + limit))
  return end - start > limit ? `${excerpt}…` : excerpt
}

/** textarea 将 CRLF/CR 显示为 LF，选择偏移必须还原到未经改写的原文。 */
export function sourceRawOffset(text: string, displayOffset: number): number {
  let view = 0
  for (let raw = 0; raw < text.length; raw++, view++) {
    if (view >= displayOffset) return raw
    if (text[raw] === '\r' && text[raw + 1] === '\n') raw++
  }
  return text.length
}
export function sourceDisplayOffset(text: string, rawOffset: number): number {
  return text.slice(0, rawOffset).replace(/\r\n?/g, '\n').length
}

/** macOS Chromium 的 readonly textarea 不执行方向键选区，保留只读并提供键盘选择。 */
export function sourceSelectionAfterKey(input: {
  text: string
  start: number
  end: number
  direction: string
  key: string
  shift: boolean
}): { start: number; end: number; direction: 'forward' | 'backward' | 'none' } | undefined {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(input.key)) return undefined
  const backward = input.direction === 'backward'
  const head = backward ? input.start : input.end
  const anchor = backward ? input.end : input.start
  const boundaries = [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(input.text),
  ].map((part) => part.index)
  boundaries.push(input.text.length)
  let next = head
  if (input.key === 'Home') next = head === 0 ? 0 : input.text.lastIndexOf('\n', head - 1) + 1
  else if (input.key === 'End') {
    const end = input.text.indexOf('\n', head)
    next = end < 0 ? input.text.length : end
  } else if (!input.shift && input.start !== input.end)
    next = input.key === 'ArrowLeft' ? input.start : input.end
  else if (input.key === 'ArrowLeft')
    next = boundaries.filter((offset) => offset < head).at(-1) ?? 0
  else next = boundaries.find((offset) => offset > head) ?? input.text.length
  if (!input.shift) return { start: next, end: next, direction: 'none' }
  return {
    start: Math.min(anchor, next),
    end: Math.max(anchor, next),
    direction: next < anchor ? 'backward' : 'forward',
  }
}
