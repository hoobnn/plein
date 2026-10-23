import type { PleinDoc } from '@plein/doc'
import type { Transaction } from 'yjs'

const SCOPE = Symbol('motion-editor')
type Scope = { id: string; group: string | null }
type Item = PleinDoc['undo']['undoStack'][number]
type StackEvent = { stackItem: Item; origin: unknown; type: 'undo' | 'redo' }
class MotionEdit {
  constructor(readonly scope: Scope) {}
}
const scopeOf = (item: Item | undefined) => item?.meta.get(SCOPE) as Scope | undefined

/** 沿用画布的唯一撤销栈，只标记动态合成编辑，并在画布级撤销／重做时传递标记。 */
export function watchMotionHistory(doc: PleinDoc) {
  const undo = doc.undo
  undo.addTrackedOrigin(MotionEdit)
  const before = (tr: Transaction) => {
    const origin = tr.origin
    if (
      !(origin instanceof MotionEdit) &&
      origin !== undo &&
      scopeOf(undo.undoStack.at(-1)) &&
      (undo.trackedOrigins.has(origin) || (origin && undo.trackedOrigins.has(origin.constructor)))
    )
      undo.stopCapturing()
  }
  const changed = ({ stackItem, origin }: StackEvent) => {
    if (origin instanceof MotionEdit) stackItem.meta.set(SCOPE, origin.scope)
    else if (origin !== undo) stackItem.meta.delete(SCOPE)
  }
  const popped = ({ stackItem, type }: StackEvent) => {
    const target = (type === 'undo' ? undo.redoStack : undo.undoStack).at(-1)
    if (!target) return
    const scope = scopeOf(stackItem)
    if (scope) target.meta.set(SCOPE, scope)
    else target.meta.delete(SCOPE)
  }
  doc.ydoc.on('beforeTransaction', before)
  undo.on('stack-item-added', changed)
  undo.on('stack-item-updated', changed)
  undo.on('stack-item-popped', popped)
  return () => {
    undo.stopCapturing()
    doc.ydoc.off('beforeTransaction', before)
    undo.off('stack-item-added', changed)
    undo.off('stack-item-updated', changed)
    undo.off('stack-item-popped', popped)
    undo.removeTrackedOrigin(MotionEdit)
  }
}

/** 连续输入按字段归并，离散动作独立；不能和先前的画布操作合并。 */
export function writeMotionEdit(
  doc: PleinDoc,
  id: string,
  action: () => void,
  group: string | null = null,
  gesture = false,
) {
  const previous = scopeOf(doc.undo.undoStack.at(-1))
  const sameGroup = !!group && previous?.id === id && previous.group === group
  if (!sameGroup) doc.undo.stopCapturing()
  const timeout = doc.undo.captureTimeout
  // 同一指针手势允许停顿，不能越过其他字段、动态合成或画布操作；时间窗只在本次同步写入内调整。
  if (gesture && sameGroup) doc.undo.captureTimeout = Infinity
  try {
    doc.ydoc.transact(action, new MotionEdit({ id, group }))
  } finally {
    doc.undo.captureTimeout = timeout
    if (!group) doc.undo.stopCapturing()
  }
}

export function canMotionHistory(doc: PleinDoc, id: string, direction: 'undo' | 'redo') {
  return (
    !doc.readOnly &&
    scopeOf((direction === 'undo' ? doc.undo.undoStack : doc.undo.redoStack).at(-1))?.id === id
  )
}

export function applyMotionHistory(doc: PleinDoc, id: string, direction: 'undo' | 'redo') {
  if (!canMotionHistory(doc, id, direction)) return
  const stack = direction === 'undo' ? doc.undo.undoStack : doc.undo.redoStack
  // Yjs 会跳过已被协作更新覆盖的空操作。临时只提供当前一项，防止继续跳到其他画布操作。
  const prefix = stack.splice(0, stack.length - 1)
  try {
    doc.undo[direction]()
  } finally {
    for (const item of stack) prefix.push(item)
    stack.length = 0
    for (const item of prefix) stack.push(item)
  }
}
