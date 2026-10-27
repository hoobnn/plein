// @vitest-environment happy-dom
import {
  type Canvas,
  type Catalog,
  CreateLibraryItem,
  type LibraryItem,
  type Project,
} from '@plein/protocol'
import { expect, it, vi } from 'vite-plus/test'
import { queryClient, queryKeys } from '../api/query'
import { LibraryPanel } from '../features/library/Library'
import { useLibrary } from '../features/library/store'
import { useTemplates } from '../features/templates/store'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { mockFetch } from '../testing/fetch'
import { act, renderApp, resetStoreAfterEach, screen, waitFor } from '../testing/render'
import { Editor } from './Editor'

// 元信息、项目归属和资产编辑均走真实组件；只隔离 GPU 与协作文档宿主。
vi.mock('../canvas/CanvasView', () => ({ CanvasView: () => null }))
resetStoreAfterEach(useLibrary)
resetStoreAfterEach(useCatalog)
resetStoreAfterEach(useTemplates)

const canvas: Canvas = {
  id: 'canvas-library',
  projectId: 'project-library',
  title: '当前画布',
  createdAt: 1,
  updatedAt: 1,
}
const project: Project = {
  id: canvas.projectId,
  title: '当前项目',
  canvases: 1,
  lastCanvasId: canvas.id,
  createdAt: 1,
  updatedAt: 1,
}
const catalog: Catalog = {
  plugins: [],
  nodes: [],
  providers: [],
  defaultModels: {},
  templates: [],
  prompts: [],
  elements: [],
}

it.each(['恢复', '缓存'] as const)(
  '画布元信息%s后，新建角色默认归属当前项目并提交真实请求',
  async (mode) => {
    let release!: (response: Response) => void
    const writes: CreateLibraryItem[] = []
    const items: LibraryItem[] = []
    mockFetch(async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === 'GET') {
        if (path === `/api/canvases/${canvas.id}`)
          return new Promise<Response>((resolve) => {
            release = resolve
          })
        if (path === '/api/catalog') return Response.json(catalog)
        if (path === '/api/templates' || path === '/api/voices') return Response.json([])
        if (path === '/api/library') return Response.json(items)
        if (path === '/api/projects') return Response.json([project])
        if (path === `/api/projects/${project.id}`) return Response.json(project)
        if (path === `/api/projects/${project.id}/canvases`) return Response.json([canvas])
      }
      if (request.method === 'POST' && path === '/api/library') {
        const body = (await request.json()) as CreateLibraryItem
        writes.push(body)
        const parsed = CreateLibraryItem.parse(body)
        const item: LibraryItem = {
          ...parsed,
          videoCompositionSource: parsed.videoCompositionSource ?? undefined,
          id: 'created-character',
          favorite: false,
          usedAt: null,
          createdAt: 1,
          updatedAt: 1,
        }
        items.push(item)
        return Response.json(item, { status: 201 })
      }
    })
    if (mode === '缓存')
      queryClient.setQueryData(queryKeys.canvas(canvas.id), canvas, { updatedAt: 1 })
    useCanvas.setState({ canvasId: canvas.id })
    const view = renderApp(
      <>
        <Editor source={{ kind: 'remote', canvasId: canvas.id }} onOpenSettings={() => {}} />
        <LibraryPanel />
      </>,
      {
        route: { name: 'canvas', id: canvas.id },
      },
    )
    await waitFor(() => expect(release).toBeTypeOf('function'))
    if (mode === '缓存') {
      await act(async () => {
        release(Response.json({ message: '刷新失败' }, { status: 503 }))
      })
      await screen.findByRole('button', { name: '画布信息刷新失败' })
    } else {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '检查点' }).disabled).toBe(true)
      await act(async () => {
        release(Response.json({ message: '读取失败' }, { status: 503 }))
      })
      await view.user.click(await screen.findByRole('button', { name: '画布信息加载失败' }))
      await view.user.click(screen.getByRole('button', { name: '重新加载画布信息' }))
      await act(async () => {
        release(Response.json(canvas))
      })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '检查点' }).disabled).toBe(false)
    act(() => useLibrary.getState().show('character'))
    await view.user.click(screen.getAllByRole('button', { name: '新建角色' })[0]!)
    await view.user.click(screen.getByRole('button', { name: '基础设定' }))
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /归到当前项目/ }).checked).toBe(
      true,
    )
    await view.user.type(screen.getByRole('textbox', { name: '名称' }), '雨后角色')
    await view.user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ kind: 'character', name: '雨后角色', projectId: project.id })
    expect(useLibrary.getState().items).toHaveLength(1)
    view.unmount()
    expect(useLibrary.getState().projectId).toBeNull()
  },
)
