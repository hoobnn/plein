import type { Engine } from '@plein/canvas-core'
import { planParams, SHOT_SIZES } from '@plein/nodes'
import { useState } from 'react'
import { useDocVersion } from '../../canvas/hooks'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { useSession } from '../../stores/session'
import { Modal, ModalHeader } from '../../ui/Modal'
import {
  applyControlDraft,
  buildControlDraft,
  CONTROL_FIELDS,
  EMPTY_CONTROLS,
  shotControlContext,
  type ControlDraft,
  type ControlField,
  type ControlRole,
  type ShotControls as Controls,
} from './shotControlModel'

const labels: Record<ControlField, string> = {
  imagePrompt: '分镜图提示词',
  motionPrompt: '运动提示词',
  lighting: '光影',
  shotSize: '景别',
}
const inputs: Array<[Exclude<keyof Controls, 'shotSize'>, string, string]> = [
  ['angle', '相机视角', '如：低机位仰拍，主体保持原姿态'],
  ['lens', '焦段意图', '如：广角空间感、长焦压缩感'],
  ['cameraMotion', '相机运动', '如：缓慢向右横移，主体不旋转'],
  ['subjectMotion', '主体动作', '如：主体向门口移动，相机保持固定'],
  ['lightPosition', '光源位置', '如：主体后方偏左的窗外'],
  ['lightDirection', '照射方向', '如：光线从左后方向右前方照射'],
  ['keep', '保持项', '如：人物身份、服装与道具状态保持'],
]

export function ShotControls({
  engine,
  canvasId,
  boardId,
  shotId,
  onClose,
  isCurrent,
}: {
  engine: Engine
  canvasId: string
  boardId: string
  shotId: string
  onClose(): void
  isCurrent?(): boolean
}) {
  useDocVersion(engine.doc)
  const catalog = useCatalog((s) => s.catalog)
  const principal = useSession((s) => s.info?.principal)
  const context = shotControlContext(engine.doc, boardId, shotId, catalog)
  const [controls, setControls] = useState<Controls>({ ...EMPTY_CONTROLS })
  const [role, setRole] = useState<ControlRole>('video')
  const [draft, setDraft] = useState<ControlDraft | null>(null)
  const [fields, setFields] = useState<ControlField[]>(['motionPrompt'])
  const [error, setError] = useState('')
  const writable = !!principal && principal.role !== 'viewer' && !engine.doc.readOnly
  const stale =
    !!draft &&
    (draft.signature !== context?.signature ||
      JSON.stringify(draft.controls) !== JSON.stringify(controls))
  const active = () => {
    const state = useCanvas.getState()
    const actor = useSession.getState().info?.principal
    return (
      state.engine === engine &&
      state.canvasId === canvasId &&
      (isCurrent ? isCurrent() : state.storyboard === boardId) &&
      !!actor &&
      actor.role !== 'viewer' &&
      !engine.doc.readOnly
    )
  }
  const generate = () => {
    if (!context || !active()) return setError('目标或可写状态已变化，请重新打开镜头控制')
    setDraft(buildControlDraft(context, role, controls))
    setFields([
      role === 'image' ? 'imagePrompt' : 'motionPrompt',
      ...(controls.lightPosition.trim() || controls.lightDirection.trim()
        ? ['lighting' as const]
        : []),
      ...(controls.shotSize ? ['shotSize' as const] : []),
    ])
    setError('')
  }
  const adopt = () => {
    if (
      !draft ||
      !active() ||
      !applyControlDraft(engine.doc, boardId, shotId, useCatalog.getState().catalog, draft, fields)
    )
      return setError('镜头、角色节点、模型或输入已变化，草稿未写入；请重新检查并生成草稿')
    useCanvas.getState().notify('已写入选定分镜字段；可在计划差异中检查并同步已展开节点')
    onClose()
  }
  return (
    <Modal label="镜头控制" onClose={onClose} top isolateKeys className="max-w-5xl">
      <ModalHeader
        title={`镜头控制${context ? ` · 镜头 ${context.shot.no}` : ''}`}
        onClose={onClose}
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
        {!context ? (
          <p role="alert">镜头已删除或分镜数据需要修复，请返回分镜表核对。</p>
        ) : (
          <>
            <p className="ui-help">
              先描述意图，再比较可编辑草稿。采用只修改勾选的分镜字段；生成仍从原有清单发起。
            </p>
            <section
              aria-label="通用创作方法"
              className="rounded-lg border border-line p-3 text-sm"
            >
              <h3 className="font-medium">通用创作方法</h3>
              <p className="mt-1 text-ink-muted">
                分别写清相机位置、相机运动和主体动作；分别描述光源在哪里、光往哪里照。焦段和角度是提示词意图，实际效果需要具体候选审片。
              </p>
            </section>
            <label className="ui-field">
              <span className="ui-label">建议用途</span>
              <select
                aria-label="建议用途"
                className="ui-input"
                value={role}
                onChange={(e) => {
                  setRole(e.target.value as ControlRole)
                  setDraft(null)
                }}
              >
                <option value="image">分镜图</option>
                <option value="video">视频运动</option>
              </select>
            </label>
            <details className="rounded-lg border border-line p-3" open>
              <summary className="cursor-pointer text-sm font-medium">
                当前用途的模型指南与能力
              </summary>
              {context.models[role].map((model, index) => (
                <div
                  key={model.nodeId ?? `future-${index}`}
                  className="mt-2 space-y-1 text-xs text-ink-muted"
                >
                  <p>
                    {model.future ? '未来新节点默认模型' : `已展开节点 ${model.nodeId}`}：
                    {model.info?.title || model.ref || '未设置'} {model.ref && `(${model.ref})`}
                  </p>
                  {!model.info ? (
                    <p>当前没有可用的模型声明，仅提供通用方法。</p>
                  ) : (
                    <>
                      {model.info.description && <p>{model.info.description}</p>}
                      {typeof model.info.promptGuide?.text === 'string' &&
                      typeof model.info.promptGuide.version === 'string' ? (
                        <p className="whitespace-pre-wrap" data-testid="model-prompt-guide">
                          指南版本 {model.info.promptGuide.version}：
                          {model.info.promptGuide.text.slice(0, 8000)}
                          {model.info.promptGuide.text.length > 8000 && '（显示前8000字）'}
                        </p>
                      ) : (
                        <p>此模型尚未提供专属提示词指南；以下仅是当前能力声明。</p>
                      )}
                      <details>
                        <summary className="cursor-pointer">查看声明的能力约束与专属参数</summary>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">
                          {JSON.stringify(
                            {
                              limits: model.info.limits ?? {},
                              options: model.info.optionsSchema ?? {},
                            },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    </>
                  )}
                </div>
              ))}
            </details>
            <div className="grid gap-3 sm:grid-cols-2">
              {inputs.map(([key, label, placeholder]) => (
                <label key={key} className="ui-field">
                  <span className="ui-label">{label}</span>
                  <input
                    aria-label={label}
                    className="ui-input"
                    value={controls[key]}
                    disabled={!writable || (role === 'image' && key === 'cameraMotion')}
                    maxLength={1000}
                    placeholder={placeholder}
                    onChange={(e) => setControls({ ...controls, [key]: e.target.value })}
                  />
                </label>
              ))}
              <label className="ui-field">
                <span className="ui-label">景别</span>
                <select
                  aria-label="控制景别"
                  className="ui-input"
                  disabled={!writable}
                  value={controls.shotSize}
                  onChange={(e) =>
                    setControls({ ...controls, shotSize: e.target.value as Controls['shotSize'] })
                  }
                >
                  <option value="">保留当前景别（{context.shot.shotSize}）</option>
                  {SHOT_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              type="button"
              className="ui-btn ui-btn-secondary"
              disabled={!writable}
              onClick={generate}
            >
              生成提示词草稿
            </button>
            {draft && (
              <section aria-label="控制草稿" className="space-y-3">
                {stale && (
                  <p role="alert" className="text-sm text-danger">
                    控制项、镜头、展开节点或模型已变化，当前草稿已过期。请重新生成并核对。
                  </p>
                )}
                <p className="ui-help">
                  勾选要写入的字段，建议可直接编辑。参考绑定、模型参数和其他镜头保持当前值。
                </p>
                {CONTROL_FIELDS.map((field) => (
                  <div key={field} className="rounded-lg border border-line p-3">
                    <label className="mb-2 flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        aria-label={`写入${labels[field]}`}
                        checked={fields.includes(field)}
                        disabled={!writable || stale}
                        onChange={(e) =>
                          setFields(
                            e.target.checked
                              ? [...fields, field]
                              : fields.filter((f) => f !== field),
                          )
                        }
                      />
                      写入{labels[field]}
                    </label>
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="ui-field">
                        <span className="ui-label">原{labels[field]}</span>
                        <textarea
                          readOnly
                          aria-label={`原${labels[field]}`}
                          className="ui-input min-h-20"
                          value={draft.baseShot[field]}
                        />
                      </label>
                      <label className="ui-field">
                        <span className="ui-label">建议{labels[field]}</span>
                        {field === 'shotSize' ? (
                          <select
                            aria-label={`建议${labels[field]}`}
                            className="ui-input"
                            disabled={!writable || stale}
                            value={draft.values.shotSize}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                values: {
                                  ...draft.values,
                                  shotSize: e.target.value as (typeof SHOT_SIZES)[number],
                                },
                              })
                            }
                          >
                            {SHOT_SIZES.map((size) => (
                              <option key={size} value={size}>
                                {size}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <textarea
                            aria-label={`建议${labels[field]}`}
                            className="ui-input min-h-20"
                            disabled={!writable || stale}
                            value={draft.values[field]}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                values: { ...draft.values, [field]: e.target.value },
                              })
                            }
                          />
                        )}
                      </label>
                    </div>
                  </div>
                ))}
                <details>
                  <summary className="cursor-pointer text-sm">查看选定字段组成的计划文字</summary>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                    {String(
                      planParams(
                        {
                          ...draft.baseShot,
                          ...Object.fromEntries(
                            fields.map((field) => [field, draft.values[field]]),
                          ),
                        },
                        role,
                      ).prompt ?? '',
                    )}
                  </pre>
                  <p className="ui-help">
                    资产引用仍按实际绑定解析。已展开节点的手改参数通过原有计划差异面板保留或同步。
                  </p>
                </details>
                <button
                  type="button"
                  className="ui-btn ui-btn-primary"
                  disabled={!writable || stale || !fields.length}
                  onClick={adopt}
                >
                  采用勾选字段
                </button>
              </section>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {!writable && (
          <p role="status" className="ui-help">
            当前只读，可以查看已有内容与模型声明。
          </p>
        )}
      </div>
    </Modal>
  )
}
