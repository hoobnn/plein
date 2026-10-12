import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, currentResult } from '@plein/doc'
import { presetsFor } from '@plein/nodes'
import type {
  Asset,
  AssetKind,
  Catalog,
  MediaCapsInfo,
  MediaDerivation,
  MediaDeriveRequest,
} from '@plein/protocol'
import { useEffect, useRef, useState } from 'react'
import { assetUrls } from '../api/client'
import { downloadAsset, mediaOf, splitGrid } from '../canvas/grid'
import { useEngineVersion } from '../canvas/hooks'
import {
  applyDerivation,
  clampRange,
  clampSpeed,
  cropRect,
  evenSegments,
  formatTimecode,
  mediaCaps,
  opLabel,
  opsFor,
  parseTimecode,
  quickOpsFor,
  SPEEDS,
} from '../canvas/media'
import { deriveNode } from '../canvas/presets'
import { loadAssetMeta } from '../stores/assetMeta'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { Icon } from '../ui/icons'
import { Popover } from '../ui/Popover'
import { LibraryAdd } from './LibraryAdd'

const BAR_H = 40
const BOTTOM_RESERVED = 64

const GRIDS = [
  { rows: 2, cols: 2, label: '4 宫格' },
  { rows: 3, cols: 3, label: '9 宫格' },
  { rows: 4, cols: 4, label: '16 宫格' },
]

/** 能接图片输入的某类生成节点（同能力多个时取内置的） */
function nodeFor(catalog: Catalog | null, capability: string) {
  const list = (catalog?.nodes ?? []).filter(
    (n) => n.capability === capability && n.inputs.some((p) => p.type === 'image'),
  )
  return list.find((n) => n.type.startsWith('plein/')) ?? list[0]
}

/**
 * 选中画布上的图片 / 视频素材时浮在它下方的工具条。
 * 生成节点不用它：同样的操作放在节点下方生成器的第一行（见 ResultActions）。
 */
export function ResultBar() {
  const engine = useCanvas((s) => s.engine)
  if (!engine) return null
  return <ResultBarHost engine={engine} />
}

function ResultBarHost({ engine }: { engine: Engine }) {
  useEngineVersion(engine)
  const catalog = useCatalog((s) => s.catalog)
  const canvasId = useCanvas((s) => s.canvasId)
  const ids = engine.selection.values()
  const el = ids.length === 1 ? engine.scene.get(ids[0]!) : undefined
  // 生成节点的结果操作在生成器里；锁定的节点没有生成器，仍用浮动工具条
  const media = el && (el.kind !== 'node' || el.locked) ? mediaOf(el) : null
  // 加工工具要覆盖音频，所以另算一份只认资产类型的
  const asset = el && (el.kind !== 'node' || el.locked) ? mediaAsset(el) : null
  const rect = el && engine.scene.rect(el.id)
  if (!el || (!media && !asset) || !rect || engine.doc.readOnly) return null

  const bl = engine.worldToClient(rect.x, rect.y + rect.h)
  const br = engine.worldToClient(rect.x + rect.w, rect.y + rect.h)
  const top = Math.min(bl.y + 12, window.innerHeight - BOTTOM_RESERVED - BAR_H)
  const center = (bl.x + br.x) / 2
  return (
    <div
      key={el.id}
      role="toolbar"
      aria-label="结果操作"
      style={{ top, left: center }}
      className="ui-bar ui-bar-sm pointer-events-auto fixed z-20 w-max -translate-x-1/2"
    >
      {media && (
        <ResultActions
          engine={engine}
          el={el}
          media={media}
          catalog={catalog}
          remote={!!canvasId}
          variant="bar"
        />
      )}
      {asset && canvasId && (
        // key 跟着素材走：换选一个素材时把已读的元信息和打开的表单一起丢掉
        <MediaTools
          key={asset.assetId}
          engine={engine}
          target={{ elId: el.id, ...asset }}
          label="媒体工具"
        />
      )}
    </div>
  )
}

/**
 * 对结果的操作：预设 = 在右侧派生一个连好、填好提示词的新节点，确认后再生成；
 * 生成视频；宫格切分在本地完成；下载、全屏查看。
 * bar 用在素材的浮动工具条里，inline 用在生成器第一行。
 */
export function ResultActions({
  engine,
  el,
  media,
  catalog,
  remote,
  variant,
}: {
  engine: Engine
  el: CanvasElement
  media: { assetId: string; kind: 'image' | 'video' }
  catalog: Catalog | null
  remote: boolean
  variant: 'bar' | 'inline'
}) {
  const [open, setOpen] = useState<{ kind: 'presets' | 'grid'; anchor: HTMLElement } | null>(null)
  const { notify, setImporting, view } = useCanvas.getState()
  const imageNode = nodeFor(catalog, 'image.generate')
  const videoNode = nodeFor(catalog, 'video.generate')
  const presets = imageNode
    ? presetsFor(catalog?.prompts ?? [], imageNode).filter((p) =>
        p.appliesTo?.includes('image.generate'),
      )
    : []
  const name = el.name ?? (media.kind === 'image' ? '图片' : '视频')
  const toggle = (kind: 'presets' | 'grid') => (e: React.MouseEvent<HTMLButtonElement>) =>
    setOpen(open?.kind === kind ? null : { kind, anchor: e.currentTarget })

  const split = async (rows: number, cols: number) => {
    setOpen(null)
    setImporting({ done: 0, total: rows * cols })
    try {
      await splitGrid(engine, el.id, media.assetId, rows, cols, (done, total) =>
        setImporting({ done, total }),
      )
    } catch (err) {
      notify((err as Error).message)
    } finally {
      setImporting(null)
    }
  }

  // 浮动工具条里用工具条按钮；生成器第一行用 28 高的安静按钮，两处图标都是 14
  const btn = variant === 'inline' ? 'ui-btn ui-btn-sm ui-btn-quiet' : 'ui-bar-btn'
  const icon = variant === 'inline' ? `${btn} ui-icon-btn` : btn
  const image = media.kind === 'image'
  return (
    <>
      {image && imageNode && presets.length > 0 && (
        <button
          type="button"
          className={`${btn} ui-btn-menu`}
          aria-expanded={open?.kind === 'presets'}
          onClick={toggle('presets')}
          title="以这张图为参考，套用预设新建一个图片节点"
        >
          <Icon name="presets" size={14} />
          预设
          <Icon name="chevronDown" size={12} />
        </button>
      )}
      {image && videoNode && (
        <button
          type="button"
          className={btn}
          title="以这张图为首帧，新建一个视频节点"
          onClick={() =>
            deriveNode(engine, catalog, el.id, videoNode.type, { name: `${name} · 视频` })
          }
        >
          <Icon name="video" size={14} />
          生成视频
        </button>
      )}
      {image && remote && (
        <button
          type="button"
          className={`${btn} ui-btn-menu`}
          aria-expanded={open?.kind === 'grid'}
          onClick={toggle('grid')}
          title="把宫格图切成单张图片"
        >
          <Icon name="gridSplit" size={14} />
          宫格切分
          <Icon name="chevronDown" size={12} />
        </button>
      )}
      {remote && (
        <LibraryAdd media={[{ elId: el.id, ...media, name: el.name ?? '' }]} variant={variant} />
      )}
      {(remote || (image && (imageNode || videoNode))) && (
        <span aria-hidden="true" className="ui-bar-sep" />
      )}
      <button
        type="button"
        className={icon}
        aria-label="下载"
        title="下载原文件"
        onClick={() => downloadAsset(media.assetId, name)}
      >
        <Icon name="download" size={14} />
      </button>
      <button
        type="button"
        className={icon}
        aria-label="全屏查看"
        title="全屏查看"
        onClick={() => view({ ...media, name })}
      >
        <Icon name="expand" size={14} />
      </button>

      {open?.kind === 'presets' && imageNode && (
        <Popover anchor={open.anchor} onClose={() => setOpen(null)} label="预设" width={280}>
          <div className="ui-menu-label">以这张图为参考新建</div>
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className="ui-menu-item"
              onClick={() => {
                setOpen(null)
                deriveNode(engine, catalog, el.id, imageNode.type, { preset: p })
              }}
            >
              <span className="ui-menu-text">
                <span>{p.title}</span>
                {p.description && <span className="ui-menu-desc">{p.description}</span>}
              </span>
            </button>
          ))}
        </Popover>
      )}
      {open?.kind === 'grid' && (
        <Popover anchor={open.anchor} onClose={() => setOpen(null)} label="宫格切分" width={200}>
          {GRIDS.map((g) => (
            <button
              key={g.label}
              type="button"
              className="ui-menu-item justify-between"
              onClick={() => void split(g.rows, g.cols)}
            >
              {g.label}
              <span className="ui-kbd">
                {g.rows}×{g.cols}
              </span>
            </button>
          ))}
        </Popover>
      )}
    </>
  )
}

/** 元素背后的资产：加工工具要连音频一起覆盖，所以不限于 image / video */
export function mediaAsset(el: CanvasElement): { assetId: string; kind: AssetKind } | null {
  if (el.kind === 'node') {
    const v = currentResult(el)?.value
    return v && (v.type === 'image' || v.type === 'video' || v.type === 'audio')
      ? { assetId: v.assetId, kind: v.type }
      : null
  }
  if ((el.kind === 'image' || el.kind === 'video' || el.kind === 'audio') && el.assetId)
    return { assetId: el.assetId, kind: el.kind }
  return null
}

/** 一次加工的目标：一个画布元素 + 它背后的资产 */
export interface MediaTarget {
  elId: string
  assetId: string
  kind: AssetKind
}

/**
 * 加工过程中统一的提示与防重入：一轮（单个或批量）只提示一次。
 * 已有一轮在跑时返回 false，不算失败。
 */
function useDeriver(engine: Engine) {
  const notify = useCanvas((s) => s.notify)
  const [busy, setBusy] = useState(false)
  // 批量加工是一轮 await 循环，用 ref 挡重入才不会被同一帧里的多次点击打乱
  const running = useRef(false)
  const run = async (targets: MediaTarget[], make: (t: MediaTarget) => MediaDeriveRequest) => {
    if (running.current || !targets.length) return false
    running.current = true
    setBusy(true)
    const made: MediaDerivation[] = []
    const errors: string[] = []
    let op: MediaDeriveRequest['op'] | undefined
    try {
      for (const t of targets) {
        const input = make(t)
        op = input.op
        try {
          made.push(await applyDerivation(engine, input, t.elId))
        } catch (err) {
          errors.push((err as Error).message)
        }
      }
    } finally {
      running.current = false
      setBusy(false)
    }
    const one = made[0]
    if (targets.length === 1)
      notify(
        one && op
          ? `已${opLabel(op)}，新素材放在右边：${one.assets.map((a) => a.name).join('、')}${
              one.note ? `。${one.note}` : ''
            }`
          : (errors[0] ?? null),
      )
    else if (errors.length) notify(`${made.length} 个成功，${errors.length} 个失败：${errors[0]}`)
    else if (op) notify(`已${opLabel(op)} ${made.length} 个素材，新素材放在右边`)
    return true
  }
  return { busy, run }
}

function num(value: string) {
  // Number('') 是 0：留空不能当成 0，否则裁剪会悄悄产出 1×1
  if (value.trim() === '') return Number.NaN
  const n = Number(value)
  return Number.isFinite(n) ? n : Number.NaN
}

/**
 * 媒体加工工具条：裁剪 / 旋转 / 镜像 / 截取 / 变速 / 切分 / 音视频分离 / 抽帧。
 * 全部交给服务端的同一套接口（见 assets/derive.ts），前端只负责收参数和摆结果。
 */
export function MediaTools({
  engine,
  target,
  label = '媒体工具',
  ops,
}: {
  engine: Engine
  target: MediaTarget | MediaTarget[]
  label?: string
  /** 多选时只给一键操作；默认按素材类型给全量 */
  ops?: ReturnType<typeof opsFor>
}) {
  const notify = useCanvas((s) => s.notify)
  const { busy, run } = useDeriver(engine)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<string | null>(null)
  const [meta, setMeta] = useState<Asset | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const btnRef = useRef<HTMLButtonElement>(null)
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)

  const list = Array.isArray(target) ? target : [target]
  const first = list[0]!
  const [caps, setCaps] = useState<MediaCapsInfo | null>(null)
  useEffect(() => {
    let alive = true
    mediaCaps()
      .then((c) => alive && setCaps(c))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  // 本机做不到的操作不显示（比如没装 ffmpeg 时的音视频加工）
  const allowed = opsFor(first.kind, caps)
  const actions = (ops ?? allowed).filter((op) => allowed.includes(op))
  const sameKind = list.every((t) => t.kind === first.kind)

  // 打开时读一次资产元信息：裁剪要有像素尺寸，抽帧和截取要知道时长
  const toggle = () => {
    const next = !open
    setOpen(next)
    setAnchorEl(btnRef.current)
    if (next && !meta)
      loadAssetMeta(first.assetId)
        .then(setMeta)
        .catch(() => notify('读不到素材信息'))
  }

  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }))

  /** 多选时按目标顺序逐个加工，失败的跳过并如实报数；上一轮还没完时不重复发起 */
  const runAll = async (make: (t: MediaTarget) => MediaDeriveRequest) => {
    if (await run(list, make)) setOpen(false)
  }

  // 批量时每个目标用自己的 assetId；区间、尺寸类参数按第一个素材的信息校验
  const submit = async () => {
    if (form === 'crop') {
      const rect = cropRect(
        {
          left: num(values.left ?? '0'),
          top: num(values.top ?? '0'),
          // 宽高留空表示到边缘，用素材信息补；信息还没到时 NaN 会被下面拦住
          width: num(values.width || String(meta?.width ?? '')),
          height: num(values.height || String(meta?.height ?? '')),
        },
        { width: meta?.width, height: meta?.height },
      )
      if (!rect.width || !rect.height) return notify('裁剪区域不对')
      await runAll((t) => ({ op: 'crop', assetId: t.assetId, ...rect }))
      return
    }
    if (form === 'trim') {
      const range = clampRange(
        parseTimecode(values.start ?? '0') ?? 0,
        parseTimecode(values.end ?? '0') ?? Number.NaN,
        meta?.duration,
      )
      if (!range) return notify('区间不对：出点要大于入点，且不能超出素材长度')
      await runAll((t) => ({ op: 'trim', assetId: t.assetId, ...range }))
      return
    }
    if (form === 'speed') {
      const speed = clampSpeed(num(values.speed ?? '1'))
      await runAll((t) => ({
        op: 'speed',
        assetId: t.assetId,
        speed,
        keepPitch: values.keepPitch !== 'no',
      }))
      return
    }
    if (form === 'split') {
      const count = Math.max(2, Math.round(num(values.count ?? '2')))
      const segments = evenSegments(meta?.duration ?? count, count)
      await runAll((t) => ({ op: 'split', assetId: t.assetId, segments }))
      return
    }
    if (form === 'frame') {
      const at = parseTimecode(values.at ?? '0')
      if (at === null) return notify('时间看不懂，试试 12.5 或 1:02')
      await runAll((t) => ({ op: 'frame', assetId: t.assetId, at }))
    }
  }

  /** 直接就能做的操作 */
  const quick = (op: 'rotate' | 'flip' | 'separate') =>
    runAll((t) =>
      op === 'rotate'
        ? { op: 'rotate', assetId: t.assetId, angle: 90 }
        : op === 'flip'
          ? { op: 'flip', assetId: t.assetId, axis: 'horizontal' }
          : { op: 'separate', assetId: t.assetId },
    )

  const field = (key: string, label: string, fallback: string) => (
    <label className="ui-field">
      <span className="ui-label">{label}</span>
      <input
        className="ui-input"
        value={values[key] ?? ''}
        placeholder={fallback}
        onChange={(e) => set(key, e.target.value)}
      />
    </label>
  )

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="ui-bar-btn ui-btn-menu"
        aria-expanded={open}
        disabled={busy || !actions.length}
        onClick={toggle}
        title="裁剪、变速、抽帧等本地加工，结果是新素材，原素材不变"
      >
        <Icon name="sliders" size={14} />
        {label}
        <Icon name="chevronDown" size={12} />
      </button>

      {open && (
        <Popover anchor={anchorEl} onClose={() => setOpen(false)} label={label} width={280}>
          {form ? (
            <>
              <div className="ui-menu-label">{opLabel(form as never)}</div>
              {form === 'crop' && (
                <div className="grid grid-cols-2 gap-2">
                  {field('left', '左', '0')}
                  {field('top', '上', '0')}
                  {field('width', '宽', String(meta?.width ?? ''))}
                  {field('height', '高', String(meta?.height ?? ''))}
                </div>
              )}
              {form === 'trim' && (
                <div className="grid grid-cols-2 gap-2">
                  {field('start', '入点', '0:00')}
                  {field('end', '出点', formatTimecode(meta?.duration ?? 0))}
                </div>
              )}
              {form === 'speed' && (
                <>
                  <div className="flex flex-wrap gap-1 pb-2">
                    {SPEEDS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="ui-menu-item w-auto justify-center px-2 py-1"
                        onClick={() => set('speed', String(s))}
                      >
                        {s}×
                      </button>
                    ))}
                  </div>
                  {field('speed', '倍数', '2')}
                  {first.kind === 'audio' && (
                    <label className="flex items-center gap-2 pt-2 text-sm">
                      <input
                        type="checkbox"
                        checked={values.keepPitch !== 'no'}
                        onChange={(e) => set('keepPitch', e.target.checked ? 'yes' : 'no')}
                      />
                      保音调（改的是素材本身，不是合成时的语速）
                    </label>
                  )}
                </>
              )}
              {form === 'split' && field('count', '切成几段', '2')}
              {form === 'frame' && field('at', '第几秒', '0:00')}
              <div className="flex gap-2 pt-3">
                <button
                  type="button"
                  className="ui-btn ui-btn-sm"
                  onClick={() => {
                    setForm(null)
                    setValues({})
                  }}
                >
                  返回
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-sm ui-btn-primary flex-1"
                  disabled={busy}
                  onClick={() => void submit()}
                >
                  {busy ? '处理中…' : '开始加工'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="ui-menu-label">
                {list.length > 1 ? `对 ${list.length} 个素材` : '加工'}
                {!sameKind && '（类型不同，只用第一个的操作）'}
              </div>
              {actions.includes('crop') && (
                <button
                  type="button"
                  className="ui-menu-item"
                  onClick={() => {
                    setValues({
                      left: '0',
                      top: '0',
                      width: String(meta?.width ?? ''),
                      height: String(meta?.height ?? ''),
                    })
                    setForm('crop')
                  }}
                >
                  裁剪
                </button>
              )}
              {actions.includes('rotate') &&
                ([90, 180, 270] as const).map((angle) => (
                  <button
                    key={angle}
                    type="button"
                    className="ui-menu-item justify-between"
                    onClick={() =>
                      void runAll((t) => ({ op: 'rotate', assetId: t.assetId, angle }))
                    }
                  >
                    旋转 {angle}°
                  </button>
                ))}
              {actions.includes('flip') && (
                <>
                  <button type="button" className="ui-menu-item" onClick={() => void quick('flip')}>
                    左右翻转
                  </button>
                  <button
                    type="button"
                    className="ui-menu-item"
                    onClick={() =>
                      void runAll((t) => ({
                        op: 'flip',
                        assetId: t.assetId,
                        axis: 'vertical',
                      }))
                    }
                  >
                    上下翻转
                  </button>
                </>
              )}
              {actions.includes('trim') && (
                <button
                  type="button"
                  className="ui-menu-item"
                  onClick={() => {
                    setValues({ start: '0:00', end: formatTimecode(meta?.duration ?? 0) })
                    setForm('trim')
                  }}
                >
                  截取一段
                </button>
              )}
              {actions.includes('speed') && (
                <button
                  type="button"
                  className="ui-menu-item"
                  onClick={() => {
                    setValues({ speed: '2', keepPitch: 'yes' })
                    setForm('speed')
                  }}
                >
                  变速
                </button>
              )}
              {actions.includes('split') && (
                <button
                  type="button"
                  className="ui-menu-item"
                  onClick={() => {
                    setValues({ count: '2' })
                    setForm('split')
                  }}
                >
                  手动切分
                </button>
              )}
              {actions.includes('separate') && (
                <button
                  type="button"
                  className="ui-menu-item"
                  onClick={() => void quick('separate')}
                >
                  分离音频与画面
                </button>
              )}
              {actions.includes('frame') && (
                <button
                  type="button"
                  className="ui-menu-item"
                  onClick={() => {
                    setValues({ at: '0:00' })
                    setForm('frame')
                  }}
                >
                  抽帧成图片
                </button>
              )}
              <div className="ui-help px-2 pt-2">
                加工在服务端跑 ffmpeg / sharp，产出新素材，原素材不动。
              </div>
            </>
          )}
        </Popover>
      )}
    </>
  )
}

/** 多选时的一键加工：只给不用填参数的操作，逐个素材跑 */
export function MediaBatchTools({ engine, targets }: { engine: Engine; targets: MediaTarget[] }) {
  const ops = [...new Set(targets.flatMap((t) => quickOpsFor(t.kind)))]
  if (!targets.length || !ops.length) return null
  return (
    <MediaTools
      key={targets.map((t) => t.assetId).join(',')}
      engine={engine}
      target={targets}
      label="批量加工"
      ops={ops}
    />
  )
}

/** 全屏查看图片 / 视频：点空白处或 Esc 关闭 */
export function Viewer() {
  const viewer = useCanvas((s) => s.viewer)
  const view = useCanvas((s) => s.view)
  if (!viewer) return null
  const src = assetUrls.original(viewer.assetId)
  return (
    <div
      role="dialog"
      aria-label={`查看「${viewer.name}」`}
      className="fixed inset-0 z-50 flex items-center justify-center p-10"
      onKeyDown={(e) => {
        if (e.key === 'Escape') view(null)
      }}
    >
      <button
        type="button"
        aria-label="关闭"
        tabIndex={-1}
        onClick={() => view(null)}
        className="absolute inset-0 cursor-default bg-black/85 backdrop-blur-sm"
      />
      {viewer.kind === 'image' ? (
        <img
          src={src}
          alt={viewer.name}
          className="relative max-h-full max-w-full rounded-md object-contain"
        />
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: 生成的视频没有字幕轨
        <video src={src} controls autoPlay className="relative max-h-full max-w-full rounded-md" />
      )}
      <button
        type="button"
        // biome-ignore lint/a11y/noAutofocus: 打开即可按 Esc 关闭
        autoFocus
        aria-label="关闭"
        onClick={() => view(null)}
        className="absolute top-5 right-5 flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
      >
        <Icon name="x" size={20} />
      </button>
    </div>
  )
}
