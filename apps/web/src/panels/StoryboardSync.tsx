import type { Engine } from '@plein/canvas-core'
import { useDocVersion } from '../canvas/hooks'
import { planDiffs, syncExpanded } from '../canvas/storyboard'
import { type ShotRole, type SyncMode, voiceOf } from '@plein/nodes'
import { useEffect } from 'react'
import { useCanvas } from '../stores/canvas'
import { Modal, ModalHeader } from '../ui/Modal'
import { EmptyState } from '../ui/EmptyState'

const ROLE_LABEL: Record<ShotRole, string> = { image: '分镜图', video: '视频', speech: '配音' }
const PARAM_LABEL: Record<string, string> = {
  prompt: '提示词',
  duration: '时长',
  text: '台词',
  voice: '音色',
}

/** 参数值直接写进界面，空值说成「空」而不是留白 */
const show = (v: unknown) => {
  if (v !== null && typeof v === 'object') {
    // 音色是 { provider, voiceId }，直接 String 会显示成 [object Object]
    const voice = voiceOf({ voice: v })
    return voice.voiceId
      ? voice.provider
        ? `${voice.voiceId}（${voice.provider}）`
        : voice.voiceId
      : '（空）'
  }
  const text = String(v ?? '').trim()
  return text || '（空）'
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
}: {
  engine: Engine
  boardId: string
  shotIds: string[]
  onClose(): void
}) {
  useDocVersion(engine.doc)
  const notify = useCanvas((s) => s.notify)
  useEffect(() => {
    // 分镜表浮层还开着时，本面板自己处理 Esc（见 StoryboardEditor 的按键拦截）
    const key = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])
  const board = engine.doc.get(boardId)
  const shots = board?.params?.shots as { id: string; no: number }[] | undefined
  const diffs = planDiffs(engine, boardId)
  const rows = (shots ?? []).filter((s) => shotIds.includes(s.id) && diffs.has(s.id))

  const sync = (mode: SyncMode) => {
    const { nodes, fields, kept } = syncExpanded(engine, boardId, shotIds, mode)
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
    <Modal label="计划差异" onClose={onClose} className="max-w-150">
      <ModalHeader title="计划与节点的差异" onClose={onClose}>
        <button
          type="button"
          className={btn}
          disabled={!rows.length}
          onClick={() => sync('unmodified')}
        >
          同步未改字段
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={!rows.length}
          onClick={() => sync('keep-overrides')}
        >
          保留用户覆盖
        </button>
      </ModalHeader>
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
              <li key={s.id} className="rounded-lg border border-line p-3">
                <p className="mb-2 text-xs font-medium text-ink-subtle">
                  镜头 {String(s.no).padStart(2, '0')}
                </p>
                <ul className="flex flex-col gap-2">
                  {(diffs.get(s.id) ?? []).map((d) => (
                    <li key={d.el.id} className="text-sm">
                      <p className="text-xs text-ink-muted">
                        {d.el.name ?? ROLE_LABEL[d.role]}
                        {d.role === 'speech' && d.line !== undefined && ` · 第 ${d.line + 1} 句`}
                        {d.version && (
                          <span className="ml-2 text-ink-subtle">展开于 {d.version}</span>
                        )}
                      </p>
                      <ul className="mt-1 flex flex-col gap-1">
                        {d.diffs.map((f) => (
                          <li
                            key={f.key}
                            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
                          >
                            <span className="w-12 shrink-0 text-ink-subtle">
                              {PARAM_LABEL[f.key]}
                            </span>
                            <span className="text-ink-muted line-through decoration-ink-subtle/50">
                              {show(f.expanded)}
                            </span>
                            <span aria-hidden="true" className="text-ink-subtle">
                              →
                            </span>
                            <span className="text-ink">
                              {show(f.overridden ? f.actual : f.wanted)}
                            </span>
                            {f.overridden ? (
                              <span className="ui-tag ui-tag-accent">你改过</span>
                            ) : (
                              <span className="ui-tag ui-tag-warning">计划已改</span>
                            )}
                            {f.legacy && <span className="ui-tag">没有展开快照</span>}
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
