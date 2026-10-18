import { activeShotNodes, expandedNodes, shotsOf, type ShotSource } from '@plein/capabilities'
import type { Engine } from '@plein/canvas-core'
import { createElement, currentResult, setParam, spotRightOf, type PleinDoc } from '@plein/doc'
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

export function refreshAnimatic(engine: Engine, id: string): string | null {
  const el = engine.doc.get(id)
  if (el?.nodeType !== ANIMATIC_TYPE) return '样片来源已变化，本次更新未执行'
  if (engine.doc.readOnly) return '画布已变为只读，本次更新未执行'
  const params = animaticNode.params.parse(el.params)
  if (engine.doc.get(params.boardId)?.nodeType !== 'plein/storyboard')
    return '来源分镜已删除或不再是分镜，本次更新未执行；已有样片与节奏已保留'
  engine.doc.undo.stopCapturing()
  setParam(engine.doc, id, 'shots', snapshotAnimatic(engine.doc, params.boardId, params.shots))
  engine.doc.undo.stopCapturing()
  engine.doc.flush()
  return null
}

/** 从分镜打开已存在的草稿；首次创建快照。后续素材更新必须显式刷新。 */
export function openAnimatic(engine: Engine, boardId: string): string | undefined {
  const board = engine.doc.get(boardId)
  if (!board) return
  const existing = [...engine.doc.elements()].find(
    (n) => n.nodeType === ANIMATIC_TYPE && n.params?.boardId === boardId,
  )
  if (existing) {
    useCanvas.getState().openSequence(existing.id)
    return existing.id
  }
  if (engine.doc.readOnly) {
    useCanvas.getState().notify('画布为只读，不能创建新样片；已有样片仍可打开查看')
    return
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
  const base = nodeElement(def)
  const spot = spotRightOf(engine.doc, boardId, base.w, base.h)
  engine.doc.undo.stopCapturing()
  const id = createElement(engine.doc, {
    ...base,
    ...spot,
    name: `${board.name ?? '分镜'} · 样片草稿`,
    params,
  })
  engine.doc.undo.stopCapturing()
  engine.doc.flush()
  useCanvas.getState().openSequence(id)
  return id
}

/** 仅把当前镜头的有效视频、配音和音效连线算作成片关联；多个版本由用户选择。 */
export function relatedSequences(engine: Engine, id: string) {
  const el = engine.doc.get(id)
  if (el?.nodeType !== ANIMATIC_TYPE) return []
  const params = animaticNode.params.parse(el.params)
  const boardId = params.boardId
  const board = engine.doc.get(boardId)
  const groups = expandedNodes(engine.doc, boardId)
  const savedShots = new Set(params.shots.map((shot) => shot.shotId))
  const active = new Set(
    (board?.nodeType === 'plein/storyboard'
      ? shotsOf(board).flatMap((shot) => activeShotNodes(shot, groups.get(shot.id) ?? []))
      : [...groups.values()].flat().filter((node) => {
          const source = node.params?.source as ShotSource
          return !source.detached && savedShots.has(source.shot)
        })
    ).map((node) => node.id),
  )
  const ports: Partial<Record<ShotSource['role'], string>> = {
    video: 'clips',
    speech: 'dialogue',
    sfx: 'sfx',
  }
  const links = new Set(
    [...engine.doc.edges()]
      .filter((edge) => {
        const source = engine.doc.get(edge.from[0])?.params?.source as ShotSource | undefined
        return active.has(edge.from[0]) && !!source && ports[source.role] === edge.to[1]
      })
      .map((edge) => edge.to[0]),
  )
  const candidates = [...engine.doc.elements()].filter((n) => n.nodeType === 'plein/sequence')
  return candidates.filter((node) => links.has(node.id))
}
