import { Icon } from '../../ui/icons'
import type { PrepIssue, StoryboardPrep } from './prepModel'

export function ShotPrepCount({ shotNo, count }: { shotNo: number; count: number }) {
  if (!count) return null
  return (
    <span
      data-shot-prep-count=""
      className="inline-flex shrink-0 items-center gap-1 text-2xs font-normal text-warning"
      aria-label={`镜头 ${shotNo} 有 ${count} 项准备缺失`}
      title={`${count} 项准备缺失`}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {count}
    </span>
  )
}

/** ShotFlow 保留行结构，这里通过已有的行 ref 只增补展示徽标。 */
export function syncShotPrepCount(row: HTMLElement | null, shotNo: number, count: number) {
  const label = row?.querySelector('td:first-child label')
  if (!label) return
  let badge = label.querySelector<HTMLElement>('[data-shot-prep-count]')
  if (!count) {
    badge?.remove()
    return
  }
  if (!badge) {
    badge = document.createElement('span')
    badge.dataset.shotPrepCount = ''
    badge.className = 'inline-flex shrink-0 items-center gap-1 text-2xs font-normal text-warning'
    label.append(badge)
  }
  badge.setAttribute('aria-label', `镜头 ${shotNo} 有 ${count} 项准备缺失`)
  badge.title = `${count} 项准备缺失`
  badge.replaceChildren()
  const dot = document.createElement('span')
  dot.setAttribute('aria-hidden', 'true')
  dot.className = 'size-1.5 rounded-full bg-current'
  badge.append(dot, document.createTextNode(String(count)))
}

export function StoryboardPrepPanel({
  prep,
  folded,
  onToggleFold,
  onLocate,
}: {
  prep: StoryboardPrep
  folded: ReadonlySet<string>
  onToggleFold(key: string): void
  onLocate(issue: PrepIssue): void
}) {
  const groups = prep.shots.filter((shot) => shot.issues.length)
  const group = (key: string, title: string, issues: PrepIssue[]) => {
    const isFolded = folded.has(key)
    return (
      <section key={key} aria-label={title} className="rounded-lg border border-line bg-surface">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-hover"
          aria-expanded={!isFolded}
          onClick={() => onToggleFold(key)}
        >
          <Icon name={isFolded ? 'chevronRight' : 'chevronDown'} size={14} />
          <span className="font-medium">{title}</span>
          <span className="text-xs text-ink-subtle">{issues.length} 项</span>
        </button>
        {!isFolded && (
          <ul className="space-y-1 px-2 pb-2">
            {issues.map((issue) => (
              <li key={issue.id}>
                <button
                  type="button"
                  aria-label={`定位准备项：${issue.label}`}
                  className="ui-btn ui-btn-quiet h-auto min-h-8 w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left"
                  onClick={() => onLocate(issue)}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    {issue.category === 'source' && <span className="ui-tag">建议核对</span>}
                    {issue.category === 'review' && <span className="ui-tag">人工审核</span>}
                    <span>{issue.label}</span>
                  </span>
                  {issue.detail && (
                    <span className="line-clamp-2 text-xs font-normal whitespace-normal text-ink-subtle">
                      {issue.detail}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  }
  return (
    <section
      id="storyboard-prep-panel"
      aria-label="逐镜准备清单"
      className="ui-scrollbar max-h-80 flex-none space-y-2 overflow-y-auto border-b border-line bg-surface-2 p-3"
    >
      {!prep.count && <p className="px-1 py-2 text-sm text-success">所有镜头已准备就绪</p>}
      {groups.map((shot) =>
        group(shot.shotId, `镜头 ${String(shot.no).padStart(2, '0')}`, shot.issues),
      )}
      {!!prep.sourceIssues.length && group('source', '原文覆盖', prep.sourceIssues)}
      {prep.count > 0 && (
        <details className="px-1 text-xs text-ink-subtle">
          <summary className="cursor-pointer">说明</summary>
          <p className="mt-1">原文覆盖是核对建议；人工审核状态来自已有节点，不会自动判定通过。</p>
        </details>
      )}
    </section>
  )
}
