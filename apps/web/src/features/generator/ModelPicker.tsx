import type { Catalog } from '@plein/protocol'
import { useEffect, useState } from 'react'
import type { NodeInfo } from '../../canvas/nodes'
import { Icon } from '../../ui/icons'
import { Popover } from '../../ui/Popover'
import { Presence } from '../../ui/Presence'
import { ProviderIcon } from '../../ui/ProviderIcon'
import { SlidePill, SlideSwap } from '../../ui/Slide'
import { useSession } from '../../stores/session'
import { pushRecentModel, readRecentModels, recentModelsKey } from './recentModels'
import { deprecatedLast } from './deprecatedLast'

/** 模型选择：左栏选平台、右栏列该平台的模型。不替用户挑，没选时按钮提示去选 */
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
  const [query, setQuery] = useState('')
  const recentKey = recentModelsKey(useSession((s) => s.info?.principal?.id))
  // 会话是异步就绪的：挂载时读到的键可能还没带上用户 id，
  // 用户就绪后要按新键重读一次，否则「最近」一直空着。
  const [recent, setRecent] = useState<string[]>(() => readRecentModels(recentModelsKey(null)))
  useEffect(() => {
    setRecent(readRecentModels(recentKey))
  }, [recentKey])
  // remote-only 只有对话类能进生成器（宿主只对覆盖范围内的对话放开提交）；
  // 其他能力的通用模型参数未经确认，仅在设置的模型列表里展示。
  // 排序：内置在用在前，remote-only 随后（不会是弃用），已弃用置后
  const submittable = (m: Catalog['providers'][number]['models'][number]) =>
    !m.remoteOnly || m.capabilities.includes('text.chat')
  const providers = (catalog?.providers ?? [])
    .filter((p) => p.enabled && p.configured)
    .map((p) => ({
      ...p,
      models: deprecatedLast(
        p.models.filter(
          (m) => submittable(m) && (!node.capability || m.capabilities.includes(node.capability)),
        ),
      ),
    }))
    .filter((p) => p.models.length > 0)
  const current = providers
    .flatMap((p) =>
      p.models.map((m) => ({
        ref: `${p.id}:${m.id}`,
        title: m.title,
        provider: p.id,
        deprecated: m.deprecated,
        remoteOnly: m.remoteOnly,
        description: m.description,
      })),
    )
    .find((m) => m.ref === value)
  const pick = (v: string) => {
    setRecent(pushRecentModel(recentKey, v))
    onChange(v)
    setAnchor(null)
  }
  // 打开时停在当前模型所在的平台；没选时停在默认模型的平台
  const owner = value ? value.slice(0, value.indexOf(':')) : ''
  const fallback = node.capability ? (catalog?.defaultModels[node.capability] ?? '') : ''
  const home = owner || fallback.slice(0, fallback.indexOf(':'))
  const [tab, setTab] = useState(home)
  const shown = providers.find((p) => p.id === tab) ?? providers[0]
  const all = providers.flatMap((p) =>
    p.models.map((m) => ({ ...m, ref: `${p.id}:${m.id}`, provider: p.title })),
  )
  const q = query.trim().toLowerCase()
  const matches = all.filter((m) => `${m.provider} ${m.title} ${m.ref}`.toLowerCase().includes(q))

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
      <ProviderIcon provider={id} />
      <span className="ui-menu-text">
        <span className="truncate">{title}</span>
        {/* 当前模型所在的平台写明「使用中」，不另加标记 */}
        <span className="ui-menu-desc truncate">{owner === id ? `使用中 · ${sub}` : sub}</span>
      </span>
    </button>
  )
  const deprecatedTag = (description?: string) => (
    <span className="ui-tag flex-none text-ink-subtle" title={description}>
      已弃用
    </span>
  )
  // remote-only 带「新」徽标：与「已弃用」可以同时出现的场景不冲突（remote-only 不会是弃用，
  // 但两者共用同一渲染位置）
  const remoteOnlyTag = () => (
    <span className="ui-tag ui-tag-accent flex-none" title="平台新发现，参数为通用默认">
      新
    </span>
  )
  const option = (
    v: string,
    title: string,
    description?: string,
    model?: { deprecated?: true; remoteOnly?: boolean; description?: string },
  ) => (
    <button
      key={v}
      type="button"
      role="option"
      aria-selected={v === value}
      title={model?.description ?? description}
      onClick={() => pick(v)}
      className="ui-menu-item items-start"
    >
      <ProviderIcon provider={v.slice(0, v.indexOf(':'))} />
      <span className="ui-menu-text">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate">
            {title}
            {v === fallback ? ' · 默认' : ''}
          </span>
          {model?.remoteOnly && remoteOnlyTag()}
          {model?.deprecated && deprecatedTag(model.description)}
        </span>
        <span className="ui-menu-desc truncate">
          {model?.remoteOnly ? '平台新发现 · 参数为通用默认' : v}
        </span>
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
        title={current?.description ?? current?.title ?? '选择模型'}
        onClick={(e) => {
          setTab(home)
          setQuery('')
          setAnchor(anchor ? null : e.currentTarget)
        }}
        className="plein-generator-model ui-btn ui-btn-menu min-w-0"
      >
        {current ? <ProviderIcon provider={current.provider} /> : <Icon name="sparkle" />}
        <span className="min-w-0 text-left text-sm whitespace-nowrap">
          {current?.title ?? '选择模型'}
        </span>
        {current?.remoteOnly && remoteOnlyTag()}
        {current?.deprecated && deprecatedTag(current.description)}
        <Icon name="chevronDown" size={14} />
      </button>
      <Presence>
        {anchor && (
          <Popover anchor={anchor} onClose={() => setAnchor(null)} label="选择模型" width={460}>
            <input
              aria-label="搜索模型"
              placeholder="搜索平台、模型名称或 ID"
              className="ui-input mb-2 w-full"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {providers.length === 0 ? (
              <p className="px-2 py-3 text-xs text-ink-subtle">
                还没有可用的模型：在设置的「模型平台」里填写密钥并启用。
              </p>
            ) : q ? (
              <div
                role="listbox"
                aria-label="搜索结果"
                className="ui-scrollbar max-h-80 overflow-auto"
              >
                {matches.length ? (
                  matches.map((m) => option(m.ref, `${m.provider} · ${m.title}`, m.description, m))
                ) : (
                  <p className="p-3 text-xs text-ink-muted">没有匹配的模型</p>
                )}
              </div>
            ) : (
              <div>
                {recent.some((ref) => all.some((m) => m.ref === ref)) && (
                  <div
                    role="listbox"
                    aria-label="最近使用的模型"
                    className="mb-2 border-b border-line pb-2"
                  >
                    {recent.flatMap((ref) => {
                      const m = all.find((item) => item.ref === ref)
                      return m ? [option(m.ref, `最近 · ${m.title}`, m.provider, m)] : []
                    })}
                  </div>
                )}
                {/* 平台悬停会切换模型；高度不能跟随模型数量改变，否则上方弹层移动会再次触发悬停。 */}
                <div className="flex h-64 min-h-40 max-h-[40vh]">
                  <div
                    role="tablist"
                    aria-label="平台"
                    aria-orientation="vertical"
                    className="ui-slide ui-scrollbar flex w-40 flex-none flex-col gap-0.5 overflow-y-auto border-r border-line pr-1"
                  >
                    <SlidePill variant="menu" />
                    {providers.map((p) => railItem(p.id, p.title, `${p.models.length} 个模型`))}
                  </div>
                  <div
                    role="listbox"
                    aria-label={`${shown!.title} 的模型`}
                    className="ui-scrollbar flex min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pl-1"
                  >
                    {/* 平台是竖排的：模型列表按上下方向滑入 */}
                    <SlideSwap
                      index={providers.indexOf(shown!)}
                      axis="y"
                      className="flex flex-col gap-0.5"
                    >
                      {shown!.models.map((m) =>
                        option(`${shown!.id}:${m.id}`, m.title, m.description, m),
                      )}
                    </SlideSwap>
                  </div>
                </div>
              </div>
            )}
          </Popover>
        )}
      </Presence>
    </>
  )
}
