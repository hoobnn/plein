import { Component, type ComponentType, type ReactNode, useEffect, useRef, useState } from 'react'
import { LoadingPanel } from './LoadingPanel'

class DeferredErrorBoundary extends Component<
  { children: ReactNode; onError(): void },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch() {
    this.props.onError()
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}

/** 第一次打开才加载；之后保留宿主。导入失败局部降级，下次打开重新 import。 */
export function DeferredPanel<P extends object>({
  active,
  load,
  props,
  fallback = null,
  panel,
}: {
  active: boolean
  load: () => Promise<ComponentType<P>>
  props: P
  fallback?: ReactNode
  panel?: { name: string; onClose(): void }
}) {
  const [opened, setOpened] = useState(active)
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  const [Loaded, setLoaded] = useState<ComponentType<P> | null>(null)
  const generation = useRef(0)
  const loadRef = useRef(load)
  loadRef.current = load
  if (active && !opened) setOpened(true)
  // 取消尚未挂载的面板时只留模块缓存；已经展示过的宿主继续负责自己的退场。
  if (panel && !active && !Loaded && opened) setOpened(false)
  const requested = panel ? active : opened
  useEffect(() => {
    if (!requested || Loaded || failed) return
    const current = ++generation.current
    let live = true
    loadRef.current().then(
      (component) => {
        // 已关闭时也保留成功的模块。新一轮导入开始后，旧结果不能覆盖它。
        if (current === generation.current) setLoaded(() => component)
      },
      () => {
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [requested, Loaded, failed, attempt])
  useEffect(() => {
    if (active || !failed) return
    setOpened(false)
    setLoaded(null)
    setFailed(false)
    setAttempt((current) => current + 1)
  }, [active, failed])
  const retry = () => {
    setLoaded(null)
    setFailed(false)
    setAttempt((current) => current + 1)
  }
  if (panel && (!Loaded || failed)) {
    if (!active) return null
    return (
      <LoadingPanel
        label={failed ? `${panel.name}加载失败` : `正在打开${panel.name}…`}
        onClose={panel.onClose}
        onRetry={failed ? retry : undefined}
      />
    )
  }
  if (!active && !opened) return null
  if (failed)
    return (
      <>
        {fallback}
        <div
          role="alert"
          className="ui-menu fixed right-4 bottom-4 z-60 flex items-center gap-3 p-3 text-sm shadow-3"
        >
          <span>浮层加载失败</span>
          <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={retry}>
            重试
          </button>
        </div>
      </>
    )
  if (!Loaded) return fallback
  return (
    <DeferredErrorBoundary key={attempt} onError={() => setFailed(true)}>
      <Loaded {...props} />
    </DeferredErrorBoundary>
  )
}
