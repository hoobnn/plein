import {
  creativeReviewKey,
  creativeReviewTarget,
  getCreativeReview,
  recordCreativeReview,
  type CanvasElement,
  type CreativeReview,
  type CreativeReviewStatus,
  type CreativeReviewTarget,
  type PleinDoc,
} from '@plein/doc'
import { useState, useSyncExternalStore } from 'react'
import { useSession } from '../../stores/session'
import { useCanvas } from '../../stores/canvas'

export const reviewLabels: Record<CreativeReviewStatus, string> = {
  pending: '待审',
  usable: '可用',
  changes: '需修改',
}
/** 显示标签统一走 issueLabel，未登记的标签原样显示。 */
export const issueLabels: Record<string, string> = {
  character: '角色一致性',
  composition: '构图',
  motion: '动作',
  camera: '运镜',
  speech: '口型 / 台词',
  sound: '声音',
  continuity: '镜头衔接',
  'continuity-costume': '服装',
  'continuity-facing': '朝向',
  'continuity-position': '位置',
  'continuity-lighting': '光线',
  'continuity-action': '动作',
  other: '其他',
}
export const issueLabel = (tag: string) => issueLabels[tag] ?? tag

/** 镜头衔接的五个细分维度，挂在「镜头衔接」标签之下。 */
export const continuitySubTags = [
  'continuity-costume',
  'continuity-facing',
  'continuity-position',
  'continuity-lighting',
  'continuity-action',
] as const

export const isContinuityTag = (tag: string) =>
  tag === 'continuity' || (continuitySubTags as readonly string[]).includes(tag)

/** 「衔接需修改：服装、光线」；没有细分项时不列出。没有衔接标签返回 undefined。 */
export function continuityIssueText(tags: readonly string[]): string | undefined {
  if (!tags.some(isContinuityTag)) return undefined
  const items = continuitySubTags.filter((tag) => tags.includes(tag)).map(issueLabel)
  return `衔接需修改${items.length ? `：${items.join('、')}` : ''}`
}

const issues: ReadonlyArray<{
  tag: string
  children?: readonly string[]
}> = [
  { tag: 'character' },
  { tag: 'composition' },
  { tag: 'motion' },
  { tag: 'camera' },
  { tag: 'speech' },
  { tag: 'sound' },
  { tag: 'continuity', children: continuitySubTags },
  { tag: 'other' },
]

/** 采用决定下游使用哪个候选，创作验收只记录人对具体候选的判断。 */
export function CreativeReviewForm({
  doc,
  node,
  stale = false,
  defaultOpen = false,
  port,
  isCurrent,
}: {
  doc: PleinDoc
  node: CanvasElement
  stale?: boolean
  defaultOpen?: boolean
  /** 审片器按正在查看的输出端口记录；其他入口默认核对主输出。 */
  port?: string
  isCurrent?(): boolean
}) {
  const element = useSyncExternalStore(
    (notify) => doc.subscribe(notify),
    () => doc.elementMaps.get(node.id),
  )
  const [binding, setBinding] = useState({ doc, element, revision: 0 })
  if (binding.doc !== doc || binding.element !== element)
    setBinding({ doc, element, revision: binding.revision + 1 })
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const target = creativeReviewTarget(node, port)
  if (!target) return <p className="text-xs text-ink-subtle">有产物后可记录创作验收</p>
  const review = getCreativeReview(node, target)
  const targetKey = creativeReviewKey(target)
  return (
    <>
      {binding.revision > 0 && (
        <p role="status" className="mb-2 text-xs text-ink-muted">
          来源节点已变化，未保存的验收草稿已清除，请核对当前素材。
        </p>
      )}
      <ReviewDraft
        key={`${creativeReviewKey(target)}/${review?.at ?? 0}/${binding.revision}`}
        doc={doc}
        node={node}
        target={target}
        review={review}
        stale={stale}
        isCurrent={isCurrent}
        expanded={expanded[targetKey] ?? defaultOpen}
        onExpanded={(open) =>
          setExpanded((old) => (old[targetKey] === open ? old : { ...old, [targetKey]: open }))
        }
      />
    </>
  )
}

function ReviewDraft({
  doc,
  node,
  target,
  review,
  stale,
  expanded,
  onExpanded,
  isCurrent,
}: {
  doc: PleinDoc
  node: CanvasElement
  target: CreativeReviewTarget
  review?: CreativeReview
  stale: boolean
  expanded: boolean
  onExpanded(open: boolean): void
  isCurrent?(): boolean
}) {
  const principal = useSession((s) => s.info?.principal)
  const currentDoc = useCanvas((s) => s.engine?.doc === doc)
  const writable =
    !doc.readOnly &&
    currentDoc &&
    !!principal &&
    principal.role !== 'viewer' &&
    isCurrent?.() !== false
  const [element] = useState(() => doc.elementMaps.get(node.id))
  const [note, setNote] = useState(review?.note ?? '')
  const [tags, setTags] = useState(review?.tags ?? [])
  const [error, setError] = useState('')
  const status = review?.status ?? 'pending'
  const older =
    node.reviews?.filter((r) => creativeReviewKey(r.target) !== creativeReviewKey(target)) ?? []
  const save = (next: CreativeReviewStatus) => {
    const currentPrincipal = useSession.getState().info?.principal
    if (
      doc.readOnly ||
      useCanvas.getState().engine?.doc !== doc ||
      !currentPrincipal ||
      currentPrincipal.role === 'viewer' ||
      isCurrent?.() === false
    ) {
      setError('画布已变为只读或编辑权限已变化，本次验收未保存')
      return
    }
    if (doc.ydoc.isDestroyed || !element || doc.elementMaps.get(node.id) !== element) {
      setError('来源节点已变化，请重新核对素材后记录验收')
      return
    }
    if (!recordCreativeReview(doc, node.id, { target, status: next, tags, note }))
      setError('采用候选已改变，请重新打开此候选再记录验收')
  }
  return (
    <details
      open={expanded}
      onToggle={(event) => onExpanded(event.currentTarget.open)}
      className="rounded border border-line px-2 py-1.5 text-xs"
      data-review-node={node.id}
    >
      <summary
        className={`cursor-pointer font-medium ${status === 'changes' ? 'text-warning' : status === 'usable' ? 'text-success' : 'text-ink-muted'}`}
      >
        创作验收：{reviewLabels[status]}
        {stale ? ' · 输入已变化' : ''}
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="text-ink-subtle">
          {target.resultId ? `候选 ${target.resultId.slice(-8)}` : '当前素材'} ·
          此结论只针对这份产物，不改变采用项
        </p>
        {stale && (
          <p className="text-warning">输入已变化；以下结论只针对旧候选，请先核对产物与新要求。</p>
        )}
        <fieldset disabled={!writable} className="flex flex-wrap gap-x-3 gap-y-1">
          <legend className="mb-1 text-ink-muted">问题标签</legend>
          {issues.map(({ tag, children }) => (
            <div key={tag} className="inline-flex flex-col items-start gap-1 align-top">
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={tags.includes(tag)}
                  onChange={(e) =>
                    setTags(
                      e.target.checked ? [...tags, tag] : tags.filter((value) => value !== tag),
                    )
                  }
                />
                {issueLabel(tag)}
              </label>
              {children && (
                <div className="ml-5 flex flex-col gap-0.5">
                  {children.map((child) => (
                    <label key={child} className="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={tags.includes(child)}
                        onChange={(e) =>
                          setTags(
                            e.target.checked
                              ? [...tags, child]
                              : tags.filter((value) => value !== child),
                          )
                        }
                      />
                      {issueLabel(child)}
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </fieldset>
        <textarea
          aria-label={`创作验收备注 · ${node.name ?? node.id}`}
          rows={2}
          maxLength={2000}
          value={note}
          disabled={!writable}
          onChange={(e) => setNote(e.target.value)}
          placeholder="具体哪里需要调整，或为什么选这一版"
          className="ui-input w-full resize-y"
        />
        <div className="flex flex-wrap gap-1">
          {(['usable', 'changes', 'pending'] as const).map((value) => (
            <button
              type="button"
              key={value}
              disabled={!writable}
              className={`ui-btn ui-btn-xs ${value === status ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
              onClick={() => save(value)}
            >
              保存为{reviewLabels[value]}
            </button>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        {older.length > 0 && (
          <details className="text-ink-subtle">
            <summary className="cursor-pointer">其他产物的验收记录（{older.length}）</summary>
            {older.map((r) => (
              <p className="mt-1 whitespace-pre-wrap" key={creativeReviewKey(r.target)}>
                {r.target.resultId?.slice(-8) ?? r.target.assetId.slice(0, 8)} ·{' '}
                {reviewLabels[r.status]}
                {r.note ? `：${r.note}` : ''}
              </p>
            ))}
          </details>
        )}
      </div>
    </details>
  )
}
