import type { Catalog } from '@plein/protocol'
import { useState } from 'react'
import type { NodeInfo } from '../../canvas/nodes'
import { Icon } from '../../ui/icons'
import { Popover } from '../../ui/Popover'
import { SlidePill, SlideSwap } from '../../ui/Slide'

/** 模型选择：左栏选平台、右栏列该平台的模型；“自动”交给服务端按能力挑 */
export function ModelPicker({
  value,
  node,
  catalog,
  onChange,
}: {
  value: string
  node: NodeInfo
  catalog: Catalog | null
  onChange(v: string): void
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const providers = (catalog?.providers ?? [])
    .filter((p) => p.enabled && p.configured)
    .map((p) => ({
      ...p,
      models: p.models.filter((m) => !node.capability || m.capabilities.includes(node.capability)),
    }))
    .filter((p) => p.models.length > 0)
  const current = providers
    .flatMap((p) => p.models.map((m) => ({ ref: `${p.id}:${m.id}`, title: m.title })))
    .find((m) => m.ref === value)
  const pick = (v: string) => {
    onChange(v)
    setAnchor(null)
  }
  // 打开时停在当前模型所在的平台
  const owner = value ? value.slice(0, value.indexOf(':')) : ''
  const [tab, setTab] = useState(owner)
  const shown = providers.find((p) => p.id === tab)

  const railItem = (id: string, title: string, sub: string) => (
    <button
      key={id}
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      onPointerEnter={() => setTab(id)}
      className="ui-menu-item"
    >
      <span className="ui-menu-text">
        <span className="truncate">{title}</span>
        {/* 当前模型所在的平台写明「使用中」，不另加标记 */}
        <span className="ui-menu-desc truncate">{owner === id ? `使用中 · ${sub}` : sub}</span>
      </span>
    </button>
  )
  const option = (v: string, title: string, description?: string) => (
    <button
      key={v}
      type="button"
      role="option"
      aria-selected={v === value}
      onClick={() => pick(v)}
      className="ui-menu-item items-start"
    >
      <span className="ui-menu-text">
        <span className="truncate">{title}</span>
        {description && <span className="ui-menu-desc line-clamp-2">{description}</span>}
      </span>
      {v === value && <Icon name="check" size={14} />}
    </button>
  )

  return (
    <>
      <button
        type="button"
        aria-label="模型"
        aria-expanded={!!anchor}
        title={current?.title ?? '自动选择模型'}
        onClick={(e) => {
          setTab(owner)
          setAnchor(anchor ? null : e.currentTarget)
        }}
        className="ui-btn ui-btn-lg ui-btn-menu min-w-0 max-w-48"
      >
        <Icon name="sparkle" />
        <span className="truncate">{current?.title ?? '自动'}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} label="选择模型" width={460}>
          {providers.length === 0 ? (
            <p className="px-2 py-3 text-xs text-ink-subtle">
              还没有可用的模型：在设置的「模型平台」里填写密钥并启用。
            </p>
          ) : (
            <div className="flex max-h-80 min-h-40">
              <div
                role="tablist"
                aria-label="平台"
                aria-orientation="vertical"
                className="ui-slide ui-scrollbar flex w-40 flex-none flex-col gap-0.5 overflow-y-auto border-r border-line pr-1"
              >
                <SlidePill variant="menu" />
                {railItem('', '自动', '按能力挑选')}
                {providers.map((p) => railItem(p.id, p.title, `${p.models.length} 个模型`))}
              </div>
              <div
                role="listbox"
                aria-label={shown ? `${shown.title} 的模型` : '自动选择'}
                className="ui-scrollbar flex min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pl-1"
              >
                {/* 平台是竖排的：模型列表按上下方向滑入 */}
                <SlideSwap
                  index={shown ? providers.indexOf(shown) + 1 : 0}
                  axis="y"
                  className="flex flex-col gap-0.5"
                >
                  {shown
                    ? shown.models.map((m) => option(`${shown.id}:${m.id}`, m.title, m.description))
                    : option('', '自动选择', '按节点能力使用第一个可用平台里的第一个模型')}
                </SlideSwap>
              </div>
            </div>
          )}
        </Popover>
      )}
    </>
  )
}
