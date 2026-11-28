import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createElement, setText } from '@plein/doc'
import { API, externalAuthPath, type ExternalMcpScope } from '@plein/protocol'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { runCli } from '../external-canvas/cli'
import { jimengCanvas } from '../external-canvas/jimeng-canvas'
import { jimengCanvasMedia } from '../external-canvas/jimeng-canvas-media'
import { jimengNovel } from '../external-canvas/jimeng-novel'
import { jimengNovelMedia } from '../external-canvas/jimeng-novel-media'
import { linkStore } from '../external-canvas/store'
import { bootServer, createCanvas, request } from '../testing'

vi.mock('../external-canvas/cli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../external-canvas/cli')>()),
  runCli: vi.fn(async () => {
    throw new Error('Unexpected CLI in mock test')
  }),
}))
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(runCli).mockClear()
})

const novel = { provider: 'jimeng-novel', target: '7/1000' } as const
const canvas = {
  provider: 'jimeng-canvas',
  target: '12451245-abcd-4123-abcd-123456789abc',
} as const
const all: ExternalMcpScope[] = ['read', 'edit', 'destructive']
async function fixture(scopes = all, options?: Parameters<typeof bootServer>[0]) {
  const { server } = await bootServer(options)
  const { id, doc } = await createCanvas(server)
  const token = (
    (await (
      await request(server, '/api/mcp/external', {
        method: 'POST',
        body: JSON.stringify({ name: 'fixture', scopes }),
      })
    ).json()) as { token: string }
  ).token
  // oxlint-disable-next-line typescript/no-explicit-any -- tool responses follow different public contracts
  const rpc = async (method: string, params?: unknown): Promise<Record<string, any>> => {
    const body = (await (
      await server.app.request('/mcp', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:8787',
          'content-type': 'application/json',
          authorization: 'Bearer ' + token,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
    ).json()) as { result?: object; error?: object }
    return body.result ?? body.error ?? {}
  }
  const call = async (action: string, args: object = {}) => {
    const r = await rpc('tools/call', {
      name: 'external_canvas_' + action,
      arguments: { canvas_id: id, ...args },
    })
    const text = r.content[0].text as string
    return {
      text,
      error: r.structuredContent?.error?.code,
      data: () => JSON.parse(text),
      result: r,
    }
  }
  const internal = (path: string, owner = 'local') =>
    server.canvasApi(
      owner,
      new Request('http://plein.internal' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: novel.provider }),
      }),
    )
  return { server, id, doc, call, rpc, internal }
}

it('只读令牌可从两个 CLI 的可见空间和项目浏览；不发起登录或泄露授权挑战', async () => {
  const f = await fixture(['read'])
  vi.spyOn(jimengCanvas, 'projects').mockResolvedValue([{ id: canvas.target, title: '全能项目' }])
  vi.spyOn(jimengNovel, 'spaces').mockResolvedValue([{ id: '7', title: '团队', current: true }])
  const projects = vi
    .spyOn(jimengNovel, 'projects')
    .mockResolvedValue([{ id: novel.target, title: '短剧项目' }])
  expect((await f.call('projects', { provider: canvas.provider })).data().items[0].id).toBe(
    canvas.target,
  )
  expect((await f.call('spaces', { provider: novel.provider })).data().items[0].id).toBe('7')
  expect(
    (await f.call('projects', { provider: novel.provider, space: '7' })).data().items[0].id,
  ).toBe(novel.target)
  expect(projects).toHaveBeenCalledWith('7')
  vi.mocked(runCli)
    .mockResolvedValueOnce(
      JSON.stringify({
        status: 'success',
        data: {
          status: 'authorization_required',
          challenge: {
            deviceCode: 'fake-device-secret',
            userCode: 'FAKE-USER-CODE',
            verificationUri: 'https://jimeng.jianying.com/auth',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        },
      }),
    )
    .mockResolvedValueOnce(JSON.stringify({ logged_in: false }))
  expect(
    (
      await request(f.server, externalAuthPath(f.id, 'start'), {
        method: 'POST',
        body: JSON.stringify({ provider: novel.provider }),
      })
    ).status,
  ).toBe(200)
  const status = await f.call('status', { provider: novel.provider })
  expect(status.data()).toEqual({ provider: novel.provider, status: 'pending' })
  expect((await f.internal(externalAuthPath(f.id, 'finish'))).status).toBe(404)
  expect((await f.internal(externalAuthPath(f.id, 'start'))).status).toBe(404)
  const tools = (await f.rpc('tools/list')).tools as {
    name: string
    annotations: { openWorldHint: boolean }
  }[]
  expect(
    tools
      .filter((t) => t.name.startsWith('external_canvas_'))
      .map((t) => t.name)
      .sort(),
  ).toEqual(
    ['media_list', 'preview', 'projects', 'read_row', 'spaces', 'status', 'targets'].map(
      (n) => 'external_canvas_' + n,
    ),
  )
  expect(tools.find((t) => t.name === 'external_canvas_preview')?.annotations.openWorldHint).toBe(
    true,
  )
  expect(
    (
      await f.call('pull_new', {
        ...novel,
        rows: [{ rowId: 'remote/1', revision: '0'.repeat(64) }],
        confirm: true,
      })
    ).error,
  ).toBe('forbidden_scope')
  expect((await f.internal(API.externalCanvas(f.id, 'spaces'), 'other-user')).status).toBe(404)
  expect((await f.call('spaces', { provider: novel.provider, canvas_id: 'missing' })).error).toBe(
    'not_found',
  )
  expect(runCli).toHaveBeenCalledTimes(2)
})

it.each([
  ['全能画布', canvas, jimengCanvas],
  ['短剧', novel, jimengNovel],
] as const)(
  '%s 从逐卡版本确认后拉入、写回；拒绝跨画布、跨项目、陈旧版本和重复覆盖',
  async (_label, target, provider) => {
    const f = await fixture()
    const card = {
      id: '156',
      kind: 'text',
      editable: true,
      fields: { title: '首幕', text: '原稿'.repeat(900) },
    }
    if (provider.canCreateAtPosition)
      vi.spyOn(provider, 'canCreateAtPosition').mockResolvedValue(false)
    if (provider.resolveTarget)
      vi.spyOn(provider, 'resolveTarget').mockImplementation(async (r) => r)
    vi.spyOn(provider, 'list').mockImplementation(async () => [structuredClone(card)])
    vi.spyOn(provider, 'read').mockImplementation(async () => structuredClone(card))
    const update = vi
      .spyOn(provider, 'update')
      .mockImplementation(async (_target, _item, fields) => {
        card.fields = { ...fields }
      })
    const preview = async (args: object = {}) =>
      (await f.call('preview', { ...target, ...args })).data()
    const first = (await preview()).items[0]
    const { rowId, revision } = first
    expect(first).toMatchObject({ state: 'remote-only', actions: ['pull'] })
    const paged = (await f.call('read_row', { ...target, rowId, revision, side: 'remote' })).data()
    const tail = (
      await f.call('read_row', {
        ...target,
        rowId,
        revision,
        side: 'remote',
        offset: paged.next_offset,
      })
    ).data()
    expect(paged.remote.text + tail.remote.text).toBe(card.fields.text)
    const batch = { ...target, rows: [{ rowId, revision }] }
    expect((await f.call('pull_new', batch)).data()).toMatchObject({
      status: 'needs_approval',
      reason: expect.stringContaining(rowId),
    })
    expect(f.doc.size).toBe(0)
    const other = await createCanvas(f.server)
    expect((await f.call('pull_new', { ...batch, canvas_id: other.id, confirm: true })).error).toBe(
      'stale',
    )
    const otherTarget =
      target.provider === 'jimeng-novel' ? '8/1000' : '02451245-abcd-4123-abcd-123456789abc'
    expect((await f.call('pull_new', { ...batch, target: otherTarget, confirm: true })).error).toBe(
      'stale',
    )
    const pulled = (await f.call('pull_new', { ...batch, confirm: true })).data()
    expect((await f.call('targets')).data().items).toEqual([target])
    const bound = (await preview()).items[0]
    const localId = pulled.applied[0].localId
    expect(pulled).toEqual({
      ...target,
      action: 'pull-new',
      imported: 1,
      applied: [{ rowId, localId, remoteId: card.id }],
    })
    expect(bound).toMatchObject({ localId, remoteId: card.id, rowId: 'local/' + localId })
    setText(f.doc, localId, '本机改稿')
    const edited = (await preview()).items[0]
    const push = { ...target, rowId: edited.rowId, revision: edited.revision, action: 'push' }
    expect((await f.call('apply', push)).data().status).toBe('needs_approval')
    expect(update).not.toHaveBeenCalled()
    card.fields.text = '对方也修改'
    expect((await f.call('apply', { ...push, confirm: true })).error).toBe('stale')
    const conflict = (await preview()).items[0]
    expect(conflict.state).toBe('conflict')
    expect(
      (await f.call('apply', { ...push, revision: conflict.revision, confirm: true })).data(),
    ).toEqual({
      ...target,
      success: true,
      action: 'push',
      applied: [{ rowId: push.rowId, localId, remoteId: card.id }],
    })
    expect(card.fields.text).toBe('本机改稿')
    expect(
      (await f.call('apply', { ...push, revision: conflict.revision, confirm: true })).error,
    ).toBe('stale')
    expect(update).toHaveBeenCalledTimes(1)
    const newLocalId = createElement(f.doc, {
      kind: 'markdown',
      name: '同名卡',
      text: '第二稿',
      x: 100,
      y: 200,
      w: 300,
      h: 200,
    })
    const draft = (await preview()).items.find((r: { localId: string }) => r.localId === newLocalId)
    if (provider.validateCreate) vi.spyOn(provider, 'validateCreate').mockResolvedValue()
    const create = vi.spyOn(provider, 'create').mockResolvedValue('fresh-remote-id')
    const createArgs = { ...target, rowId: draft.rowId, revision: draft.revision, action: 'push' }
    expect((await f.call('apply', createArgs)).data().status).toBe('needs_approval')
    expect(create).not.toHaveBeenCalled()
    expect((await f.call('apply', { ...createArgs, confirm: true })).data().applied).toEqual([
      { rowId: draft.rowId, localId: newLocalId, remoteId: 'fresh-remote-id' },
    ])
    expect(create).toHaveBeenCalledTimes(1)
    expect(runCli).not.toHaveBeenCalled()
  },
)

it('只读查看待核对的创建结果保留绑定记录；确认时重新核实旧绑定实际所在的空间', async () => {
  const f = await fixture()
  const legacy = { ...novel, target: '1000' }
  const localId = createElement(f.doc, {
    kind: 'markdown',
    name: '角色',
    text: '新稿',
    x: 0,
    y: 0,
    w: 120,
    h: 60,
  })
  const store = linkStore(f.server.db, f.id)
  store.save({
    ...legacy,
    canvasId: f.id,
    localId,
    operationId: 'candidate',
    baseline: { title: '角色', text: '新稿' },
  })
  let space = '7'
  vi.spyOn(jimengNovel, 'resolveTarget').mockImplementation(async () => space + '/1000')
  vi.spyOn(jimengNovel, 'list').mockResolvedValue([
    {
      id: '987',
      kind: 'text',
      editable: true,
      operationId: 'candidate',
      fields: { title: '角色', text: '新稿' },
    },
  ])
  const preview = (await f.call('preview', legacy)).data()
  expect(preview.resolvedTarget).toBe(novel.target)
  expect(preview.items[0].state).toBe('synced')
  expect(store.list(legacy)[0]?.remoteId).toBeNull()
  const invalid = await f.call('apply', {
    ...legacy,
    resolvedTarget: novel.target,
    rowId: preview.items[0].rowId,
    revision: '0'.repeat(64),
    action: 'unlink',
    confirm: true,
  })
  expect(invalid.error).toBe('stale')
  expect(store.list(legacy)[0]?.remoteId).toBeNull()
  space = '8'
  const { rowId, revision } = preview.items[0]
  const stale = await f.call('apply', {
    ...legacy,
    resolvedTarget: preview.resolvedTarget,
    rowId,
    revision,
    action: 'unlink',
    confirm: true,
  })
  expect(stale.error).toBe('stale')
  expect(store.list(legacy)[0]?.remoteId).toBeNull()
})

it('所选媒体必须保持目标空间和资产版本；导入、替换、发布均先问再执行', async () => {
  const f = await fixture()
  const bytes = await sharp({ create: { width: 3, height: 4, channels: 3, background: 'blue' } })
    .png()
    .toBuffer()
  const row = {
    nodeId: '100',
    assetId: '111',
    kind: 'image',
    title: '样片',
    replaceable: true,
  } as const
  let choices = [row]
  vi.spyOn(jimengNovelMedia, 'resolveTarget').mockResolvedValue(novel.target)
  vi.spyOn(jimengNovelMedia, 'listMedia').mockImplementation(async () => choices)
  vi.spyOn(jimengNovelMedia, 'readMedia').mockImplementation(async () => choices)
  const download = vi
    .spyOn(jimengNovelMedia, 'download')
    .mockImplementation(async (_target, _row, file) => {
      await writeFile(file, bytes)
      return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    })
  const replace = vi.spyOn(jimengNovelMedia, 'replace').mockResolvedValue('222')
  const publish = vi
    .spyOn(jimengCanvasMedia, 'publish')
    .mockResolvedValue({ nodeId: '400', assetId: '500' })
  const listed = (await f.call('media_list', { ...novel, target: '1000' })).data()
  expect(listed).toMatchObject({ target: novel.target, items: [row] })
  const sel = { ...novel, target: listed.target, nodeId: row.nodeId, assetId: row.assetId }
  expect((await f.call('media_import', sel)).data().status).toBe('needs_approval')
  expect(download).not.toHaveBeenCalled()
  expect((await f.call('media_import', { ...sel, target: '1000', confirm: true })).text).toContain(
    '请选择已核实的短剧空间',
  )
  const imported = (await f.call('media_import', { ...sel, confirm: true })).data()
  expect(f.doc.get(imported.elementId)?.assetId).toBe(imported.assetId)
  const replacement = { ...sel, localAssetId: imported.assetId }
  expect((await f.call('media_replace', replacement)).data().status).toBe('needs_approval')
  expect(replace).not.toHaveBeenCalled()
  choices = []
  expect((await f.call('media_replace', { ...replacement, confirm: true })).result.isError).toBe(
    true,
  )
  expect(replace).not.toHaveBeenCalled()
  choices = [row]
  expect((await f.call('media_replace', { ...replacement, confirm: true })).data()).toEqual({
    assetId: '222',
  })
  const exp = { ...canvas, localAssetId: imported.assetId }
  expect((await f.call('media_publish', exp)).data().status).toBe('needs_approval')
  expect(publish).not.toHaveBeenCalled()
  expect((await f.call('media_publish', { ...exp, confirm: true })).data()).toEqual({
    nodeId: '400',
    assetId: '500',
  })
  expect(runCli).not.toHaveBeenCalled()
})

it('非回环服务的界面和内部调用均无即梦业务路由', async () => {
  const f = await fixture(['read'], { env: { PLEIN_HOST: '0.0.0.0', PLEIN_AUTH: 'none' } })
  const path = API.externalCanvas(f.id, 'spaces')
  expect(
    (
      await request(f.server, path, {
        method: 'POST',
        body: JSON.stringify({ provider: novel.provider }),
      })
    ).status,
  ).toBe(404)
  expect((await f.internal(path)).status).toBe(404)
  const tools = (await f.rpc('tools/list')).tools as { name: string }[]
  expect(tools.some((t) => t.name.startsWith('external_canvas_'))).toBe(false)
  expect(
    await f.rpc('tools/call', {
      name: 'external_canvas_spaces',
      arguments: { canvas_id: f.id, provider: novel.provider },
    }),
  ).toMatchObject({ code: -32602, message: expect.stringContaining('Unknown tool') })
  expect(runCli).not.toHaveBeenCalled()
})
