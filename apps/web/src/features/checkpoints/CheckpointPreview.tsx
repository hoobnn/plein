import { Engine } from '@plein/canvas-core'
import { createDoc, currentResult } from '@plein/doc'
import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { assetUrls } from '../../api/client'
import { canvasTheme, useTheme } from '../../stores/theme'

function decode(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

/** 独立只读引擎；不连接同步、不注册到当前画布 store、不使用当前画布的过期状态。 */
export function CheckpointPreview({ state }: { state: string }) {
  const host = useRef<HTMLDivElement>(null),
    overlay = useRef<HTMLDivElement>(null),
    fitRef = useRef<(() => void) | null>(null)
  const [error, setError] = useState(''),
    [ready, setReady] = useState(false)
  useEffect(() => {
    setError('')
    setReady(false)
    const ydoc = new Y.Doc()
    try {
      Y.applyUpdate(ydoc, decode(state))
    } catch {
      ydoc.destroy()
      setError('检查点预览数据无法读取，请重新加载预览。')
      return
    }
    const doc = createDoc(ydoc)
    doc.readOnly = true
    const engine = new Engine({
      host: host.current!,
      overlay: overlay.current!,
      doc,
      theme: canvasTheme(useTheme.getState().name),
      assetUrl: (id, kind, size) =>
        assetUrls.variant(
          id,
          kind === 'video'
            ? 'poster'
            : kind === 'audio'
              ? 'waveform'
              : size === 'small'
                ? 'thumb-256'
                : 'thumb-1024',
        ),
    })
    let disposed = false,
      initialized = false
    const labels = new Map<string, HTMLElement>()
    const sync = () => {
      const visible = new Set(engine.highDetail ? engine.visibleIds : [])
      for (const [id, label] of labels)
        if (!visible.has(id)) {
          label.remove()
          labels.delete(id)
        }
      for (const id of visible) {
        const el = doc.get(id),
          rect = doc.worldRect(id)
        if (!el || !rect || (el.kind !== 'node' && el.kind !== 'markdown')) continue
        let label = labels.get(id)
        if (!label) {
          label = document.createElement('div')
          label.className = 'absolute overflow-hidden rounded-lg px-3 py-2 text-sm text-ink'
          overlay.current!.appendChild(label)
          labels.set(id, label)
        }
        label.style.transform = `translate(${rect.x}px,${rect.y - 24}px)`
        label.style.width = `${rect.w}px`
        label.style.maxHeight = `${rect.h + 24}px`
        const result = currentResult(el)?.value
        const text =
          result?.type === 'text'
            ? result.text
            : result?.type === 'json'
              ? JSON.stringify(result.value)
              : !result
                ? String(el.params?.description ?? el.params?.prompt ?? el.params?.text ?? '')
                : ''
        label.textContent = `${el.name ?? el.nodeType ?? '文本'}\n${el.kind === 'markdown' ? (el.text ?? '') : text}`
        label.style.whiteSpace = 'pre-wrap'
        label.style.lineHeight = '1.6'
      }
    }
    let off = () => {},
      offCamera = () => {}
    const dispose = () => {
      off()
      offCamera()
      engine.destroy()
      doc.destroy()
      ydoc.destroy()
      labels.clear()
    }
    void engine.init().then(
      () => {
        initialized = true
        if (disposed) {
          dispose()
          return
        }
        engine.setTool('hand')
        const camera = engine.camera
        const snapshot = () => ({
          width: camera.width,
          height: camera.height,
          x: camera.x,
          y: camera.y,
          zoom: camera.zoom,
          center: camera.center,
        })
        let previous = snapshot(),
          followingFit = true,
          adjusting = false
        const fit = () => {
          adjusting = true
          followingFit = true
          // 小预览不沿用主画布的固定大留白，避免压到最低缩放并隐藏正文。
          engine.zoomToFit(undefined, Math.min(32, camera.width / 8, camera.height / 8))
          previous = snapshot()
          adjusting = false
        }
        offCamera = camera.onChange(() => {
          if (adjusting) return
          if (camera.width !== previous.width || camera.height !== previous.height) {
            if (followingFit) fit()
            else {
              adjusting = true
              camera.lookAt(previous.center.x, previous.center.y, previous.zoom)
              previous = snapshot()
              adjusting = false
            }
          } else {
            if (camera.x !== previous.x || camera.y !== previous.y || camera.zoom !== previous.zoom)
              followingFit = false
            previous = snapshot()
          }
        })
        fitRef.current = fit
        off = engine.onViewChange(sync)
        fit()
        sync()
        setReady(true)
      },
      (reason: Error) => {
        if (!disposed) setError(`检查点预览加载失败：${reason.message}`)
        doc.destroy()
        ydoc.destroy()
      },
    )
    return () => {
      disposed = true
      fitRef.current = null
      if (initialized) dispose()
    }
  }, [state])
  return (
    <div
      className="relative flex min-h-40 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-canvas md:min-h-80"
      data-testid="checkpoint-preview"
    >
      <div className="flex flex-none items-center justify-between border-b border-line bg-surface px-3 py-2 text-xs">
        <span>只读预览 · 拖动与缩放查看</span>
        <button
          type="button"
          className="ui-btn ui-btn-xs ui-btn-secondary"
          disabled={!ready}
          onClick={() => fitRef.current?.()}
        >
          适应画布
        </button>
      </div>
      <div ref={host} className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={overlay} className="pointer-events-none absolute top-0 left-0 origin-top-left" />
      </div>
      {error && (
        <p
          role="alert"
          className="absolute inset-x-3 bottom-3 rounded-lg bg-surface p-3 text-sm text-danger"
        >
          {error}
        </p>
      )}
    </div>
  )
}
