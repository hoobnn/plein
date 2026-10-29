import type { ShotScene } from './prepModel'

export function StoryboardPrepFilter({
  scenes,
  scene,
  missingOnly,
  shown,
  total,
  onScene,
  onScenePrep,
  onMissingOnly,
}: {
  scenes: ShotScene[]
  scene: string
  missingOnly: boolean
  shown: number
  total: number
  onScene(value: string): void
  onScenePrep?(): void
  onMissingOnly(value: boolean): void
}) {
  const filtered = !!scene || missingOnly
  return (
    <div
      role="group"
      aria-label="分镜显示筛选"
      className="flex flex-none flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-2 text-xs"
    >
      <label className="flex items-center gap-2">
        <span className="text-ink-muted">场景</span>
        <select
          aria-label="按场景筛选"
          className="ui-input max-w-56"
          value={scene}
          onChange={(event) => onScene(event.target.value)}
        >
          <option value="">全部场景</option>
          {scenes.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      {onScenePrep && (
        <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={onScenePrep}>
          场景准备
        </button>
      )}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={missingOnly}
          onChange={(event) => onMissingOnly(event.target.checked)}
        />
        只看有缺失的镜头
      </label>
      <span className="text-ink-subtle">
        显示 {shown} / {total} 镜{filtered ? ' · 全选仅选择可见镜头' : ''}
      </span>
    </div>
  )
}
