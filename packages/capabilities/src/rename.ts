import { type PleinDoc, ReadOnlyDocError, setParams, updateElement } from '@plein/doc'
import {
  findMentions,
  sortMentionTargets,
  type MentionTarget,
  isAiAnalysisType,
  AiSceneRequest,
  AiSummaryRequest,
  AiDraftOrigin,
} from '@plein/nodes'
import { boundReferenceTokens, referenceBindings } from '@plein/plugin-sdk'
import { mentionTargetsIn } from './story/nodes'
import { resolveShotAsset } from './story/bindings'

/** 名称与当前可编辑引用作为一次操作写入；历史结果与文件本体不参与改名。 */
export function renameElement(doc: PleinDoc, id: string, value: string) {
  if (doc.readOnly) throw new ReadOnlyDocError()
  const element = doc.get(id)
  if (!element) throw new Error('节点已删除，无法重命名')
  const name = value.trim()
  if (!name || name.length > 200 || /[\r\n@]/.test(name))
    throw new Error('名称需为 1–200 个字符，不能包含换行或 @')
  if (element.name === name) return { references: 0, elements: 0 }
  const before = mentionTargetsIn(doc)
  const after = before.map((t) => (t.id === id ? { ...t, name } : t))
  const all = [...doc.elements()]
  const named = all.map((el) => ({
    id: el.id,
    name: el.id === id ? name : el.name?.trim() || '参考素材',
  }))
  const referenceName = (source: string) => {
    const target = named.find((t) => t.id === source)
    return target ? tokenFor(target, named).slice(1) : undefined
  }
  let references = 0
  const patches: Array<{ id: string; params: Record<string, unknown> }> = []
  const texts: Array<{ id: string; edits: Edit[] }> = []
  for (const el of all) {
    // 已固化的执行输入、剪辑字幕与来源记录属于历史证据。
    if (
      el.nodeType === 'plein/delivery-check' ||
      el.nodeType === 'plein/sequence' ||
      AiDraftOrigin.safeParse(el.params?.aiDraftOrigin).success ||
      (isAiAnalysisType(el.nodeType) &&
        (AiSceneRequest.safeParse(el.params?.request).success ||
          AiSummaryRequest.safeParse(el.params?.request).success))
    )
      continue
    const params = el.params ?? {}
    const bindings = referenceBindings(params)
    const aliases = new Map<string, string>()
    for (const [alias, binding] of Object.entries(bindings)) {
      if (!binding.source || !binding.assetId) continue
      const next = referenceName(binding.source)
      const source = all.find((item) => item.id === binding.source)
      const peersChanged =
        source &&
        all.some(
          (item) =>
            item.id === id &&
            (item.name?.trim() === source.name?.trim() || name === source.name?.trim()),
        )
      // 旧编号有独立的身份协议，保留原样；名称绑定跟随来源与同名消歧序号。
      if (
        next &&
        (binding.source === id || peersChanged) &&
        (!/^(image|video|audio)[1-9]\d*$/.test(alias) ||
          Object.keys(params).some((key) =>
            key.startsWith(`referenceNameBinding:${encodeURIComponent(alias)}:`),
          ))
      )
        aliases.set(alias, next)
    }
    const rewrite = (text: string) => {
      const edits = editsFor(
        text,
        before.filter((t) => t.id !== el.id),
        after.filter((t) => t.id !== el.id),
        params,
        aliases,
      )
      references += edits.length
      return applyEdits(text, edits)
    }
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(params)) {
      if (key.startsWith('referenceNameBinding:')) {
        let alias: string
        try {
          alias = decodeURIComponent(key.slice('referenceNameBinding:'.length).split(':')[0]!)
        } catch {
          continue
        }
        const replacement = aliases.get(alias)
        if (replacement && replacement !== alias) {
          next[key] = undefined
          next[
            `referenceNameBinding:${encodeURIComponent(replacement)}:${key.slice(key.indexOf(':', 'referenceNameBinding:'.length) + 1)}`
          ] = value
        }
      } else if (key === 'referenceBindings' && value && typeof value === 'object') {
        const migrated = Object.fromEntries(
          Object.entries(value).map(([alias, binding]) => [aliases.get(alias) ?? alias, binding]),
        )
        if (JSON.stringify(migrated) !== JSON.stringify(value)) next[key] = migrated
      } else if (key === 'shots' && Array.isArray(value)) {
        next[key] = value.map((shot) => {
          if (!shot || typeof shot !== 'object') return shot
          const row = shot as Record<string, unknown>
          const assetBindings = {
            ...(row.assetBindings as Record<string, { elementId?: string }> | undefined),
          }
          const renameAsset = (old: string, binding?: { elementId?: string }) =>
            resolveShotAsset(doc, old, binding)?.id === id ? name : old
          const characters = Array.isArray(row.characters)
            ? row.characters.map((old) => {
                if (typeof old !== 'string') return old
                const renamed = renameAsset(old, assetBindings[old])
                if (renamed !== old) {
                  if (
                    (assetBindings[renamed] && assetBindings[renamed]?.elementId !== id) ||
                    ((row.characters as unknown[]).includes(renamed) &&
                      resolveShotAsset(doc, renamed, assetBindings[renamed])?.id !== id)
                  )
                    throw new Error(`分镜中已有另一个「${name}」，请使用不同的名称`)
                  assetBindings[renamed] = { ...assetBindings[old], elementId: id }
                  delete assetBindings[old]
                  references++
                }
                return renamed
              })
            : row.characters
          const dialogue = Array.isArray(row.dialogue)
            ? row.dialogue.map((line) => {
                if (!line || typeof line !== 'object') return line
                const entry = line as Record<string, unknown>
                if (typeof entry.character !== 'string') return line
                const renamed = renameAsset(
                  entry.character,
                  (entry.speaker ??
                    (row.assetBindings as Record<string, unknown> | undefined)?.[
                      entry.character
                    ]) as { elementId?: string } | undefined,
                )
                if (renamed === entry.character) return line
                references++
                return {
                  ...entry,
                  character: renamed,
                  speaker: { ...(entry.speaker as object), elementId: id },
                }
              })
            : row.dialogue
          // 仅用于显式绑定或对白的资产，也可能不在出场列表里。
          for (const [old, binding] of Object.entries(
            (row.assetBindings ?? {}) as Record<string, { elementId?: string }>,
          )) {
            if (old === name || !assetBindings[old] || renameAsset(old, binding) === old) continue
            if (assetBindings[name] && assetBindings[name]?.elementId !== id)
              throw new Error(`分镜中已有另一个「${name}」，请使用不同的名称`)
            assetBindings[name] = { ...binding, elementId: id }
            delete assetBindings[old]
            references++
          }
          return rewriteValue(
            {
              ...row,
              characters,
              dialogue,
              ...(row.assetBindings || Object.keys(assetBindings).length ? { assetBindings } : {}),
            },
            rewrite,
          )
        })
      } else {
        const rewritten = rewriteValue(value, rewrite, key)
        if (JSON.stringify(rewritten) !== JSON.stringify(value)) next[key] = rewritten
      }
    }
    if (Object.keys(next).some((key) => JSON.stringify(next[key]) !== JSON.stringify(params[key])))
      patches.push({ id: el.id, params: next })
    if (typeof el.text === 'string') {
      const edits = editsFor(el.text, before, after, {}, new Map())
      if (edits.length) {
        references += edits.length
        texts.push({ id: el.id, edits })
      }
    }
  }
  doc.undo.stopCapturing()
  doc.ydoc.transact(() => {
    updateElement(doc, id, { name })
    for (const patch of patches) setParams(doc, patch.id, patch.params)
    for (const item of texts) {
      const text = doc.getText(item.id)
      for (const edit of item.edits.toReversed()) {
        text?.delete(edit.start, edit.end - edit.start)
        text?.insert(edit.start, edit.value)
      }
    }
  }, doc.origin)
  doc.undo.stopCapturing()
  return { references, elements: new Set([...patches, ...texts].map((p) => p.id)).size }
}

interface Edit {
  start: number
  end: number
  value: string
}
function tokenFor(target: MentionTarget, targets: MentionTarget[]) {
  const peers = sortMentionTargets(targets.filter((t) => t.name === target.name))
  return `@${target.name}${peers.length > 1 ? `#${peers.findIndex((t) => t.id === target.id) + 1}` : ''}`
}
function editsFor(
  text: string,
  before: MentionTarget[],
  after: MentionTarget[],
  params: Record<string, unknown>,
  aliases: Map<string, string>,
): Edit[] {
  const bound = boundReferenceTokens(text, params)
  const edits: Edit[] = []
  for (const token of bound) {
    const name = aliases.get(token.name)
    if (name && name !== token.name)
      edits.push({ start: token.start, end: token.end, value: `@${name}` })
  }
  for (const mention of findMentions(text, before)) {
    if (bound.some((t) => t.start === mention.start)) continue
    const target = after.find((t) => t.id === mention.id)
    const end =
      mention.start +
      1 +
      mention.name.length +
      (text.slice(mention.start + 1 + mention.name.length).match(/^#\d{1,3}/)?.[0].length ?? 0)
    // 原先未消歧或越界的引用不能在改名后意外指向另一张卡。
    const changedPeers =
      mention.ids.join() !==
      sortMentionTargets(after.filter((t) => t.name === mention.name))
        .map((t) => t.id)
        .join()
    const value = target
      ? tokenFor(target, after)
      : changedPeers
        ? `@${mention.name}#0`
        : text.slice(mention.start, end)
    if (text.slice(mention.start, end) !== value) edits.push({ start: mention.start, end, value })
  }
  return edits
    .sort((a, b) => a.start - b.start)
    .filter(
      (edit, index, sorted) =>
        !sorted.slice(0, index).some((previous) => previous.end > edit.start),
    )
}
function applyEdits(text: string, edits: Edit[]) {
  for (const edit of edits.toReversed())
    text = text.slice(0, edit.start) + edit.value + text.slice(edit.end)
  return text
}
const TEXT_KEYS =
  /^(?:.*[Pp]rompt|text|description|content|instruction|cameraMotion|emotion|lighting|sfx|line)$/
function rewriteValue(value: unknown, rewrite: (text: string) => string, key = ''): unknown {
  if (typeof value === 'string') return TEXT_KEYS.test(key) ? rewrite(value) : value
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, rewrite, key))
  if (value && typeof value === 'object') {
    if (
      [
        'legacySourceSettings',
        'subtitleTrack',
        'origin',
        'segment',
        'aiDraftOrigin',
        'request',
      ].includes(key)
    )
      return value
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, rewriteValue(v, rewrite, k)]),
    )
  }
  return value
}
