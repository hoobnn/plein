import { currentResult, inputEdges, type CanvasElement, type PleinDoc } from '@plein/doc'
import {
  findBrokenMentions,
  findMentions,
  isMentionStart,
  mentionProblem,
  pickLabel,
} from '@plein/nodes'
import {
  boundReferenceTokens,
  parseModelRef,
  referenceBindings,
  referenceLabel,
  referenceLabelStyle,
  referenceNumbering,
  sameReference,
  type NodeDefinition,
  type PortValue,
  type ReferenceIdentity,
} from '@plein/plugin-sdk'
import type {
  InputPromptReference,
  InputRef,
  InputSentReference,
  InputUnsentReason,
  InputUnsentReference,
  PreparedInput,
} from '@plein/protocol'

import { mentionTargets } from './mentions'

export type ReferencePreview = Pick<PreparedInput, 'sent' | 'unsent' | 'promptReferences'>

// @ 后误留空格、只剩扩展名（例如 `@ .png`）时也要认出断链引用，否则它会悄悄留在最终提示词里。
const UNKNOWN =
  /@[ \t]*(?:\.[a-z0-9]+|[^\s@，。,.!！?？:：;；、（）()【】[\]「」"'“”]+(?:[ \t]+·[ \t]*[^\s@，。,.!！?？:：;；、（）()【】[\]「」"'“”]+)*)/gi

/** 从最终实际输入反推面板所需的一份权威数据；预览与生成共用这里的顺序。 */
export function referencePreview({
  doc,
  el,
  def,
  params,
  inputs,
  collected = {},
  details = [],
  referenceLimit,
}: {
  doc: PleinDoc
  el: CanvasElement
  def?: NodeDefinition
  params: Record<string, unknown>
  inputs: Record<string, PortValue[]>
  collected?: Record<string, PortValue[]>
  details?: InputRef[]
  referenceLimit?: number
}): ReferencePreview {
  if (def?.capability !== 'image.generate' && def?.capability !== 'video.generate') return {}
  const ports = def.inputs.filter((port) => port.type === 'image').map((port) => port.id)
  const finalImages = ports.flatMap((port) =>
    (inputs[port] ?? []).filter((value) => value.type === 'image'),
  )
  const original = String(el.params?.prompt ?? '')
  const bindings = referenceBindings(el.params)
  const bound = boundReferenceTokens(original, el.params)
  const targets = mentionTargets(doc)
  const mentions = findMentions(original, targets).filter(
    (mention) =>
      mention.id !== el.id &&
      !bound.some((token) => token.start <= mention.start && token.end > mention.start),
  )
  const sent: InputSentReference[] = []
  // 编号只有一份：这里的 token 就是最终提示词正文里写的那个编号。
  const style = referenceLabelStyle(
    def?.capability,
    parseModelRef(String(params.model ?? ''))?.provider,
  )
  const numbering = referenceNumbering(style, finalImages)
  for (const [index, value] of finalImages.entries()) {
    if (!('assetId' in value)) continue
    const assetId = value.assetId
    const source = 'source' in value ? value.source : undefined
    const refs = details.filter((detail) => detail.sent.includes(assetId))
    const origins = new Set<InputSentReference['origins'][number]>()
    if (
      ports.some((port) =>
        (collected[port] ?? []).some(
          (item) => item.type === 'image' && 'assetId' in item && item.assetId === assetId,
        ),
      )
    )
      origins.add('edge')
    if (refs.length) origins.add('mention')
    if (refs.some((ref) => ref.kind === 'character')) origins.add('role')
    const continuation = params.continuesFrom
    if (continuation && typeof continuation === 'object' && index === 0) origins.add('continuation')
    for (const token of bound) {
      const binding = bindings[token.name]
      if (binding && bindingMatches(binding, value, token.name, el.params)) origins.add('binding')
    }
    const primary = !origins.has('edge') && refs.length ? refs[0] : undefined
    const elementId = primary?.elementId ?? source
    sent.push({
      index: index + 1,
      token: numbering.label(assetId) ?? referenceLabel(style, index + 1),
      assetId,
      ...(elementId ? { elementId } : {}),
      name: primary?.name ?? (elementId && doc.get(elementId)?.name) ?? '参考素材',
      origins: [...origins],
    })
  }

  const promptReferences: InputPromptReference[] = []
  const unsent: InputUnsentReference[] = []
  const unsentKeys = new Set<string>()
  const addUnsent = (item: InputUnsentReference) => {
    const key = [item.reason, item.elementId ?? '', item.assetId ?? '', item.name].join('|')
    if (unsentKeys.has(key)) return
    unsentKeys.add(key)
    unsent.push(item)
  }
  const indexOf = (assetId: string) => sent.find((item) => item.assetId === assetId)?.index
  const indicesOf = (assetIds: string[]) =>
    [
      ...new Set(
        assetIds.flatMap((assetId) => {
          const index = indexOf(assetId)
          return index === undefined ? [] : [index]
        }),
      ),
    ].sort((a, b) => a - b)

  for (const token of bound) {
    const binding = bindings[token.name]
    const source = binding?.source
    const saved = el.params?.referenceBindings
    const cleared =
      saved && typeof saved === 'object' && !Array.isArray(saved) && Object.keys(saved).length === 0
    const legacyIndex = !binding && !cleared ? /^image([1-9]\d*)$/.exec(token.name)?.[1] : undefined
    const match = binding
      ? finalImages.find((value) => bindingMatches(binding, value, token.name, el.params))
      : legacyIndex
        ? finalImages[Number(legacyIndex) - 1]
        : undefined
    const assetId = match && 'assetId' in match ? match.assetId : undefined
    const deleted = source ? !doc.has(source) : false
    const reason: InputUnsentReason | undefined = assetId
      ? undefined
      : !binding
        ? legacyIndex
          ? 'mention_broken'
          : 'stale_binding'
        : deleted
          ? 'stale_binding'
          : 'not_sent'
    const message = reason
      ? !binding
        ? legacyIndex
          ? `引用 @${token.name} 尚未确认素材身份，请从参考素材重新选择`
          : `残留引用 @${token.name} 没有可确认的素材身份，已忽略`
        : deleted
          ? `绑定 @${token.name} 指向已删除的元素，已忽略`
          : `绑定 @${token.name} 的素材未送入，请重新选择`
      : undefined
    promptReferences.push({
      start: token.start,
      end: token.end,
      text: original.slice(token.start, token.end),
      name: token.name,
      ...(source ? { elementId: source } : {}),
      indices: assetId ? indicesOf([assetId]) : [],
      ...(reason ? { reason, message } : {}),
    })
    if (reason && message)
      addUnsent({
        ...(binding?.assetId ? { assetId: binding.assetId } : {}),
        ...(source ? { elementId: source } : {}),
        name: token.name,
        reason,
        message,
        origins: ['binding'],
      })
  }

  for (const mention of mentions) {
    const problem = mentionProblem(mention)
    const name = mentionName(mention)
    const detail = mention.id
      ? details.find((item) => item.elementId === mention.id && item.name === name)
      : undefined
    // 非多模态模式不会追加 @ 参考图，但首帧 / 尾帧本身已经通过连线送入。
    const framed = detail?.reason === 'unsupported' ? detail.available : []
    const indices = detail ? indicesOf([...detail.sent, ...framed]) : []
    const reason: InputUnsentReason | undefined = problem
      ? 'mention_ambiguous'
      : indices.length
        ? undefined
        : (detail?.reason ?? (detail ? 'no_image' : undefined))
    const message = problem ?? (reason ? reasonMessage(reason, name, referenceLimit) : undefined)
    promptReferences.push({
      start: mention.start,
      end: mention.end,
      text: original.slice(mention.start, mention.end),
      name: mention.name,
      ...(mention.id ? { elementId: mention.id } : {}),
      indices,
      ...(reason ? { reason, message } : {}),
    })
    if (reason && reason !== 'over_limit' && message)
      addUnsent({
        ...(mention.id ? { elementId: mention.id } : {}),
        name: mention.name,
        reason,
        message,
        origins: ['mention'],
      })
  }

  const ranges = [
    ...bound.map((token) => ({ start: token.start, end: token.end })),
    ...mentions.map((mention) => ({ start: mention.start, end: mention.end })),
  ]
  const broken = findBrokenMentions(original, targets)
  for (const match of original.matchAll(UNKNOWN)) {
    const start = match.index
    const end = start + match[0].length
    if (
      !isMentionStart(original, start) ||
      ranges.some((range) => start >= range.start && start < range.end)
    )
      continue
    const near = broken.find((item) => item.start === start)
    const name = near?.name ?? match[0].slice(1).trim()
    // @ 后留白时只把文件名样式当作断链；普通句子里的 @ 仍是普通文字。
    if (/^@[ \t]+/.test(match[0]) && !/\.[a-z0-9]+$/i.test(name)) continue
    const message = near
      ? `提示词里的 @${name} 找不到同名资产，可能已被改名为「${near.candidates.join('」「')}」，请改过来`
      : `提示词里的 @${name} 找不到同名资产，可能已删除或改名，请重新选择`
    promptReferences.push({
      start,
      end,
      text: match[0],
      name,
      indices: [],
      reason: 'mention_broken',
      message,
    })
    addUnsent({ name, reason: 'mention_broken', message, origins: ['mention'] })
  }
  promptReferences.sort((a, b) => a.start - b.start)

  for (const detail of details) {
    if (detail.reason !== 'over_limit') continue
    for (const assetId of detail.available) {
      if (indexOf(assetId) !== undefined) continue
      addUnsent({
        assetId,
        elementId: detail.elementId,
        name: detail.name,
        reason: 'over_limit',
        message: reasonMessage('over_limit', detail.name, referenceLimit),
        origins: detail.kind === 'character' ? ['mention', 'role'] : ['mention'],
      })
    }
  }

  // 连线没有值、或值没有进入最终输入时也要进入同一个「未送入」列表。
  for (const port of ports) {
    for (const edge of inputEdges(doc, el.id, port)) {
      const source = doc.get(edge.from[0])
      if (!source) continue
      const result = source.kind === 'node' ? currentResult(source, edge.from[1]) : undefined
      const assetId =
        source.kind === 'image'
          ? source.assetId
          : result?.value.type === 'image'
            ? result.value.assetId
            : undefined
      const name = source.name ?? '连线素材'
      if (!assetId) {
        addUnsent({
          elementId: source.id,
          name,
          reason: 'no_image',
          message: `「${name}」已连线，但还没有可用图片`,
          origins: ['edge'],
        })
      } else if (indexOf(assetId) === undefined) {
        const reason =
          referenceLimit !== undefined && sent.length >= referenceLimit ? 'over_limit' : 'not_sent'
        addUnsent({
          assetId,
          elementId: source.id,
          name,
          reason,
          message:
            reason === 'over_limit'
              ? reasonMessage(reason, name, referenceLimit)
              : `「${name}」已连线，但未送入当前模型`,
          origins: ['edge'],
        })
      }
    }
  }

  // 不再被正文或连线使用的绑定是残留数据；只报告，不参与编号或阻断。
  const usedNames = new Set(bound.map((token) => token.name))
  const mentionedIds = new Set(mentions.flatMap((mention) => (mention.id ? [mention.id] : [])))
  for (const raw of rawBindingEntries(el.params)) {
    const { name } = raw
    if (usedNames.has(name)) continue
    const binding = bindings[name]
    const source = binding?.source ?? raw.source
    const connected =
      !!source &&
      ports.some((port) => inputEdges(doc, el.id, port).some((edge) => edge.from[0] === source))
    // null 是历史绑定留下的空值；仍被普通 @ 或连线使用的元素不是残留。
    if (
      source &&
      doc.has(source) &&
      (connected || mentionedIds.has(source)) &&
      (!binding || binding.assetId)
    )
      continue
    const assetId = binding?.assetId ?? raw.assetId
    addUnsent({
      ...(assetId ? { assetId } : {}),
      ...(source ? { elementId: source } : {}),
      name,
      reason: 'stale_binding',
      message: `残留绑定 @${name} 已忽略（元素已删除，或既未连线也未被 @）`,
      origins: ['binding'],
    })
  }
  return { sent, unsent, promptReferences }
}

/** 连历史 null 也列出，供「未送入」说明；实际编号仍只使用 referenceBindings 的有效身份。 */
function rawBindingEntries(params: unknown) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return []
  const out: Array<{ name: string; source?: string; assetId?: string }> = []
  for (const [key, value] of Object.entries(params)) {
    const named = key.startsWith('referenceNameBinding:')
    const legacy = key.startsWith('referenceBinding:')
    if (!named && !legacy) continue
    const body = key.slice(named ? 'referenceNameBinding:'.length : 'referenceBinding:'.length)
    let name = named ? body.slice(0, body.lastIndexOf(':')) : body.split(':')[0]!
    if (named)
      try {
        name = decodeURIComponent(name)
      } catch {
        // 损坏的编码按原文展示，不影响其他绑定。
      }
    const source = named ? body.slice(body.lastIndexOf(':') + 1) : body.split(':')[1]
    const assetId =
      value && typeof value === 'object' && 'assetId' in value && typeof value.assetId === 'string'
        ? value.assetId
        : undefined
    out.push({ name, ...(source ? { source } : {}), ...(assetId ? { assetId } : {}) })
  }
  return out
}

function bindingMatches(
  binding: ReferenceIdentity,
  value: PortValue,
  name: string,
  params: unknown,
) {
  if (value.type !== binding.type || !('assetId' in value)) return false
  const named =
    params &&
    typeof params === 'object' &&
    Object.keys(params).some((key) =>
      key.startsWith(`referenceNameBinding:${encodeURIComponent(name)}:`),
    )
  const legacy = !named && /^(image|video|audio)[1-9]\d*$/.test(name)
  return legacy || !binding.source
    ? sameReference(binding, {
        type: value.type,
        assetId: value.assetId,
        ...('source' in value ? { source: value.source } : {}),
      })
    : binding.source === ('source' in value ? value.source : undefined)
}

function mentionName(mention: ReturnType<typeof findMentions>[number]) {
  const base =
    mention.total > 1
      ? `${mention.name}#${mention.id ? mention.ids.indexOf(mention.id) + 1 : (mention.index ?? 1)}`
      : mention.name
  const label = pickLabel(base, mention.pick ?? {})
  return mention.sceneView ? `${label}（${mention.sceneView.name}）` : label
}

function reasonMessage(reason: InputUnsentReason, name: string, limit?: number) {
  if (reason === 'over_limit')
    return `「${name}」的图片超过模型参考上限${limit === undefined ? '' : ` ${limit} 张`}，未送入`
  if (reason === 'failed') return `「${name}」的参考图生成失败，未送入`
  if (reason === 'unsupported') return `「${name}」的参考图在当前模式下不送入`
  if (reason === 'selection_missing') return `「${name}」选定的参考图已不可用，未送入`
  return `「${name}」没有可用图片，未送入`
}
