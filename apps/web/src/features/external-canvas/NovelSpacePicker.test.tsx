// @vitest-environment happy-dom
import { API, externalAuthPath } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { renderApp, screen } from '../../testing/render'
import { ExternalCanvasDialog } from './ExternalCanvasDialog'

const id = 'canvas'
const provider = 'jimeng-novel'
const spaces = [
  { id: '0', title: '个人空间', current: true },
  { id: '9876543210123456789', title: '联合创作', current: false },
]
const team = spaces[1]!.id
const scoped = team + '/12345'

async function renderNovelDialog() {
  const { user } = renderApp(<ExternalCanvasDialog canvasId={id} onClose={() => {}} />)
  expect(screen.queryByRole('button', { name: '选择短剧空间' })).toBeNull()
  await user.click(screen.getByRole('combobox', { name: '创作平台' }))
  await user.click(screen.getByRole('option', { name: '即梦短剧' }))
  return user
}

it('只在展开后获取空间，切换空间清除旧差异并保留可预览的完整团队项目 ID', async () => {
  const reads: unknown[] = []
  mockFetch(async (req) => {
    const path = new URL(req.url).pathname
    if (path === API.externalCanvas(id, 'targets')) return Response.json([])
    const op = path.split('/').at(-1)
    const body = await req.json()
    reads.push({ op, ...body })
    if (op === 'spaces') return Response.json(spaces)
    if (op === 'projects')
      return Response.json([{ id: body.space ? scoped : '12345', title: '第一集' }])
    if (op === 'preview')
      return Response.json({
        ...body,
        rows: [
          {
            rowId: 'remote/1',
            revision: 'a'.repeat(64),
            kind: 'text',
            state: 'remote-only',
            localId: null,
            local: null,
            remoteId: '1',
            remote: { title: '场记', text: '晨光' },
            actions: ['pull'],
          },
        ],
      })
  })
  const user = await renderNovelDialog()
  const choose = async (name: string, option: string) => {
    await user.click(await screen.findByRole('combobox', { name }))
    await user.click(screen.getByRole('option', { name: option }))
  }
  await user.click(screen.getByRole('button', { name: '我的即梦项目' }))
  await choose('我的即梦项目', '第一集')
  await user.click(screen.getByRole('button', { name: '读取差异' }))
  await user.click(await screen.findByRole('checkbox', { name: '选择导入「场记」' }))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '导入所选（1）' }).disabled).toBe(
    false,
  )
  expect(reads).toEqual([
    { op: 'projects', provider },
    { op: 'preview', provider, target: '12345' },
  ])
  await user.click(screen.getByRole('button', { name: '选择短剧空间' }))
  await choose('短剧空间', '联合创作')
  expect(screen.queryByRole('button', { name: '导入所选（1）' })).toBeNull()
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '即梦项目链接或 ID' }).value).toBe(
    '',
  )
  await choose('我的即梦项目', '第一集')
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '即梦项目链接或 ID' }).value).toBe(
    scoped,
  )
  await user.click(screen.getByRole('button', { name: '读取差异' }))
  await screen.findByRole('region', { name: '节点差异' })
  await choose('短剧空间', '个人空间（当前）')
  await screen.findByRole('combobox', { name: '我的即梦项目' })
  await choose('创作平台', '即梦全能画布')
  expect(screen.queryByRole('combobox', { name: '我的即梦项目' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: '短剧空间' })).toBeNull()
  expect(reads.slice(2)).toEqual([
    { op: 'spaces', provider },
    { op: 'projects', provider, space: team },
    { op: 'preview', provider, target: scoped },
    { op: 'projects', provider, space: '0' },
  ])
})

it.each(['spaces', 'projects'])('授权完成后只重读原来的 %s 请求和空间', async (failed) => {
  let signedIn = false
  const calls: unknown[] = []
  mockFetch(async (req) => {
    const path = new URL(req.url).pathname
    if (path === API.externalCanvas(id, 'targets')) return Response.json([])
    const op = path.split('/').at(-1)
    calls.push({ op, ...(await req.json()) })
    if (path === externalAuthPath(id, 'start')) {
      signedIn = true
      return Response.json({ status: 'authenticated' })
    }
    if (!signedIn && op === failed) return Response.json({ message: '需要登录' }, { status: 422 })
    if (op === 'spaces') return Response.json(spaces)
    if (op === 'projects') return Response.json([{ id: scoped, title: '第二集' }])
  })
  const user = await renderNovelDialog()
  await user.click(screen.getByRole('button', { name: '选择短剧空间' }))
  if (failed === 'projects') {
    await user.click(await screen.findByRole('combobox', { name: '短剧空间' }))
    await user.click(screen.getByRole('option', { name: '联合创作' }))
  }
  await user.click(await screen.findByRole('button', { name: '连接即梦账号' }))
  await screen.findByRole('combobox', { name: failed === 'spaces' ? '短剧空间' : '我的即梦项目' })
  const listing = { op: 'projects', provider, space: team }
  const directory = { op: 'spaces', provider }
  const start = { op: 'start', provider }
  expect(calls).toEqual(
    failed === 'spaces' ? [directory, start, directory] : [directory, listing, start, listing],
  )
})
