import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, type RenderOptions } from '@testing-library/react/pure'
import userEvent from '@testing-library/user-event'
import type { ReactElement, ReactNode } from 'react'
import type { StoreApi } from 'zustand'
import { afterEach, beforeEach, expect, vi } from 'vite-plus/test'
import { queryClient } from '../api/query'
import { routeHash, type Route } from '../router'
import { useCanvas } from '../stores/canvas'
import { useSession } from '../stores/session'
import { useTheme } from '../stores/theme'
import { DialogHost } from '../ui/Dialog'
import { mockMatchMedia } from './browser'
import { finishPendingRequests, mockFetch, takeUnhandledRequests } from './fetch'

export { act, fireEvent, screen, waitFor, within } from '@testing-library/react/pure'

const resets = new Set<() => void>()
const queryDefaults = queryClient.getDefaultOptions()

/** 在文件顶层登记用到的领域 store；每条用例前后恢复初值，保留真实 actions。 */
export function resetStoreAfterEach<T>(store: Pick<StoreApi<T>, 'getInitialState' | 'setState'>) {
  resets.add(() => store.setState(store.getInitialState(), true))
}
resetStoreAfterEach(useCanvas)
resetStoreAfterEach(useSession)
resetStoreAfterEach(useTheme)

function resetAppState() {
  mockMatchMedia((query) => query === '(prefers-reduced-motion: reduce)')
  for (const reset of resets) reset()
  useTheme.getState().setPref(useTheme.getInitialState().pref)
  setRoute({ name: 'home' })
  localStorage.clear()
  sessionStorage.clear()
}

function setRoute(route: Route) {
  history.replaceState(null, '', routeHash(route))
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // Testing Library 通过这个兼容入口识别 fake timers，并推进异步查询的等待计时器。
  vi.stubGlobal('jest', { advanceTimersByTime: vi.advanceTimersByTime })
  localStorage.clear()
  sessionStorage.clear()
  queryClient.clear()
  // 命令式 cacheProject/cacheCanvas 也引用这个 client，不能另建一份 Provider 缓存。
  queryClient.setDefaultOptions({
    ...queryDefaults,
    queries: {
      ...queryDefaults.queries,
      retry: false,
      gcTime: Infinity,
      refetchOnWindowFocus: false,
    },
    mutations: { ...queryDefaults.mutations, retry: false },
  })
  act(resetAppState)
  mockFetch()
})

afterEach(async () => {
  try {
    // 即使用例中途失败，也结算 Dialog 模块里的未完成请求，避免污染下一条。
    render(<DialogHost active={false} />)
    cleanup()
    await queryClient.cancelQueries()
    const unfinished = await finishPendingRequests()
    queryClient.clear()
    act(() => {
      useCanvas.getState().notify(null)
      resetAppState()
    })
    localStorage.clear()
    sessionStorage.clear()
    expect(
      [...takeUnhandledRequests(), ...unfinished],
      '请求必须显式 mock 并在用例内结算，不能被组件的错误提示吞掉',
    ).toEqual([])
  } finally {
    queryClient.setDefaultOptions(queryDefaults)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})

interface AppRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  route?: Route
  /** 测试 App 本身时已包含 DialogHost，应关闭这里的附带宿主。 */
  dialogs?: boolean
  wrapper?: RenderOptions['wrapper']
  userOptions?: Parameters<typeof userEvent.setup>[0]
}

/** 只在带 happy-dom 文件头的组件测试中导入；纯逻辑单测不加载这些依赖。 */
export function renderApp(
  ui: ReactElement,
  { route, dialogs = true, wrapper: Wrapper, userOptions, ...options }: AppRenderOptions = {},
) {
  if (route) act(() => setRoute(route))
  const user = userEvent.setup({
    ...(vi.isFakeTimers() ? { advanceTimers: vi.advanceTimersByTimeAsync } : {}),
    ...userOptions,
  })
  const providers = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {Wrapper ? <Wrapper>{children}</Wrapper> : children}
      {dialogs && <DialogHost />}
    </QueryClientProvider>
  )
  return { ...render(ui, { ...options, wrapper: providers }), user, queryClient }
}
