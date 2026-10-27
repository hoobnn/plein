// @vitest-environment happy-dom
import type {
  Project,
  ProjectImportPreview,
  ProjectImportResult,
  ProjectPackageSummary,
} from '@plein/protocol'
import { expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { mockFetch } from '../../testing/fetch'
import { act, fireEvent, renderApp, screen, waitFor, within } from '../../testing/render'
import { useEffect, useState } from 'react'
import { Presence } from '../../ui/Presence'

import { ExportPackageDialog, ImportPackageDialog } from './ProjectPackage'

const project: Project = {
  id: 'p-1',
  title: '导出项目',
  createdAt: 1,
  updatedAt: 1,
  canvases: 2,
  lastCanvasId: 'canvas-1',
}

const summary: ProjectPackageSummary = {
  candidates: 'current',
  canvases: 2,
  checkpoints: 1,
  assets: 3,
  library: 4,
  jobs: 5,
  bytes: 1024,
  missing: [],
  tooLarge: false,
}

const preview = (over: Partial<ProjectImportPreview> = {}): ProjectImportPreview => ({
  token: 'token-1',
  expiresAt: Date.now() + 60_000,
  formatVersion: 2,
  title: '导入的项目',
  candidates: 'current',
  counts: { canvases: 1, assets: 1, library: 0, jobs: 0, bytes: 2048, checkpoints: 0 },
  copy: true,
  remapped: { canvases: 0, library: 0, jobs: 0 },
  reusedLibrary: 0,
  models: [],
  voices: [],
  nodes: [],
  missing: [],
  notices: [],
  ...over,
})

const result: ProjectImportResult = {
  projectId: 'p-2',
  title: '导入的项目（副本）',
  canvasId: 'canvas-9',
}

type Route = (request: Request, url: URL) => Response | Promise<Response> | undefined

const callsOf = (fetch: ReturnType<typeof mockFetch>, method: string, path: string) =>
  fetch.mock.calls.filter(([input, init]) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url, location.href)
    return (init?.method ?? 'GET') === method && url.pathname === path
  }).length

const file = (name = '包.plein') => new File(['bytes'], name)

/** 与首页同构的宿主：Presence 包裹，关闭时真正卸载；换文件时重用同一实例 */
function ImportHost({
  file,
  onImported,
  onClosed,
}: {
  file: File
  onImported(result: ProjectImportResult): void
  onClosed(): void
}) {
  const [open, setOpen] = useState(true)
  // 重新选择文件时再次弹出（首页通过隐藏的 file input 触发）
  useEffect(() => {
    setOpen(true)
  }, [file])
  return (
    <Presence>
      {open && (
        <ImportPackageDialog
          key={file.name}
          file={file}
          onClose={() => {
            setOpen(false)
            onClosed()
          }}
          onImported={onImported}
        />
      )}
    </Presence>
  )
}

async function renderImport(routes: Record<string, Route> = {}, initial?: File) {
  const fetch = mockFetch((request) => {
    const url = new URL(request.url)
    const route = routes[`${request.method} ${url.pathname}`]
    if (route) return route(request, url)
  })
  const onImported = vi.fn()
  const initialFile = initial ?? file()
  const rendered = renderApp(
    <ImportHost file={initialFile} onImported={onImported} onClosed={() => {}} />,
  )
  return {
    fetch,
    onImported,
    user: rendered.user,
    rerenderFile(next: File) {
      rendered.rerender(<ImportHost file={next} onImported={onImported} onClosed={() => {}} />)
    },
    unmount: () => rendered.unmount(),
  }
}

it('预检失败可直接重新校验同一文件，取消预览不导入', async () => {
  let fail = true
  const f = await renderImport({
    'POST /api/project-imports': () =>
      fail ? Response.json({ message: '预检暂不可用' }, { status: 503 }) : Response.json(preview()),
    'DELETE /api/project-imports/token-1': () => new Response(null, { status: 204 }),
  })
  const error = await screen.findByRole('dialog', { name: '无法导入' })
  expect(error.textContent).toContain('预检暂不可用')
  fail = false
  await f.user.click(within(error).getByRole('button', { name: '重新校验' }))
  const dialog = await screen.findByRole('dialog', { name: '导入「导入的项目」' })
  expect(dialog.textContent).toContain('会作为副本导入')
  await f.user.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(callsOf(f.fetch, 'POST', '/api/project-imports/token-1')).toBe(0)
  expect(f.onImported).not.toHaveBeenCalled()
})

it('损坏的包说明具体错误，不提供反复校验同一坏文件的入口', async () => {
  const f = await renderImport({
    'POST /api/project-imports': () =>
      Response.json({ message: '这不是一个项目包：请选择 .plein 文件' }, { status: 422 }),
  })
  const error = await screen.findByRole('dialog', { name: '无法导入' })
  expect(error.textContent).toContain('这不是一个项目包')
  expect(within(error).queryByRole('button', { name: '重新校验' })).toBeNull()
  await f.user.click(within(error).getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(callsOf(f.fetch, 'POST', '/api/project-imports')).toBe(1)
})

it('确认导入中不能取消或重复确认，完成后只导入一次', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  const f = await renderImport({
    'POST /api/project-imports': () => Response.json(preview()),
    'POST /api/project-imports/token-1': () => held,
  })
  const dialog = await screen.findByRole('dialog', { name: '导入「导入的项目」' })
  const confirm = within(dialog).getByRole('button', { name: '作为副本导入' })
  act(() => {
    confirm.click()
    confirm.click()
  })
  await waitFor(() => expect(callsOf(f.fetch, 'POST', '/api/project-imports/token-1')).toBe(1))
  expect((within(dialog).getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.getByRole('dialog', { name: '导入「导入的项目」' })).toBe(dialog)
  await act(async () => release(Response.json(result)))
  await waitFor(() => expect(f.onImported).toHaveBeenCalledExactlyOnceWith(result))
  expect(callsOf(f.fetch, 'POST', '/api/project-imports/token-1')).toBe(1)
})

it('确认响应丢失显示未确认状态，说明下一步且不再校验', async () => {
  const f = await renderImport({
    'POST /api/project-imports': () => Response.json(preview()),
    'POST /api/project-imports/token-1': () =>
      Response.json({ message: '未收到导入确认' }, { status: 503 }),
    'DELETE /api/project-imports/token-1': () => new Response(null, { status: 204 }),
  })
  const dialog = await screen.findByRole('dialog', { name: '导入「导入的项目」' })
  await f.user.click(within(dialog).getByRole('button', { name: '作为副本导入' }))
  const unknown = await screen.findByRole('dialog', { name: '导入未获确认' })
  expect(unknown.textContent).toContain('请先在首页检查是否已经导入')
  expect(within(unknown).queryByRole('button', { name: '重新校验' })).toBeNull()
  await f.user.click(within(unknown).getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(f.onImported).not.toHaveBeenCalled()
  expect(callsOf(f.fetch, 'POST', '/api/project-imports/token-1')).toBe(1)
})

it('离开导入页面后迟到的成功只提示，不把用户带离当前画布', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  const f = await renderImport({
    'POST /api/project-imports': () => Response.json(preview()),
    'POST /api/project-imports/token-1': () => held,
  })
  const dialog = await screen.findByRole('dialog', { name: '导入「导入的项目」' })
  await f.user.click(within(dialog).getByRole('button', { name: '作为副本导入' }))
  await waitFor(() => expect(callsOf(f.fetch, 'POST', '/api/project-imports/token-1')).toBe(1))
  f.unmount()
  await act(async () => release(Response.json(result)))
  await waitFor(() => expect(useCanvas.getState().notice).toBe('已导入项目「导入的项目（副本）」'))
  expect(f.onImported).not.toHaveBeenCalled()
  expect(location.hash).toBe('#/')
})

it('取消预检后迟到的临时结果会释放，不重新打开预览', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  const discards: string[] = []
  const f = await renderImport({
    'POST /api/project-imports': () => held,
    'DELETE /api/project-imports/token-1': () => {
      discards.push('token-1')
      return new Response(null, { status: 204 })
    },
  })
  // 预检挂起时从「导入项目包」窗口取消
  const checking = await screen.findByRole('dialog', { name: '导入项目包' })
  await f.user.click(within(checking).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await act(async () => release(Response.json(preview())))
  // 迟到的预检结果只触发释放令牌，不再弹预览
  await waitFor(() => expect(discards).toEqual(['token-1']))
  await act(async () => {})
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(callsOf(f.fetch, 'POST', '/api/project-imports/token-1')).toBe(0)
})

it('取消后立即换文件：旧预检不覆盖新预览，取消新文件释放新令牌', async () => {
  let releaseOld!: (r: Response) => void
  const oldHeld = new Promise<Response>((resolve) => {
    releaseOld = resolve
  })
  let inspected = 0
  const discards: string[] = []
  const f = await renderImport({
    'POST /api/project-imports': () => {
      inspected++
      return inspected === 1
        ? oldHeld
        : Response.json(preview({ token: 'token-2', title: '第二个项目' }))
    },
    'DELETE /api/project-imports/token-1': () => {
      discards.push('token-1')
      return new Response(null, { status: 204 })
    },
    'DELETE /api/project-imports/token-2': () => {
      discards.push('token-2')
      return new Response(null, { status: 204 })
    },
  })
  const checking = await screen.findByRole('dialog', { name: '导入项目包' })
  await f.user.click(within(checking).getByRole('button', { name: '取消' }))
  f.rerenderFile(file('另一个项目.plein'))
  const next = await screen.findByRole('dialog', { name: '导入「第二个项目」' })
  // 旧文件的预检结果迟到：只释放旧令牌，不动新预览
  await act(async () => releaseOld(Response.json(preview())))
  await waitFor(() => expect(discards).toContain('token-1'))
  expect(screen.getByRole('dialog', { name: '导入「第二个项目」' })).toBe(next)
  await f.user.click(within(next).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(discards).toEqual(['token-1', 'token-2']))
  expect(callsOf(f.fetch, 'POST', '/api/project-imports/token-2')).toBe(0)
})

it('历史候选开关切换统计请求，导出 URL 带上范围参数', async () => {
  const summaryUrls: string[] = []
  let history = false
  mockFetch((request) => {
    const url = new URL(request.url)
    if (
      request.method === 'GET' &&
      url.pathname === `/api/projects/${project.id}/package/summary`
    ) {
      if (url.searchParams.get('history') === '1') history = true
      summaryUrls.push(`${url.pathname}${url.search}`)
      return Response.json({ ...summary, assets: history ? 2 : 1 })
    }
  })
  // 拦截下载锚点：导出按钮点击后核对它请求的 URL（happy-dom 里导航是空操作）
  const hrefs: string[] = []
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    hrefs.push(this.href)
  })
  renderApp(<ExportPackageDialog project={project} onClose={() => {}} />)
  const dialog = await screen.findByRole('dialog', { name: '导出项目包' })
  await waitFor(() => expect(dialog.textContent).toContain('1 个素材'))
  // 打开历史候选：统计按 history=1 重新请求
  within(dialog).getByRole('switch', { name: '包含历史候选' }).click()
  await waitFor(() => expect(dialog.textContent).toContain('2 个素材'))
  expect(summaryUrls).toEqual([
    `/api/projects/${project.id}/package/summary`,
    `/api/projects/${project.id}/package/summary?history=1`,
  ])
  within(dialog).getByRole('button', { name: '导出' }).click()
  // 下载地址与统计范围一致：带上 history=1
  expect(hrefs).toEqual([
    new URL(`/api/projects/${project.id}/package?history=1`, location.href).href,
  ])
  click.mockRestore()
})

it('导出统计失败可重试，恢复后展示范围且导出可用', async () => {
  let fail = true
  const fetch = mockFetch((request) => {
    const url = new URL(request.url)
    if (
      request.method === 'GET' &&
      url.pathname === `/api/projects/${project.id}/package/summary`
    ) {
      if (fail) return Response.json({ message: '项目统计暂不可用' }, { status: 503 })
      return Response.json(summary)
    }
  })
  renderApp(<ExportPackageDialog project={project} onClose={() => {}} />)
  const dialog = await screen.findByRole('dialog', { name: '导出项目包' })
  await waitFor(() => expect(dialog.textContent).toContain('读取失败：项目统计暂不可用'))
  expect((within(dialog).getByRole('button', { name: '导出' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  fail = false
  within(dialog).getByRole('button', { name: '重新统计' }).click()
  await waitFor(() => expect(dialog.textContent).toContain('3 个素材'))
  expect(dialog.textContent).not.toContain('读取失败')
  expect((within(dialog).getByRole('button', { name: '导出' }) as HTMLButtonElement).disabled).toBe(
    false,
  )
  void fetch
})
