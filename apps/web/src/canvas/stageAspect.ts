import { currentResult, fitAspect, type PleinDoc } from '@plein/doc'
import { aspectRatio, STAGE_TYPE, StageSnapshot } from '@plein/nodes'

/** 构图卡片跟随已采用截图的画幅，和仍在编辑的场景画幅分开。 */
export function watchStageAspect(doc: PleinDoc) {
  const check = (id: string) => {
    const el = doc.get(id)
    if (el?.kind !== 'node' || el.nodeType !== STAGE_TYPE) return
    const adopted = currentResult(el, 'image')
    if (!adopted) return
    // 只校验当前采用的一条来源，避免拖动卡片时反复解析全部历史场景。
    const records = el.params?.snapshots
    const source = StageSnapshot.safeParse(
      Array.isArray(records) ? records.find((s) => s?.resultId === adopted.id) : undefined,
    )
    if (source.success) fitAspect(doc, id, aspectRatio(source.data.scene.aspect))
  }
  for (const el of doc.elements()) check(el.id)
  return doc.subscribe((change) => {
    for (const id of change.elements) check(id)
  })
}
