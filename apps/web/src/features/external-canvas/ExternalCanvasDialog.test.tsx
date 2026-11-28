// @vitest-environment happy-dom
import { API, LOCAL_PRINCIPAL, type ExternalRow } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { EditorActions } from '../../shell/EditorActions'
import { useSession } from '../../stores/session'
import { mockFetch } from '../../testing/fetch'
import { renderApp, screen, within } from '../../testing/render'
import { ExternalCanvasDialog } from './ExternalCanvasDialog'

const canvasId = 'canvas'
const target = '074af812-57ec-45ea-a82f-e41998cf3252'
const revision = 'a'.repeat(64)
const ref = { provider: 'jimeng-canvas', target }
const conflict: ExternalRow = {
  references: [{ label: '角色图', usage: 'firstFrame', sourceId: 'remote-picture' }],
  rowId: 'local/one',
  revision,
  kind: 'text',
  state: 'conflict',
  localId: 'one',
  remoteId: 'two',
  local: { title: '旁白', text: '第一稿', position: { x: 0, y: 40 } },
  remote: { title: '旁白', text: '第二稿', position: { x: 30, y: 40 } },
  actions: ['pull', 'push', 'unlink'],
}

it('从编辑器打开全能画布，选项目，比对双方正文和坐标，将指定修订推送到已选目标', async () => {
  let applied: Record<string, unknown> | null = null
  const previews: string[] = []
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (path === API.externalCanvas(canvasId, 'targets')) return Response.json([ref])
    if (path === API.externalCanvas(canvasId, 'projects'))
      return Response.json([{ id: target, title: '秋日' }])
    if (path === API.externalCanvas(canvasId, 'preview')) {
      previews.push((await request.json()).target)
      return Response.json({
        ...ref,
        rows: [applied ? { ...conflict, state: 'synced', actions: ['unlink'] } : conflict],
      })
    }
    if (path === API.externalCanvas(canvasId, 'apply')) {
      applied = await request.json()
      return new Response(null, { status: 204 })
    }
  })
  useSession.setState({
    status: 'ready',
    info: {
      principal: LOCAL_PRINCIPAL,
      authRequired: false,
      needsSetup: false,
      externalCanvas: true,
    },
  })
  const { user } = renderApp(<EditorActions remote canvasId={canvasId} onOpenSettings={() => {}} />)
  await user.click(screen.getByRole('button', { name: '即梦同步' }))
  expect(screen.getByRole('combobox', { name: '创作平台' }).textContent).toContain('即梦全能画布')
  await user.click(screen.getByRole('button', { name: '我的即梦项目' }))
  await user.click(await screen.findByRole('combobox', { name: '我的即梦项目' }))
  await user.click(await screen.findByRole('option', { name: '秋日' }))
  await user.click(screen.getByRole('button', { name: '读取差异' }))
  const diff = await screen.findByRole('region', { name: '节点差异' })
  expect(within(diff).getByText('第一稿')).toBeTruthy()
  expect(within(diff).getByText('第二稿')).toBeTruthy()
  expect(within(diff).getByText('坐标 0, 40')).toBeTruthy()
  expect(within(diff).getByRole('region', { name: '即梦引用' }).textContent).toContain(
    '角色图 · 首帧remote-picture',
  )
  await user.click(within(diff).getByRole('button', { name: '用 Plein 版本更新即梦' }))
  expect(await screen.findByText('已完成「用 Plein 版本更新即梦」')).toBeTruthy()
  expect(applied).toMatchObject({ ...ref, rowId: 'local/one', action: 'push', revision })
  expect(previews).toEqual([target, target])
})

it('待核对的创建只允许手动指定即梦节点；失败后旧版本不能重复提交', async () => {
  const calls: unknown[] = []
  const pending = {
    ...conflict,
    state: 'pending',
    remoteId: null,
    remote: null,
    actions: ['reconcile', 'unlink'],
  }
  const candidate = {
    ...conflict,
    rowId: 'remote/two',
    state: 'remote-only',
    localId: null,
    local: null,
    actions: ['pull'],
  }
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (path === API.externalCanvas(canvasId, 'targets')) return Response.json([])
    if (path === API.externalCanvas(canvasId, 'preview'))
      return Response.json({ ...ref, rows: [pending, candidate] })
    if (path === API.externalCanvas(canvasId, 'apply')) {
      calls.push(await request.json())
      return Response.json({ message: '远端内容已变化，请重新读取' }, { status: 409 })
    }
  })
  const { user } = renderApp(<ExternalCanvasDialog canvasId={canvasId} onClose={() => {}} />)
  await user.type(screen.getByRole('textbox', { name: '即梦项目链接或 ID' }), target)
  await user.click(screen.getByRole('button', { name: '读取差异' }))
  const reconcile = await screen.findByRole<HTMLButtonElement>('button', {
    name: '关联已核对的节点',
  })
  expect(reconcile.disabled).toBe(true)
  expect(screen.queryByRole('button', { name: '在即梦创建' })).toBeNull()
  await user.click(screen.getByRole('combobox', { name: '待核对的即梦节点' }))
  await user.click(await screen.findByRole('option', { name: '旁白 · two' }))
  expect(reconcile.disabled).toBe(false)
  await user.click(reconcile)
  expect((await screen.findByRole('alert')).textContent).toContain('远端内容已变化')
  expect(calls).toEqual([
    { ...ref, action: 'reconcile', rowId: pending.rowId, revision, remoteId: 'two' },
  ])
  expect(screen.queryByRole('button', { name: '关联已核对的节点' })).toBeNull()
})

it('导入新增节点只提交即梦独有的条目及各自的预览版本', async () => {
  let imported: unknown
  const only = {
    ...conflict,
    state: 'remote-only',
    rowId: 'remote/two',
    remoteId: 'only-two',
    remote: { title: '片尾', text: '落幕' },
    localId: null,
    local: null,
    actions: ['pull'],
  }
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (path === API.externalCanvas(canvasId, 'targets')) return Response.json([])
    if (path === API.externalCanvas(canvasId, 'preview'))
      return Response.json({
        ...ref,
        rows: imported
          ? [{ ...only, rowId: 'local/new', localId: 'new', local: only.remote, state: 'synced' }]
          : [
              conflict,
              only,
              {
                ...only,
                rowId: 'remote/hidden',
                remoteId: 'hidden',
                remote: { title: '旅途', text: '出发' },
              },
            ],
      })
    if (path === API.externalCanvas(canvasId, 'pull-new')) {
      imported = await request.json()
      return Response.json({ imported: 1 })
    }
  })
  const { user } = renderApp(<ExternalCanvasDialog canvasId={canvasId} onClose={() => {}} />)
  await user.type(screen.getByLabelText('即梦项目链接或 ID'), target)
  await user.click(screen.getByRole('button', { name: '读取差异' }))
  const search = await screen.findByRole('searchbox', { name: '查找同步节点' })
  await user.type(search, '无此节点')
  expect(await screen.findByText('没有匹配的节点')).toBeTruthy()
  expect(screen.queryByRole('region', { name: '节点差异' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '清除筛选' }))
  await user.click(screen.getByRole('combobox', { name: '同步状态' }))
  await user.click(await screen.findByRole('option', { name: '仅即梦有（2）' }))
  await user.type(search, '落幕')
  expect(screen.getByRole('region', { name: '节点差异' }).textContent).toContain('落幕')
  await user.click(screen.getByRole('checkbox', { name: '选择导入「片尾」' }))
  await user.clear(search)
  await user.type(search, '出发')
  expect(screen.getByText('含当前筛选外的 1 项')).toBeTruthy()
  expect(screen.getByRole('region', { name: '节点差异' }).textContent).toContain('旅途')
  expect(imported).toBeUndefined()
  await user.click(await screen.findByRole('button', { name: '导入所选（1）' }))
  expect(await screen.findByText('已导入 1 个即梦节点')).toBeTruthy()
  expect(imported).toEqual({ ...ref, rows: [{ rowId: 'remote/two', revision }] })
  expect(screen.getByRole('region', { name: '节点差异' }).textContent).toContain('片尾')
  expect(screen.getByRole('link', { name: '打开即梦画布' }).getAttribute('href')).toBe(
    'https://jimeng.jianying.com/ai-tool/ai-canvas/' + target,
  )
})

it('在多份即梦素材中显式选定版本，再用所选本地素材替换同一版本', async () => {
  const localId = 'c'.repeat(64)
  const calls: unknown[] = []
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (path === API.externalCanvas(canvasId, 'targets')) return Response.json([])
    if (path === API.externalCanvas(canvasId, 'preview'))
      return Response.json({ ...ref, rows: [{ ...conflict, kind: 'image' }] })
    if (path.endsWith('/media/list'))
      return Response.json([
        { nodeId: 'two', assetId: 'v1', kind: 'image', title: '第一版' },
        { nodeId: 'two', assetId: 'v2', kind: 'image', title: '第二版', replaceable: true },
        { nodeId: 'other', assetId: 'v3', kind: 'image', title: '别的镜头' },
      ])
    if (path === '/api/assets')
      return Response.json({
        items: [{ id: localId, kind: 'image', name: '定稿' }],
        nextCursor: null,
      })
    if (path.endsWith('/media/replace')) {
      calls.push(await request.json())
      return Response.json({ assetId: 'v4' })
    }
  })
  const { user } = renderApp(<ExternalCanvasDialog canvasId={canvasId} onClose={() => {}} />)
  await user.type(screen.getByLabelText('即梦项目链接或 ID'), target)
  await user.click(screen.getByRole('button', { name: '读取差异' }))
  const remote = await screen.findByRole('combobox', { name: '即梦候选素材' })
  expect(screen.queryByRole('button', { name: '将此素材导入 Plein' })).toBeNull()
  await user.click(remote)
  expect(screen.queryByRole('option', { name: /别的镜头/ })).toBeNull()
  await user.click(await screen.findByRole('option', { name: '第二版 · v2' }))
  await user.click(screen.getByRole('button', { name: '选择 Plein 素材替换' }))
  await user.click(await screen.findByRole('combobox', { name: 'Plein 素材' }))
  await user.click(await screen.findByRole('option', { name: /定稿/ }))
  await user.click(screen.getByRole('button', { name: '替换即梦当前素材' }))
  expect(await screen.findByText('已替换即梦素材')).toBeTruthy()
  expect(calls).toEqual([{ ...ref, assetId: 'v2', nodeId: 'two', localAssetId: localId }])
})
