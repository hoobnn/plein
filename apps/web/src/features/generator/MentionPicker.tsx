import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react'
import { assetUrls } from '../../api/client'
import { Icon, type IconName } from '../../ui/icons'
import { Popover } from '../../ui/Popover'

export interface MentionChoice {
  key: string
  name: string
  insert: string
  category: 'image' | 'video' | 'audio' | 'asset'
  description: string
  thumbnail?: string
  poster?: boolean
  used: boolean
}
export interface MentionPickerHandle {
  handleKey(event: KeyboardEvent): void
}
const CATEGORIES: Array<{ id: MentionChoice['category']; label: string; icon: IconName }> = [
  { id: 'image', label: '图片', icon: 'image' },
  { id: 'video', label: '视频', icon: 'video' },
  { id: 'audio', label: '音频', icon: 'audio' },
  { id: 'asset', label: '资产', icon: 'folder' },
]

/** 查询只改变候选列表；选定后才替换正文中的 @ 查询，避免搜索污染草稿。 */
export function MentionPicker({
  ref,
  anchor,
  query,
  choices,
  onPick,
  onClose,
}: {
  ref: Ref<MentionPickerHandle>
  anchor: HTMLElement
  query: string
  choices: MentionChoice[]
  onPick(insert: string): void
  onClose(): void
}) {
  const [search, setSearch] = useState(query)
  const [category, setCategory] = useState<MentionChoice['category'] | null>(null)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    setSearch(query)
    setActive(0)
  }, [query])
  const q = search.trim().toLowerCase()
  const filtered = choices.filter(
    (c) =>
      (!category || c.category === category) &&
      `${c.name} ${c.insert} ${c.description}`.toLowerCase().includes(q),
  )
  const home = !category && !q
  const items = home ? filtered.filter((c) => c.used) : filtered
  const total = items.length + (home ? CATEGORIES.length : 0)
  const choose = (i: number) => {
    const item = items[i]
    if (item) onPick(item.insert)
    else if (home && CATEGORIES[i - items.length]) {
      setCategory(CATEGORIES[i - items.length]!.id)
      setActive(0)
    }
  }
  const handleKey = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && total) {
      event.preventDefault()
      setActive((i) => (i + (event.key === 'ArrowDown' ? 1 : -1) + total) % total)
    } else if (
      ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) || event.key === 'Tab') &&
      total
    ) {
      event.preventDefault()
      choose(Math.min(active, total - 1))
    }
  }
  useImperativeHandle(ref, () => ({ handleKey }))
  useLayoutEffect(() => {
    root.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <Popover anchor={anchor} label="引用素材" onClose={onClose} width={300} initialFocus={false}>
      <div
        ref={root}
        role="group"
        aria-label="素材选择"
        className="flex flex-col gap-2 p-1"
        onKeyDown={handleKey}
      >
        <div className="flex items-center gap-2 rounded-lg border border-line px-2">
          <Icon name="search" size={16} />
          <input
            aria-label="搜索引用素材"
            placeholder="搜索"
            value={search}
            className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
            onChange={(e) => {
              setSearch(e.target.value)
              setActive(0)
            }}
          />
        </div>
        {category && (
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-quiet justify-start"
            onClick={() => {
              setCategory(null)
              setSearch('')
              setActive(0)
            }}
          >
            <Icon name="chevronLeft" size={14} />
            {CATEGORIES.find((c) => c.id === category)!.label}
          </button>
        )}
        <div role="listbox" aria-label="引用资产" className="ui-scrollbar max-h-72 overflow-y-auto">
          {home && items.length > 0 && <div className="ui-menu-label">已引用</div>}
          {items.map((item, i) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={i === active}
              className="ui-menu-item"
              title={`${item.name} · ${item.description}`}
              onPointerDown={(e) => e.preventDefault()}
              onPointerEnter={() => setActive(i)}
              onClick={() => onPick(item.insert)}
            >
              {item.thumbnail ? (
                <img
                  src={assetUrls.variant(item.thumbnail, item.poster ? 'poster' : 'thumb-256')}
                  alt=""
                  className="size-7 shrink-0 rounded-md object-cover"
                />
              ) : (
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-2">
                  <Icon name={CATEGORIES.find((c) => c.id === item.category)!.icon} size={16} />
                </span>
              )}
              <span className="ui-menu-text">
                <span className="truncate">{item.name}</span>
                <span className="ui-menu-desc truncate">{item.description}</span>
              </span>
            </button>
          ))}
          {home && (
            <>
              <div className="ui-menu-label">素材引用</div>
              {CATEGORIES.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={active === items.length + i}
                  className="ui-menu-item"
                  onPointerDown={(e) => e.preventDefault()}
                  onPointerEnter={() => setActive(items.length + i)}
                  onClick={() => choose(items.length + i)}
                >
                  <Icon name={c.icon} />
                  <span className="flex-1">{c.label}</span>
                  <Icon name="chevronRight" size={14} />
                </button>
              ))}
            </>
          )}
          {!home && !items.length && (
            <p className="px-3 py-5 text-center text-xs text-ink-subtle">
              {q ? '没有匹配的素材' : '暂无可引用素材'}
            </p>
          )}
        </div>
      </div>
    </Popover>
  )
}
