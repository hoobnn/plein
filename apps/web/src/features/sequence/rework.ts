import {
  connect,
  currentResult,
  createElement,
  deleteElements,
  editSequenceInstance,
  inputEdges,
  isGenerationOrigin,
  isVideoSegment,
  isSequenceInstance,
  replaceSequenceSegment,
  sequenceInstancesOf,
  type CanvasElement,
  type PleinDoc,
  type SequenceSound,
  type VideoSegment,
  videoSegmentConflict,
} from '@plein/doc'
import type { ArrangedClip } from '@plein/nodes'

/** Resolve a known local selection, never an asset-name or historical-origin guess. */
export function inspectReworkSource(doc: PleinDoc, row: ArrangedClip, canvasId: string | null) {
  if (!row.clip.assetId) return { problem: '这个片段尚未采用有效视频，请先生成并采用候选。' }
  const selection = row.segment?.selection
  if (row.segment && !selection)
    return {
      problem: '这份固定素材没有可核对的候选选择记录，可使用“替换本实例固定素材”选择新素材。',
    }
  const id = row.segment ? selection?.nodeId : row.source
  const port = row.segment ? selection?.port : row.port
  if (row.segment && selection?.canvasId !== canvasId)
    return { problem: '候选来源位于其他画布，请到来源画布继续生成，或明确替换本实例固定素材。' }
  const source = id ? doc.get(id) : undefined
  if (!source)
    return { problem: '来源节点已删除，请先创建视频生成节点，再明确替换本实例固定素材。' }
  if (source.kind !== 'node')
    return { problem: '来源是导入素材，没有可修改的视频生成输入。可明确替换本实例固定素材。' }
  if (source.locked) return { problem: '来源节点已锁定，请先解锁后返工。' }
  if (!port || !source.ports?.outputs.some((p) => p.id === port && p.type === 'video'))
    return { problem: '来源的视频输出端口已变化，请重新核对来源或替换固定素材。' }
  if (!row.segment) {
    const edge = row.edgeId ? doc.getEdge(row.edgeId) : undefined
    const adopted = currentResult(source, port)
    if (
      !edge ||
      edge.from[0] !== source.id ||
      edge.from[1] !== port ||
      edge.to[1] !== 'clips' ||
      adopted?.value.type !== 'video' ||
      adopted.value.assetId !== row.clip.assetId
    )
      return { problem: '来源连线或当前采用项已变化，请重新选择并核对片段。' }
  }
  if (selection) {
    const result = source.results?.find(
      (r) => r.id === selection.resultId && r.port === port && r.runId === selection.runId,
    )
    if (result?.value.type !== 'video' || result.value.assetId !== row.clip.assetId)
      return { problem: '原候选记录或文件已变化，无法确认当前片段的生成输入来源。' }
  }
  return { source, port }
}

export function reworkSource(doc: PleinDoc, row: ArrangedClip, canvasId: string | null) {
  const result = inspectReworkSource(doc, row, canvasId)
  return 'problem' in result ? undefined : result
}

/** Keep incoming references in their exact order; drafts own no old results or task identity. */
export function createReworkDraft(doc: PleinDoc, source: CanvasElement) {
  if (doc.readOnly || !doc.has(source.id) || doc.get(source.id)?.locked) return null
  let id = ''
  doc.undo.stopCapturing()
  doc.ydoc.transact(() => {
    const rect = doc.worldRect(source.id) ?? source
    id = createElement(doc, {
      kind: 'node',
      nodeType: source.nodeType,
      nodeVersion: source.nodeVersion,
      name: `${source.name ?? '视频'} · 返工草稿`,
      params: structuredClone(source.params ?? {}),
      ports: structuredClone(source.ports),
      x: rect.x + rect.w + 60,
      y: rect.y,
      w: source.w,
      h: source.h,
    })
    for (const edge of inputEdges(doc, source.id)) connect(doc, edge.from, [id, edge.to[1]])
  }, doc.origin)
  doc.undo.stopCapturing()
  doc.flush()
  return id
}

/** Replace just one instance. Keep editorial values and the old subtitle key (now stale). */
export function applyReworkCandidate(
  doc: PleinDoc,
  options: {
    canvasId: string
    sequenceId: string
    instanceId: string
    expected: string
    draftId: string
    port: string
    resultId: string
    expectedResult: string
    duration: number
    sound: Exclude<SequenceSound, 'legacy'>
    /** Freeze the currently resolved legacy audio before leaving automatic mapping. */
    legacyAudio?: { dialogue?: string; sfx?: string }
  },
) {
  const sequence = doc.get(options.sequenceId)
  const raw =
    sequence && sequenceInstancesOf(sequence).find((c) => c.clipInstanceId === options.instanceId)
  const draft = doc.get(options.draftId)
  const result = draft?.results?.find((r) => r.id === options.resultId && r.port === options.port)
  if (
    doc.readOnly ||
    !sequence ||
    sequence.locked ||
    !raw ||
    JSON.stringify(raw) !== options.expected ||
    !draft ||
    draft.locked ||
    result?.value.type !== 'video' ||
    JSON.stringify(result) !== options.expectedResult ||
    !Number.isFinite(options.duration) ||
    options.duration <= raw.in ||
    (raw.out !== undefined && options.duration < raw.out)
  )
    return false
  const segment: VideoSegment = {
    version: 1,
    segmentId: `segment:${crypto.randomUUID()}`,
    asset: { assetId: result.value.assetId, kind: 'video', mime: result.value.mime },
    duration: options.duration,
    selection: {
      canvasId: options.canvasId,
      nodeId: draft.id,
      port: options.port,
      resultId: result.id,
      runId: result.runId,
    },
    ...(isGenerationOrigin(result.generationOrigin) ? { origin: result.generationOrigin } : {}),
  }
  const rows = sequenceInstancesOf(sequence)
  if (
    !isVideoSegment(segment) ||
    videoSegmentConflict(doc.elements(), segment) ||
    !isSequenceInstance({ ...raw, segment, sound: options.sound }) ||
    !Array.isArray(sequence.params?.clips) ||
    rows.length !== sequence.params.clips.length ||
    new Set(rows.map((r) => r.clipInstanceId)).size !== rows.length
  )
    return false
  let saved = false
  const fixed =
    raw.sound === 'legacy'
      ? {
          ...raw,
          sound: options.sound,
          dialogue: raw.dialogue ?? options.legacyAudio?.dialogue ?? '',
          sfx: raw.sfx ?? options.legacyAudio?.sfx ?? '',
        }
      : raw
  doc.undo.stopCapturing()
  doc.ydoc.transact(() => {
    const view = createElement(doc, {
      kind: 'video',
      name: `${draft.name ?? '返工'} · 固定素材`,
      assetId: segment.asset.assetId,
      videoSegment: segment,
      x: sequence.x - 450,
      y: sequence.y,
      w: 320,
      h: 180,
    })
    // A legacy automatic row must first choose an explicit sound route before fixing.
    if (raw.sound === 'legacy')
      editSequenceInstance(
        doc,
        sequence.id,
        raw.clipInstanceId,
        { sound: fixed.sound, dialogue: fixed.dialogue, sfx: fixed.sfx },
        options.expected,
      )
    saved = replaceSequenceSegment(
      doc,
      sequence.id,
      raw.clipInstanceId,
      view,
      JSON.stringify(fixed),
    )
    if (!saved) {
      deleteElements(doc, [view])
      if (raw.sound === 'legacy')
        editSequenceInstance(doc, sequence.id, raw.clipInstanceId, {
          sound: raw.sound,
          dialogue: raw.dialogue,
          sfx: raw.sfx,
        })
    }
  }, doc.origin)
  doc.undo.stopCapturing()
  doc.flush()
  return saved
}
