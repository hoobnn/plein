import {
  appendProductionGoal,
  emptyProductionGoal,
  productionGoalHeads,
  sameProductionGoalScope,
  type PleinDoc,
  type ProductionGoal,
  type ProductionGoalScope,
  type ProductionGoalRevision,
  type ProductionRequirement,
} from '@plein/doc'
import { useState } from 'react'
import { useSession } from '../../stores/session'
import type { GuideFacts } from './facts'
import { ProductionGoalSummary, requirementLabels } from './ProductionGoalSummary'
import { goalScopeOf } from './productionGoalScope'

export function ProductionGoalEditor({
  doc,
  scope,
  heads,
  writable,
  readCurrent,
  onError,
}: {
  doc: PleinDoc
  scope: ProductionGoalScope
  heads: ProductionGoalRevision[]
  writable: boolean
  readCurrent(): GuideFacts | null
  onError(message: string): void
}) {
  const [draft, setDraft] = useState<ProductionGoal | null>(null)
  const [expectedHeads, setExpectedHeads] = useState<string[]>([])
  const patch = (value: Partial<ProductionGoal>) =>
    setDraft((current) => current && { ...current, ...value })
  const edit = (content = heads.length === 1 ? heads[0]!.content : emptyProductionGoal()) => {
    setDraft(JSON.parse(JSON.stringify(content)) as ProductionGoal)
    setExpectedHeads(heads.map((r) => r.id))
  }
  const number = (key: 'min' | 'max', value: string) =>
    patch({ duration: { ...draft?.duration, [key]: value === '' ? undefined : Number(value) } })
  return (
    <details className="border-t border-line pt-2">
      <summary className="cursor-pointer font-medium">编辑制作目标</summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="text-ink-subtle">保存只记录当前范围的制作要求，不修改序列设置或发起生成。</p>
        {heads.length > 1 && (
          <div role="status" className="text-warning">
            发现 {heads.length} 份并发修订，请核对后明确保存合并版本。
            {heads.map((r) => (
              <div key={r.id} className="mt-2 rounded border border-line p-2">
                <ProductionGoalSummary revision={r} />
                <button
                  className="ui-btn ui-btn-secondary ui-btn-sm mt-1"
                  type="button"
                  disabled={!writable}
                  onClick={() => edit(r.content)}
                >
                  以此版为草稿
                </button>
              </div>
            ))}
          </div>
        )}
        {!draft ? (
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
            disabled={!writable}
            onClick={() => edit()}
          >
            填写或修订制作目标
          </button>
        ) : (
          <>
            <label className="ui-field">
              <span className="ui-label">目标画幅</span>
              <select
                aria-label="目标画幅"
                className="ui-input"
                disabled={!writable}
                value={draft.aspectRatio ?? ''}
                onChange={(e) =>
                  patch({
                    aspectRatio: (e.target.value as ProductionGoal['aspectRatio']) || undefined,
                  })
                }
              >
                <option value="">未约定</option>
                <option>9:16</option>
                <option>16:9</option>
              </select>
            </label>
            <label className="ui-field">
              <span className="ui-label">目标分辨率</span>
              <select
                aria-label="目标分辨率"
                className="ui-input"
                disabled={!writable}
                value={draft.resolution ?? ''}
                onChange={(e) =>
                  patch({
                    resolution: (e.target.value as ProductionGoal['resolution']) || undefined,
                  })
                }
              >
                <option value="">未约定</option>
                <option>720p</option>
                <option>1080p</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(['min', 'max'] as const).map((key) => (
                <label className="ui-field" key={key}>
                  <span className="ui-label">
                    {key === 'min' ? '最短时长（秒）' : '最长时长（秒）'}
                  </span>
                  <input
                    aria-label={key === 'min' ? '目标最短时长' : '目标最长时长'}
                    type="number"
                    min="0.01"
                    max="86400"
                    step="any"
                    className="ui-input"
                    disabled={!writable}
                    value={draft.duration?.[key] ?? ''}
                    onChange={(e) => number(key, e.target.value)}
                  />
                </label>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(requirementLabels).map(([key, label]) => (
                <label className="ui-field" key={key}>
                  <span className="ui-label">{label}要求</span>
                  <select
                    aria-label={`目标${label}要求`}
                    className="ui-input"
                    disabled={!writable}
                    value={draft[key as keyof typeof requirementLabels]}
                    onChange={(e) => patch({ [key]: e.target.value as ProductionRequirement })}
                  >
                    <option value="unspecified">未约定</option>
                    <option value="required">需要</option>
                    <option value="none">不需要</option>
                  </select>
                </label>
              ))}
            </div>
            <label>
              <input
                type="checkbox"
                disabled={!writable}
                checked={draft.allowSilence}
                onChange={(e) => patch({ allowSilence: e.target.checked })}
              />{' '}
              允许有意静音
            </label>
            <label>
              <input
                type="checkbox"
                disabled={!writable}
                checked={draft.allowBlack}
                onChange={(e) => patch({ allowBlack: e.target.checked })}
              />{' '}
              允许有意黑场
            </label>
            <label className="ui-field">
              <span className="ui-label">文字创作要求</span>
              <textarea
                aria-label="文字创作要求"
                className="ui-input min-h-20"
                disabled={!writable}
                maxLength={4000}
                value={draft.requirements}
                placeholder="例如：递物过程清楚，人物关系可信；这些要求由人工审看。"
                onChange={(e) => patch({ requirements: e.target.value })}
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                className="ui-btn ui-btn-primary ui-btn-sm"
                disabled={!writable}
                onClick={() => {
                  const current = readCurrent()
                  const currentScope = current && goalScopeOf(current, scope.canvasId)
                  const actor = useSession.getState().info?.principal
                  if (!currentScope || !sameProductionGoalScope(scope, currentScope)) {
                    onError('制作目标范围已变化，请重新打开编辑')
                    return
                  }
                  if (doc.readOnly || !actor || actor.role === 'viewer') {
                    onError('当前只读，不能保存制作目标')
                    return
                  }
                  if (
                    JSON.stringify(
                      productionGoalHeads(current!.board, scope)
                        .map((r) => r.id)
                        .sort(),
                    ) !== JSON.stringify([...expectedHeads].sort())
                  ) {
                    onError('制作目标已有新修订，请重新载入后核对')
                    return
                  }
                  const saved = appendProductionGoal(doc, {
                    scope,
                    content: draft,
                    expectedHeads,
                    userId: actor.id,
                  })
                  if (!saved) onError('目标未保存：请检查时长范围和当前目标版本')
                  else {
                    setDraft(null)
                    onError('')
                  }
                }}
              >
                保存目标新版本
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                onClick={() => setDraft(null)}
              >
                放弃本次编辑
              </button>
            </div>
          </>
        )}
      </div>
    </details>
  )
}
