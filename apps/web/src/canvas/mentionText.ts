import {
  boundReferenceTokens,
  referenceBindings,
  resolveReferenceBindings,
  type ReferenceIdentity,
  videoReferenceTokens,
} from '@plein/plugin-sdk'
import { findMentions, isMentionStart, mentionProblem, type MentionTarget } from '@plein/nodes'

/** 正文里一处引用的最终编号与问题：编号来自服务端，与最终提示词完全一致。 */
export interface MentionNumber {
  /** 原文里的起止位置 */
  start: number
  end: number
  /** 服务端看到的原文，用来确认区间仍对应当前草稿 */
  text?: string
  /** 最终提示词里的编号写法，如「图片3」；一张资产卡可能对应多张图 */
  labels: string[]
  /** 引用的名字 */
  name?: string
  /** 引用元素；Cmd / Ctrl + 点击可定位 */
  id?: string
  /** 送不进去的原因 */
  reason?: string
  message?: string
}

/** 编辑器里一处引用的编号徽标与名称。 */
export interface MentionBadge {
  labels: string[]
  title: string
  name?: string
}

/** 面板里要画成标记的一处引用区间。 */
interface MentionRange {
  start: number
  end: number
  id?: string
  missing?: true
  warning?: string
  badge?: MentionBadge
}

/** 有效引用共用生成解析器；找不到目标的 @ 写法单独标为缺失，不绑定到猜测的元素。 */
export interface MentionReferences {
  bindings: unknown
  items: ReferenceIdentity[]
  pending?: boolean
  /** 服务端给的编号与问题；有这一项时以它为准，不再本地猜。 */
  numbers?: MentionNumber[]
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
    /** 送入模型的编号徽标（与服务端给的最终提示词一致） */
    badge?: MentionBadge
  }> = []
  let end = 0
  // 服务端 promptReferences 是唯一权威区间：断链、残留绑定与编号都按它画。
  // 只有服务端没给、或区间对不上当前草稿（例如正在输入）时，才退回本地解析。
  const numbers = references?.numbers
  const serverRanges: MentionRange[] | undefined =
    numbers &&
    numbers.every((n) => text.slice(n.start, n.end) === (n.text ?? text.slice(n.start, n.end)))
      ? numbers.map((n) => ({
          start: n.start,
          end: n.end,
          id: n.id,
          missing:
            n.reason === 'mention_broken' ||
            n.reason === 'mention_ambiguous' ||
            n.reason === 'stale_binding'
              ? (true as const)
              : undefined,
          warning: n.message,
          badge:
            n.labels.length && !n.reason
              ? {
                  labels: n.labels,
                  title: [n.name, n.labels.join('、')].filter(Boolean).join(' · '),
                  ...(n.name ? { name: n.name } : {}),
                }
              : undefined,
        }))
      : undefined
  const ranges: MentionRange[] = serverRanges ?? localRanges(text, targets, references)
  for (const m of ranges) {
    if (m.start < end) continue
    if (m.start > end) parts.push({ text: text.slice(end, m.start), start: end })
    parts.push({
      text: text.slice(m.start, m.end),
      start: m.start,
      mention: true,
      id: m.id,
      missing: m.missing,
      warning: m.warning,
      ...(m.badge ? { badge: m.badge } : {}),
    })
    end = m.end
  }
  if (end < text.length) parts.push({ text: text.slice(end), start: end })
  return parts
}

/** 服务端没有 `promptReferences` 时的本地兜底：只做名称绑定与同名元素解析。 */
function localRanges(
  text: string,
  targets: readonly MentionTarget[],
  references?: MentionReferences,
): MentionRange[] {
  const bindings = referenceBindings(references?.bindings)
  const bound = references ? boundReferenceTokens(text, references.bindings) : []
  const matches = findMentions(text, targets).filter(
    (m) => !bound.some((t) => t.start <= m.start && t.end > m.start),
  )
  const reserved = new Set(videoReferenceTokens(text).map((t) => t.start))
  const unknown =
    /@[^\s@，。,.!！?？:：;；、（）()【】[\]「」"'“”]+(?:[ \t]+·[ \t]*[^\s@，。,.!！?？:：;；、（）()【】[\]「」"'“”]+)*/g
  return [
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
