import type { Engine } from '@plein/canvas-core'
import {
  adoptResult,
  createElements,
  type HistoryEntry,
  type NewElement,
  resultHistory,
} from '@plein/doc'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { assetUrls } from '../api/client'
import { downloadAsset } from '../canvas/grid'
import { useDocVersion } from '../canvas/hooks'
import { elementFor } from '../canvas/import'
import { loadAssetMeta } from '../stores/assetMeta'
import { useCanvas } from '../stores/canvas'
import { shortTime } from '../ui/format'
import { Icon, type IconName } from '../ui/icons'
import { Modal, ModalHeader } from '../ui/Modal'
import { SlidePill } from '../ui/Slide'

type MediaType = 'image' | 'video' | 'audio'
type TypeFilter = 'all' | MediaType

const TYPES: Array<{ id: TypeFilter; label: string; icon?: IconName }> = [
  { id: 'all', label: '全部' },
  { id: 'image', label: '图片', icon: 'image' },
  { id: 'video', label: '视频', icon: 'video' },
  { id: 'audio', label: '音频', icon: 'audio' },
]

const TYPE_LABEL: Record<MediaType, string> = { image: '图片', video: '视频', audio: '音频' }

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
}

const SIZE_MIN = 96
const SIZE_MAX = 280
/** 一行最多放几个，超出换行 */
const ROW = 4
const GAP = 24

const keyOf = (e: HistoryEntry) => `${e.elementId}/${e.result.id}`

function thumbOf(e: HistoryEntry, size: number) {
  const { type, assetId } = e.result.value
  if (type === 'video') return assetUrls.variant(assetId, 'poster')
  if (type === 'audio') return assetUrls.variant(assetId, 'waveform')
  return assetUrls.variant(assetId, size * devicePixelRatio > 256 ? 'thumb-1024' : 'thumb-256')
}

/**
 * 生成历史：本画布所有节点的图片 / 视频 / 音频结果。
 * 按类型分栏计数、时间排序、调缩略图大小；
 * 点一项定位到所属节点并采用它，批量选中后可下载或放到画布上。
 * “全部画布”需要服务端结果索引，暂不支持。
 */
export function History() {
  const engine = useCanvas((s) => s.engine)
  const open = useCanvas((s) => s.history)
  if (!engine || !open) return null
  return <HistoryPanel engine={engine} />
}

function HistoryPanel({ engine }: { engine: Engine }) {
  const { toggleHistory: toggle, notify, setImporting } = useCanvas.getState()
  const doc = engine.doc
  const version = useDocVersion(doc)
  // biome-ignore lint/correctness/useExhaustiveDependencies: version 变化即文档变化
  const all = useMemo(() => resultHistory(doc), [doc, version])
  const [type, setType] = useState<TypeFilter>('all')
  const [oldestFirst, setOldestFirst] = useState(false)
  const [size, setSize] = useState(160)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const close = () => toggle(false)

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useCanvas.getState().toggleHistory(false)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  const counts = useMemo(() => {
    const c = { all: all.length, image: 0, video: 0, audio: 0 }
    for (const e of all) c[e.result.value.type]++
    return c
  }, [all])

  const shown = useMemo(() => {
    const list = all.filter((e) => type === 'all' || e.result.value.type === type)
    return oldestFirst ? list.reverse() : list
  }, [all, type, oldestFirst])

  // 结果被删或筛掉后，选择里只保留还看得见的
  const visible = new Set(shown.map(keyOf))
  const selected = shown.filter((e) => picked.has(keyOf(e)))
  const togglePick = (e: HistoryEntry) => {
    const next = new Set([...picked].filter((k) => visible.has(k)))
    const k = keyOf(e)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setPicked(next)
  }

  const nameOf = (e: HistoryEntry) => doc.get(e.elementId)?.name ?? TYPE_LABEL[e.result.value.type]

  const locate = (e: HistoryEntry) => {
    if (!doc.has(e.elementId)) return
    close()
    if (!e.adopted && !doc.readOnly) adoptResult(doc, e.elementId, e.result.id)
    engine.selection.set([e.elementId])
    engine.zoomToFit([e.elementId])
  }

  const download = async () => {
    for (const [i, e] of selected.entries()) {
      const ext = EXT[e.result.value.mime ?? '']
      const base = selected.length > 1 ? `${nameOf(e)}-${i + 1}` : nameOf(e)
      downloadAsset(e.result.value.assetId, ext ? `${base}.${ext}` : base)
      // 连续触发下载时留点间隔，浏览器才不会吞掉后面的
      await new Promise((ok) => setTimeout(ok, 250))
    }
  }

  const place = async () => {
    setBusy(true)
    setImporting({ done: 0, total: selected.length })
    try {
      let done = 0
      const inputs = await Promise.all(
        selected.map(async (e) => {
          const asset = await loadAssetMeta(e.result.value.assetId)
          setImporting({ done: ++done, total: selected.length })
          const input = elementFor(asset)
          return input && { ...input, name: nameOf(e) }
        }),
      )
      // 以视口中央为中心排成网格，每行 ROW 个，一次写入（一步撤销）
      const items = inputs.filter((i) => i !== null)
      const rows: Array<typeof items> = []
      for (let i = 0; i < items.length; i += ROW) rows.push(items.slice(i, i + ROW))
      const rowH = rows.map((r) => Math.max(...r.map((i) => i.h)))
      const c = engine.camera.viewRect
      let y = c.y + c.h / 2 - rowH.reduce((s, h) => s + h + GAP, -GAP) / 2
      const list: NewElement[] = []
      rows.forEach((row, ri) => {
        let x = c.x + c.w / 2 - row.reduce((s, i) => s + i.w + GAP, -GAP) / 2
        for (const i of row) {
          list.push({
            ...i,
            x: Math.round(x),
            y: Math.round(y + (rowH[ri]! - i.h) / 2),
          } as NewElement)
          x += i.w + GAP
        }
        y += rowH[ri]! + GAP
      })
      const created = list.length ? createElements(doc, list) : []
      engine.selection.set(created)
      close()
      notify(`已放到画布上：${created.length} 个素材`)
    } catch (err) {
      notify((err as Error).message)
    } finally {
      setImporting(null)
      setBusy(false)
    }
  }

  return (
    <Modal label="生成历史" onClose={close} isolateKeys className="h-[min(86vh,820px)] max-w-280">
      <ModalHeader
        title="生成历史"
        onClose={close}
        meta={
          <span className="ui-tag" title="“全部画布”需要服务端索引所有画布的结果，暂只支持本画布">
            本画布
          </span>
        }
      >
        <label className="flex items-center gap-2 text-ink-subtle" title="缩略图大小">
          <Icon name="board" size={14} />
          <input
            type="range"
            aria-label="缩略图大小"
            min={SIZE_MIN}
            max={SIZE_MAX}
            step={8}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            className="w-28"
          />
        </label>
        <button
          type="button"
          className="ui-btn ui-btn-quiet ui-btn-sm"
          onClick={() => setOldestFirst(!oldestFirst)}
          title="切换排序"
        >
          <Icon name={oldestFirst ? 'sortOldest' : 'sortNewest'} size={14} />
          {oldestFirst ? '最早在前' : '最新在前'}
        </button>
      </ModalHeader>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
        <Segmented label="类型">
          {TYPES.map((t) => (
            <SegButton key={t.id} active={type === t.id} onClick={() => setType(t.id)}>
              {t.icon && <Icon name={t.icon} size={14} />}
              {t.label}
              <span className="tabular-nums text-ink-subtle">{counts[t.id]}</span>
            </SegButton>
          ))}
        </Segmented>
      </div>

      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {shown.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-ink-subtle">
            <Icon name="history" size={24} />
            {all.length === 0 ? '本画布还没有生成过图片、视频或音频' : '没有符合筛选条件的结果'}
          </div>
        ) : (
          <ul
            className="grid gap-3"
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))` }}
          >
            {shown.map((e) => (
              <Card
                key={keyOf(e)}
                entry={e}
                name={nameOf(e)}
                thumb={thumbOf(e, size)}
                picked={picked.has(keyOf(e))}
                selecting={selected.length > 0}
                onPick={() => togglePick(e)}
                onOpen={() => locate(e)}
              />
            ))}
          </ul>
        )}
      </div>

      {selected.length > 0 && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3 text-sm">
          <span className="mr-1">已选 {selected.length} 项</span>
          <button
            type="button"
            className="ui-btn ui-btn-quiet ui-btn-sm"
            onClick={() => setPicked(new Set(shown.map(keyOf)))}
          >
            全选
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-quiet ui-btn-sm"
            onClick={() => setPicked(new Set())}
          >
            取消选择
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" className="ui-btn ui-btn-secondary" onClick={download}>
              <Icon name="download" />
              下载
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={busy || doc.readOnly}
              onClick={() => void place()}
            >
              <Icon name="upload" />
              放到画布上
            </button>
          </div>
        </footer>
      )}
    </Modal>
  )
}

function Segmented({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-ink-subtle">{label}</span>
      <div className="ui-seg ui-slide">
        <SlidePill variant="seg" />
        {children}
      </div>
    </div>
  )
}

function SegButton(props: { active: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={props.active}
      onClick={props.onClick}
      className="ui-seg-item"
    >
      {props.children}
    </button>
  )
}

function Card(props: {
  entry: HistoryEntry
  name: string
  thumb: string
  picked: boolean
  selecting: boolean
  onPick(): void
  onOpen(): void
}) {
  const { entry, picked } = props
  const { type } = entry.result.value
  const [broken, setBroken] = useState(false)
  return (
    <li className="group relative flex flex-col gap-1.5">
      <button
        type="button"
        onClick={(e) =>
          props.selecting || e.metaKey || e.ctrlKey || e.shiftKey ? props.onPick() : props.onOpen()
        }
        title={props.selecting ? '选择' : '定位到节点并采用这个结果'}
        className={`relative flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-surface-2 outline-offset-2 transition-shadow ${
          picked ? 'ring-2 ring-accent' : 'shadow-1 hover:shadow-2'
        }`}
      >
        {broken ? (
          <span className="text-ink-subtle">
            <Icon name={type} size={24} />
          </span>
        ) : (
          <img
            src={props.thumb}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => setBroken(true)}
            className={`h-full w-full ${type === 'audio' ? 'object-fill px-3' : 'object-contain'}`}
          />
        )}
        {type !== 'image' && (
          <span className="ui-badge absolute bottom-2 left-2">
            <Icon name={type} size={12} />
            {TYPE_LABEL[type]}
          </span>
        )}
        {entry.adopted && (
          <span className="ui-badge absolute top-2 right-2 bg-primary text-on-primary">采用中</span>
        )}
      </button>
      <input
        type="checkbox"
        aria-label={`选择「${props.name}」`}
        checked={picked}
        onChange={props.onPick}
        className={`absolute left-2 top-2 size-4 cursor-pointer ${
          picked || props.selecting
            ? ''
            : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
        }`}
      />
      <div className="min-w-0 px-0.5">
        <div className="truncate text-xs">{props.name}</div>
        <div className="whitespace-nowrap text-2xs text-ink-subtle">
          {shortTime(entry.result.at)}
        </div>
      </div>
    </li>
  )
}
