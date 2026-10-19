import type { Engine } from '@plein/canvas-core'
import { useDocVersion } from '../../canvas/hooks'
import { planDiffs, shotsOf, syncExpanded } from './model'
import { type ShotRole, type SyncMode, voiceOf } from '@plein/nodes'
import { useState } from 'react'
import { useCanvas } from '../../stores/canvas'
import { Modal, ModalHeader } from '../../ui/Modal'
import { storyboardLabels } from './sourceLabels'
import { EmptyState } from '../../ui/EmptyState'
import { useCatalog } from '../../stores/catalog'
import { voicePresets } from '../../ui/VoicePicker'

const ROLE_LABEL: Record<ShotRole, string> = {
  image: '分镜图',
  video: '视频',
  speech: '配音',
  sfx: '音效',
}
const PARAM_LABEL: Record<string, string> = {
  prompt: '提示词',
  duration: '时长',
  text: '台词',
  voice: '音色',
  instruction: '语气指令',
}

const diffSnapshot = (
  shots: Array<{ id: string; no: number }>,
  diffs: ReturnType<typeof planDiffs>,
  ids: string[],
) =>
  JSON.stringify(
    shots
      .filter((s) => ids.includes(s.id) && diffs.has(s.id))
      .map((s) => [
        s.id,
        s.no,
        diffs.get(s.id)!.map((d) => [d.el.id, d.el.name, d.role, d.line, d.version, d.diffs]),
      ]),
  )

/** 参数值直接写进界面，空值说成「空」而不是留白 */
const show = (v: unknown) => {
  if (v !== null && typeof v === 'object') {
    // 音色是 { provider, voiceId }，直接 String 会显示成 [object Object]；预置音色显示名字
    const voice = voiceOf({ voice: v })
    const preset = voicePresets(useCatalog.getState().catalog).find(
      (p) => p.provider === voice.provider && p.id === voice.voiceId,
    )
    if (preset) return preset.label
    return voice.voiceId
      ? voice.provider
        ? `${voice.voiceId}（${voice.provider}）`
        : voice.voiceId
      : '（空）'
  }
  const text = String(v ?? '')
  return text.trim() ? text : '（空）'
}

/**
 * 计划与已展开节点的差异面板。
 * 分镜表改了之后这里列出「哪个节点的哪个字段」和计划不一致，默认什么都不做：
 * 要同步得按下面两个按钮之一，用户明确选了才写进节点。
 */
export function StoryboardSync({
  engine,
  boardId,
  shotIds,
  onClose,
  isCurrent,
}: {
  engine: Engine
  boardId: string
  shotIds: string[]
  onClose(): void
  /** 其他入口显式提供来源校验；默认仍归分镜编辑器所有。 */
  isCurrent?(): boolean
}) {
  useDocVersion(engine.doc)
  const notify = useCanvas((s) => s.notify)
  const canvasId = useCanvas((s) => s.canvasId)
  const [error, setError] = useState<string | null>(null)
  const source = storyboardLabels(engine.doc).get(boardId) ?? '已删除的分镜'
  const board = engine.doc.get(boardId)
  const shots = shotsOf(board)
  const diffs = planDiffs(engine, boardId)
  const rows = shots.filter((s) => shotIds.includes(s.id) && diffs.has(s.id))
  const displayed = diffSnapshot(shots, diffs, shotIds)

  const sync = (mode: SyncMode) => {
    const state = useCanvas.getState()
    if (
      state.engine !== engine ||
      state.canvasId !== canvasId ||
      (isCurrent ? !isCurrent() : state.storyboard !== boardId) ||
      engine.doc.get(boardId)?.nodeType !== 'plein/storyboard'
    )
      return
    if (engine.doc.readOnly) {
      setError('画布已变为只读，本次操作未执行')
      return
    }
    if (
      displayed !==
      diffSnapshot(shotsOf(engine.doc.get(boardId)), planDiffs(engine, boardId), shotIds)
    ) {
      setError('差异已变化，本次操作未执行；请核对更新后的内容再操作')
      return
    }
    if (!rows.length) return
    setError(null)
    let result!: ReturnType<typeof syncExpanded>
    engine.doc.undo.stopCapturing()
    try {
      engine.doc.ydoc.transact(() => {
        result = syncExpanded(engine, boardId, shotIds, mode)
      }, engine.doc.origin)
      engine.doc.flush()
    } catch (error) {
      setError(`操作失败：${(error as Error).message}`)
      return
    } finally {
      engine.doc.undo.stopCapturing()
    }
    const { nodes, fields, kept } = result
    if (mode === 'unmodified')
      notify(
        fields
          ? `已把计划同步到 ${nodes} 个节点的 ${fields} 个字段${kept ? `，保留 ${kept} 处手改` : ''}`
          : '没有可同步的字段（改动过的都留着手改）',
      )
    else notify(kept ? `已保留 ${kept} 处手改，这版差异记为已确认` : '已确认：节点按现状，不动参数')
  }

  const btn = 'ui-btn ui-btn-secondary'
  return (
    <Modal label="计划差异" onClose={onClose} isolateKeys className="max-w-150">
      <ModalHeader title="计划与节点的差异" onClose={onClose}>
        <button
          type="button"
          className={btn}
          disabled={!rows.length || engine.doc.readOnly}
          title="节点一个字段都不改，这版差异记为已确认、不再提示"
          onClick={() => sync('keep-overrides')}
        >
          不同步，按节点现状
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={!rows.length || engine.doc.readOnly}
          title="把分镜表的改动写进节点；你在节点上改过的字段保留"
          onClick={() => sync('unmodified')}
        >
          同步计划改动
        </button>
      </ModalHeader>
      <p
        data-testid="storyboard-source"
        title={source}
        className="min-w-0 flex-none truncate px-5 pt-3 text-xs text-ink-muted"
      >
        分镜：{source}
      </p>
      {error && (
        <p role="alert" className="flex-none px-5 pb-3 text-sm text-danger">
          {error}
        </p>
      )}
      {rows.length > 0 && (
        <p className="px-5 pb-3 text-xs text-ink-subtle">
          「同步计划改动」只改标着「计划已改」的字段，标着「你改过」的保留你的值；同步后的节点需要重新生成。
        </p>
      )}
      {rows.length === 0 ? (
        <EmptyState
          icon="check"
          title="没有待处理的差异"
          hint="分镜表改了之后，有出入的字段会出现在这里。"
        />
      ) : (
        <div className="ui-scrollbar min-h-0 overflow-auto px-5 pb-5">
          <ul className="flex flex-col gap-3">
            {rows.map((s) => (
              <li key={s.id} className="min-w-0 rounded-lg border border-line p-3">
                <p className="mb-2 text-xs font-medium text-ink-subtle">
                  镜头 {String(s.no).padStart(2, '0')}
                </p>
                <ul className="flex flex-col gap-2">
                  {(diffs.get(s.id) ?? []).map((d) => (
                    <li key={d.el.id} data-node-id={d.el.id} className="min-w-0 text-sm">
                      <p
                        className="truncate text-xs text-ink-muted"
                        title={[
                          d.el.name ?? ROLE_LABEL[d.role],
                          d.version ? `展开时的计划版本：${d.version}` : undefined,
                        ]
                          .filter(Boolean)
                          .join('\n')}
                      >
                        {d.el.name ?? ROLE_LABEL[d.role]}
                        {d.role === 'speech' && d.line !== undefined && ` · 第 ${d.line + 1} 句`}
                      </p>
                      <ul className="mt-1 flex flex-col gap-1">
                        {d.diffs.map((f) => (
                          <li
                            key={f.key}
                            aria-label={`${PARAM_LABEL[f.key] ?? f.key}差异`}
                            className="min-w-0 border-t border-line pt-2 first:border-t-0 first:pt-0"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-medium text-ink">
                                {PARAM_LABEL[f.key] ?? f.key}
                              </span>
                              {f.overridden ? (
                                <span className="ui-tag ui-tag-accent">你改过</span>
                              ) : (
                                <span className="ui-tag ui-tag-warning">计划已改</span>
                              )}
                              {f.legacy && <span className="ui-tag">没有展开快照</span>}
                            </div>
                            <dl className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">
                              {f.overridden && !f.legacy && (
                                <DiffValue label="展开时" value={f.expanded} wide />
                              )}
                              <DiffValue label="当前节点" value={f.actual} />
                              <DiffValue label="分镜计划" value={f.wanted} />
                            </dl>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  )
}

function DiffValue({
  label,
  value,
  wide = false,
}: {
  label: string
  value: unknown
  wide?: boolean
}) {
  return (
    <div className={`min-w-0 rounded-lg border border-line p-2 ${wide ? 'sm:col-span-2' : ''}`}>
      <dt className="mb-1 text-xs text-ink-subtle">{label}</dt>
      <dd className="m-0 min-w-0 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
        {show(value)}
      </dd>
    </div>
  )
}
