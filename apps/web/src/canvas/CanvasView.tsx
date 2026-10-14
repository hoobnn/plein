import { Engine, isEditableTarget, type PreviewSize } from '@plein/canvas-core'
import { createDoc, type ElementKind, type PleinDoc, SCHEMA_VERSION } from '@plein/doc'
import { SEQUENCE_TYPE, STORYBOARD_TYPE } from '@plein/nodes'
import { useEffect, useRef } from 'react'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { assetUrls, syncUrl } from '../api/client'
import { navigate } from '../router'
import { useAgent } from '../features/agent/store'
import { loadAssetMeta } from '../stores/assetMeta'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { canvasTheme, useTheme } from '../stores/theme'
import { demoAssetUrls, seedDemo } from './demo'
import { importFiles, importText } from './import'
import { localCacheName } from './localCache'
import { abortGroupRuns } from '../features/runs/groupRuns'
import { watchStale } from '../features/runs/stale'
import { NodeCards } from './nodeCards'
import { CanvasOverlays } from './overlays'
import { applyPresetToNode } from './presets'
import { cancelNode, runNode } from '../features/runs/run'
import { watchVideoAspect } from './videoAspect'
import { droppedFiles, MAX_IMPORT_FILES } from './dropped'

export type CanvasSource = { kind: 'remote'; canvasId: string } | { kind: 'demo'; count: number }

/** 画布上的预览图：图片缩略图（缩得很小时用 256 档）、视频封面、音频波形 */
function previewUrl(assetId: string, kind: ElementKind, size: PreviewSize) {
  if (kind === 'video') return assetUrls.variant(assetId, 'poster')
  if (kind === 'audio') return assetUrls.variant(assetId, 'waveform')
  return assetUrls.variant(assetId, size === 'small' ? 'thumb-256' : 'thumb-1024')
}

/** 视频的宽高比，取自入库时探测的尺寸（已按旋转元数据换算） */
async function videoRatio(assetId: string) {
  const { width, height } = await loadAssetMeta(assetId)
  return width && height ? width / height : null
}

/** 打开本地缓存；隐私模式等 IndexedDB 不可用时返回 null，照常等服务端同步 */
function openLocalCache(canvasId: string, ydoc: Y.Doc) {
  try {
    const local = new IndexeddbPersistence(localCacheName(canvasId), ydoc)
    ;(local as unknown as { _db?: Promise<unknown> })._db?.catch(() => {})
    return local
  } catch {
    return null
  }
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
      assetUrl: (id: string, kind: ElementKind, size: PreviewSize) => string | undefined,
      awareness?: unknown,
    ) => {
      const engine = new Engine({
        host,
        doc,
        overlay: overlayRoot,
        assetUrl,
        theme: canvasTheme(useTheme.getState().name),
      })
      // StrictMode 下 effect 会执行两次：init 未完成前不能 destroy
      engine.init().then(
        () => {
          if (disposed) return engine.destroy()
          const overlays = new CanvasOverlays(engine, overlayRoot, host, {
            originalUrl: assetUrls.original,
            awareness,
          })
          const cards = new NodeCards(engine, overlayRoot, {
            run: runNode,
            cancel: cancelNode,
            applyPreset: (id, preset) =>
              applyPresetToNode(engine, useCatalog.getState().catalog, id, preset),
            thumbUrl: (id) => assetUrls.variant(id, 'thumb-256'),
          })
          // 双击节点：聚焦生成器的提示词（面板在选中后的下一帧才挂载）
          const offActivate = engine.onActivate((id) => {
            const el = engine.scene.get(id)
            if (el?.kind !== 'node') return
            if (el.nodeType === STORYBOARD_TYPE) return useCanvas.getState().openStoryboard(id)
            if (el.nodeType === SEQUENCE_TYPE) return useCanvas.getState().openSequence(id)
            requestAnimationFrame(() =>
              window.dispatchEvent(new CustomEvent('plein:focus-generator', { detail: id })),
            )
          })
          const offStale = canvasId ? watchStale(engine, canvasId) : () => {}
          const offAspect = canvasId ? watchVideoAspect(engine, videoRatio) : () => {}
          const detach = attach(engine)
          // 端到端测试读画布状态、换算节点屏幕坐标用；只有 e2e 构建（--mode e2e）才有，正式构建会被摇掉
          const e2e = import.meta.env.MODE === 'e2e'
          if (e2e)
            (window as { __plein?: unknown }).__plein = {
              engine,
              // 模拟小满改动了这些元素（光晕 + 光标）
              agentTouch: (ids: string[]) => {
                engine.flash(ids)
                useAgent.setState({ cursor: { ids, at: Date.now() } })
              },
            }
          // 开发时方便在控制台调试
          if (import.meta.env.DEV) (window as { plein?: unknown }).plein = engine
          const off = attachImport(engine, host, { setImporting, notify })
          const offView = awareness ? publishView(engine, awareness as ViewAwareness) : () => {}
          const offTheme = useTheme.subscribe((s, prev) => {
            if (s.name !== prev.name) engine.setTheme(canvasTheme(s.name))
          })
          cleanups.push(() => {
            offView()
            offStale()
            offAspect()
            offTheme()
            off()
            offActivate()
            cards.destroy()
            overlays.destroy()
            detach()
            engine.destroy()
            if (e2e) delete (window as { __plein?: unknown }).__plein
            if (import.meta.env.DEV) delete (window as { plein?: unknown }).plein
          })
          engine.zoomToFit()
        },
        (err) => {
          if (disposed) return
          console.error(err)
          // 只有确实拿不到 WebGL 才提示换浏览器；其余是画布内容或引擎的问题，直接给出原因
          const webgl = !!document.createElement('canvas').getContext('webgl2')
          notify(
            webgl
              ? `画布加载失败：${err instanceof Error ? err.message : String(err)}`
              : '画布加载失败：拿不到 WebGL，请开启硬件加速；桌面端请重启应用',
          )
        },
      )
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
      // 本地缓存：上次打开过的画布不等服务端，先用缓存显示，同步完再补齐差异
      const local = openLocalCache(canvasId, ydoc)
      const provider = new WebsocketProvider(syncUrl(), canvasId, ydoc)
      provider.awareness.setLocalStateField('user', { name: '我', color: '#4177d0' })
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
          void local?.clearData()
          notify('画布不存在或已被删除')
          navigate({ name: 'home' })
        }
      })
      let doc: PleinDoc | null = null
      const open = () => {
        doc = createDoc(ydoc)
        start(doc, previewUrl, provider.awareness)
      }
      // 缓存已是当前版本：直接打开，迁移是空操作；旧版本缓存要等服务端完整状态再迁移
      void local?.whenSynced.then(() => {
        if (doc || disposed || provider.synced) return
        if (ydoc.getMap('meta').get('schemaVersion') === SCHEMA_VERSION) open()
      })
      const onSync = (synced: boolean) => {
        if (!synced || disposed) return
        if (!doc) return open()
        // 从缓存打开的：服务端状态到齐后再检查一次版本（可能已被更新的客户端升级）
        const wasReadOnly = doc.readOnly
        doc.migrate()
        if (doc.readOnly && !wasReadOnly) {
          notify('这个画布已被新版本升级，当前只能查看，请刷新或更新应用')
          useCanvas.getState().engine?.refreshState()
        }
      }
      provider.on('sync', onSync)
      cleanups.push(() => {
        provider.destroy()
        void local?.destroy()
        doc?.destroy()
        ydoc.destroy()
      })
    }

    return () => {
      disposed = true
      for (const c of cleanups.reverse()) c()
      abortGroupRuns()
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
  const run = async (all: File[], at: { x: number; y: number }) => {
    if (!all.length) return
    const files = all.slice(0, MAX_IMPORT_FILES)
    ui.setImporting({ done: 0, total: files.length })
    try {
      const res = await importFiles(engine, files, at, (done, total) =>
        ui.setImporting({ done, total }),
      )
      const notes: string[] = []
      if (res.skipped.length) {
        const shown = res.skipped.slice(0, 3).map((s) => `${s.name}（${s.reason}）`)
        notes.push(
          `${res.skipped.length} 个文件未导入：${shown.join('，')}${res.skipped.length > 3 ? ' 等' : ''}`,
        )
      }
      if (all.length > files.length)
        notes.push(
          `一次最多导入 ${MAX_IMPORT_FILES} 个文件，其余 ${all.length - files.length} 个没有导入`,
        )
      if (notes.length) ui.notify(notes.join('；'))
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
    if (!e.dataTransfer?.files.length) return
    e.preventDefault()
    const at = engine.clientToWorld(e.clientX, e.clientY)
    void droppedFiles(e.dataTransfer).then((files) => run(files, at))
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

interface ViewAwareness {
  setLocalStateField(field: string, value: unknown): void
}

/**
 * 把选区和视口节流发布到 awareness：服务端的智能体据此知道用户选中了什么、正在看哪里
 * （见 apps/server/src/agent/tools.ts 的 viewOf）。
 */
function publishView(engine: Engine, awareness: ViewAwareness) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const publish = () => {
    timer = undefined
    const r = engine.camera.viewRect
    awareness.setLocalStateField('view', {
      selection: engine.selection.values().slice(0, 200),
      viewport: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) },
      at: Date.now(),
    })
  }
  const schedule = () => {
    timer ??= setTimeout(publish, 250)
  }
  publish()
  const offState = engine.onStateChange(schedule)
  const offMove = engine.onMove(schedule)
  const onFocus = () => publish()
  window.addEventListener('focus', onFocus)
  return () => {
    clearTimeout(timer)
    offState()
    offMove()
    window.removeEventListener('focus', onFocus)
  }
}
