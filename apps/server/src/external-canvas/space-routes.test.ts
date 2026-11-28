import { API } from '@plein/protocol'
import { beforeEach, expect, it, vi } from 'vite-plus/test'
import { bootServer, createCanvas, request } from '../testing'
import { runCli } from './cli'

vi.mock('./cli', () => ({ runCli: vi.fn() }))

const cli = vi.mocked(runCli)
beforeEach(() => {
  cli.mockReset()
})

const fixture = async () => {
  const { server } = await bootServer()
  const { id } = await createCanvas(server)
  return (op: 'spaces' | 'projects', body: unknown, canvas = id) =>
    request(server, API.externalCanvas(canvas, op), {
      method: 'POST',
      body: JSON.stringify(body),
    })
}

it('只把已通过协议校验的空间 ID 字符串交给短剧适配器，省略沿用当前空间', async () => {
  const send = await fixture()
  const provider = 'jimeng-novel'
  cli.mockResolvedValueOnce(
    JSON.stringify({
      status: 'success',
      data: { spaces: [{ team_id: 0, name: '个人空间', current: true }] },
    }),
  )
  expect(await (await send('spaces', { provider })).json()).toEqual([
    { id: '0', title: '个人空间', current: true },
  ])
  expect(cli.mock.calls.at(-1)?.[1].slice(0, 2)).toEqual(['space', 'list'])
  for (const space of [undefined, '0', '99999999999999999999']) {
    cli.mockResolvedValueOnce(
      JSON.stringify({
        status: 'success',
        context: { teamId: space },
        data: { items: [{ projectId: '1001', name: '剧本' }] },
      }),
    )
    expect(await (await send('projects', { provider, space })).json()).toEqual([
      { id: space === undefined ? '1001' : space + '/1001', title: '剧本' },
    ])
    const args = cli.mock.calls.at(-1)![1]
    if (space === undefined) expect(args).not.toContain('--team-id')
    else expect(args[args.indexOf('--team-id') + 1]).toBe(space)
  }
})

it('拒绝无效类型、溢长、非规范 ID 和多余参数，并沿用画布所有权检查', async () => {
  const send = await fixture()
  for (const space of [0, null, '', '--team-id', '-1', '01', '1\n', '1'.repeat(21)]) {
    expect((await send('projects', { provider: 'jimeng-novel', space })).status).toBe(400)
  }
  expect((await send('spaces', { provider: 'jimeng-novel', space: '0' })).status).toBe(400)
  expect((await send('projects', { provider: 'jimeng-novel', teamId: '5' })).status).toBe(400)
  expect((await send('spaces', { provider: 'jimeng-novel' }, 'missing')).status).toBe(404)
  expect(runCli).not.toHaveBeenCalled()
})

it('平台未声明空间接口时不能查询空间目录或指定空间，但原项目列表仍可用', async () => {
  const send = await fixture()
  expect((await send('spaces', { provider: 'jimeng-canvas' })).status).toBe(422)
  expect((await send('projects', { provider: 'jimeng-canvas', space: '0' })).status).toBe(422)
  expect(runCli).not.toHaveBeenCalled()
  vi.mocked(runCli).mockResolvedValueOnce(
    JSON.stringify({ ok: true, data: { items: [], hasMore: false } }),
  )
  expect(await (await send('projects', { provider: 'jimeng-canvas' })).json()).toEqual([])
})
