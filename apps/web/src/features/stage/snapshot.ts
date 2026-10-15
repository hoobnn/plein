import { addResults, fitAspect, type PleinDoc, setParam, SYSTEM_ORIGIN } from '@plein/doc'
import {
  aspectRatio,
  MAX_STAGE_SNAPSHOTS,
  STAGE_RENDER_VERSION,
  type StageScene,
  type StageSnapshot,
  stageSnapshotsOf,
} from '@plein/nodes'
import { api } from '../../api/client'

const shortId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/**
 * 截图入库：PNG 上传成资产（按内容哈希存，之后不会变），作为节点的新结果写入并采用，
 * 同一事务里记下这张图的来源（场景、机位、场景版本、渲染版本）。
 * 结果和来源都是系统写入，不进撤销栈：撤销场景编辑不会把已经截好的图弄丢。
 */
export async function saveSnapshot(doc: PleinDoc, id: string, scene: StageScene, blob: Blob) {
  const file = new File([blob], `构图-第${scene.rev}版.png`, { type: 'image/png' })
  const asset = await api.upload(file)
  const at = Date.now()
  const resultId = shortId('res')
  const entry: StageSnapshot = {
    resultId,
    assetId: asset.id,
    rev: scene.rev,
    render: STAGE_RENDER_VERSION,
    scene,
    at,
  }
  doc.ydoc.transact(() => {
    addResults(doc, id, [
      {
        id: resultId,
        port: 'image',
        value: { type: 'image', assetId: asset.id, mime: 'image/png' },
        runId: shortId('snap'),
        at,
      },
    ])
    const prev = stageSnapshotsOf(doc.get(id)?.params)
    setParam(doc, id, 'snapshots', [entry, ...prev].slice(0, MAX_STAGE_SNAPSHOTS))
    // 卡片跟着截图的画幅走，和图片节点一样
    fitAspect(doc, id, aspectRatio(scene.aspect))
  }, SYSTEM_ORIGIN)
  return entry
}
