import { lazy, Suspense, useEffect, useState } from 'react'
import { desktop } from './desktop'
import { useAgent } from './features/agent/store'
import { DesktopEvents } from './shell/DesktopEvents'
import type { Section } from './features/settings/Settings'
import { DialogHost } from './ui/Dialog'
import { TooltipHost } from './ui/Tooltip'
import { useCanvas } from './stores/canvas'
import { useLibrary } from './features/library/store'
import { useRoute } from './router'
import { useSession } from './stores/session'
import { Presence } from './ui/Presence'
import { Mascot } from './ui/Mascot'
import { useMediaLibrary } from './features/media-library/store'
import { useCheckpoints } from './features/checkpoints/store'

const Editor = lazy(() => import('./pages/Editor').then((m) => ({ default: m.Editor })))
const Home = lazy(() => import('./pages/Home').then((m) => ({ default: m.Home })))
const Login = lazy(() => import('./pages/Login').then((m) => ({ default: m.Login })))
const ProjectOpen = lazy(() =>
  import('./pages/ProjectOpen').then((m) => ({ default: m.ProjectOpen })),
)
const AgentDock = lazy(() =>
  import('./features/agent/Agent').then((m) => ({ default: m.AgentDock })),
)
const LibraryPanel = lazy(() =>
  import('./features/library/Library').then((m) => ({ default: m.LibraryPanel })),
)
const SettingsDialog = lazy(() =>
  import('./features/settings/Settings').then((m) => ({ default: m.SettingsDialog })),
)
const MediaLibraryPanel = lazy(() =>
  import('./features/media-library/MediaLibrary').then((m) => ({ default: m.MediaLibraryPanel })),
)
const CheckpointsPanel = lazy(() =>
  import('./features/checkpoints/Checkpoints').then((m) => ({ default: m.CheckpointsPanel })),
)

const isEditableTarget = (target: Element | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLMediaElement ||
    target.closest('[data-plein-active]') !== null)

export function App() {
  const [settings, setSettings] = useState<false | Section | undefined>(false)
  const route = useRoute()
  const agentOpen = useAgent((s) => s.open)
  const libraryOpen = useLibrary((s) => s.open)
  const mediaOpen = useMediaLibrary((s) => !!s.open || !!s.target)
  const checkpointsOpen = useCheckpoints((s) => !!s.open)
  const ready = useSession((s) => s.status === 'ready' && !!s.info?.principal)
  // 卡片、任务面板上的“去设置”（如密钥无效）直接打开对应分区
  useEffect(() => {
    const open = (e: Event) =>
      setSettings((e as CustomEvent<{ section?: Section }>).detail?.section)
    window.addEventListener('plein:open-settings', open)
    return () => window.removeEventListener('plein:open-settings', open)
  }, [])
  useEffect(
    () =>
      desktop?.onMenuCommand((command) => {
        if (command === 'settings') {
          setSettings(undefined)
          return
        }
        const engine = useCanvas.getState().engine
        if (
          engine &&
          !document.querySelector('[role=dialog]') &&
          !isEditableTarget(document.activeElement)
        ) {
          engine[command]()
          return
        }
        // CodeMirror 先处理自己的快捷键；普通输入框交给 Chromium 原生编辑。
        const target = document.activeElement ?? document.body
        const event = new KeyboardEvent('keydown', {
          key: command === 'selectAll' ? 'a' : 'z',
          code: command === 'selectAll' ? 'KeyA' : 'KeyZ',
          metaKey: desktop?.platform === 'darwin',
          ctrlKey: desktop?.platform !== 'darwin',
          shiftKey: command === 'redo',
          bubbles: true,
          cancelable: true,
        })
        if (target.dispatchEvent(event)) void desktop?.nativeEdit(command)
      }),
    [],
  )

  return (
    <>
      <Suspense
        fallback={
          <div role="status" className="p-6 text-sm text-ink-muted">
            正在打开工作区…
          </div>
        }
      >
        <AppContent onOpenSettings={() => setSettings(undefined)} />
      </Suspense>
      <Suspense fallback={null}>
        {ready && (route.name === 'canvas' || agentOpen) ? (
          <AgentDock />
        ) : ready && route.name !== 'demo' ? (
          <button
            type="button"
            aria-label="打开助手"
            className="plein-mascot-btn pointer-events-auto fixed right-3 bottom-2 z-40 rounded-full"
            onClick={() => useAgent.getState().toggle(true)}
          >
            <Mascot mood="idle" />
          </button>
        ) : null}
        {libraryOpen && <LibraryPanel />}
        {mediaOpen && <MediaLibraryPanel />}
        {checkpointsOpen && <CheckpointsPanel />}
        <Presence>
          {settings !== false && (
            <SettingsDialog initial={settings} onClose={() => setSettings(false)} />
          )}
        </Presence>
      </Suspense>
      <DialogHost />
      <TooltipHost />
      <DesktopEvents />
    </>
  )
}

function AppContent({ onOpenSettings }: { onOpenSettings(): void }) {
  const route = useRoute()
  const { status, info, refresh } = useSession()

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 本地演示不依赖服务端，可用于性能测试：#/demo?n=1000
  if (route.name === 'demo') {
    const n = Number(new URLSearchParams(location.hash.split('?')[1] ?? '').get('n') ?? 1000)
    return (
      <Editor
        onOpenSettings={onOpenSettings}
        source={{ kind: 'demo', count: Number.isFinite(n) ? n : 1000 }}
      />
    )
  }
  if (status === 'loading') return null
  if (status === 'offline') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-ink-muted">
        <p>连不上 Plein 服务端。开发时请先运行 pnpm dev:server。</p>
        <button type="button" onClick={refresh} className="ui-btn ui-btn-secondary">
          重试
        </button>
      </div>
    )
  }
  if (info?.authRequired && !info.principal) return <Login setup={info.needsSetup} />
  if (route.name === 'project') return <ProjectOpen key={route.id} id={route.id} />
  if (route.name === 'canvas')
    return (
      <Editor
        onOpenSettings={onOpenSettings}
        key={route.id}
        source={{ kind: 'remote', canvasId: route.id }}
      />
    )
  return <Home onOpenSettings={onOpenSettings} />
}
