import type { Engine } from '@plein/canvas-core'
import { connect, createElement } from '@plein/doc'
import { MOTION_TYPE, MotionParams } from '@plein/nodes'
import { CompositionSourceRef } from '@plein/plugin-sdk'
import { request } from '../../api/client'
import { findNode, nodeElement } from '../../canvas/nodes'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import type { MotionInputs } from './api'
import { writeMotionEdit } from './history'

export interface MotionSource {
  params: MotionParams
  inputs: MotionInputs
}

/** 宿主负责所有权、引擎/模板版本和原素材校验；客户端只接收结构化源参数。 */
export async function loadMotionSource(
  manifestAssetId: string,
  signal: AbortSignal,
): Promise<MotionSource> {
  const source = await request<{ params: unknown; inputs?: MotionInputs }>(
    `/api/motion/source/${encodeURIComponent(manifestAssetId)}`,
    { signal },
  )
  const params = MotionParams.parse(source.params)
  const inputs: MotionInputs = {}
  for (const kind of ['image', 'video'] as const) {
    const assetId = source.inputs?.[kind]
    if (!assetId) continue
    if (!/^[0-9a-f]{64}$/.test(assetId)) throw new Error('源工程中的素材引用无效')
    inputs[kind] = assetId
  }
  return { params, inputs }
}

/** 独立新节点与旧版输入在同一撤销事务创建；原视频/节点及现有连线保留。 */
export function copyMotionSource(
  engine: Engine,
  anchorId: string,
  source: MotionSource,
): string | undefined {
  if (engine.doc.readOnly || !engine.doc.get(anchorId)) return
  const info = findNode(useCatalog.getState().catalog, MOTION_TYPE)
  if (!info) throw new Error('动态合成节点尚未启用')
  const params = MotionParams.parse(source.params)
  for (const kind of ['image', 'video'] as const) {
    if (
      source.inputs[kind] &&
      (!/^[0-9a-f]{64}$/.test(source.inputs[kind]) ||
        !info.inputs.some((port) => port.id === kind && port.type === kind))
    )
      throw new Error('源工程中的素材引用或输入端口无效')
  }
  const nodeId = `el_${crypto.randomUUID().replaceAll('-', '')}`
  const anchor = engine.doc.worldRect(anchorId) ?? { x: 0, y: 0, w: 320, h: 240 }
  writeMotionEdit(engine.doc, nodeId, () => {
    createElement(engine.doc, {
      ...nodeElement(info, params),
      id: nodeId,
      name: `${params.title || '动态合成'} · 源版本`,
      x: anchor.x + anchor.w + 380,
      y: anchor.y,
    })
    for (const [index, kind] of (['image', 'video'] as const).entries()) {
      const assetId = source.inputs[kind]
      if (!assetId) continue
      const inputId = createElement(engine.doc, {
        kind,
        assetId,
        x: anchor.x + anchor.w + 40,
        y: anchor.y + index * 240,
        w: 280,
        h: 180,
        name: `源版本${kind === 'image' ? '图片' : '视频'}`,
      })
      connect(engine.doc, [inputId, kind], [nodeId, kind])
    }
  })
  engine.doc.flush()
  engine.selection.set([nodeId])
  engine.zoomToFit([nodeId])
  useCanvas.getState().openMotion(nodeId)
  return nodeId
}

/** 异步读取属于发起时的画布、视频对象和来源身份；迟到的请求不能恢复到其他文档。 */
export async function resumeMotionSource(
  engine: Engine,
  id: string,
  canvasId: string,
  signal: AbortSignal,
  expected?: {
    target: ReturnType<Engine['doc']['elementMaps']['get']>
    assetId: string
    source: CompositionSourceRef
  },
): Promise<string | undefined> {
  const original = engine.doc.get(id)
  if (original?.kind !== 'video' || !original.assetId || engine.doc.readOnly || signal.aborted)
    return
  const source = expected?.source ?? CompositionSourceRef.parse(original.params?.compositionSource)
  const assetId = expected?.assetId ?? original.assetId
  const target = expected?.target ?? engine.doc.elementMaps.get(id)
  const identity = JSON.stringify(source)
  const current = () => {
    const state = useCanvas.getState()
    const video = engine.doc.get(id)
    const reference = CompositionSourceRef.safeParse(video?.params?.compositionSource)
    return (
      !signal.aborted &&
      !engine.doc.readOnly &&
      state.engine === engine &&
      state.canvasId === canvasId &&
      engine.doc.elementMaps.get(id) === target &&
      video?.kind === 'video' &&
      video.assetId === assetId &&
      reference.success &&
      JSON.stringify(reference.data) === identity
    )
  }
  if (!current()) return
  const loaded = await loadMotionSource(source.manifestAssetId, signal)
  if (!current()) return
  return copyMotionSource(engine, id, loaded)
}
