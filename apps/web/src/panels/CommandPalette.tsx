import { CapabilityError } from '@plein/capabilities'
import type { PluginCapabilityInfo } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api } from '../api/client'
import { queryKeys } from '../api/query'
import { type LocalCapability, localCapabilities, localContext } from '../canvas/capabilities'
import { useAgent } from '../stores/agent'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { Icon, type IconName } from '../ui/icons'
import { shortcut } from '../ui/keys'
import { Mascot } from '../ui/Mascot'
import { Modal } from '../ui/Modal'
import { Presence } from '../ui/Presence'

const ICONS: Record<string, IconName> = {
  duplicate_elements: 'copy',
  group_elements: 'group',
  ungroup: 'ungroup',
  arrange_elements: 'arrange',
  reorder_elements: 'layers',
  place_drama_template: 'story',
  extract_cast: 'character',
  expand_storyboard: 'board',
}

/** 能力在面板里显示的部分：浏览器里跑的自带能力，或服务端跑的插件能力 */
type Command =
  | { kind: 'local'; cap: LocalCapability; input: Record<string, unknown> }
  | { kind: 'plugin'; cap: PluginCapabilityInfo }

type Item = { kind: 'cap'; command: Command } | { kind: 'agent'; text: string }

/** 命令说明的第一句：列表里只放得下一行 */
const brief = (text: string) => text.split(/[。：]/)[0] ?? text

/**
 * ⌘K 命令面板：列出对当前选区可用的能力（与智能体同一套），参数从选区来；
 * 搜不到想要的，回车把这句话交给小满去做。
 */
export function CommandPalette({ canvasId }: { canvasId: string | null }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  return (
    <Presence>{open && <Palette canvasId={canvasId} onClose={() => setOpen(false)} />}</Presence>
  )
}

function Palette({ canvasId, onClose }: { canvasId: string | null; onClose(): void }) {
  const engine = useCanvas((s) => s.engine)
  const catalog = useCatalog((s) => s.catalog)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  // 打开那一刻的选区：面板开着时画布不会变
  const selection = useMemo(() => [...(engine?.selection.values() ?? [])], [engine])
  // 插件能力在服务端跑，只有连着服务端的画布才能用
  const { data: plugins } = useQuery({
    queryKey: queryKeys.capabilities,
    queryFn: api.capabilities,
    enabled: !!canvasId,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const commands = useMemo<Command[]>(() => {
    if (!engine) return []
    const local = localCapabilities.list().flatMap((cap): Command[] => {
      const input = cap.palette?.fromSelection(selection, engine.doc)
      return input ? [{ kind: 'local', cap, input: input as Record<string, unknown> }] : []
    })
    const remote = (canvasId ? (plugins ?? []) : []).flatMap((cap): Command[] =>
      cap.palette === 'always' || (cap.palette === 'selection' && selection.length)
        ? [{ kind: 'plugin', cap }]
        : [],
    )
    return [...local, ...remote]
  }, [engine, selection, plugins, canvasId])

  const q = query.trim()
  const items = useMemo<Item[]>(() => {
    const hits = commands.filter(
      ({ cap }) => !q || cap.title.includes(q) || cap.name.includes(q.toLowerCase()),
    )
    const out: Item[] = hits.map((command) => ({ kind: 'cap', command }))
    if (q && canvasId) out.push({ kind: 'agent', text: q })
    return out
  }, [commands, q, canvasId])

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const run = async (item: Item) => {
    onClose()
    if (!engine) return
    const { notify } = useCanvas.getState()
    if (item.kind === 'agent') {
      const agent = useAgent.getState()
      agent.toggle(true)
      await agent.send(item.text, selection)
      return
    }
    const command = item.command
    if (command.kind === 'plugin') return runPlugin(command.cap)
    const { cap, input } = command
    // 一条命令单独算一步撤销，不和前后紧挨着的编辑合并
    engine.doc.undo.stopCapturing()
    try {
      const result = await localCapabilities.invoke(cap.name, localContext(engine, catalog), input)
      engine.doc.undo.stopCapturing()
      reveal(result)
    } catch (err) {
      notify(err instanceof CapabilityError ? err.message : `${cap.title}失败`)
    }
  }

  /** 插件能力在服务端执行；改了画布的，提示里给一个“撤销”整次撤回 */
  const runPlugin = async (cap: PluginCapabilityInfo) => {
    if (!canvasId) return
    const { notify } = useCanvas.getState()
    try {
      const out = await api.callCapability(canvasId, cap.name, { selection })
      let result: unknown = out.result
      try {
        result = JSON.parse(out.result)
      } catch {}
      reveal(result)
      const said =
        typeof result === 'string'
          ? result
          : typeof (result as { note?: unknown })?.note === 'string'
            ? (result as { note: string }).note
            : `${cap.title}：完成`
      const undo = out.undo
      notify(
        said.slice(0, 120),
        undo
          ? {
              label: '撤销',
              run: () =>
                api.undoCapabilityCall(undo).catch((err) => {
                  notify(err instanceof ApiError ? err.message : '撤销失败')
                }),
            }
          : undefined,
      )
    } catch (err) {
      notify(err instanceof ApiError ? err.message : `${cap.title}失败`)
    }
  }

  /** 新建的选中并高亮，铺出的分组带镜头过去；有提示语就显示 */
  const reveal = (result: unknown) => {
    if (!engine || !result || typeof result !== 'object') return
    const r = result as Record<string, unknown>
    const ids = [
      ...(typeof r.id === 'string' ? [r.id] : []),
      ...(Array.isArray(r.frames) ? r.frames : []),
      ...(typeof r.frame_id === 'string' ? [r.frame_id] : []),
      ...(Array.isArray(r.ids) ? r.ids : []),
      ...(Array.isArray(r.created) ? r.created : []),
    ].filter((v): v is string => typeof v === 'string')
    if (ids.length) {
      engine.selection.set(ids)
      engine.flash(ids)
      if (Array.isArray(r.frames) || Array.isArray(r.created)) engine.flyTo(ids)
    }
    if (typeof r.notice === 'string') useCanvas.getState().notify(r.notice)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = items.length
      if (n) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[active]
      if (item) void run(item)
    }
  }

  const scope = selection.length ? `选中的 ${selection.length} 个元素` : '整个画布'
  return (
    <Modal
      label="命令面板"
      onClose={onClose}
      isolateKeys
      className="plein-palette max-w-140 self-start sm:mt-[12vh]"
    >
      <div className="flex items-center gap-2 border-b border-line px-4">
        <span className="text-ink-subtle">
          <Icon name="search" />
        </span>
        <input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- 打开面板就是为了输入
          autoFocus
          className="h-13 min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-subtle"
          placeholder={canvasId ? '搜索命令，或直接告诉小满要做什么…' : '搜索命令…'}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded
          aria-controls="plein-palette-list"
          aria-activedescendant={items.length ? `plein-palette-${active}` : undefined}
        />
        <span className="flex-none text-2xs text-ink-subtle">{scope}</span>
      </div>
      <div
        ref={list}
        id="plein-palette-list"
        role="listbox"
        aria-label="命令"
        className="flex max-h-[min(420px,60vh)] flex-col overflow-y-auto p-2"
      >
        {items.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-ink-subtle">
            {selection.length ? '没有适用于选区的命令' : '先选中元素，或输入你想做的事'}
          </p>
        )}
        {items.map((item, i) => (
          <div
            key={item.kind === 'cap' ? `${item.command.kind}:${item.command.cap.name}` : 'agent'}
            id={`plein-palette-${i}`}
            data-index={i}
            role="option"
            aria-selected={i === active}
            tabIndex={-1}
            className="plein-palette-item ui-menu-item cursor-pointer"
            style={{ '--i': i } as React.CSSProperties}
            onPointerMove={() => setActive(i)}
            onClick={() => void run(item)}
            onKeyDown={() => {}}
          >
            {item.kind === 'cap' ? (
              <>
                <span className="flex size-7 flex-none items-center justify-center plein-palette-icon rounded-md bg-hover text-ink-muted">
                  <Icon
                    name={
                      ICONS[item.command.cap.name] ??
                      (item.command.kind === 'plugin' ? 'puzzle' : 'sparkle')
                    }
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{item.command.cap.title}</span>
                  <span className="truncate text-2xs text-ink-subtle">
                    {brief(item.command.cap.description)}
                  </span>
                </span>
                {item.command.kind === 'local' && item.command.cap.palette?.shortcut && (
                  <kbd className="ui-keycap flex-none">
                    {shortcut(item.command.cap.palette.shortcut)}
                  </kbd>
                )}
                {item.command.kind === 'plugin' && (
                  <span className="flex-none text-2xs text-ink-subtle">
                    {item.command.cap.plugin}
                  </span>
                )}
              </>
            ) : (
              <>
                <span className="flex size-7 flex-none items-center justify-center">
                  <Mascot mood="idle" size={26} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">让小满来做</span>
                  <span className="truncate text-2xs text-ink-subtle">「{item.text}」</span>
                </span>
                <kbd className="ui-keycap flex-none">{shortcut('enter')}</kbd>
              </>
            )}
          </div>
        ))}
      </div>
    </Modal>
  )
}
