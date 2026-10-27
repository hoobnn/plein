import type { Engine } from '@plein/canvas-core'
import { type HistoryEntry, type NewElement, resultHistory } from '@plein/doc'
import { useEffect, useMemo, useRef, useState } from 'react'
import { assetUrls } from '../api/client'
import { useBatchDownload } from './useBatchDownload'
import { useDocVersion } from '../canvas/hooks'
import { elementFor, placeImports, revealImports } from '../canvas/import'
import { beginImport } from '../canvas/importProgress'
import { importLocation, watchImportView } from '../canvas/importView'
import { loadAssetMeta } from '../stores/assetMeta'
import { type NoticeAction, useCanvas } from '../stores/canvas'
import { shortTime } from '../ui/format'
import { Icon, type IconName } from '../ui/icons'
import { Modal, ModalHeader } from '../ui/Modal'
import { Segmented } from '../ui/Segmented'
import { Presence, useClosing } from '../ui/Presence'
import { EmptyState } from '../ui/EmptyState'

type MediaType = 'image' | 'video' | 'audio'
type TypeFilter = 'all' | MediaType

const TYPES: Array<{ id: TypeFilter; label: string; icon?: IconName }> = [
  { id: 'all', label: '全部' },
  { id: 'image', label: '图片', icon: 'image' },
  { id: 'video', label: '视频', icon: 'video' },
  { id: 'audio', label: '音频', icon: 'audio' },
]

const TYPE_LABEL: Record<MediaType, string> = { image: '图片', video: '视频', audio: '音频' }

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
 * 点一项先预览，在审片器中明确采用；批量选中后可下载或放到画布上。
 * 跨画布素材通过独立的“素材”入口检索。
 */
export function History() {
  const engine = useCanvas((s) => s.engine)
  const open = useCanvas((s) => s.history)
  return <Presence>{engine && open && <HistoryPanel engine={engine} />}</Presence>
}

function HistoryPanel({ engine }: { engine: Engine }) {
  const { toggleHistory: toggle } = useCanvas.getState()
  const closing = useClosing()
  const downloads = useBatchDownload(engine, !closing)
  const doc = engine.doc
  const version = useDocVersion(doc)
  // oxlint-disable react-hooks/exhaustive-deps -- version 变化即文档变化
  const all = useMemo(() => resultHistory(doc), [doc, version])
  // oxlint-enable react-hooks/exhaustive-deps
  const [type, setType] = useState<TypeFilter>('all')
  const [oldestFirst, setOldestFirst] = useState(false)
  const [size, setSize] = useState(160)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [placeError, setPlaceError] = useState<string | null>(null)
  const mounted = useRef(false)
  const close = () => toggle(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
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
  const retained = new Set([...picked].filter((key) => visible.has(key)))
  // 同步清掉状态里的旧身份，筛选返回或撤销恢复时不自动勾回已离开的结果。
  if (retained.size !== picked.size) setPicked(retained)
  const selected = shown.filter((e) => retained.has(keyOf(e)))
  const togglePick = (e: HistoryEntry) => {
    setPicked((previous) => {
      const next = new Set([...previous].filter((key) => visible.has(key)))
      const key = keyOf(e)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const nameOf = (e: HistoryEntry) => doc.get(e.elementId)?.name ?? TYPE_LABEL[e.result.value.type]

  const locate = (e: HistoryEntry) => {
    if (!doc.has(e.elementId)) return
    useCanvas
      .getState()
      .view({ kind: 'result', nodeId: e.elementId, resultId: e.result.id, name: nameOf(e) })
  }

  const download = () => {
    void downloads.start(
      selected.map((entry, i) => {
        const name = selected.length > 1 ? `${nameOf(entry)}-${i + 1}` : nameOf(entry)
        return { assetId: entry.result.value.assetId, name }
      }),
    )
  }

  const place = async () => {
    if (pending.current || closing || !selected.length || useCanvas.getState().engine !== engine)
      return
    if (doc.readOnly) {
      setPlaceError('当前画布只读，恢复编辑权限后再放入素材。')
      return
    }
    let batch: ReturnType<typeof beginImport> | undefined
    let view: ReturnType<typeof watchImportView> | undefined
    const notes: string[] = []
    let action: NoticeAction | undefined
    try {
      pending.current = true
      setBusy(true)
      setPlaceError(null)
      const active = beginImport(engine, selected.length)
      batch = active
      view = watchImportView(engine, active.signal)
      const viewport = engine.camera.viewRect
      let done = 0
      const inputs = await Promise.all(
        selected.map(async (e) => {
          const asset = await loadAssetMeta(e.result.value.assetId)
          active.progress(++done)
          const input = elementFor(asset, e.result.value.compositionSource)
          return input && { ...input, name: nameOf(e) }
        }),
      )
      active.signal.throwIfAborted()
      if (doc.readOnly) throw new Error('画布已变为只读，恢复编辑权限后再试')
      // 以视口中央为中心排成网格，每行 ROW 个，一次写入（一步撤销）
      const items = inputs.filter((i) => i !== null)
      const rows: Array<typeof items> = []
      for (let i = 0; i < items.length; i += ROW) rows.push(items.slice(i, i + ROW))
      const rowH = rows.map((r) => Math.max(...r.map((i) => i.h)))
      const c = viewport
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
      const created = placeImports(engine, list)
      if (mounted.current && view.unchanged()) {
        revealImports(engine, created)
        close()
      } else if (created.length) action = importLocation(engine, created)
      notes.push(`已放到画布上：${created.length} 个素材`)
    } catch (err) {
      if (!batch?.signal.aborted) {
        const message = `放入失败：${err instanceof Error ? err.message : '素材读取失败'}。选择已保留，请重试。`
        notes.push(message)
        if (mounted.current) setPlaceError(message)
      }
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
      view?.dispose()
      batch?.finish(notes, action)
    }
  }

  return (
    <Modal label="生成历史" onClose={close} isolateKeys className="h-[min(86vh,820px)] max-w-280">
      <ModalHeader
        title="生成历史"
        onClose={close}
        meta={
          <span className="ui-tag" title="这里查看本画布候选；跨画布检索请打开“素材”">
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
        <div className="flex items-center gap-2">
          <span className="hidden shrink-0 text-xs text-ink-subtle sm:block">类型</span>
          <Segmented
            label="类型"
            options={TYPES.map((t) => ({
              value: t.id,
              label: t.label,
              icon: t.icon,
              extra: counts[t.id],
            }))}
            value={type}
            onChange={setType}
          />
        </div>
      </div>

      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {shown.length === 0 ? (
          <EmptyState
            fill
            icon={all.length === 0 ? 'history' : 'filter'}
            title={
              all.length === 0 ? '本画布还没有生成过图片、视频或音频' : '没有符合筛选条件的结果'
            }
          />
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
                picked={retained.has(keyOf(e))}
                selecting={selected.length > 0}
                onPick={() => togglePick(e)}
                onOpen={() => locate(e)}
              />
            ))}
          </ul>
        )}
      </div>

      {(selected.length > 0 || downloads.total > 0) && (
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
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {downloads.running && (
              <button type="button" className="ui-btn ui-btn-quiet" onClick={downloads.cancel}>
                取消下载
              </button>
            )}
            {!downloads.running && downloads.remaining.length > 0 && (
              <button
                type="button"
                className="ui-btn ui-btn-quiet"
                onClick={() => void downloads.start(downloads.remaining)}
              >
                {downloads.cancelled ? '继续下载' : '重试未下载'}（{downloads.remaining.length}）
              </button>
            )}
            <button
              type="button"
              className="ui-btn ui-btn-secondary"
              disabled={downloads.running || !selected.length}
              onClick={download}
            >
              <Icon name="download" />
              {downloads.running
                ? `正在读取（${Math.min(downloads.done + downloads.failed + 1, downloads.total)}/${downloads.total}）`
                : '下载'}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={busy || !selected.length || doc.readOnly}
              onClick={() => void place()}
            >
              <Icon name="upload" />
              {busy ? '正在读取素材…' : '放到画布上'}
            </button>
          </div>
          {placeError && (
            <p role="alert" className="w-full text-xs text-danger">
              {placeError}
            </p>
          )}
          {downloads.total > 0 && !downloads.running && (
            <span
              role="status"
              className="w-full text-xs text-ink-muted"
              title={downloads.remaining.map((item) => item.name).join('、')}
            >
              {downloads.remaining.length
                ? `${downloads.remaining.length} 个文件${downloads.cancelled ? '未下载' : '读取失败'}`
                : `已交给浏览器下载 ${downloads.done} 个文件，请在浏览器中查看保存状态`}
            </span>
          )}
        </footer>
      )}
    </Modal>
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
  const preview = useRef<HTMLButtonElement>(null)
  const [load, setLoad] = useState({ src: props.thumb, attempt: 0, broken: false })
  const current = load.src === props.thumb ? load : { src: props.thumb, attempt: 0, broken: false }
  if (load.src !== props.thumb) setLoad(current)
  return (
    <li className="group relative flex flex-col gap-1.5">
      <div
        className={`relative aspect-square rounded-lg bg-surface-2 ${picked ? 'ring-2 ring-accent' : 'shadow-1 hover:shadow-2'}`}
      >
        <button
          ref={preview}
          type="button"
          aria-label={`${props.selecting ? '选择' : '预览'}「${props.name}」`}
          onClick={(e) =>
            props.selecting || e.metaKey || e.ctrlKey || e.shiftKey
              ? props.onPick()
              : props.onOpen()
          }
          title={props.selecting ? '选择' : '预览结果，审片确认后再采用'}
          className="relative flex size-full items-center justify-center overflow-hidden rounded-lg outline-offset-2"
        >
          {current.broken ? (
            <span
              role="img"
              aria-label={`「${props.name}」缩略图加载失败`}
              className="flex flex-col items-center gap-2 text-xs text-ink-subtle"
            >
              <Icon name={type} size={24} />
              缩略图加载失败
            </span>
          ) : (
            <img
              key={JSON.stringify([current.src, current.attempt])}
              src={current.src}
              alt=""
              loading="lazy"
              draggable={false}
              onError={() =>
                setLoad((old) =>
                  old.src === current.src && old.attempt === current.attempt
                    ? { ...old, broken: true }
                    : old,
                )
              }
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
            <span className="ui-badge absolute top-2 right-2 bg-primary text-on-primary">
              采用中
            </span>
          )}
        </button>
        {current.broken && (
          <button
            type="button"
            aria-label={`重新加载「${props.name}」缩略图`}
            title="只重新加载缩略图，不改变选择或采用结果"
            className="ui-btn ui-btn-xs ui-btn-quiet absolute right-2 bottom-2"
            onClick={() => {
              preview.current?.focus()
              setLoad((old) => ({ ...old, attempt: old.attempt + 1, broken: false }))
            }}
          >
            重试
          </button>
        )}
      </div>
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
