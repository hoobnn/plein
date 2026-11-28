import type { ExternalAction, ExternalContent, ExternalRow, ExternalState } from '@plein/protocol'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Select } from '../../ui/Select'

export const states: Record<ExternalState, string> = {
  'remote-only': '仅即梦有',
  'local-only': '仅 Plein 有',
  synced: '一致',
  'local-changed': 'Plein 已修改',
  'remote-changed': '即梦已修改',
  conflict: '双方均有修改',
  mergeable: '可合并',
  'missing-local': 'Plein 节点已移除',
  'missing-remote': '即梦节点已移除',
  pending: '待核对创建结果',
}
const kinds: Record<string, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
  scene: '场景',
  role: '角色',
  group: '分组',
  storyboard: '分镜',
  script: '剧本',
  resource: '素材',
}

const referenceUsage: Record<string, string> = {
  reference: '参考',
  firstFrame: '首帧',
  lastFrame: '尾帧',
}

export type ReviewScope = ExternalState | 'changed' | 'all'

// Keep the text between the first and last differing lines intact, including blank lines.
function changedPassage(local?: string, remote?: string) {
  if (!local || !remote || local === remote) return
  const a = local.split('\n')
  const b = remote.split('\n')
  const length = Math.min(a.length, b.length)
  let start = 0
  while (start < length && a[start] === b[start]) start++
  let end = 0
  while (end < length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++
  if (start + end < 4) return
  return {
    start,
    end,
    local: a.slice(start, a.length - end),
    remote: b.slice(start, b.length - end),
  }
}

function Content({
  label,
  value,
  id,
  action,
  excerpt,
}: {
  label: string
  value: ExternalContent | null
  id: string | null
  action?: ReactNode
  excerpt?: { start: number; end: number; lines: string[] }
}) {
  let body = value?.text || '（空正文）'
  if (excerpt) {
    body = excerpt.lines.length ? excerpt.lines.join('\n') || '（空行）' : '（此处无对应行）'
  }
  return (
    <section className="min-w-0 rounded-lg border border-line p-3" aria-label={label}>
      <h4 className="mb-2 text-xs font-medium text-ink-muted">{label}</h4>
      {value ? (
        <>
          <p className="font-medium wrap-anywhere">{value.title || '无标题'}</p>
          {!!excerpt?.start && (
            <p className="mt-2 text-xs text-ink-muted">前 {excerpt.start} 行相同</p>
          )}
          <p className="mt-2 max-h-56 overflow-auto text-sm whitespace-pre-wrap wrap-anywhere">
            {body}
          </p>
          {!!excerpt?.end && <p className="mt-1 text-xs text-ink-muted">后 {excerpt.end} 行相同</p>}
          {value.position && (
            <p className="mt-2 text-xs text-ink-muted">
              坐标 {value.position.x}, {value.position.y}
            </p>
          )}
        </>
      ) : (
        <p className="text-ink-muted">没有对应节点</p>
      )}
      {id && <p className="mt-3 font-mono text-xs text-ink-muted wrap-anywhere">{id}</p>}
      {action}
    </section>
  )
}

export function actionLabel(row: ExternalRow, action: ExternalAction) {
  if (action === 'merge') return '合并两端改动'
  if (action === 'pull') return row.local ? '用即梦版本更新 Plein' : '导入 Plein'
  if (action === 'push') return row.remote ? '用 Plein 版本更新即梦' : '在即梦创建'
  if (action === 'reconcile') return '关联已核对的节点'
  return row.state === 'pending' ? '已确认未创建，解除记录' : '解除关联'
}

export interface SourceNavigation {
  trail: {
    rowId: string
    title: string
    filter: string
    scope: ReviewScope
    referenceKey: string
    candidate: string
  }[]
  focusKey: string
  candidate?: string
}

export function RowDetails({
  row,
  rows,
  busy,
  onApply,
  onSource,
  onBack,
  onLocate,
  navigation,
  children,
}: {
  children?: ReactNode
  navigation: SourceNavigation | null
  onSource(source: ExternalRow, key: string, candidate: string): void
  onBack(): void
  onLocate(id: string): void
  row: ExternalRow
  rows: ExternalRow[]
  busy: boolean
  onApply(row: ExternalRow, action: ExternalAction, remoteId?: string): void
}) {
  const [candidate, setCandidate] = useState(navigation?.candidate ?? '')
  const [showFull, setShowFull] = useState(false)
  const detail = useRef<HTMLElement>(null)
  const previous = navigation?.trail.at(-1)
  useLayoutEffect(() => {
    if (!navigation || !detail.current) return
    const origin = Array.from(
      detail.current.querySelectorAll<HTMLButtonElement>('[data-reference-key]'),
    ).find((button) => button.dataset.referenceKey === navigation.focusKey)
    const destination = origin ?? detail.current.querySelector<HTMLElement>('h3')
    destination?.focus()
  }, [navigation])
  const choices =
    row.state === 'pending' && row.local
      ? rows.filter((r) => r.state === 'remote-only' && r.remoteId && r.kind === row.kind)
      : []
  const match = choices.find((r) => r.remoteId === candidate)
  const compared = match?.remote ?? row.remote
  const passage = changedPassage(row.local?.text, compared?.text)
  const folded = showFull ? undefined : passage
  const sources = new Map(
    rows.filter((r) => r.remote && r.remoteId && r.rowId !== row.rowId).map((r) => [r.remoteId, r]),
  )
  const occurrences = new Map<string, number>()
  const references = ((match ?? row).references ?? []).map((reference) => {
    const identity = JSON.stringify([reference.sourceId, reference.label, reference.usage])
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    return {
      ...reference,
      key: identity + ':' + occurrence,
      source: reference.sourceId ? sources.get(reference.sourceId) : undefined,
    }
  })
  return (
    <section ref={detail} className="min-w-0 p-4 sm:p-5" aria-label="节点差异">
      {previous && (
        <button type="button" className="ui-btn ui-btn-quiet ui-btn-sm mb-2" onClick={onBack}>
          返回「{previous.title}」
        </button>
      )}
      <h3 tabIndex={-1} className="font-semibold wrap-anywhere">
        {row.local?.title || row.remote?.title || '无标题'}
      </h3>
      <p className="mt-1 mb-4 text-xs text-ink-muted">
        {kinds[row.kind] ?? row.kind} · {states[row.state]}
      </p>
      {passage && (
        <button
          type="button"
          className="ui-btn ui-btn-quiet ui-btn-sm mb-2"
          aria-expanded={showFull}
          onClick={() => setShowFull(!showFull)}
        >
          {showFull ? '折叠首尾相同行' : '展开完整正文'}
        </button>
      )}
      <div className="grid items-start gap-2 lg:grid-cols-2">
        <Content
          label="Plein"
          value={row.local}
          id={row.localId}
          excerpt={folded && { start: folded.start, end: folded.end, lines: folded.local }}
          action={
            row.local &&
            row.localId && (
              <button
                type="button"
                className="ui-btn ui-btn-quiet ui-btn-sm mt-1"
                onClick={() => onLocate(row.localId!)}
              >
                定位到画布
              </button>
            )
          }
        />
        <Content
          label="即梦"
          value={compared}
          excerpt={folded && { start: folded.start, end: folded.end, lines: folded.remote }}
          id={match?.remoteId ?? row.remoteId}
        />
      </div>
      {row.state === 'mergeable' && row.merged && (
        <div className="mt-3">
          <Content label="合并结果预览" id={null} value={row.merged} />
        </div>
      )}
      {references.length > 0 && (
        <section className="mt-4" aria-label="即梦引用">
          <h4 className="text-sm font-medium">即梦引用</h4>
          <p className="my-1 text-xs text-ink-muted">写回时保留即梦的引用及顺序。</p>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {references.map((reference) => (
              <li key={reference.key} className="wrap-anywhere">
                {reference.source ? (
                  <button
                    type="button"
                    className="font-medium text-accent underline underline-offset-2"
                    aria-label={`查看来源「${reference.label}」`}
                    data-reference-key={reference.key}
                    onClick={() => {
                      if (reference.source) onSource(reference.source, reference.key, candidate)
                    }}
                  >
                    {reference.label}
                  </button>
                ) : (
                  reference.label
                )}
                {reference.usage && ` · ${referenceUsage[reference.usage] ?? reference.usage}`}
                {reference.sourceId && (
                  <span className="ml-2 font-mono text-xs text-ink-muted">
                    {reference.sourceId}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      {row.state === 'pending' && (
        <div className="mt-4 space-y-2">
          <p className="text-sm text-ink-muted">
            先在即梦画布核对创建结果。若已创建，请按节点 ID 选择对应项；确认没有副本后可解除记录。
          </p>
          {choices.length > 0 && (
            <Select
              aria-label="待核对的即梦节点"
              disabled={busy}
              value={candidate}
              className="max-w-full"
              options={[
                { value: '', label: '选择待核对的即梦节点' },
                ...choices.map((r) => ({
                  value: r.remoteId!,
                  label: `${r.remote?.title || '无标题'} · ${r.remoteId}`,
                })),
              ]}
              onChange={setCandidate}
            />
          )}
        </div>
      )}
      {(row.state === 'mergeable' || row.state === 'conflict') && (
        <p className="mt-4 text-xs text-ink-muted">
          {row.state === 'mergeable' && '合并会把预览结果写入两边。'}
          选用一侧版本会覆盖另一侧对应字段的改动。
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {row.actions.map((action) => (
          <button
            key={action}
            type="button"
            disabled={
              busy || (action === 'reconcile' && !match) || (action === 'merge' && !row.merged)
            }
            title={action === 'unlink' ? '保留两边节点，移除同步关系' : undefined}
            className={`ui-btn ui-btn-sm ${action === 'merge' ? 'ui-btn-primary' : action === 'unlink' ? 'ui-btn-quiet' : 'ui-btn-secondary'}`}
            onClick={() => onApply(row, action, action === 'reconcile' ? candidate : undefined)}
          >
            {actionLabel(row, action)}
          </button>
        ))}
      </div>
      {children}
    </section>
  )
}
