import { createElement, deleteElements, setText, updateElement } from '@plein/doc'
import { API } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { bootServer, createCanvas, request } from '../testing'
import type { CanvasProvider, RemoteItem } from './provider'
import { canonicalTarget, projectLockKey } from './targets'
import { externalService } from './service'

const ref = { provider: 'jimeng-novel' as const, target: '1000' }

async function fixture() {
  const { server } = await bootServer()
  const { id, doc } = await createCanvas(server)
  const card: RemoteItem = {
    id: 'card',
    kind: 'text',
    fields: { title: '第一集', text: '初稿' },
    editable: true,
  }
  const items: RemoteItem[] = [card]
  const provider: CanvasProvider = {
    list: async () => structuredClone(items),
    update: async (_target, item, fields) => {
      items.find((i) => i.id === item.id)!.fields = { ...fields }
    },
    create: async (_target, fields, operationId) => {
      items.push({ id: 'created', kind: 'text', editable: true, fields, operationId })
      throw new Error('连接在收取回执时中断')
    },
  }
  const svc = externalService(server.db, server.rooms, {
    'jimeng-novel': provider,
    'jimeng-canvas': provider,
  })
  const preview = async () => (await svc.run(id, ref)).rows
  return { id, doc, svc, preview, items, card, server, provider }
}

it('拉入、双边修改、冲突选择与过期预览按同一对节点核对', async () => {
  const { id, doc, svc, preview, card } = await fixture()
  const [newCard] = await preview()
  await svc.run(id, ref, { ...ref, ...newCard!, remoteId: undefined, action: 'pull' })
  const [linked] = await preview()
  expect(linked?.state).toBe('synced')
  const node = linked!.localId!
  setText(doc, node, '本机改稿')
  const [before] = await preview()
  expect(before?.state).toBe('local-changed')
  card.fields.text = '即梦改稿'
  await expect(
    svc.run(id, ref, { ...ref, ...before!, remoteId: undefined, action: 'push' }),
  ).rejects.toThrow('变化')
  const [conflict] = await preview()
  expect(conflict?.state).toBe('conflict')
  await svc.run(id, ref, { ...ref, ...conflict!, remoteId: undefined, action: 'push' })
  expect(card.fields.text).toBe('本机改稿')
  expect((await preview())[0]?.state).toBe('synced')
  deleteElements(doc, [node])
  expect((await preview())[0]?.state).toBe('missing-local')
  const [restore] = await preview()
  await svc.run(id, ref, { ...ref, ...restore!, remoteId: undefined, action: 'pull' })
  expect(doc.get(node)?.text).toBe('本机改稿')
})

it('两侧分别改正文、标题或位置时可合并，拖动冲突按整个位置核对', async () => {
  const { id, doc, svc, preview, card } = await fixture()
  card.fields.position = { x: 0, y: 0 }
  const [initial] = await preview()
  const apply = (row: NonNullable<typeof initial>, action: 'pull' | 'merge') =>
    svc.run(id, ref, { ...ref, rowId: row.rowId, revision: row.revision, action })
  await apply(initial!, 'pull')
  const localId = (await preview())[0]!.localId!
  setText(doc, localId, '校订台词')
  card.fields.title = '第一幕'
  card.fields.position = { x: 12, y: -8 }
  const merged = { title: '第一幕', text: '校订台词', position: { x: 12, y: -8 } }
  const [row] = await preview()
  expect(row).toMatchObject({ state: 'mergeable', merged })
  await apply(row!, 'merge')
  expect(card.fields).toEqual(merged)
  expect(doc.get(localId)).toMatchObject({
    name: merged.title,
    text: merged.text,
    ...merged.position,
  })
  expect((await preview())[0]?.state).toBe('synced')
  updateElement(doc, localId, { x: 24 })
  card.fields.position = { x: 12, y: 16 }
  const [overlap] = await preview()
  expect(overlap?.state).toBe('conflict')
  expect(overlap?.actions).not.toContain('merge')
})

it('合并时远端保存期间的本地编辑不会被覆盖', async () => {
  const { id, doc, svc, preview, card, provider } = await fixture()
  const [initial] = await preview()
  await svc.run(id, ref, {
    ...ref,
    rowId: initial!.rowId,
    revision: initial!.revision,
    action: 'pull',
  })
  const localId = (await preview())[0]!.localId!
  setText(doc, localId, '校订台词')
  card.fields.title = '第一幕'
  const update = provider.update
  provider.update = async (...args) => {
    await update(...args)
    setText(doc, localId, '保存期间的新台词')
  }
  const [row] = await preview()
  await expect(
    svc.run(id, ref, { ...ref, rowId: row!.rowId, revision: row!.revision, action: 'merge' }),
  ).rejects.toThrow('Plein 在保存期间有新改动')
  expect(doc.get(localId)?.text).toBe('保存期间的新台词')
  expect(card.fields).toEqual({ title: '第一幕', text: '校订台词' })
  expect((await preview())[0]?.state).toBe('conflict')
})

it('创建回执丢失后按操作身份恢复关联，保留同名不同项', async () => {
  const { id, doc, svc, preview, items } = await fixture()
  const local = createElement(doc, {
    kind: 'markdown',
    x: 0,
    y: 0,
    w: 384,
    h: 120,
    name: '第一集',
    text: '初稿',
  })
  const row = (await preview()).find((r) => r.localId === local)!
  await expect(
    svc.run(id, ref, { ...ref, ...row, remoteId: undefined, action: 'push' }),
  ).rejects.toThrow('回执')
  expect(items).toHaveLength(2)
  const recovered = (await preview()).find((r) => r.localId === local)!
  expect(recovered).toMatchObject({ state: 'synced', remoteId: 'created' })
  await expect(
    svc.run(id, ref, { ...ref, ...row, remoteId: undefined, action: 'push' }),
  ).rejects.toThrow('变化')
  expect(items).toHaveLength(2)
})

it('默认空间与显式空间共用已核验的绑定，其他团队的同号项目独立', async () => {
  const { id, svc, provider, preview } = await fixture()
  provider.resolveTarget = async (target) => (target === '1000' ? '7/1000' : target)
  const [row] = await preview()
  await svc.run(id, ref, { ...ref, rowId: row!.rowId, revision: row!.revision, action: 'pull' })
  const project = { ...ref, target: '7/1000' }
  expect(projectLockKey(ref)).toBe(projectLockKey(project))
  const [bound] = (await svc.run(id, project)).rows
  expect(bound).toMatchObject({ remoteId: 'card', state: 'synced' })
  expect((await preview())[0]?.localId).toBe(bound!.localId)
  const other = (await svc.run(id, { ...ref, target: '9/1000' })).rows
  expect(other.find((r) => r.remoteId === 'card')?.localId).toBeNull()
  expect(svc.targets(id)).toEqual([project])
})

it('旧版未记录空间的绑定沿用原入口，显式选择其他团队不会接管', async () => {
  const { id, svc, provider, preview } = await fixture()
  const [row] = await preview()
  await svc.run(id, ref, { ...ref, rowId: row!.rowId, revision: row!.revision, action: 'pull' })
  provider.resolveTarget = async (target) => (target === '1000' ? '7/1000' : target)
  expect((await svc.run(id, ref)).rows[0]?.state).toBe('synced')
  expect((await svc.run(id, { ...ref, target: '7/1000' })).rows[0]?.state).toBe('remote-only')
  expect(svc.targets(id)).toEqual([ref])
})

it('失败的预览不阻塞排队请求，另一个画布、团队空间或项目分别读取自己的结果', async () => {
  const { id, svc, server, provider, card } = await fixture()
  const other = await createCanvas(server)
  createElement(other.doc, {
    kind: 'markdown',
    name: '仅另一张画布',
    text: '草稿',
    x: 0,
    y: 0,
    w: 100,
    h: 40,
  })
  const seen: string[] = []
  let fail!: (reason: Error) => void
  const unavailable = new Promise<never>((_resolve, reject) => {
    fail = reject
  })
  provider.list = async (target) => {
    seen.push(target)
    if (seen.length === 1) return unavailable
    return [{ ...card, fields: { title: target, text: '初稿' } }]
  }
  const a = { ...ref, target: '7/1000' }
  const b = { ...ref, target: '8/1000' }
  const parallel = svc.run(id, a)
  const shared = svc.run(id, a)
  const failure = Promise.allSettled([parallel, shared])
  const next = svc.run(other.id, a)
  const nextSpace = svc.run(other.id, b)
  const independent = await svc.run(id, { ...ref, target: '7/2000' })
  expect(independent.rows[0]?.remote?.title).toBe('7/2000')
  expect(seen).toEqual(['7/1000', '7/2000'])
  fail(new Error('CLI 暂时离线'))
  expect(await failure).toEqual([
    { status: 'rejected', reason: new Error('CLI 暂时离线') },
    { status: 'rejected', reason: new Error('CLI 暂时离线') },
  ])
  const [otherCanvas, otherSpace] = await Promise.all([next, nextSpace])
  expect(otherCanvas.rows.map((r) => r.local?.title ?? r.remote?.title)).toEqual([
    '7/1000',
    '仅另一张画布',
  ])
  expect(otherSpace.rows[0]?.remote?.title).toBe('8/1000')
  expect(seen).toEqual(['7/1000', '7/2000', '7/1000', '8/1000'])
})

it('仅接受官方项目链接，未知画布不会启动 CLI', async () => {
  expect(
    canonicalTarget({
      ...ref,
      target: 'https://jimeng.jianying.com/novel/detail/canvas?projectId=1000&canvasId=234',
    }),
  ).toEqual(ref)
  expect(() => canonicalTarget({ ...ref, target: 'https://example.org/?projectId=1000' })).toThrow()
  const { server } = await bootServer()
  const response = await request(server, API.externalCanvas('missing', 'preview'), {
    method: 'POST',
    body: JSON.stringify(ref),
  })
  expect(response.status).toBe(404)
})

it('非回环监听不开放宿主机 CLI', async () => {
  const { server } = await bootServer({ config: { auth: 'none', host: '0.0.0.0' } })
  const { id } = await createCanvas(server)
  const response = await request(server, API.externalCanvas(id, 'targets'))
  expect(response.status).toBe(404)
})

it('整批导入先验证全部 revision，角色和分镜继续使用 Plein 原生卡片', async () => {
  const { id, doc, svc, preview, items } = await fixture()
  items.push({
    id: 'role-1',
    kind: 'role',
    editable: true,
    fields: { title: '小雨', text: '灰色外套' },
  })
  items.push({
    id: 'shot-1',
    kind: 'video',
    editable: true,
    fields: { title: '街景', text: '从远景切到特写' },
  })
  const rows = (await preview()).map(({ revision, rowId }) => ({ revision, rowId }))
  await expect(
    svc.run(id, ref, { ...ref, rows: [rows[0]!, { ...rows[1]!, revision: 'stale' }] }),
  ).rejects.toThrow('变化')
  expect(doc.size).toBe(0)
  await svc.run(id, ref, { ...ref, rows })
  const nodes = [...doc.elements()]
  expect(nodes.find((el) => el.nodeType === 'plein/character')?.params?.description).toBe(
    '灰色外套',
  )
  expect(nodes.find((el) => el.nodeType === 'plein/video')?.params?.prompt).toBe('从远景切到特写')
  expect((await preview()).every((row) => row.state === 'synced')).toBe(true)
  items[2]!.fields.text = '特写'
  const change = (await preview()).find((row) => row.remoteId === 'shot-1')!
  await svc.run(id, ref, { ...ref, action: 'pull', rowId: change.rowId, revision: change.revision })
  expect(doc.get(change.localId!)?.params?.prompt).toBe('特写')
  await expect(svc.run(id, ref, { ...ref, rows })).rejects.toThrow('变化')
  expect(doc.size).toBe(3)
})
