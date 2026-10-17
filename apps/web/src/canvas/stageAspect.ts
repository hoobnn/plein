import { currentResult, fitAspect, type PleinDoc } from '@plein/doc'
import { aspectRatio, STAGE_TYPE, stageSnapshotFor } from '@plein/nodes'

/** 构图卡片跟随已采用截图的画幅，和仍在编辑的场景画幅分开。 */
export function watchStageAspect(doc: PleinDoc) {
  const check = (id: string) => {
    const el = doc.get(id)
    if (el?.kind !== 'node' || el.nodeType !== STAGE_TYPE) return
    const adopted = currentResult(el, 'image')
    if (adopted?.value.type !== 'image') return
    const source = stageSnapshotFor(el.params, adopted.id)
    if (source?.assetId === adopted.value.assetId)
      fitAspect(doc, id, aspectRatio(source.scene.aspect))
  }
  for (const el of doc.elements()) check(el.id)
  return doc.subscribe((change) => {
    for (const id of change.elements) check(id)
  })
}
