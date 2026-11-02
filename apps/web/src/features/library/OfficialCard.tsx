import type { OfficialLibraryItem } from '@plein/nodes'

export function OfficialCard({
  item,
  canPlace,
  placing,
  onOpen,
  onPlace,
}: {
  item: OfficialLibraryItem
  canPlace: boolean
  placing: boolean
  onOpen(): void
  onPlace(): void
}) {
  return (
    <li data-library-id={item.id} className="home-card lib-card group relative">
      <button type="button" onClick={onOpen} className="lib-card-open block w-full text-left">
        <div className="plein-thumb flex aspect-[4/3] flex-col justify-end gap-1 p-3">
          <span className="ui-chip self-start">{Object.values(item.tags)[0]}</span>
          <span className="line-clamp-3 text-xs text-ink-muted">{item.description}</span>
        </div>
        <div className="px-3 py-3">
          <div className="truncate text-sm font-medium">{item.name}</div>
          <div className="truncate text-xs text-ink-subtle">官方 · 提示词</div>
        </div>
      </button>
      {canPlace && (
        <button
          type="button"
          onClick={onPlace}
          disabled={placing}
          className="ui-btn ui-btn-primary ui-btn-sm lib-card-place absolute bottom-16 left-1/2"
        >
          {placing ? '正在放入…' : '添加到画布'}
        </button>
      )}
    </li>
  )
}
