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
  type ReferenceMediaKind,
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
  referenceMediaLimits,
}: {
  doc: PleinDoc
  el: CanvasElement
  def?: NodeDefinition
  params: Record<string, unknown>
  inputs: Record<string, PortValue[]>
  collected?: Record<string, PortValue[]>
  details?: InputRef[]
  referenceLimit?: number
  referenceMediaLimits?: { video: number; audio: number }
}): ReferencePreview {
  if (
    def?.capability !== 'image.generate' &&
    def?.capability !== 'video.generate' &&
    def?.capability !== 'text.chat' &&
    def?.capability !== 'image.edit' &&
    def?.capability !== 'image.process' &&
    def?.capability !== 'audio.speech'
  )
    return {}
  const capability = def.capability
  const isVideo = capability === 'video.generate'
  const videoMode = isVideo ? String(params.mode ?? 'text') : undefined
  // 文生视频不送任何图；首尾帧模式的连线图按位置作帧，不是参考图。
  const textOnly = videoMode === 'text'
  // 这几类能力不收 @ 参考图，但预览同样要给出 sent / unsent：
  // @ 了却没送、连了图确实送了，都要看得见，不能静默。
  const plainMedia = !isVideo && capability !== 'image.generate'
  const ports = def.inputs.filter((port) => port.type === 'image').map((port) => port.id)
  const finalImages = ports.flatMap((port) =>
    (inputs[port] ?? []).filter((value) => value.type === 'image'),
  )
  const finalMedia = {
    image: finalImages,
    video: def.inputs
      .filter((port) => port.type === 'video')
      .flatMap((port) => (inputs[port.id] ?? []).filter((value) => value.type === 'video')),
    audio: def.inputs
      .filter((port) => port.type === 'audio')
      .flatMap((port) => (inputs[port.id] ?? []).filter((value) => value.type === 'audio')),
  }
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
  if (plainMedia) {
    // 这类节点不写参考编号：媒体按连线顺序如实列出（与执行器实际送入的一致），
    // token 只是面板徽标用的顺序标记，不是提示词里的编号写法。
    for (const [index, value] of finalImages.entries()) {
      if (!('assetId' in value)) continue
      const elementId = 'source' in value ? value.source : undefined
      sent.push({
        index: index + 1,
        token: `图${index + 1}`,
        assetId: value.assetId,
        ...(elementId ? { elementId } : {}),
        name: (elementId && doc.get(elementId)?.name) ?? '参考素材',
        // @ 引用不会并入这类节点的输入，这里的媒体都来自连线。
        origins: ['edge'],
      })
    }
  } else {
    // 编号只有一份：这里的 token 就是最终提示词正文里写的那个编号。
    const style = referenceLabelStyle(
      capability,
      parseModelRef(String(params.model ?? ''))?.provider,
    )
    const numbering = referenceNumbering(style, finalImages)
    // 文生视频不送图：连线图不进 sent（预览与实际提交一致），稍后放进 unsent 说明原因。
    for (const [index, value] of (textOnly ? [] : finalImages).entries()) {
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
      if (continuation && typeof continuation === 'object' && index === 0)
        origins.add('continuation')
      for (const token of bound) {
        const binding = bindings[token.name]
        if (binding && bindingMatches(binding, value, token.name, el.params)) origins.add('binding')
      }
      const primary = !origins.has('edge') && refs.length ? refs[0] : undefined
      const elementId = primary?.elementId ?? source
      // 首尾帧按位置标注用途；token 保留平台编号写法，前端有 role 时优先显示用途。
      const role = frameRole(videoMode, index)
      sent.push({
        index: index + 1,
        token: numbering.label(assetId) ?? referenceLabel(style, index + 1),
        ...(role ? { role } : {}),
        assetId,
        ...(elementId ? { elementId } : {}),
        name: primary?.name ?? (elementId && doc.get(elementId)?.name) ?? '参考素材',
        origins: [...origins],
      })
    }
  }

  const promptReferences: InputPromptReference[] = []
  const unsent: InputUnsentReference[] = []
  const unsentKeys = new Set<string>()
  const addUnsent = (item: InputUnsentReference, identity = '') => {
    // 去重键不含 name（有 elementId 时）：不同路径对同一引用的取名格式可能不同
    // （如带不带 #序号），键里带 name 会让同一引用去重失效；同一张卡的不同视角 /
    // 档案项用视角 / 档案项身份区分，逐条列出。没有 elementId 的条目（断链 @、
    // 消歧失败、无来源的残留绑定）只剩显示名能标识引用：键里带上它，
    // 不同引用不合并，同一引用写多次仍只报一次。
    const key = [
      item.reason,
      item.elementId ?? '',
      item.assetId ?? '',
      item.elementId ? identity : item.name,
    ].join('|')
    if (unsentKeys.has(key)) return
    unsentKeys.add(key)
    unsent.push(item)
  }
  // unsupported 的文案按节点区分：非生成节点是「不送 @ 引用」，文生视频是「不用参考图」。
  const unsentScope: UnsupportedScope = plainMedia ? 'node' : textOnly ? 'text' : 'mode'
  const indexOf = (assetId: string, kind: ReferenceMediaKind = 'image') => {
    if (kind !== 'image') {
      const index = finalMedia[kind].findIndex(
        (value) => 'assetId' in value && value.assetId === assetId,
      )
      return index < 0 ? undefined : index + 1
    }
    return sent.find((item) => item.assetId === assetId)?.index
  }
  const indicesOf = (assetIds: string[], kind: ReferenceMediaKind = 'image') =>
    [
      ...new Set(
        assetIds.flatMap((assetId) => {
          const index = indexOf(assetId, kind)
          return index === undefined ? [] : [index]
        }),
      ),
    ].sort((a, b) => a - b)

  for (const token of bound) {
    const binding = bindings[token.name]
    const kind = token.kind
    const supported = kind === 'image' || !referenceMediaLimits || referenceMediaLimits[kind] > 0
    const source = binding?.source
    const saved = el.params?.referenceBindings
    const cleared =
      saved && typeof saved === 'object' && !Array.isArray(saved) && Object.keys(saved).length === 0
    const legacyIndex =
      !binding && !cleared ? /^(?:image|video|audio)([1-9]\d*)$/.exec(token.name)?.[1] : undefined
    const match = binding
      ? finalMedia[binding.type].find((value) =>
          bindingMatches(binding, value, token.name, el.params),
        )
      : legacyIndex
        ? finalMedia[kind][Number(legacyIndex) - 1]
        : undefined
    const assetId = supported && match && 'assetId' in match ? match.assetId : undefined
    const deleted = source ? !doc.has(source) : false
    const reason: InputUnsentReason | undefined = !supported
      ? 'unsupported'
      : assetId
        ? undefined
        : !binding
          ? legacyIndex
            ? 'mention_broken'
            : 'stale_binding'
          : deleted
            ? 'stale_binding'
            : 'not_sent'
    const message =
      reason === 'unsupported'
        ? reasonMessage(reason, token.name, undefined, kind, unsentScope)
        : reason
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
      indices: assetId ? indicesOf([assetId], kind) : [],
      ...(kind === 'image' ? {} : { kind }),
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
    const kind = detail?.media ?? 'image'
    // 非多模态模式不会追加 @ 参考图，但首帧 / 尾帧本身已经通过连线送入。
    const framed = kind === 'image' && detail?.reason === 'unsupported' ? detail.available : []
    const indices = detail ? indicesOf([...detail.sent, ...framed], kind) : []
    const reason: InputUnsentReason | undefined = problem
      ? 'mention_ambiguous'
      : indices.length
        ? undefined
        : (detail?.reason ?? (detail ? 'no_image' : undefined))
    const message =
      problem ??
      (reason ? reasonMessage(reason, name, referenceLimit, kind, unsentScope) : undefined)
    promptReferences.push({
      start: mention.start,
      end: mention.end,
      text: original.slice(mention.start, mention.end),
      name: mention.name,
      ...(mention.id ? { elementId: mention.id } : {}),
      indices,
      ...(kind === 'image' ? {} : { kind }),
      ...(reason ? { reason, message } : {}),
    })
    if (reason && reason !== 'over_limit' && message)
      addUnsent(
        {
          ...(mention.id ? { elementId: mention.id } : {}),
          // 与文案里的名字一致：用带 #序号 / 视角后缀的显示名，不用裸 mention.name。
          name,
          reason,
          message,
          origins: ['mention'],
        },
        pickIdentity(mention),
      )
  }

  // 上游文本里的有效引用没有原文区间，但缺图 / 不支持等状态仍要进入未送入列表。
  for (const detail of details) {
    const reason = detail.reason
    if (!reason || reason === 'over_limit') continue
    const kind = detail.media ?? 'image'
    const framed = kind === 'image' && reason === 'unsupported' ? detail.available : []
    if (indicesOf([...detail.sent, ...framed], kind).length) continue
    addUnsent(
      {
        elementId: detail.elementId,
        name: detail.name,
        reason,
        message: reasonMessage(reason, detail.name, referenceLimit, kind, unsentScope),
        origins: detail.kind === 'character' ? ['mention', 'role'] : ['mention'],
      },
      // 解析阶段已把档案项 / 视角身份写在明细上（上游文本里的引用没有原文区间，只能靠它），
      // 与 mention 路径的 pickIdentity 同一格式，同一处引用只报一次。
      detail.pickIdentity ?? '',
    )
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
      addUnsent(
        {
          assetId,
          elementId: detail.elementId,
          name: detail.name,
          reason: 'over_limit',
          message: reasonMessage('over_limit', detail.name, referenceLimit),
          origins: detail.kind === 'character' ? ['mention', 'role'] : ['mention'],
        },
        detail.pickIdentity ?? '',
      )
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
        const overLimit = referenceLimit !== undefined && sent.length >= referenceLimit
        const reason: InputUnsentReason = textOnly
          ? 'unsupported'
          : overLimit
            ? 'over_limit'
            : 'not_sent'
        addUnsent({
          assetId,
          elementId: source.id,
          name,
          reason,
          message: textOnly
            ? reasonMessage('unsupported', name, referenceLimit, 'image', 'text')
            : reason === 'over_limit'
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

/** 档案项 / 视角的稳定身份（不含显示名）：同一张卡的不同视角或档案项是不同引用，去重时不能合并。 */
function pickIdentity(mention: ReturnType<typeof findMentions>[number]): string {
  const pick = mention.pick
  return [
    pick?.period?.id,
    pick?.outfit?.id,
    pick?.expression?.id,
    pick?.voiceState?.id,
    mention.sceneView?.id,
  ]
    .map((value) => value ?? '')
    .join('/')
}

function mentionName(mention: ReturnType<typeof findMentions>[number]) {
  const base =
    mention.total > 1
      ? `${mention.name}#${mention.id ? mention.ids.indexOf(mention.id) + 1 : (mention.index ?? 1)}`
      : mention.name
  const label = pickLabel(base, mention.pick ?? {})
  return mention.sceneView ? `${label}（${mention.sceneView.name}）` : label
}

/** 非参考模式的视频按位置用图：第 1 张（首尾帧模式再加第 2 张）有明确用途，不是参考图。 */
function frameRole(
  mode: string | undefined,
  position: number,
): 'firstFrame' | 'lastFrame' | undefined {
  if (mode === 'image') return position === 0 ? 'firstFrame' : undefined
  if (mode === 'lastFrame') return position === 0 ? 'lastFrame' : undefined
  if (mode === 'frames')
    return position === 0 ? 'firstFrame' : position === 1 ? 'lastFrame' : undefined
  return undefined
}

type UnsupportedScope = 'mode' | 'node' | 'text'

function reasonMessage(
  reason: InputUnsentReason,
  name: string,
  limit?: number,
  kind: ReferenceMediaKind = 'image',
  scope: UnsupportedScope = 'mode',
) {
  if (reason === 'over_limit')
    return `「${name}」的图片超过模型参考上限${limit === undefined ? '' : ` ${limit} 张`}，未送入`
  if (reason === 'failed') return `「${name}」的参考图生成失败，未送入`
  if (reason === 'unsupported') {
    // 不收参考图的节点（对话、局部重绘、精修、配音、分镜等）：@ 引用只保留名称。
    if (scope === 'node') return `「${name}」当前节点不会送入 @ 引用的参考图`
    if (scope === 'text' && kind === 'image') return `「${name}」文生视频模式不使用参考图`
    if (kind !== 'image') {
      const media = kind === 'video' ? '参考视频' : '参考音频'
      return `「${name}」的${media}在当前模型或模式下不送入`
    }
    return `「${name}」的参考图在当前模式下不送入`
  }
  if (reason === 'selection_missing') return `「${name}」选定的参考图已不可用，未送入`
  if (kind !== 'image') return `「${name}」没有可用${kind === 'video' ? '视频' : '音频'}，未送入`
  return `「${name}」没有可用图片，未送入`
}
