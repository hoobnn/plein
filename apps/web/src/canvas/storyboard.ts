import type { Engine } from '@plein/canvas-core'
import {
  type CanvasElement,
  connect,
  createElement,
  currentResult,
  LOCAL_ORIGIN,
  type NewElement,
} from '@plein/doc'
import type { Shot } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { findNode, mentionTargets, nodeElement } from './nodes'
import { runNode } from './runner'

/** 展开出来的节点记下来源，重新展开、批量运行都按它找 */
export interface ShotSource {
  storyboard: string
  shot: string
  role: 'image' | 'video' | 'speech'
}

const sourceOf = (el: CanvasElement) => el.params?.source as ShotSource | undefined

export function shotsOf(el: CanvasElement | undefined): Shot[] {
  const list = el?.params?.shots
  return Array.isArray(list) ? (list as Shot[]) : []
}

/** 某个分镜表已展开的节点，按镜头 id 分组 */
export function expandedNodes(engine: Engine, boardId: string) {
  const out = new Map<string, CanvasElement[]>()
  for (const el of engine.doc.elements()) {
    const src = sourceOf(el)
    if (el.kind !== 'node' || src?.storyboard !== boardId) continue
    out.set(src.shot, [...(out.get(src.shot) ?? []), el])
  }
  return out
}

const PAD = 24
const HEAD = 40
const GAP = 80
const ROW_GAP = 16
const FRAME_GAP = 48

/**
 * 把镜头展开成节点：每个镜头一个 Frame，里面是 分镜图 → 视频，每句台词一个配音节点。
 * 已展开过的镜头跳过（不覆盖手改）。出场角色有同名资产卡时在提示词里 @ 它，
 * 配音节点直接用角色卡的音色。整个展开是一步撤销。返回新建的 Frame。
 */
export function expandShots(
  engine: Engine,
  boardId: string,
  shotIds: string[],
  catalog: Catalog | null,
): string[] {
  const { doc } = engine
  const board = doc.get(boardId)
  const boardRect = doc.worldRect(boardId)
  const imageInfo = findNode(catalog, 'plein/image')
  const videoInfo = findNode(catalog, 'plein/video')
  const speechInfo = findNode(catalog, 'plein/speech')
  if (!board || !boardRect || !imageInfo || !videoInfo || !speechInfo) return []
  const done = expandedNodes(engine, boardId)
  const shots = shotsOf(board).filter((s) => shotIds.includes(s.id) && !done.has(s.id))
  if (shots.length === 0) return []

  // 新 Frame 接在已展开的镜头下面，都放在分镜表右侧
  const x = boardRect.x + boardRect.w + 120
  let y = boardRect.y
  for (const list of done.values()) {
    for (const el of list) {
      const p = el.parentId ? doc.worldRect(el.parentId) : doc.worldRect(el.id)
      if (p) y = Math.max(y, p.y + p.h + FRAME_GAP)
    }
  }

  const targets = mentionTargets(engine)
  const image = nodeElement(imageInfo)
  const video = nodeElement(videoInfo)
  const speech = nodeElement(speechInfo)
  const frames: string[] = []
  doc.ydoc.transact(() => {
    for (const shot of shots) {
      const lines = shot.dialogue.filter((d) => d.line.trim())
      const w = PAD * 2 + image.w + GAP + video.w
      const h = HEAD + image.h + PAD + lines.length * (speech.h + ROW_GAP)
      const frame = createElement(doc, {
        kind: 'frame',
        name: `镜头 ${String(shot.no).padStart(2, '0')} · ${shot.shotSize}`,
        x: Math.round(x),
        y: Math.round(y),
        w,
        h,
      })
      frames.push(frame)
      y += h + FRAME_GAP
      const source = (role: ShotSource['role']): ShotSource => ({
        storyboard: boardId,
        shot: shot.id,
        role,
      })
      const mentions = shot.characters
        .filter((c) => targets.has(c))
        .map((c) => `@${c}`)
        .join(' ')
      const add = (base: Omit<NewElement, 'x' | 'y'>, at: [number, number], extra: object) =>
        createElement(doc, {
          ...base,
          parentId: frame,
          x: at[0],
          y: at[1],
          params: { ...base.params, ...extra },
        } as NewElement)

      const img = add(image, [PAD, HEAD], {
        source: source('image'),
        prompt: [mentions, shot.imagePrompt || shot.description].filter(Boolean).join(' '),
      })
      const vid = add(video, [PAD + image.w + GAP, HEAD], {
        source: source('video'),
        prompt: shot.motionPrompt || shot.description,
        duration: Math.max(1, Math.min(30, Math.round(shot.duration))),
      })
      connect(doc, [img, 'images'], [vid, 'firstFrame'])
      lines.forEach((d, i) => {
        const card = targets.get(d.character)
        const voice = typeof card?.params?.voice === 'string' ? card.params.voice : ''
        add(
          { ...speech, name: `台词 · ${d.character || '旁白'}` },
          [PAD, HEAD + image.h + PAD + i * (speech.h + ROW_GAP)],
          { source: source('speech'), text: d.line, voice },
        )
      })
    }
  }, LOCAL_ORIGIN)
  doc.flush()
  return frames
}

/**
 * 批量运行展开出来的某类节点。视频要等分镜图有结果，没有的跳过。
 * 返回实际发起的数量和跳过的数量。
 */
export function runExpanded(
  engine: Engine,
  boardId: string,
  shotIds: string[],
  role: ShotSource['role'],
) {
  const groups = expandedNodes(engine, boardId)
  let started = 0
  let skipped = 0
  for (const id of shotIds) {
    for (const el of groups.get(id) ?? []) {
      if (sourceOf(el)?.role !== role) continue
      if (el.run?.status === 'running' || el.run?.status === 'queued') continue
      if (role === 'video') {
        const edge = [...engine.doc.edges()].find(
          (e) => e.to[0] === el.id && e.to[1] === 'firstFrame',
        )
        const up = edge && engine.doc.get(edge.from[0])
        if (!up || !currentResult(up)) {
          skipped++
          continue
        }
      }
      void runNode(el.id)
      started++
    }
  }
  return { started, skipped }
}
