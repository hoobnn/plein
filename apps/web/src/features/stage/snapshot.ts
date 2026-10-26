import {
  addResults,
  currentResult,
  fitAspect,
  type PleinDoc,
  ReadOnlyDocError,
  setParam,
  SYSTEM_ORIGIN,
} from '@plein/doc'
import {
  aspectRatio,
  STAGE_RENDER_VERSION,
  STAGE_TYPE,
  type StageScene,
  type StageSnapshot,
  stageSnapshotsOf,
} from '@plein/nodes'
import { api } from '../../api/client'

const shortId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/**
 * 截图入库：PNG 上传成资产（按内容哈希存，之后不会变），作为节点的新结果写入；当前采用未改变时自动采用，
 * 同一事务里记下这张图的来源（场景、机位、场景版本、渲染版本）。
 * 结果和来源都是系统写入，不进撤销栈：撤销场景编辑不会把已经截好的图弄丢。
 */
export async function saveSnapshot(
  doc: PleinDoc,
  id: string,
  scene: StageScene,
  blob: Blob,
  baseline: { resultId?: string; element?: ReturnType<PleinDoc['mutable']>; time?: number } = {
    resultId: doc.get(id) ? currentResult(doc.get(id)!, 'image')?.id : undefined,
  },
) {
  if (
    baseline.time !== undefined &&
    (!scene.motion ||
      !Number.isFinite(baseline.time) ||
      baseline.time < 0 ||
      baseline.time > scene.motion.duration)
  )
    throw new Error('截图时刻超出预演时长')
  const element = baseline.element ?? doc.mutable(id)
  const writable = () => {
    if (doc.ydoc.isDestroyed) throw new Error('画布已经关闭，请重新打开构图后截图')
    if (doc.readOnly) throw new ReadOnlyDocError()
    if (doc.get(id)?.locked) throw new Error('3D 构图节点已锁定')
    if (doc.mutable(id) !== element) throw new Error('3D 构图节点已被替换，请重新打开后截图')
    if (doc.get(id)?.nodeType !== STAGE_TYPE) throw new Error('3D 构图节点已经不在画布上了')
  }
  writable()
  const file = new File([blob], `构图-第${scene.rev}版.png`, { type: 'image/png' })
  const asset = await api.upload(file)
  writable()
  // 上传不能抢走期间手动采用的结果；仍保留截图及其来源供之后选择。
  const adopt = currentResult(doc.get(id)!, 'image')?.id === baseline.resultId
  const at = Date.now()
  const resultId = shortId('res')
  const entry: StageSnapshot = {
    resultId,
    assetId: asset.id,
    rev: scene.rev,
    render: STAGE_RENDER_VERSION,
    scene,
    at,
    ...(baseline.time !== undefined ? { time: baseline.time } : {}),
  }
  doc.ydoc.transact(() => {
    addResults(
      doc,
      id,
      [
        {
          id: resultId,
          port: 'image',
          value: { type: 'image', assetId: asset.id, mime: 'image/png' },
          runId: shortId('snap'),
          at,
        },
      ],
      { adopt },
    )
    const prev = stageSnapshotsOf(doc.get(id)?.params)
    // 结果保留策略会优先保住正在采用的旧图，来源必须跟随同一名单，不能独立截取最新 N 条。
    const retained = new Set(doc.get(id)?.results?.map((r) => r.id))
    setParam(
      doc,
      id,
      'snapshots',
      [entry, ...prev].filter((s) => retained.has(s.resultId)),
    )
    // 卡片跟着截图的画幅走，和图片节点一样
    if (adopt) fitAspect(doc, id, aspectRatio(scene.aspect))
  }, SYSTEM_ORIGIN)
  return { ...entry, adopted: currentResult(doc.get(id)!, 'image')?.id === resultId }
}
