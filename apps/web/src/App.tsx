import { useEffect } from 'react'
import { Editor } from './pages/Editor'
import { Home } from './pages/Home'
import { Login } from './pages/Login'
import { useRoute } from './router'
import { useSession } from './stores/session'

export function App() {
  const route = useRoute()
  const { status, info, refresh } = useSession()

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 本地演示不依赖服务端，可用于性能测试：#/demo?n=1000
  if (route.name === 'demo') {
    const n = Number(new URLSearchParams(location.hash.split('?')[1] ?? '').get('n') ?? 1000)
    return <Editor source={{ kind: 'demo', count: Number.isFinite(n) ? n : 1000 }} />
  }
  if (status === 'loading') return null
  if (status === 'offline') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-ink-muted">
        <p>连不上 Plein 服务端。开发时请先运行 pnpm dev:server。</p>
        <button
          type="button"
          onClick={refresh}
          className="rounded-lg bg-surface px-4 py-2 text-ink"
        >
          重试
        </button>
      </div>
    )
  }
  if (info?.authRequired && !info.principal) return <Login setup={info.needsSetup} />
  if (route.name === 'canvas')
    return <Editor key={route.id} source={{ kind: 'remote', canvasId: route.id }} />
  return <Home />
}
