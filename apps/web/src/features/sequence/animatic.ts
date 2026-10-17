import { activeShotNodes, expandedNodes, shotsOf, type ShotSource } from '@plein/capabilities'
import type { Engine } from '@plein/canvas-core'
import { createElement, currentResult, setParam, type PleinDoc } from '@plein/doc'
import { ANIMATIC_TYPE, animaticNode, matchLines, type AnimaticShot } from '@plein/nodes'
import { findNode, nodeElement } from '../../canvas/nodes'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'

/** 只读取已采用产物。草稿没有生成器连线，打开与导出均不调度上游。 */
export function snapshotAnimatic(
  doc: PleinDoc,
  boardId: string,
  previous: AnimaticShot[] = [],
): AnimaticShot[] {
  const groups = expandedNodes(doc, boardId)
  return shotsOf(doc.get(boardId)).map((shot) => {
    const nodes = activeShotNodes(shot, groups.get(shot.id) ?? [])
    const image = nodes.find((n) => (n.params?.source as ShotSource)?.role === 'image')
    const imageValue = image && currentResult(image)?.value
    const speech = nodes.filter((n) => (n.params?.source as ShotSource)?.role === 'speech')
    const lines = matchLines(
      speech.map((n, i) => {
        const source = n.params?.source as ShotSource
        return {
          id: n.id,
          dialogueId: source.dialogueId,
          line: source.line ?? i,
          text: String(source.plan?.params.text ?? n.params?.text ?? ''),
        }
      }),
      shot.dialogue,
    )
    speech.sort((a, b) => {
      return (lines.get(a.id) ?? 0) - (lines.get(b.id) ?? 0)
    })
    const old = previous.find((p) => p.shotId === shot.id)
    return {
      shotId: shot.id,
      imageSource: image?.id,
      imageAssetId: imageValue?.type === 'image' ? imageValue.assetId : undefined,
      duration: old?.duration ?? shot.duration,
      lineDelay: old?.lineDelay ?? 0,
      lineGap: old?.lineGap ?? 0.2,
      subtitle: old?.subtitle,
      dialogue: speech.flatMap((n) => {
        const value = currentResult(n)?.value
        return value?.type === 'audio'
          ? [
              {
                source: n.id,
                assetId: value.assetId,
                caption: value.caption ?? String(n.params?.text ?? ''),
              },
            ]
          : []
      }),
    }
  })
}

export function refreshAnimatic(engine: Engine, id: string) {
  const el = engine.doc.get(id)
  if (el?.nodeType !== ANIMATIC_TYPE) return
  const params = animaticNode.params.parse(el.params)
  setParam(engine.doc, id, 'shots', snapshotAnimatic(engine.doc, params.boardId, params.shots))
  engine.doc.flush()
}

/** 从分镜打开已存在的草稿；首次创建快照。后续素材更新必须显式刷新。 */
export function openAnimatic(engine: Engine, boardId: string): string | undefined {
  const board = engine.doc.get(boardId)
  if (!board || engine.doc.readOnly) return
  const existing = [...engine.doc.elements()].find(
    (n) => n.nodeType === ANIMATIC_TYPE && n.params?.boardId === boardId,
  )
  if (existing) {
    useCanvas.getState().openSequence(existing.id)
    return existing.id
  }
  const def = findNode(useCatalog.getState().catalog, ANIMATIC_TYPE)
  if (!def) {
    useCanvas.getState().notify('分镜样片节点尚未加载，请刷新后重试')
    return
  }
  const params = animaticNode.params.parse({
    boardId,
    shots: snapshotAnimatic(engine.doc, boardId),
    aspectRatio: board.params?.aspectRatio ?? '16:9',
    subtitles: true,
    asrTiming: false,
  })
  const id = createElement(engine.doc, {
    ...nodeElement(def),
    x: board.x + board.w + 80,
    y: board.y,
    name: `${board.name ?? '分镜'} · 样片草稿`,
    params,
  })
  engine.doc.flush()
  useCanvas.getState().openSequence(id)
  return id
}

export function relatedSequence(engine: Engine, id: string): string | undefined {
  const el = engine.doc.get(id)
  const boardId = el?.nodeType === ANIMATIC_TYPE ? el.params?.boardId : undefined
  if (typeof boardId !== 'string') return
  const candidates = [...engine.doc.elements()].filter((n) => n.nodeType === 'plein/sequence')
  return candidates.find((n) =>
    [...engine.doc.edges()].some(
      (e) =>
        e.to[0] === n.id &&
        (engine.doc.get(e.from[0])?.params?.source as ShotSource)?.storyboard === boardId,
    ),
  )?.id
}
