import { Component, type ComponentType, type ReactNode, useEffect, useRef, useState } from 'react'

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
}: {
  active: boolean
  load: () => Promise<ComponentType<P>>
  props: P
  fallback?: ReactNode
}) {
  const [opened, setOpened] = useState(active)
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  const [Loaded, setLoaded] = useState<ComponentType<P> | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load
  if (active && !opened) setOpened(true)
  useEffect(() => {
    if (!opened || Loaded || failed) return
    let live = true
    loadRef.current().then(
      (component) => {
        if (live) setLoaded(() => component)
      },
      () => {
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [opened, Loaded, failed, attempt])
  useEffect(() => {
    if (active || !failed) return
    setOpened(false)
    setLoaded(null)
    setFailed(false)
    setAttempt((current) => current + 1)
  }, [active, failed])
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
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
            onClick={() => {
              setLoaded(null)
              setFailed(false)
              setAttempt((current) => current + 1)
            }}
          >
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
