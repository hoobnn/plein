import type { Engine } from '@plein/canvas-core'
import { templateData } from '../../canvas/groups'
import { useCanvas } from '../../stores/canvas'
import { useTemplates } from './store'
import { promptDialog } from '../../ui/Dialog'

/**
 * 存为模板：问一个名字，把分组存进「我的模板」。模板以分组为单位，
 * 不给 frameId 时先把当前选区打组再存（选区工具条上的入口）。
 */
export async function saveAsTemplate(engine: Engine, frameId: string | null, name: string) {
  const notify = useCanvas.getState().notify
  const title = await promptDialog({
    title: '存为模板',
    message: '存好后，双击画布空白处，在「我的模板」里找到它。',
    defaultValue: name,
    placeholder: '模板名称',
    confirmLabel: '保存',
  })
  if (!title) return
  let frame = frameId
  if (!frame) {
    engine.groupSelection()
    frame = engine.selection.values()[0] ?? null
    if (!frame || engine.scene.get(frame)?.kind !== 'frame') return
  }
  try {
    await useTemplates.getState().save(title, templateData(engine, frame))
    notify(`${frameId ? '已' : '已打组并'}存为模板「${title}」，双击空白处在“我的模板”里找到`)
  } catch (err) {
    notify((err as Error).message)
  }
}
