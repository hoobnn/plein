import { Engine, isEditableTarget } from '@plein/canvas-core'
import { createDoc, type ElementKind, type PleinDoc } from '@plein/doc'
import { useEffect, useRef } from 'react'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { assetUrls, syncUrl } from '../api/client'
import { navigate } from '../router'
import { useCanvas } from '../stores/canvas'
import { demoAssetUrls, seedDemo } from './demo'
import { importFiles, importText } from './import'
import { NodeCards } from './nodeCards'
import { CanvasOverlays } from './overlays'
import { cancelNode, runNode } from './runner'

export type CanvasSource = { kind: 'remote'; canvasId: string } | { kind: 'demo'; count: number }

/** 画布上的预览图：图片缩略图、视频封面、音频波形 */
function previewUrl(assetId: string, kind: ElementKind) {
  if (kind === 'video') return assetUrls.variant(assetId, 'poster')
  if (kind === 'audio') return assetUrls.variant(assetId, 'waveform')
  return assetUrls.variant(assetId, 'thumb-1024')
}

/** 画布被删除时服务端以 4404 关闭同步连接 */
const CLOSE_DELETED = 4404

/** React 只负责挂载；相机与渲染完全脱离 React 渲染周期。 */
export function CanvasView({ source }: { source: CanvasSource }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const kind = source.kind
  const canvasId = source.kind === 'remote' ? source.canvasId : ''
  const count = source.kind === 'demo' ? source.count : 0

  useEffect(() => {
    const host = hostRef.current!
    const overlayRoot = overlayRef.current!
    const { attach, setSync, setImporting, notify, setCanvasId } = useCanvas.getState()
    let disposed = false
    const cleanups: Array<() => void> = []

    const start = (
      doc: PleinDoc,
      assetUrl: (id: string, kind: ElementKind) => string | undefined,
      awareness?: unknown,
    ) => {
      const engine = new Engine({ host, doc, overlay: overlayRoot, assetUrl })
      // StrictMode 下 effect 会执行两次：init 未完成前不能 destroy
      engine.init().then(() => {
        if (disposed) return engine.destroy()
        const overlays = new CanvasOverlays(engine, overlayRoot, host, {
          originalUrl: assetUrls.original,
          awareness,
        })
        const cards = new NodeCards(engine, overlayRoot, {
          run: runNode,
          cancel: cancelNode,
          thumbUrl: (id) => assetUrls.variant(id, 'thumb-256'),
        })
        // 双击节点：聚焦生成器的提示词（面板在选中后的下一帧才挂载）
        const offActivate = engine.onActivate((id) => {
          if (engine.scene.get(id)?.kind !== 'node') return
          requestAnimationFrame(() =>
            window.dispatchEvent(new CustomEvent('plein:focus-generator', { detail: id })),
          )
        })
        const detach = attach(engine)
        const off = attachImport(engine, host, { setImporting, notify })
        cleanups.push(() => {
          off()
          offActivate()
          cards.destroy()
          overlays.destroy()
          detach()
          engine.destroy()
        })
        engine.zoomToFit()
        // 方便在控制台调试和端到端测试（页面脚本本就同源，不额外暴露能力）
        Object.assign(window, { plein: engine })
      })
    }

    if (kind === 'demo') {
      setSync('local')
      const doc = createDoc()
      seedDemo(doc, count)
      const urls = demoAssetUrls()
      start(doc, (id) => urls.get(id))
      cleanups.push(() => doc.destroy())
    } else {
      setSync('connecting')
      setCanvasId(canvasId)
      const ydoc = new Y.Doc()
      const provider = new WebsocketProvider(syncUrl(), canvasId, ydoc)
      provider.awareness.setLocalStateField('user', { name: '我', color: '#e8d5b5' })
      provider.on('status', ({ status }: { status: string }) => {
        setSync(
          status === 'connected'
            ? 'connected'
            : status === 'connecting'
              ? 'connecting'
              : 'disconnected',
        )
      })
      provider.on('connection-close', (event: CloseEvent | null) => {
        if (event?.code === CLOSE_DELETED) {
          provider.disconnect()
          notify('画布不存在或已被删除')
          navigate({ name: 'home' })
        }
      })
      let doc: PleinDoc | null = null
      // 首次同步完成后再建文档模型：迁移要基于服务端的完整状态
      const onSync = (synced: boolean) => {
        if (!synced || doc || disposed) return
        doc = createDoc(ydoc)
        start(doc, previewUrl, provider.awareness)
      }
      provider.on('sync', onSync)
      cleanups.push(() => {
        provider.destroy()
        doc?.destroy()
        ydoc.destroy()
      })
    }

    return () => {
      disposed = true
      for (const c of cleanups.reverse()) c()
      setSync('local')
      setCanvasId(null)
    }
  }, [kind, canvasId, count])

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div
        ref={hostRef}
        tabIndex={-1}
        className="absolute inset-0 touch-none select-none outline-none"
      />
      {/* DOM 覆盖层：Markdown 正文、编辑器、播放器，跟随相机变换 */}
      <div
        ref={overlayRef}
        className="plein-overlay pointer-events-none absolute left-0 top-0 origin-top-left"
      />
    </div>
  )
}

/** 拖入文件、粘贴文件或文本导入到画布 */
function attachImport(
  engine: Engine,
  host: HTMLElement,
  ui: {
    setImporting(v: { done: number; total: number } | null): void
    notify(msg: string | null): void
  },
) {
  const center = () => {
    const r = engine.camera.viewRect
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
  }
  const run = async (files: File[], at: { x: number; y: number }) => {
    if (!files.length) return
    ui.setImporting({ done: 0, total: files.length })
    try {
      const res = await importFiles(engine, files, at, (done, total) =>
        ui.setImporting({ done, total }),
      )
      if (res.skipped.length) {
        ui.notify(
          `${res.skipped.length} 个文件未导入：${res.skipped.map((s) => `${s.name}（${s.reason}）`).join('，')}`,
        )
      }
    } finally {
      ui.setImporting(null)
    }
  }

  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }
  const onDrop = (e: DragEvent) => {
    const files = [...(e.dataTransfer?.files ?? [])]
    if (!files.length) return
    e.preventDefault()
    void run(files, engine.clientToWorld(e.clientX, e.clientY))
  }
  const onPaste = (e: ClipboardEvent) => {
    // 引擎已处理 plein 自己的剪贴板格式
    if (e.defaultPrevented || isEditableTarget(e.target)) return
    const files = [...(e.clipboardData?.files ?? [])]
    if (files.length) {
      e.preventDefault()
      void run(files, center())
      return
    }
    const text = e.clipboardData?.getData('text/plain')?.trim()
    if (text) {
      e.preventDefault()
      importText(engine, text, center())
    }
  }
  const onImportRequest = (e: Event) => void run((e as CustomEvent<File[]>).detail, center())

  host.addEventListener('dragover', onDragOver)
  host.addEventListener('drop', onDrop)
  window.addEventListener('paste', onPaste)
  window.addEventListener('plein:import', onImportRequest)
  return () => {
    host.removeEventListener('dragover', onDragOver)
    host.removeEventListener('drop', onDrop)
    window.removeEventListener('paste', onPaste)
    window.removeEventListener('plein:import', onImportRequest)
  }
}
