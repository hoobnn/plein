import { useCatalog } from '../stores/catalog'
import { deriveNode } from '../canvas/presets'
import type { Engine } from '@plein/canvas-core'
import type {
  Asset,
  AssetKind,
  MediaCapsInfo,
  MediaDerivation,
  MediaDeriveRequest,
} from '@plein/protocol'
import { useEffect, useRef, useState } from 'react'
import {
  applyDerivation,
  clampRange,
  clampSpeed,
  cropRect,
  formatTimecode,
  mediaCaps,
  opLabel,
  opsFor,
  parseTimecode,
  quickOpsFor,
  SPEEDS,
} from '../canvas/media'
import { loadAssetMeta } from '../stores/assetMeta'
import { useCanvas } from '../stores/canvas'
import { Icon } from '../ui/icons'
import { Popover } from '../ui/Popover'
import { Presence } from '../ui/Presence'
import { audioSplitPlan } from './audioSegments'

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

function SplitPreview({
  duration,
  mode,
  value,
  count,
}: {
  duration?: number
  mode: string
  value: string
  count: number
}) {
  let plan: Array<{ start: number; end: number }> = []
  let errorMessage: string | undefined
  try {
    plan = audioSplitPlan(duration, mode, value, count)
  } catch (error) {
    errorMessage = (error as Error).message
  }
  return errorMessage ? (
    <p className="ui-help">{errorMessage}</p>
  ) : (
    <div aria-label="切分区间预览" className="ui-help">
      将生成 {plan.length} 段：
      {plan
        .map((range) => `${formatTimecode(range.start)} – ${formatTimecode(range.end)}`)
        .join('；')}
    </div>
  )
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
      let segments: Array<{ start: number; end: number }>
      try {
        segments = audioSplitPlan(
          meta?.duration,
          values.splitMode ?? 'even',
          values.intervals ?? '',
          num(values.count ?? '2'),
        )
      } catch (error) {
        notify((error as Error).message)
        return
      }
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

      <Presence>
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
                {form === 'split' && (
                  <>
                    <label className="ui-field">
                      <span className="ui-label">分段方式</span>
                      <select
                        aria-label="分段方式"
                        className="ui-input"
                        value={values.splitMode ?? 'even'}
                        onChange={(e) => {
                          set('splitMode', e.target.value)
                          set('intervals', '')
                        }}
                      >
                        <option value="even">等分</option>
                        <option value="cuts">自定义切点</option>
                        <option value="ranges">自定义区间</option>
                      </select>
                    </label>
                    {(values.splitMode ?? 'even') === 'even' ? (
                      field('count', '切成几段', '2')
                    ) : (
                      <label className="ui-field">
                        <span className="ui-label">
                          {values.splitMode === 'cuts'
                            ? '切点（秒或时间码，逗号分隔）'
                            : '区间（每行：开始 - 结束）'}
                        </span>
                        <textarea
                          aria-label={values.splitMode === 'cuts' ? '音频切点' : '音频区间'}
                          className="ui-input"
                          rows={3}
                          value={values.intervals ?? ''}
                          placeholder={
                            values.splitMode === 'cuts' ? '1.2, 3.5, 0:08' : '0 - 1.2\n1.2 - 3.5'
                          }
                          onChange={(e) => set('intervals', e.target.value)}
                        />
                      </label>
                    )}
                    <SplitPreview
                      duration={meta?.duration}
                      mode={values.splitMode ?? 'even'}
                      value={values.intervals ?? ''}
                      count={num(values.count ?? '2')}
                    />
                  </>
                )}
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
                {first.kind === 'image' && list.length === 1 && (
                  <button
                    type="button"
                    className="ui-menu-item"
                    onClick={() => {
                      const id = deriveNode(
                        engine,
                        useCatalog.getState().catalog,
                        first.elId,
                        'plein/image-process',
                        { inputPort: 'image', name: '图片精修' },
                      )
                      if (id) {
                        setOpen(false)
                        engine.selection.set([id])
                      }
                    }}
                  >
                    AI 精修（放大 / 扩图 / 抠图）
                  </button>
                )}
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
                    <button
                      type="button"
                      className="ui-menu-item"
                      onClick={() => void quick('flip')}
                    >
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
      </Presence>
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
