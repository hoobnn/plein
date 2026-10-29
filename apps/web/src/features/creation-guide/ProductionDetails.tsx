import {
  appendProductionDecision,
  confirmProductionContent,
  currentProductionConfirmation,
  currentProductionDecisions,
  productionContentSnapshot,
  type CanvasElement,
  type PleinDoc,
  type ProductionDecision,
} from '@plein/doc'
import { shotsOf } from '@plein/capabilities'
import { planVersion } from '@plein/nodes'
import { useState } from 'react'
import { useSession } from '../../stores/session'
import type { GuideFacts } from './facts'

/** 正式记录仅由当前界面的明确操作产生，操作人始终读取当前 session。 */
export function ProductionDetails({
  doc,
  canvasId,
  board,
  writable,
  readCurrent,
  onError,
}: {
  doc: PleinDoc
  canvasId: string
  board: CanvasElement
  writable: boolean
  readCurrent(): GuideFacts | null
  onError(message: string): void
}) {
  const [category, setCategory] = useState<ProductionDecision['category']>('style')
  const [subject, setSubject] = useState('整体风格')
  const [value, setValue] = useState('')
  const [note, setNote] = useState('')
  const validRows =
    Array.isArray(board.params?.shots) && shotsOf(board).length === board.params.shots.length
  const confirmation = validRows ? currentProductionConfirmation(board, canvasId) : undefined
  const history = board.production?.confirmations ?? []
  const decisions = board.production?.decisions ?? []
  const currentDecisions = currentProductionDecisions(board, canvasId)
  const actor = () => {
    const principal = useSession.getState().info?.principal
    return principal && principal.role !== 'viewer' && !doc.readOnly ? principal.id : undefined
  }
  const status = (scope: { canvasId: string; boardId: string }, historical?: boolean) =>
    historical || scope.canvasId !== canvasId || scope.boardId !== board.id
      ? '历史范围，待重新核实'
      : '当前范围'
  return (
    <section
      aria-label="制作记录"
      className="flex flex-col gap-2 border-t border-line pt-2 text-2xs"
    >
      {!confirmation && validRows && productionContentSnapshot(board) && (
        <button
          type="button"
          className="ui-btn ui-btn-secondary ui-btn-sm"
          disabled={!writable}
          onClick={() => {
            const current = readCurrent()
            const userId = actor()
            if (!current?.board || !current.planSignature || !userId) return
            if (
              !confirmProductionContent(doc, {
                scope: { canvasId, boardId: current.board.id },
                expectedSnapshot: current.planSignature,
                version: planVersion(current.shots),
                userId,
              })
            )
              onError('分镜内容已变化，请重新核对后确认')
            else onError('')
          }}
        >
          我已人工核对这份分镜
        </button>
      )}
      <details>
        <summary className="cursor-pointer text-ink-muted">说明</summary>
        <p className="mt-1 text-ink-subtle">
          内容核对不授权执行。代表镜头的可用结论继续记录在具体候选的创作验收中。
        </p>
      </details>
      {!writable && (
        <p role="status" className="text-ink-subtle">
          当前只读：可查看制作记录，不能保存确认或选择。
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-ink-muted">
          分镜核对历史（{history.length}）
        </summary>
        <ul className="mt-2 flex flex-col gap-2" aria-label="分镜核对历史">
          {history.map((record) => (
            <li key={record.id} className="break-words text-ink-subtle">
              {record.id === confirmation?.id
                ? '当前内容已核对'
                : status(record.scope, record.historical) === '当前范围'
                  ? record.snapshot === productionContentSnapshot(board)
                    ? '同内容的旧核对'
                    : '内容已变化，待重新核对'
                  : '历史范围，待重新核实'}{' '}
              · {record.version}
              <br />
              {record.actor.userId} · 界面操作 · {new Date(record.at).toLocaleString()}
              <br />
              <span title={`${record.scope.canvasId} / ${record.scope.boardId}`}>
                来源 {record.scope.canvasId} / {record.scope.boardId}
              </span>
            </li>
          ))}
          {!history.length && (
            <li className="text-ink-subtle">尚无文档内的人工核对记录；旧本机标记不作为确认。</li>
          )}
        </ul>
      </details>
      <details>
        <summary className="cursor-pointer text-ink-muted">制作决策（{decisions.length}）</summary>
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-ink-subtle">
            记录模型、风格等选择及修订理由；保存不会修改模型或发起生成。
          </p>
          <label className="ui-field">
            <span className="ui-label">决策类型</span>
            <select
              aria-label="决策类型"
              className="ui-input"
              disabled={!writable}
              value={category}
              onChange={(event) =>
                setCategory(event.target.value as ProductionDecision['category'])
              }
            >
              <option value="style">风格</option>
              <option value="model">模型</option>
              <option value="other">其他</option>
            </select>
          </label>
          <label className="ui-field">
            <span className="ui-label">决策对象</span>
            <input
              aria-label="决策对象"
              className="ui-input"
              disabled={!writable}
              maxLength={120}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </label>
          <label className="ui-field">
            <span className="ui-label">本次选择</span>
            <input
              aria-label="本次选择"
              className="ui-input"
              disabled={!writable}
              maxLength={2000}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <label className="ui-field">
            <span className="ui-label">修订理由</span>
            <textarea
              aria-label="修订理由"
              className="ui-input"
              disabled={!writable}
              maxLength={2000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
            disabled={!writable || !subject.trim() || !value.trim()}
            onClick={() => {
              const current = readCurrent()
              const userId = actor()
              if (!current?.board || !userId) return
              if (
                appendProductionDecision(doc, {
                  scope: { canvasId, boardId: current.board.id },
                  userId,
                  category,
                  subject,
                  value,
                  note,
                })
              ) {
                setValue('')
                setNote('')
                onError('')
              }
            }}
          >
            保存为新修订
          </button>
          <ul aria-label="制作决策历史" className="flex flex-col gap-2">
            {decisions.map((record) => (
              <li key={record.id} className="break-words text-ink-subtle">
                {record.subject}：{record.value} ·{' '}
                {currentDecisions.some((r) => r.id === record.id)
                  ? '当前选择'
                  : status(record.scope, record.historical) === '当前范围'
                    ? '旧修订'
                    : '历史范围，待重新核实'}
                <br />
                {record.note && (
                  <>
                    {record.note}
                    <br />
                  </>
                )}
                {record.actor.userId} · 界面操作 · {new Date(record.at).toLocaleString()}
              </li>
            ))}
          </ul>
        </div>
      </details>
    </section>
  )
}
