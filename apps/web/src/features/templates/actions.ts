import type { Engine } from '@plein/canvas-core'
import { templateData } from '../../canvas/groups'
import { ApiError } from '../../api/client'
import { useCanvas } from '../../stores/canvas'
import { useTemplates } from './store'
import { promptDialog } from '../../ui/Dialog'

/** 模板名称上限，与服务端一致；输入框就限制住，避免提交后才看到校验错误。 */
const MAX_TITLE = 60

/**
 * 存为模板：问一个名字，把分组存进「我的模板」。模板以分组为单位，
 * 不给 frameId 时先把当前选区打组再存（选区工具条上的入口）。
 */
export async function saveAsTemplate(engine: Engine, frameId: string | null, name: string) {
  const { canvasId, notify } = useCanvas.getState()
  const isCurrent = () => {
    const current = useCanvas.getState()
    return current.engine === engine && current.canvasId === canvasId
  }
  if (!isCurrent()) return
  const writable = () => {
    if (!engine.doc.readOnly) return true
    notify('当前画布只读，无法保存模板')
    return false
  }
  const expected = frameId ? [frameId] : engine.selection.values()
  const validTargets = () => {
    if (!expected.length || expected.some((id) => !engine.doc.has(id))) return false
    if (frameId) return engine.doc.get(frameId)?.kind === 'frame'
    const selected = engine.selection.values()
    return selected.length === expected.length && expected.every((id) => selected.includes(id))
  }
  const changed = () => notify('模板目标已变化，请重新选择后保存')
  if (!writable()) return
  if (!validTargets()) return changed()
  const title = await promptDialog({
    title: '存为模板',
    message: '存好后，双击画布空白处，在「我的模板」里找到它。',
    defaultValue: name,
    placeholder: '模板名称',
    confirmLabel: '保存',
    maxLength: MAX_TITLE,
  })
  if (!title) return
  if (!isCurrent() || !writable()) return
  if (!validTargets()) return changed()
  try {
    let frame = frameId
    if (!frame) {
      engine.groupSelection()
      frame = engine.selection.values()[0] ?? null
      if (!frame || engine.doc.get(frame)?.kind !== 'frame')
        throw new Error('无法创建模板分组，请重新选择后保存')
    }
    await useTemplates.getState().save(title, templateData(engine, frame))
    if (isCurrent())
      notify(`${frameId ? '已' : '已打组并'}存为模板「${title}」，双击空白处在“我的模板”里找到`)
  } catch (err) {
    if (!isCurrent()) return
    // 校验失败时服务端回的是原始校验结果，翻译成用户能照着改的说法。
    if (err instanceof ApiError && err.status === 400) return notify('模板内容不合法，请检查后重试')
    notify(err instanceof Error && err.message ? err.message : '模板没有存上，请重试')
  }
}
