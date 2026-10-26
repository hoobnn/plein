import type { Engine } from '@plein/canvas-core'
import { elementMedia } from '@plein/doc'
import { MediaDeriveRequest, type Asset } from '@plein/protocol'
import { useEffect, useId, useRef, useState } from 'react'
import { assetUrls } from '../../api/client'
import { useDocVersion } from '../../canvas/hooks'
import { parseTimecode, type MediaTarget } from '../../canvas/media'
import { loadAssetMeta } from '../../stores/assetMeta'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Select } from '../../ui/Select'
import { useMediaDeriver } from '../mediaRequests'

export type AdvancedVideoOperation = 'repair-region' | 'replace-range'

/** An operand includes the element identity, not just a reusable file hash. */
export function captureVideoOperand(engine: Engine, target: MediaTarget) {
  const map = engine.doc.elementMaps.get(target.elId)
  return () => {
    const current = engine.doc.get(target.elId)
    return (
      !engine.doc.readOnly &&
      !!map &&
      engine.doc.elementMaps.get(target.elId) === map &&
      !!current &&
      !current.locked &&
      elementMedia(current)?.kind === 'video' &&
      elementMedia(current)?.assetId === target.assetId
    )
  }
}

function useMetadata(assetId: string | undefined) {
  const [loaded, setLoaded] = useState<{ id: string; asset: Asset } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setError(null)
    if (assetId)
      void loadAssetMeta(assetId)
        .then((asset) => {
          if (alive) setLoaded({ id: assetId, asset })
        })
        .catch((cause) => {
          if (alive) setError((cause as Error).message)
        })
    return () => {
      alive = false
    }
  }, [assetId])
  return { asset: loaded && loaded.id === assetId ? loaded.asset : null, error }
}

export function AdvancedVideo({
  engine,
  target,
  operation,
  onClose,
}: {
  engine: Engine
  target: MediaTarget
  operation: AdvancedVideoOperation
  onClose(): void
}) {
  useDocVersion(engine.doc)
  const replacementSelectId = useId()
  const [sourceCurrent] = useState(() => captureVideoOperand(engine, target))
  const [replacement, setReplacement] = useState<{
    target: MediaTarget
    current(): boolean
  } | null>(null)
  const source = useMetadata(target.assetId)
  const other = useMetadata(replacement?.target.assetId)
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const { run, busy, cancel } = useMediaDeriver(engine, [target])
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const title = operation === 'repair-region' ? '区域修补（本地插值）' : '片段替换'
  const candidates = [...engine.doc.elements()].flatMap((el) => {
    const media = elementMedia(el)
    return el.id !== target.elId && !el.locked && media?.kind === 'video'
      ? [
          {
            elId: el.id,
            assetId: media.assetId,
            kind: 'video' as const,
            name: el.name || '未命名视频',
          },
        ]
      : []
  })
  const meta = source.asset
  const defaults = {
    left: String(Math.max(1, Math.floor((meta?.width ?? 20) * 0.1))),
    top: String(Math.max(1, Math.floor((meta?.height ?? 20) * 0.8))),
    width: String(Math.max(1, Math.floor((meta?.width ?? 20) * 0.8))),
    height: String(Math.max(1, Math.floor((meta?.height ?? 20) * 0.1))),
    start: '0',
    end: String(meta?.duration ?? ''),
    replacementStart: '0',
  }
  const value = (key: keyof typeof defaults) => values[key] ?? defaults[key]
  const set = (key: string, next: string) => {
    setValues((previous) => ({ ...previous, [key]: next }))
    setError(null)
  }
  const field = (key: keyof typeof defaults, label: string) => (
    <label className="ui-field">
      <span className="ui-label">{label}</span>
      <input
        className="ui-input"
        value={value(key)}
        disabled={busy}
        onChange={(event) => set(key, event.target.value)}
      />
    </label>
  )
  const valid = () => sourceCurrent() && (operation !== 'replace-range' || !!replacement?.current())
  const stale = !sourceCurrent()
    ? '原视频已变化、锁定或移除，请关闭后重新选择。'
    : replacement && !replacement.current()
      ? '替换素材已变化、锁定或移除，请重新选择替换素材。'
      : null
  const submit = async () => {
    setError(null)
    if (!valid()) return setError('原视频或替换素材已变化、锁定或移除，请重新选择。')
    if (!meta || !Number.isFinite(meta.duration)) return setError('请等待原视频信息读取完成。')
    const start = parseTimecode(value('start')),
      end = parseTimecode(value('end'))
    if (start === null || end === null || end <= start || end > meta.duration! + 0.001)
      return setError('请输入原视频范围内的有效入点和出点，出点须晚于入点。')
    let body: unknown
    if (operation === 'repair-region') {
      const rect = Object.fromEntries(
        ['left', 'top', 'width', 'height'].map((key) => [
          key,
          values[key]?.trim() === ''
            ? NaN
            : Number(values[key] ?? defaults[key as keyof typeof defaults]),
        ]),
      )
      if (
        Object.values(rect).some((n) => !Number.isSafeInteger(n) || n < 1) ||
        !meta.width ||
        !meta.height ||
        rect.left! + rect.width! >= meta.width ||
        rect.top! + rect.height! >= meta.height
      )
        return setError('矩形必须使用正整数像素，并在视频四周各留下至少 1 像素背景。')
      body = { op: operation, assetId: target.assetId, ...rect, start, end }
    } else {
      const replacementStart = parseTimecode(value('replacementStart'))
      if (
        !other.asset?.duration ||
        replacementStart === null ||
        replacementStart + end - start > other.asset.duration + 0.001
      )
        return setError('替换素材信息尚未就绪，或从所选起点开始的剩余时长不足。')
      body = {
        op: operation,
        assetId: target.assetId,
        replacementAssetId: replacement!.target.assetId,
        start,
        end,
        replacementStart,
      }
    }
    const parsed = MediaDeriveRequest.safeParse(body)
    if (!parsed.success) return setError('参数无效，请检查像素与时间填写。')
    const started = await run([target], () => parsed.data, {
      validate: valid,
      onFinished(result) {
        if (!mounted.current) return
        if (result.succeeded) onClose()
        else
          setError(
            result.cancelled
              ? '加工已取消，请重新核对素材。'
              : (result.errors[0] ?? '加工未完成，请重试。'),
          )
      },
    })
    if (!started && mounted.current) setError('来源已变化或已有加工正在进行，请重新核对。')
  }
  const overlay =
    operation === 'repair-region' &&
    meta?.width &&
    meta.height &&
    ['left', 'top', 'width', 'height'].every((key) =>
      Number.isFinite(Number(values[key] ?? defaults[key as keyof typeof defaults])),
    )
  return (
    <Modal label={title} onClose={onClose} top isolateKeys className="max-w-xl">
      <ModalHeader title={title} onClose={onClose} />
      <div className="ui-scrollbar flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
        <p className="ui-help">
          {operation === 'repair-region'
            ? '使用周围背景插值填补固定矩形，可限定时间段。适合简单背景，不会识别或跟踪字幕；保留原音轨。'
            : '使用另一视频的等长片段替换画面，保留原视频总时长和原音轨。替换画面等比缩放并补边。'}
        </p>
        <div className="relative">
          <video
            aria-label="原视频预览"
            src={assetUrls.original(target.assetId)}
            controls
            muted
            className="w-full rounded-lg"
          />
          {overlay && (
            <div
              aria-label="修补区域预览"
              className="pointer-events-none absolute border-2 border-accent bg-accent/20"
              style={{
                left: `${(Number(value('left')) / meta.width!) * 100}%`,
                top: `${(Number(value('top')) / meta.height!) * 100}%`,
                width: `${(Number(value('width')) / meta.width!) * 100}%`,
                height: `${(Number(value('height')) / meta.height!) * 100}%`,
              }}
            />
          )}
        </div>
        {operation === 'repair-region' ? (
          <div className="grid grid-cols-2 gap-3">
            {field('left', '左侧像素')}
            {field('top', '顶部像素')}
            {field('width', '区域宽度')}
            {field('height', '区域高度')}
          </div>
        ) : (
          <>
            <label className="ui-field" htmlFor={replacementSelectId}>
              <span className="ui-label">替换素材</span>
              <Select
                id={replacementSelectId}
                aria-label="替换素材"
                value={replacement?.target.elId ?? ''}
                disabled={busy}
                options={[
                  { value: '', label: '请选择画布中的另一个视频' },
                  ...candidates.map((item) => ({
                    value: item.elId,
                    label: `${item.name} · ${item.elId.slice(0, 6)}`,
                  })),
                ]}
                onChange={(id) => {
                  const selected = candidates.find((item) => item.elId === id)
                  setReplacement(
                    selected
                      ? { target: selected, current: captureVideoOperand(engine, selected) }
                      : null,
                  )
                  setError(null)
                }}
              />
            </label>
            {!candidates.length && (
              <p className="ui-help">先把生成候选或上传的视频放入当前画布，再选择替换素材。</p>
            )}
            {field('replacementStart', '替换素材起点（秒）')}
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          {field('start', '原视频入点（秒）')}
          {field('end', '原视频出点（秒）')}
        </div>
        {operation === 'replace-range' && (
          <p className="ui-help">
            入点和出点须落在原视频帧边界；如不匹配，加工结果会提示可用秒数。
          </p>
        )}
        {(error || stale || source.error || other.error) && (
          <p role="alert" className="ui-help text-danger">
            {error || stale || source.error || other.error}
          </p>
        )}
      </div>
      <footer className="flex justify-end gap-2 border-t border-line p-4">
        <button type="button" className="ui-btn ui-btn-secondary" onClick={onClose}>
          {busy ? '返回画布，后台继续' : '关闭'}
        </button>
        {busy && (
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            onClick={(event) => cancel(event.currentTarget)}
          >
            取消加工
          </button>
        )}
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={busy || !source.asset || !valid()}
          onClick={() => void submit()}
        >
          {busy ? '处理中…' : '生成新视频'}
        </button>
      </footer>
    </Modal>
  )
}
