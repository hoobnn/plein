// @vitest-environment happy-dom
import { API, type ExternalRow } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { renderApp, screen, within } from '../../testing/render'
import { ExternalCanvasDialog } from './ExternalCanvasDialog'

const canvasId = 'canvas'
const ref = { provider: 'jimeng-canvas', target: '1080b87f-6542-42b8-b114-f6ea0cbb082b' }
const source: ExternalRow = {
  localId: 'p-one',
  remoteId: 'remote-source',
  rowId: 'local/p-one',
  revision: '1'.repeat(64),
  kind: 'text',
  state: 'remote-changed',
  local: { title: '城门', text: 'Plein 的城门设定' },
  remote: { title: '城门', text: '即梦的新设定' },
  actions: ['pull', 'unlink'],
}
async function openPreview() {
  const { user } = renderApp(<ExternalCanvasDialog canvasId={canvasId} onClose={() => {}} />)
  await user.type(screen.getByRole('textbox', { name: '即梦项目链接或 ID' }), ref.target)
  await user.click(screen.getByRole('button', { name: '读取差异' }))
  await screen.findByRole('region', { name: '节点差异' })
  return user
}

it('从受筛选分镜定位真实来源，返回时恢复原搜索及焦点；同名与外部引用不能误配', async () => {
  const shot: ExternalRow = {
    ...source,
    rowId: 'local/shot',
    localId: 'p-shot',
    remoteId: 'r-shot',
    local: { title: '夜街分镜', text: '出城' },
    references: [
      { label: '开场', usage: 'firstFrame', sourceId: 'remote-source' },
      { label: '外部素材', usage: 'lastFrame', sourceId: 'unavailable' },
      { label: '城门', usage: 'reference' },
    ],
  }
  mockFetch((req) => {
    const path = new URL(req.url).pathname
    if (path === API.externalCanvas(canvasId, 'targets')) return Response.json([])
    if (path === API.externalCanvas(canvasId, 'preview'))
      return Response.json({
        ...ref,
        rows: [
          shot,
          {
            ...source,
            rowId: 'local/another',
            localId: 'remote-source',
            remoteId: 'other-id',
            remote: { title: '城门', text: '另一份同名设定' },
          },
          source,
        ],
      })
  })
  const user = await openPreview()
  const search = screen.getByRole<HTMLInputElement>('searchbox', { name: '查找同步节点' })
  await user.type(search, '夜街')
  const references = screen.getByRole('region', { name: '即梦引用' })
  expect(within(references).getAllByRole('button')).toHaveLength(1)
  await user.click(within(references).getByRole('button', { name: '查看来源「开场」' }))
  const detail = screen.getByRole('region', { name: '节点差异' })
  expect(detail.textContent).toContain('Plein 的城门设定')
  expect(detail.textContent).toContain('即梦的新设定')
  expect(detail.textContent).not.toContain('另一份同名设定')
  expect(document.activeElement).toBe(within(detail).getByRole('heading', { name: '城门' }))
  await user.click(within(detail).getByRole('button', { name: '返回「夜街分镜」' }))
  expect(search.value).toBe('夜街')
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '查看来源「开场」' }))
})

it('合并前呈现服务端核算的标题、正文及位置，执行仅提交所见修订', async () => {
  const merged = { title: '现场勘景', text: '即梦更新的说明', position: { x: 20, y: 0 } }
  const row: ExternalRow = {
    ...source,
    state: 'mergeable',
    local: { title: merged.title, text: '旧说明', position: merged.position },
    remote: { title: '城门', text: merged.text, position: { x: 0, y: 0 } },
    merged,
    actions: ['merge', 'pull', 'push', 'unlink'],
  }
  let submitted: unknown
  mockFetch(async (req) => {
    const path = new URL(req.url).pathname
    if (path === API.externalCanvas(canvasId, 'targets')) return Response.json([])
    if (path === API.externalCanvas(canvasId, 'preview'))
      return Response.json({
        ...ref,
        rows: [
          submitted
            ? { ...row, state: 'synced', local: merged, remote: merged, actions: ['unlink'] }
            : row,
        ],
      })
    if (path === API.externalCanvas(canvasId, 'apply')) {
      submitted = await req.json()
      return new Response(null, { status: 204 })
    }
  })
  const user = await openPreview()
  const preview = screen.getByRole('region', { name: '合并结果预览' })
  expect(within(preview).getByText('现场勘景')).toBeTruthy()
  expect(within(preview).getByText('即梦更新的说明')).toBeTruthy()
  expect(within(preview).getByText('坐标 20, 0')).toBeTruthy()
  expect(screen.getByText(/合并会把预览结果写入两边/)).toBeTruthy()
  expect(screen.getByRole('button', { name: '用即梦版本更新 Plein' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '用 Plein 版本更新即梦' })).toBeTruthy()
  expect(submitted).toBeUndefined()
  await user.click(screen.getByRole('button', { name: '合并两端改动' }))
  expect(await screen.findByText('已完成「合并两端改动」')).toBeTruthy()
  expect(submitted).toEqual({ ...ref, rowId: row.rowId, revision: row.revision, action: 'merge' })
  expect(screen.queryByRole('region', { name: '合并结果预览' })).toBeNull()
})

it('长剧本新增台词时显示真实差异边界，也能展开查看全文', async () => {
  const start = ['场一', '清晨', '站台']
  const end = ['列车远去', '本场完']
  const prior = [...start, ...end].join('\n')
  const next = [...start, '林岚：车来了。', ...end].join('\n')
  mockFetch((req) => {
    if (req.url.endsWith('/targets')) return Response.json([])
    if (req.url.endsWith('/preview'))
      return Response.json({
        ...ref,
        rows: [
          {
            ...source,
            local: { title: '第一集', text: prior },
            remote: { title: '第一集', text: next },
          },
        ],
      })
  })
  const user = await openPreview()
  const local = within(screen.getByRole('region', { name: 'Plein' }))
  const remote = within(screen.getByRole('region', { name: '即梦' }))
  expect(local.getByText('（此处无对应行）')).toBeTruthy()
  expect(remote.getByText('前 3 行相同')).toBeTruthy()
  expect(remote.getByText('后 2 行相同')).toBeTruthy()
  expect(remote.getByText('林岚：车来了。')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '展开完整正文' }))
  expect(remote.getByText((_, el) => el?.tagName === 'P' && el.textContent === next)).toBeTruthy()
})
