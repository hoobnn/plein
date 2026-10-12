import { isEditableTarget } from '@plein/canvas-core'
import { useEffect, useState } from 'react'
import { desktop } from './desktop'
import { AgentDock } from './panels/Agent'
import { SettingsDialog } from './panels/Settings'
import { DialogHost } from './ui/Dialog'
import { TooltipHost } from './ui/Tooltip'
import { useCanvas } from './stores/canvas'
import { Editor } from './pages/Editor'
import { Home } from './pages/Home'
import { Login } from './pages/Login'
import { useRoute } from './router'
import { useSession } from './stores/session'

export function App() {
  const [settings, setSettings] = useState(false)
  useEffect(
    () =>
      desktop?.onMenuCommand((command) => {
        if (command === 'settings') {
          setSettings(true)
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
      <AppContent onOpenSettings={() => setSettings(true)} />
      <AgentDock />
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
      <DialogHost />
      <TooltipHost />
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
