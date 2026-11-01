import type { Engine } from '@plein/canvas-core'
import { renameElement } from '@plein/capabilities'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { promptDialog } from '../ui/Dialog'
import { outlineTitle } from './outline'

export function saveElementName(engine: Engine, id: string, name: string) {
  try {
    const result = renameElement(engine.doc, id, name)
    if (result.references)
      useCanvas.getState().notify(`名称已更新，已同步 ${result.references} 处引用`)
    return true
  } catch (error) {
    useCanvas.getState().notify(error instanceof Error ? error.message : '名称未保存')
    return false
  }
}

export async function requestElementRename(engine: Engine, id: string) {
  const element = engine.doc.get(id)
  if (!element || engine.doc.readOnly) return
  const identity = engine.doc.elementMaps.get(id)
  const expected = element.name
  await promptDialog({
    title: '重命名节点',
    message: '同步当前画布中的 @引用、参考素材名称与分镜资产名称。',
    defaultValue: outlineTitle(element, useCatalog.getState().catalog),
    confirmLabel: '保存并同步引用',
    maxLength: 200,
    onConfirm: async (name) => {
      if (useCanvas.getState().engine !== engine || engine.doc.elementMaps.get(id) !== identity)
        throw new Error('画布已切换或节点已删除，请重新选择节点')
      if (engine.doc.get(id)?.name !== expected)
        throw new Error('名称已在其他位置更新，请关闭后重新编辑')
      const result = renameElement(engine.doc, id, name)
      useCanvas
        .getState()
        .notify(result.references ? `名称已更新，已同步 ${result.references} 处引用` : '名称已更新')
    },
  })
}
