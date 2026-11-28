import { readFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { setText } from '@plein/doc'
import { API, externalMediaPath, type ExternalPreview, type ExternalRow } from '@plein/protocol'
import { expect, it, vi } from 'vite-plus/test'
import { bootServer, createCanvas, request } from '../testing'
import { runCli } from './cli'

vi.mock('./cli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cli')>()
  return { ...actual, runCli: vi.fn() }
})

it('真实 HTTP 路由经过短剧适配器导入，重启本机服务后写回同一个节点', async () => {
  let app = await bootServer()
  const { id, doc } = await createCanvas(app.server)
  const config = { type: 'text', name: '序章', text: '初稿' }
  const cli = vi.mocked(runCli).mockImplementation(async (binary, args) => {
    expect(binary).toBe('jimeng-novel')
    expect(args.slice(0, 1)).toEqual(['node'])
    expect(args[args.indexOf('--project-id') + 1]).toBe('1000')
    const card = { nodeId: '8899', type: 'text', key: 'story/E01', config }
    let data: unknown
    switch (args[1]) {
      case 'list':
        data = { items: [card], nextCursor: null }
        break
      case 'get':
        data = card
        break
      case 'update': {
        const input = JSON.parse(await readFile(args[args.indexOf('--input-file') + 1]!, 'utf8'))
        expect(input).toEqual({ text: '本机校订' })
        config.text = input.text
        data = card
        break
      }
      default:
        throw new Error('意外的命令')
    }
    return JSON.stringify({ status: 'success', data, context: { projectId: '1000' } })
  })
  const target = { provider: 'jimeng-novel', target: '1000' }
  const post = (op: 'preview' | 'apply', body: object) =>
    request(app.server, API.externalCanvas(id, op), {
      method: 'POST',
      body: JSON.stringify({ ...target, ...body }),
    })
  const preview = async () => {
    const response = await post('preview', {})
    expect(response.status).toBe(200)
    return ((await response.json()) as ExternalPreview).rows[0]!
  }
  const apply = (row: ExternalRow, action: 'pull' | 'push') =>
    post('apply', { rowId: row.rowId, revision: row.revision, action })
  try {
    expect((await apply(await preview(), 'pull')).status).toBe(204)
    const linked = await preview()
    expect(linked).toMatchObject({ state: 'synced', remoteId: '8899' })
    setText(doc, linked.localId!, '本机校订')
    app.server.rooms.get(id).persistNow()
    doc.destroy()
    const dataDir = app.dataDir
    await app.close()
    app = await bootServer({ dataDir })
    const edited = await preview()
    expect(edited).toMatchObject({
      state: 'local-changed',
      localId: linked.localId,
      remoteId: '8899',
    })
    expect((await apply(edited, 'push')).status).toBe(204)
    expect(config.text).toBe('本机校订')
    expect((await preview()).state).toBe('synced')
  } finally {
    cli.mockReset()
  }
})

it('手动刷新和轮询共用一次在途扫描，连续保存逐次重读，写后刷新读取新版本', async () => {
  const { server } = await bootServer()
  const { id, doc } = await createCanvas(server)
  const target = { provider: 'jimeng-novel', target: '7/1000' }
  const post = async (op: 'preview' | 'apply', body: object = {}) =>
    request(server, API.externalCanvas(id, op), {
      method: 'POST',
      body: JSON.stringify({ ...target, ...body }),
    })
  const rowOf = async (response: Response) => {
    expect(response.status, await response.clone().text()).toBe(200)
    return ((await response.json()) as ExternalPreview).rows[0]!
  }
  const config = { type: 'text', name: '序章', text: '第一版' }
  const card = { nodeId: '8899', type: 'text', key: 'story/E01', config }
  const envelope = (data: unknown) =>
    JSON.stringify({ status: 'success', context: { projectId: '1000', teamId: '7' }, data })
  const cli = vi.mocked(runCli).mockImplementation(async (_binary, args) => {
    switch (args[1]) {
      case 'list':
        return envelope({ items: [card] })
      case 'get':
        return envelope(card)
      case 'update':
        config.text = JSON.parse(
          await readFile(args[args.indexOf('--input-file') + 1]!, 'utf8'),
        ).text
        return envelope(card)
      default:
        throw new Error('未知 CLI 命令')
    }
  })
  try {
    const initial = await rowOf(await post('preview'))
    expect(
      (await post('apply', { rowId: initial.rowId, revision: initial.revision, action: 'pull' }))
        .status,
    ).toBe(204)
    const bound = await rowOf(await post('preview'))
    setText(doc, bound.localId!, '第二版')
    const edited = await rowOf(await post('preview'))
    const apply = { rowId: edited.rowId, revision: edited.revision, action: 'push' }

    cli.mockClear()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    cli.mockImplementationOnce(async (_binary, args) => {
      expect(args.slice(0, 2)).toEqual(['node', 'list'])
      await gate
      return envelope({ items: [card] })
    })
    const requests = [
      post('preview'),
      post('preview', { target: ' 7/1000 ' }),
      post('apply', apply),
      post('apply', apply),
      post('preview'),
      post('preview'),
    ]
    await setImmediate()
    const media = Promise.all(
      [0, 1].map(async () =>
        request(server, externalMediaPath(id, 'list'), {
          method: 'POST',
          body: JSON.stringify(target),
        }),
      ),
    )
    await setImmediate()
    const interleaved = post('preview')
    await setImmediate()
    expect(cli.mock.calls.map(([, args]) => args[1])).toEqual(['list'])
    release()
    const [first, second, write, duplicate, after, poll] = await Promise.all(requests)
    expect((await rowOf(first!)).state).toBe('local-changed')
    expect((await rowOf(second!)).state).toBe('local-changed')
    expect(write!.status).toBe(204)
    expect(duplicate!.status).toBe(409)
    expect((await rowOf(after!)).remote?.text).toBe('第二版')
    expect((await rowOf(poll!)).state).toBe('synced')
    expect((await rowOf(await interleaved)).state).toBe('synced')
    for (const response of await media) {
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([])
    }
    expect(cli.mock.calls.map(([, args]) => args[1])).toEqual([
      'list',
      'get',
      'get',
      'update',
      'get',
      'list',
      'list',
    ])

    config.text = '第三版'
    expect((await rowOf(await post('preview'))).remote?.text).toBe('第三版')
    expect(cli.mock.calls).toHaveLength(8)
  } finally {
    cli.mockReset()
  }
})
