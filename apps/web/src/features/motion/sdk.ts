import { openComposition, type Composition, type EditOp } from '@hyperframes/sdk'
import { motionHtml, type MotionEditOperation, type MotionParams } from '@plein/nodes'

/** SDK 只解析可信模板；主页面不执行模板脚本，也不接受任意 HTML。 */
export const openMotionDocument = (params: MotionParams) =>
  openComposition(motionHtml(params), { history: false })

export function editMotionDocument(document: Composition, edit: MotionEditOperation) {
  const op: EditOp =
    edit.op === 'text'
      ? { type: 'setText', target: edit.id, value: edit.text }
      : edit.op === 'style'
        ? { type: 'setStyle', target: edit.id, styles: { [edit.property]: edit.value } }
        : {
            type: 'setTiming',
            target: edit.id,
            start: edit.start,
            duration: edit.end - edit.start,
            linked: false,
          }
  const allowed = document.can(op)
  if (!allowed.ok) throw new Error(allowed.message)
  document.dispatch(op, { origin: 'plein-motion-intent' })
}
