import type { Engine } from '@plein/canvas-core'
import {
  type CanvasElement,
  connect,
  createElement,
  currentResult,
  ReadOnlyDocError,
  setParam,
  updateElement,
  videoAssetOf,
} from '@plein/doc'
import { ContinuesFrom, continueShotParams, nearestAspect } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { api } from '../api/client'
import { elementSize, formatTimecode } from './media'
import { aspectKey, fieldsOf, findNode, type NodeInfo, nodeElement } from './nodes'
import { focusGenerator, freeSpotRight } from './presets'

/** 从哪一帧续：尾帧，或视频里的某一秒 */
export type ContinuePoint = { last: true } | { at: number }

/** 接续用的视频节点：父镜头本身是视频节点时用同一种，否则取内置的 */
export function continueNodeFor(
  catalog: Catalog | null,
  source: CanvasElement | undefined,
): NodeInfo | undefined {
  const same = findNode(catalog, source?.nodeType)
  if (same?.capability === 'video.generate' && same.inputs.some((p) => p.type === 'image'))
    return same
  const list = (catalog?.nodes ?? []).filter(
    (n) => n.capability === 'video.generate' && n.inputs.some((p) => p.type === 'image'),
  )
  return list.find((n) => n.type.startsWith('plein/')) ?? list[0]
}

/**
 * 续镜节点的参数：图生视频，父镜头是同类视频节点时沿用模型、时长、画幅等；
 * 父镜头是导入的视频时按画面比例挑画幅。提示词留空。
 */
export function continueParams(
  node: NodeInfo,
  source: CanvasElement,
  from: ContinuesFrom,
  frameSize?: { width?: number; height?: number },
): Record<string, unknown> {
  const fields = fieldsOf(node)
  const ak = aspectKey(node)
  const options = (fields.find(([k]) => k === ak)?.[1] as { enum?: unknown[] } | undefined)?.enum
  const aspect = options && nearestAspect(options, frameSize?.width, frameSize?.height)
  return continueShotParams({
    defaults: node.defaults ?? {},
    keys: fields.map(([k]) => k),
    parent: source.kind === 'node' && source.nodeType === node.type ? source.params : undefined,
    aspect: ak && aspect !== undefined ? { key: ak, value: aspect } : undefined,
    from,
  })
}

/** 画布上这个元素的播放器正停在第几秒（没在播放器里打开时为 null） */
export function playheadOf(elId: string): number | null {
  const media = document.querySelector<HTMLVideoElement>(
    `[data-player-el="${CSS.escape(elId)}"] video`,
  )
  return media && Number.isFinite(media.currentTime) ? media.currentTime : null
}

/** 「续自 镜头 3 · 尾帧」里的取帧位置 */
export function continuePointLabel(from: Pick<ContinuesFrom, 'last' | 'at'>) {
  return from.last ? '尾帧' : formatTimecode(from.at ?? 0)
}

/**
 * 取帧续镜：从视频（视频素材或视频节点的当前结果）取一帧，在右边接一个图生视频节点，
 * 那一帧连成新镜头的首帧，并在新节点上记下父视频，之后能一键回到上一个镜头。
 * 父镜头是开了「返回尾帧」的视频节点时直接连它的尾帧输出，不再抽帧。
 * 返回新节点 id。
 */
export async function continueShot(
  engine: Engine,
  catalog: Catalog | null,
  sourceId: string,
  point: ContinuePoint,
  options: { signal?: AbortSignal; focus?: boolean } = {},
): Promise<string> {
  options.signal?.throwIfAborted()
  if (engine.doc.readOnly) throw new ReadOnlyDocError()
  const source = engine.doc.get(sourceId)
  const assetId = videoAssetOf(source)
  if (!source || !assetId) throw new Error('选中的不是视频')
  const node = continueNodeFor(catalog, source)
  if (!node) throw new Error('没有能做图生视频的节点')
  const input = node.inputs.find((p) => p.type === 'image')!
  const name = source.name ?? '视频'
  const last = 'last' in point

  // 视频节点自己给了尾帧（「返回尾帧」）就直接用
  const own = last && source.kind === 'node' ? currentResult(source, 'lastFrame')?.value : undefined
  const frame =
    own?.type === 'image'
      ? null
      : await api.mediaDerive(
          {
            op: 'frame',
            assetId,
            at: last ? 0 : point.at,
            ...(last ? { last: true } : {}),
            name: `${name} · ${last ? '尾帧' : formatTimecode(point.at)}`,
          },
          options.signal,
        )
  options.signal?.throwIfAborted()
  const frameAsset = frame?.assets[0]
  if (frame && !frameAsset) throw new Error('没取到画面')
  // 只接受仍对应当前视频的抽帧；等待期间的参数编辑则沿用最新值。
  if (engine.doc.readOnly) throw new ReadOnlyDocError()
  const latest = engine.doc.get(sourceId)
  if (!latest) throw new Error('视频已经不在画布上了')
  if (videoAssetOf(latest) !== assetId) throw new Error('视频已经更换，请重新续镜')

  const from: ContinuesFrom = {
    elementId: sourceId,
    assetId,
    ...(last ? { last: true } : { at: point.at }),
    ...(frame
      ? {
          frameAssetId: frameAsset!.id,
          ...(last && typeof frame.params.at === 'number' ? { at: frame.params.at } : {}),
        }
      : own?.type === 'image'
        ? { frameAssetId: own.assetId }
        : {}),
  }
  const params = continueParams(node, latest, from, frameAsset)
  const base = nodeElement(node, params)

  const { doc } = engine
  // 取出的帧、新节点和两条连线算一步撤销
  doc.undo.stopCapturing()
  let id = ''
  doc.ydoc.transact(() => {
    let out: [string, string] = [sourceId, 'lastFrame']
    let anchor = sourceId
    const size = frameAsset && elementSize(frameAsset)
    if (frameAsset && size) {
      const spot = freeSpotRight(engine, sourceId, size.w, size.h)
      const img = createElement(doc, {
        kind: 'image',
        assetId: frameAsset.id,
        name: frameAsset.name.replace(/\.png$/, ''),
        w: size.w,
        h: size.h,
        x: Math.round(spot.x),
        y: Math.round(spot.y),
      })
      out = [img, 'image']
      anchor = img
    }
    const spot = freeSpotRight(engine, anchor, base.w, base.h)
    id = createElement(doc, {
      ...base,
      name: `${name} · 续镜`,
      params,
      x: Math.round(spot.x),
      y: Math.round(spot.y),
    })
    connect(doc, out, [id, input.id])
  }, doc.origin)
  doc.undo.stopCapturing()
  if (options.focus !== false) focusGenerator(engine, id)
  return id
}

/** 节点上记的续镜来路；没有或格式不对时为 null */
export function continuesFromOf(el: CanvasElement | undefined): ContinuesFrom | null {
  const parsed = ContinuesFrom.safeParse(el?.params?.continuesFrom)
  return parsed.success ? parsed.data : null
}

/**
 * 父镜头重新生成过（当前视频不是取帧时那个）且首帧是抽出来的图片时，
 * 首帧已经旧了；连的是父节点的尾帧输出时会自己跟着变，不算旧
 */
export function continueStale(engine: Engine, nodeId: string): boolean {
  const el = engine.doc.get(nodeId)
  const from = continuesFromOf(el)
  if (!from) return false
  const parent = engine.doc.get(from.elementId)
  const now = videoAssetOf(parent)
  if (!now || now === from.assetId) return false
  const live = engine.doc
    .edgesOf(nodeId)
    .some(
      (edge) =>
        edge.from[0] === from.elementId && edge.from[1] === 'lastFrame' && edge.to[0] === nodeId,
    )
  return !live && !!from.frameAssetId
}

/** 用父镜头当前的视频重新取帧，替换旧的首帧图片（同一个元素换资产，连线不动） */
export async function refreshContinue(engine: Engine, nodeId: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const { doc } = engine
  if (doc.readOnly) throw new ReadOnlyDocError()
  const from = continuesFromOf(doc.get(nodeId))
  const parent = from ? doc.get(from.elementId) : undefined
  const assetId = videoAssetOf(parent)
  if (!from || !parent || !assetId) throw new Error('上一个镜头已经不在画布上了')
  const edge = doc.edgesOf(nodeId).find((e) => {
    const el = doc.get(e.from[0])
    return e.to[0] === nodeId && el?.kind === 'image' && el.assetId === from.frameAssetId
  })
  const frameEl = edge && doc.get(edge.from[0])
  const made = await api.mediaDerive(
    {
      op: 'frame',
      assetId,
      at: from.last ? 0 : (from.at ?? 0),
      ...(from.last ? { last: true } : {}),
      name: frameEl?.name ?? `${parent.name ?? '前镜'} · 接续帧`,
    },
    signal,
  )
  signal?.throwIfAborted()
  const asset = made.assets[0]
  if (!asset) throw new Error('没取到画面')
  // 比较与本次取帧相关的状态，避免覆盖等待期间的新视频、手动换图或断线。
  // 校验必须放在事务前：失败时连首帧、来路和撤销记录都不改。
  if (doc.readOnly) throw new ReadOnlyDocError()
  if (
    videoAssetOf(doc.get(from.elementId)) !== assetId ||
    JSON.stringify(continuesFromOf(doc.get(nodeId))) !== JSON.stringify(from) ||
    (frameEl && doc.get(frameEl.id)?.assetId !== from.frameAssetId) ||
    (edge &&
      !doc
        .edgesOf(nodeId)
        .some(
          (e) =>
            e.id === edge.id &&
            e.from[0] === frameEl!.id &&
            e.from[1] === edge.from[1] &&
            e.to[0] === nodeId &&
            e.to[1] === edge.to[1],
        ))
  )
    throw new Error('续镜内容已经改变，请重新获取首帧')
  doc.undo.stopCapturing()
  doc.ydoc.transact(() => {
    if (frameEl) updateElement(doc, frameEl.id, { assetId: asset.id })
    setParam(doc, nodeId, 'continuesFrom', {
      ...from,
      assetId,
      frameAssetId: asset.id,
      ...(from.last && typeof made.params.at === 'number' ? { at: made.params.at } : {}),
    })
  }, doc.origin)
  doc.undo.stopCapturing()
}
