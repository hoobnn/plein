import { Room, type DocStore } from '../sync/rooms'
import { connect, createDoc, createElement, removeEdges, setParams } from '@plein/doc'
import type { PreparedInput } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import * as Y from 'yjs'
import type { Server } from '../app'
import { addNode, bootServer, createCanvas, mockSettings, request } from '../testing'

/**
 * 浏览器当前这一版文档必须先到服务端，才能用它读实际输入或提交任务。
 * 凭据是客户端 Yjs 快照（含删除集）：纯删除不会推进状态向量，只看 stateVector 会误判成已同步。
 */

/** 与服务端同步过、但之后又在本机改过的一份文档 */
async function syncedClient(server: Server, canvasId: string) {
  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server.rooms.get(canvasId).doc))
  return { client, doc: createDoc(client, { schedule: () => {} }) }
}

const credential = (doc: Y.Doc) => Buffer.from(Y.encodeSnapshot(Y.snapshot(doc))).toString('base64')

const syncServer = (server: Server, canvasId: string, client: Y.Doc) =>
  Y.applyUpdate(server.rooms.get(canvasId).doc, Y.encodeStateAsUpdate(client))

const preview = (server: Server, canvasId: string, nodeId: string, expectSnapshot?: string) =>
  request(server, `/api/canvases/${canvasId}/nodes/${nodeId}/input`, {
    method: 'POST',
    body: JSON.stringify(expectSnapshot === undefined ? {} : { expectSnapshot }),
  })

it('本机改过、服务端还没收到的文档不能读取实际输入；同步后读到新的输入', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const node = addNode(doc, 'plein/image', { params: { prompt: '旧的提示词' } })
  const { client, doc: clientDoc } = await syncedClient(server, id)
  setParams(clientDoc, node, { prompt: '新的提示词' })

  const blocked = await preview(server, id, node, credential(client))
  expect(blocked.status).toBe(409)
  expect(((await blocked.json()) as { error: string }).error).toBe('sync_pending')
  expect(server.runs.list(id).jobs).toHaveLength(0)

  // 服务端收到这一版之后才放行，读到的是本机的提示词
  syncServer(server, id, client)
  const allowed = await preview(server, id, node, credential(client))
  expect(allowed.status).toBe(200)
  expect(((await allowed.json()) as PreparedInput).prompt).toContain('新的提示词')
  expect(server.runs.list(id).jobs).toHaveLength(0)
  client.destroy()
})

it('只删掉一条引用也要服务端收到：两端状态向量一致、删除集不同', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const node = addNode(doc, 'plein/image', { params: { prompt: '带参考图' } })
  const image = createElement(doc, {
    kind: 'image',
    assetId: 'a'.repeat(64),
    x: 0,
    y: 300,
    w: 100,
    h: 100,
  })
  expect(connect(doc, [image, 'image'], [node, 'references'])).toBeTruthy()
  const { client, doc: clientDoc } = await syncedClient(server, id)
  const edgeIds = [...clientDoc.edges()].filter((edge) => edge.to[0] === node).map((e) => e.id)
  expect(edgeIds).toHaveLength(1)
  removeEdges(clientDoc, edgeIds)
  expect([...clientDoc.edges()].filter((edge) => edge.to[0] === node)).toHaveLength(0)
  expect(
    Y.equalDeleteSets(Y.snapshot(client).ds, Y.createDeleteSetFromStructStore(client.store)),
  ).toBe(true)

  // 纯删除不推进状态向量：两端一致，只有删除集不同
  expect([...Y.encodeStateVector(client)]).toEqual([
    ...Y.encodeStateVector(server.rooms.get(id).doc),
  ])
  const blocked = await preview(server, id, node, credential(client))
  expect(blocked.status).toBe(409)
  expect(((await blocked.json()) as { error: string }).error).toBe('sync_pending')

  syncServer(server, id, client)
  const allowed = await preview(server, id, node, credential(client))
  expect(allowed.status).toBe(200)
  expect(((await allowed.json()) as PreparedInput).inputs.references).toBeUndefined()
  client.destroy()
})

it('服务端同时有别的改动也放行，只看是否包含本机这一版', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const node = addNode(doc, 'plein/image', { params: { prompt: '本机的提示词' } })
  const { client } = await syncedClient(server, id)
  // 协作者在服务端又加了一个元素
  addNode(doc, 'plein/text', { params: { text: '别人写的说明' }, x: 0, y: 400 })
  syncServer(server, id, client)

  const response = await preview(server, id, node, credential(client))
  expect(response.status).toBe(200)
  client.destroy()
})

it('凭据格式坏了给出可理解的错误，不猜也不放行', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const node = addNode(doc, 'plein/image', { params: { prompt: '提示词' } })
  const response = await preview(server, id, node, '不是快照')
  expect(response.status).toBe(409)
  expect(((await response.json()) as { error: string }).error).toBe('sync_invalid')
  expect(server.runs.list(id).jobs).toHaveLength(0)
})

it('提交任务同样要等同步；同步后只提交一次', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const node = addNode(doc, 'plein/image', { params: { prompt: '旧的提示词' } })
  const { client, doc: clientDoc } = await syncedClient(server, id)
  setParams(clientDoc, node, { prompt: '新的提示词' })

  const blocked = await request(server, `/api/canvases/${id}/nodes/${node}/run`, {
    method: 'POST',
    body: JSON.stringify({ expectSnapshot: credential(client) }),
  })
  expect(blocked.status).toBe(409)
  expect(((await blocked.json()) as { error: string }).error).toBe('sync_pending')
  expect(server.runs.list(id).jobs).toHaveLength(0)

  syncServer(server, id, client)
  const previewed = await preview(server, id, node, credential(client))
  const input = (await previewed.json()) as PreparedInput
  const started = await request(server, `/api/canvases/${id}/nodes/${node}/run`, {
    method: 'POST',
    body: JSON.stringify({ expect: input.inputHash, expectSnapshot: credential(client) }),
  })
  expect(started.status).toBe(202)
  client.destroy()
})

it('不带凭据的旧调用照常读取，兼容现有客户端', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const node = addNode(doc, 'plein/image', { params: { prompt: '提示词' } })
  const legacy = await request(server, `/api/canvases/${id}/nodes/${node}/input`)
  expect(legacy.status).toBe(200)
  const viaPost = await preview(server, id, node)
  expect(viaPost.status).toBe(200)
})

it('同步确认接口：服务端包含这一版才回 included', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  addNode(doc, 'plein/image', { params: { prompt: '提示词' } })
  const { client, doc: clientDoc } = await syncedClient(server, id)
  setParams(clientDoc, doc.elements().next().value!.id, { prompt: '改了' })

  const pending = await request(server, `/api/canvases/${id}/sync`, {
    method: 'POST',
    body: JSON.stringify({ expectSnapshot: credential(client) }),
  })
  expect(pending.status).toBe(409)
  syncServer(server, id, client)
  const ok = await request(server, `/api/canvases/${id}/sync`, {
    method: 'POST',
    body: JSON.stringify({ expectSnapshot: credential(client) }),
  })
  expect(ok.status).toBe(200)
  expect((await ok.json()) as { included: boolean; persisted: boolean }).toEqual({
    included: true,
    persisted: true,
  })
  client.destroy()
})

it('服务端收到了但写不进数据库时不算已保存', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const rooms = server.rooms as unknown as { store: DocStore }
  const original = rooms.store
  let fail = true
  // 房间创建后持有 store 引用：在打开房间之前换掉写入
  rooms.store = {
    load: original.load,
    replace: original.replace,
    append: (canvasId, update) => {
      if (fail) throw new Error('磁盘写入失败')
      original.append(canvasId, update)
    },
  }
  const { id, doc } = await createCanvas(server)
  const node = addNode(doc, 'plein/image', { params: { prompt: '提示词' } })
  const client = server.rooms.get(id).doc
  const snapshot = credential(client)

  const unsaved = await request(server, `/api/canvases/${id}/sync`, {
    method: 'POST',
    body: JSON.stringify({ expectSnapshot: snapshot }),
  })
  expect(unsaved.status).toBe(503)
  expect(((await unsaved.json()) as { error: string }).error).toBe('sync_unsaved')

  // 写入恢复后才算保存下来，浏览器这时才能安全离开
  fail = false
  const saved = await request(server, `/api/canvases/${id}/sync`, {
    method: 'POST',
    body: JSON.stringify({ expectSnapshot: credential(client) }),
  })
  expect(saved.status).toBe(200)
  expect((await saved.json()) as { persisted: boolean }).toEqual({
    included: true,
    persisted: true,
  })
  expect(node).toBeTruthy()
})

it('房间在写库失败时不会把未落盘的增量算成已保存', () => {
  let fail = true
  const stored: Uint8Array[] = []
  const store: DocStore = {
    load: () => [],
    append: (_id, update) => {
      if (fail) throw new Error('磁盘写入失败')
      stored.push(update)
    },
    replace: (_id, state) => void stored.push(state),
  }
  const room = new Room('canvas', store, () => {})
  const doc = createDoc(room.doc, { schedule: () => {} })
  createElement(doc, { kind: 'markdown', text: '草稿', x: 0, y: 0, w: 10, h: 10 } as never)
  expect(room.persistNow()).toBe(false)
  fail = false
  expect(room.persistNow()).toBe(true)
  expect(stored.length).toBeGreaterThan(0)
  doc.destroy()
  room.close()
})
