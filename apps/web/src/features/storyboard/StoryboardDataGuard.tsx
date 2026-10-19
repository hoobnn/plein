import type { Engine } from '@plein/canvas-core'
import { setParam } from '@plein/doc'
import type { ReactNode } from 'react'
import { useEngineVersion } from '../../canvas/hooks'
import { useCanvas } from '../../stores/canvas'
import { Modal, ModalHeader } from '../../ui/Modal'
import { restoreStoryboardRow, storyboardDataProblem } from './dataRecovery'

export function StoryboardDataGuard({
  engine,
  id,
  onClose,
  children,
}: {
  engine: Engine
  id: string
  onClose(): void
  children: ReactNode
}) {
  useEngineVersion(engine)
  const notify = useCanvas((s) => s.notify)
  const el = engine.doc.get(id)
  if (!el || el.nodeType !== 'plein/storyboard') return null
  const value = el.params?.shots
  const problem = storyboardDataProblem(value)
  if (!problem) return children
  const readOnly = engine.doc.readOnly
  const expected = JSON.stringify(value)
  const current = () => {
    const state = useCanvas.getState()
    return state.engine === engine && state.storyboard === id && !engine.doc.readOnly
  }
  const restore = (index?: number) => {
    if (!current()) return
    const latest = engine.doc.get(id)
    if (latest?.nodeType !== 'plein/storyboard') return
    const raw = latest.params?.shots
    if (JSON.stringify(raw) !== expected) {
      notify('分镜数据已变化，请检查当前问题后重试')
      return
    }
    const next =
      index === undefined
        ? storyboardDataProblem(raw)?.kind === 'list'
          ? []
          : undefined
        : restoreStoryboardRow(raw, index)
    if (!next) return
    engine.doc.undo.stopCapturing()
    setParam(engine.doc, id, 'shots', next)
    engine.doc.flush()
    engine.doc.undo.stopCapturing()
  }
  return (
    <Modal label="分镜数据问题" onClose={onClose} isolateKeys className="max-w-2xl">
      <ModalHeader title="分镜数据需要修复" onClose={onClose}>
        <button
          type="button"
          className="ui-btn"
          disabled={readOnly || !engine.doc.undo.undoStack.length}
          onClick={() => {
            if (current()) engine.undo()
          }}
        >
          撤销
        </button>
        <button
          type="button"
          className="ui-btn"
          disabled={readOnly || !engine.doc.undo.redoStack.length}
          onClick={() => {
            if (current()) engine.redo()
          }}
        >
          重做
        </button>
      </ModalHeader>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
        <p role="alert" className="break-words">
          {problem.kind === 'list'
            ? '镜头列表格式无效。'
            : `共 ${problem.count} 行，${problem.rows.map((row) => `第 ${row.index + 1} 行`).join('、')}需要修复。`}
          原始数据已保留，修复前暂停编辑与批量操作。
        </p>
        <p>恢复只修改指定的无效字段，其他行、画布节点和生成结果保留；恢复后可以撤销。</p>
        {readOnly && <p>当前画布为只读，暂不能恢复数据。</p>}
        {problem.kind === 'list' ? (
          <>
            <p>重置会将损坏的镜头列表清空，可通过撤销恢复原始数据。</p>
            <button
              type="button"
              className="ui-btn ui-btn-secondary self-start"
              disabled={readOnly}
              onClick={() => restore()}
            >
              重置镜头列表
            </button>
          </>
        ) : (
          <ul className="flex flex-col gap-4">
            {problem.rows.map((row) => (
              <li key={row.index} className="space-y-2 rounded-lg border border-line p-3">
                <h3 className="font-medium">
                  第 {row.index + 1} 行：{row.labels.join('、')}
                </h3>
                {row.replace && <p>该行不是有效镜头对象，将恢复为空白镜头并生成新标识。</p>}
                {row.fields.includes('id') && (
                  <p>将为这一行生成新镜头标识；已有素材仍关联原标识，请重新核对或展开关联。</p>
                )}
                {row.fields.includes('dialogue') && (
                  <p>该行台词列表会整体重置，其他行的台词保留。</p>
                )}
                {row.fields.includes('characters') && <p>该行出场元素列表会整体重置。</p>}
                {row.fields.includes('assetBindings') && (
                  <p>该行无效的元素绑定会清除，请重新核对引用。</p>
                )}
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary"
                  disabled={readOnly}
                  onClick={() => restore(row.index)}
                >
                  恢复第 {row.index + 1} 行无效字段
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
