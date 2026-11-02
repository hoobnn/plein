import {
  boundReferenceTokens,
  referenceBindings,
  resolveReferenceBindings,
  type ReferenceIdentity,
  videoReferenceTokens,
} from '@plein/plugin-sdk'
import { findMentions, isMentionStart, mentionProblem, type MentionTarget } from '@plein/nodes'

/** 有效引用共用生成解析器；找不到目标的 @ 写法单独标为缺失，不绑定到猜测的元素。 */
export interface MentionReferences {
  bindings: unknown
  items: ReferenceIdentity[]
  pending?: boolean
}

export function mentionParts(
  text: string,
  targets: readonly MentionTarget[],
  references?: MentionReferences,
) {
  const parts: Array<{
    text: string
    start: number
    id?: string
    warning?: string
    missing?: true
    mention?: true
  }> = []
  let end = 0
  const bindings = referenceBindings(references?.bindings)
  const bound = references ? boundReferenceTokens(text, references.bindings) : []
  const matches = findMentions(text, targets).filter(
    (m) => !bound.some((t) => t.start <= m.start && t.end > m.start),
  )
  const reserved = new Set(videoReferenceTokens(text).map((t) => t.start))
  const unknown =
    /@[^\s@，。,.!！?？:：;；、（）()【】[\]「」"'“”]+(?:[ \t]+·[ \t]*[^\s@，。,.!！?？:：;；、（）()【】[\]「」"'“”]+)*/g
  const ranges = [
    ...bound.map((token) => {
      const error = references?.pending
        ? undefined
        : resolveReferenceBindings(`@${token.name}`, references!.items, references!.bindings).error
      return {
        start: token.start,
        end: token.end,
        id: bindings[token.name]?.source,
        ...(error ? { missing: true as const } : {}),
        warning: error ?? (references?.pending ? '正在确认参考素材…' : undefined),
      }
    }),
    ...matches.map((m) => ({
      start: m.start,
      end: m.end,
      id: m.id,
      warning:
        mentionProblem(m) ??
        m.profileConflict ??
        (m.sceneViewMiss !== undefined
          ? `视角「${m.sceneViewMiss}」不存在，请重新选择`
          : undefined) ??
        (m.profileMiss ? `档案中没有「${m.profileMiss}」` : undefined),
    })),
    ...[...text.matchAll(unknown)].flatMap((match) => {
      const start = match.index
      // 邮件地址和已解析引用中的 @ 不当作新引用。
      if (
        !isMentionStart(text, start) ||
        reserved.has(start) ||
        bound.some((t) => start >= t.start && start < t.end) ||
        matches.some((m) => start >= m.start && start < m.end)
      )
        return []
      return [
        {
          start,
          end: start + match[0].length,
          missing: true as const,
          warning: `未找到元素「${match[0]}」，请检查名称或重新选择`,
        },
      ]
    }),
  ].sort((a, b) => a.start - b.start)
  for (const m of ranges) {
    if (m.start < end) continue
    if (m.start > end) parts.push({ text: text.slice(end, m.start), start: end })
    parts.push({
      text: text.slice(m.start, m.end),
      start: m.start,
      mention: true,
      id: 'id' in m ? m.id : undefined,
      missing: 'missing' in m ? m.missing : undefined,
      warning: m.warning,
    })
    end = m.end
  }
  if (end < text.length) parts.push({ text: text.slice(end), start: end })
  return parts
}

export function renderMentionText(
  root: HTMLElement,
  text: string,
  targets: readonly MentionTarget[],
  locate?: (id: string) => void,
) {
  root.replaceChildren(
    ...mentionParts(text, targets).map((part) => {
      if (!part.mention) return document.createTextNode(part.text)
      const mark = document.createElement('mark')
      mark.className = 'plein-mention'
      mark.dataset.state = part.missing ? 'missing' : part.warning ? 'warning' : 'resolved'
      if (part.id) mark.dataset.mentionId = part.id
      mark.textContent = part.text
      if (part.warning) mark.title = part.warning
      if (part.id && locate) {
        mark.setAttribute('role', 'button')
        mark.tabIndex = 0
        mark.title = part.warning ?? `点击定位「${part.text}」`
        mark.addEventListener('pointerdown', (event) => event.stopPropagation())
        mark.addEventListener('click', (event) => {
          event.stopPropagation()
          locate(part.id!)
        })
        mark.addEventListener('keydown', (event) => {
          event.stopPropagation()
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            locate(part.id!)
          }
        })
      }
      return mark
    }),
  )
}
