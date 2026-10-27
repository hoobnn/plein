import { type BrowserContext, expect, type Page, test, type WebSocketRoute } from './fixtures'
import { addNode, elements, newProject, waitEngine } from './canvas'

/**
 * 浏览器文档缓存（y-indexeddb）与断线重连验收。
 *
 * 断线有两种做法：
 * - 拦截同步 WebSocket（`routeWebSocket`）：页面和素材照常从服务端取，只断文档同步，
 *   用来验证已打开画布断线编辑、断线时刷新从缓存恢复；
 * - 真的停掉服务进程再起来：验证服务重启后重连合并。服务停着时页面入口本身打不开
 *   （前端由同一个服务托管，没有 Service Worker），所以「首次离线启动」不在支持范围内。
 */

const sync = /\/sync\//

/** 控制同步连接通断：断开时切掉已有连接，新连接直接关掉 */
async function syncSwitch(context: BrowserContext) {
  let online = true
  const open = new Set<WebSocketRoute>()
  await context.routeWebSocket(sync, (ws) => {
    if (!online) return void ws.close()
    ws.connectToServer()
    open.add(ws)
    ws.onClose(() => open.delete(ws))
  })
  return {
    offline() {
      online = false
      for (const ws of open) void ws.close()
      open.clear()
    },
    online() {
      online = true
    },
  }
}

const syncStatus = (page: Page) => page.getByTestId('sync-status')
const nodeCount = async (page: Page) =>
  (await elements(page)).filter((e) => e.kind === 'node').length

/** 不带缓存的新页面打开画布，读出服务端那边的节点数 */
async function serverNodes(context: BrowserContext, url: string) {
  const fresh = await context.browser()!.newContext()
  const page = await fresh.newPage()
  await page.goto(url)
  await waitEngine(page)
  await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected')
  const n = await nodeCount(page)
  await fresh.close()
  return n
}

test(
  '断线编辑，断线时刷新从本机缓存恢复，重连后合并到服务端',
  { tag: '@core' },
  async ({ page, context }) => {
    const net = await syncSwitch(context)
    await newProject(page)
    await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected')
    const url = page.url()
    await addNode(page, '文本', { x: 400, y: 450 })
    await page.keyboard.press('Escape')
    await expect.poll(() => nodeCount(page)).toBe(1)

    net.offline()
    await expect(syncStatus(page)).toHaveAttribute('data-sync', 'disconnected')
    await addNode(page, '文本', { x: 900, y: 450 })
    await page.keyboard.press('Escape')
    await expect.poll(() => nodeCount(page)).toBe(2)
    await expect(syncStatus(page)).toContainText('改动先存在本机')

    // 写入完成才承诺刷新恢复，不能只等内存里出现两个节点。
    await expect(syncStatus(page)).toHaveAttribute('data-cache', 'saved')
    // 断线时刷新：页面照常从服务端取，文档同步不通，从 IndexedDB 缓存打开，两个节点都在
    await page.reload()
    await waitEngine(page)
    await expect.poll(() => nodeCount(page)).toBe(2)
    await expect(syncStatus(page)).toHaveAttribute('data-sync', 'disconnected')
    // 服务端此时只有断线前的一个节点
    expect(await serverNodes(context, url)).toBe(1)

    net.online()
    await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected', { timeout: 30_000 })
    await expect.poll(() => serverNodes(context, url)).toBe(2)
  },
)

test('离线正文撤销重做与在线同伴修改合并，刷新和无缓存客户端保持一致', async ({
  page,
  context,
}) => {
  const net = await syncSwitch(context)
  await newProject(page)
  await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected')
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '离线正文',
      params: { text: '初始正文' },
      x: 400,
      y: 300,
    }),
  )
  const read = (target: Page) =>
    target.evaluate((id) => {
      const doc = window.__plein.engine.doc
      const el = doc.get(id)
      return { name: el?.name, text: el?.params?.text, count: [...doc.elements()].length }
    }, id)
  const peerContext = await context.browser()!.newContext()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    const peer = await peerContext.newPage()
    peer.on('pageerror', (error) => errors.push(error.message))
    await peer.goto(page.url())
    await waitEngine(peer)
    await expect(syncStatus(peer)).toHaveAttribute('data-sync', 'connected')
    await expect.poll(() => read(peer)).toEqual({ name: '离线正文', text: '初始正文', count: 1 })

    net.offline()
    await expect(syncStatus(page)).toHaveAttribute('data-sync', 'disconnected')
    await page.getByRole('treeitem', { name: '离线正文 定位到画布', exact: true }).click()
    const prompt = page.getByRole('textbox', { name: '提示词', exact: true })
    await prompt.fill('离线修改后的正文')
    await expect
      .poll(() => read(page))
      .toEqual({ name: '离线正文', text: '离线修改后的正文', count: 1 })
    await expect(syncStatus(page)).toHaveAttribute('data-cache', 'saved')
    expect(await read(peer)).toEqual({ name: '离线正文', text: '初始正文', count: 1 })

    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(prompt).toHaveValue('初始正文')
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect(prompt).toHaveValue('离线修改后的正文')
    await page.screenshot({ path: test.info().outputPath('offline-edit-before-reconnect.png') })

    // 修改不同字段，验证真实远端事务不会被本机撤销历史吞掉。
    await peer.getByRole('treeitem', { name: '离线正文 定位到画布', exact: true }).dblclick()
    const name = peer.getByRole('tree').getByRole('textbox', { name: '元素名称', exact: true })
    await name.fill('同伴重命名')
    await name.press('Enter')
    await addNode(peer, '文本', { x: 950, y: 450 })
    await peer.keyboard.press('Escape')
    await expect.poll(() => read(peer)).toEqual({ name: '同伴重命名', text: '初始正文', count: 2 })
    expect(await read(page)).toEqual({ name: '离线正文', text: '离线修改后的正文', count: 1 })

    net.online()
    await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected', { timeout: 30_000 })
    const merged = { name: '同伴重命名', text: '离线修改后的正文', count: 2 }
    await expect.poll(() => read(page)).toEqual(merged)
    await expect.poll(() => read(peer)).toEqual(merged)
    await expect(prompt).toHaveValue('离线修改后的正文')
    await expect(
      page.getByRole('treeitem', { name: '同伴重命名 定位到画布', exact: true }),
    ).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('offline-edit-after-reconnect.png') })
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect.poll(() => read(page)).toEqual({ ...merged, text: '初始正文' })
    await expect.poll(() => read(peer)).toEqual({ ...merged, text: '初始正文' })
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect.poll(() => read(peer)).toEqual(merged)
    await expect(syncStatus(page)).toHaveAttribute('data-cache', 'saved')
    await page.reload()
    await waitEngine(page)
    await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected')
    await expect.poll(() => read(page)).toEqual(merged)

    const freshContext = await context.browser()!.newContext()
    try {
      const fresh = await freshContext.newPage()
      await fresh.goto(page.url())
      await waitEngine(fresh)
      await expect(syncStatus(fresh)).toHaveAttribute('data-sync', 'connected')
      await expect.poll(() => read(fresh)).toEqual(merged)
    } finally {
      await freshContext.close()
    }
    expect(errors).toEqual([])
  } finally {
    await peerContext.close()
  }
})

test('同伴删除离线正在编辑的节点后关闭编辑器，隐藏并发新连线且不复活节点', async ({
  page,
  context,
}) => {
  const net = await syncSwitch(context)
  await newProject(page)
  await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected')
  const source = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '待删除正文',
      params: { text: '原文' },
      x: 100,
      y: 100,
    }),
  )
  const read = (target: Page) =>
    target.evaluate((id) => {
      const doc = window.__plein.engine.doc
      return {
        exists: !!doc.get(id),
        count: [...doc.elements()].length,
        edges: [...doc.edges()].length,
      }
    }, source)
  const peerContext = await context.browser()!.newContext()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    const peer = await peerContext.newPage()
    await peer.goto(page.url())
    await waitEngine(peer)
    await expect(syncStatus(peer)).toHaveAttribute('data-sync', 'connected')
    await expect.poll(() => read(peer)).toEqual({ exists: true, count: 1, edges: 0 })
    net.offline()
    await expect(syncStatus(page)).toHaveAttribute('data-sync', 'disconnected')
    await page.getByRole('treeitem', { name: '待删除正文 定位到画布', exact: true }).click()
    await page.getByRole('textbox', { name: '提示词', exact: true }).fill('尚未同步的正文')
    // 模拟离线中新建依赖；同伴删除时尚不知道这条边的存在。
    await page.evaluate((id) => {
      const target = window.__plein.addNode({
        type: 'plein/image',
        name: '保留的图片',
        params: {},
        x: 800,
        y: 100,
      })
      if (!window.__plein.connect([id, 'text'], [target, 'prompt'])) throw new Error('连线失败')
    }, source)
    await expect.poll(() => read(page)).toEqual({ exists: true, count: 2, edges: 1 })
    await peer.getByRole('treeitem', { name: '待删除正文 定位到画布', exact: true }).click()
    await peer.keyboard.press('Delete')
    await expect.poll(() => read(peer)).toEqual({ exists: false, count: 0, edges: 0 })
    net.online()
    await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected', { timeout: 30_000 })
    const merged = { exists: false, count: 1, edges: 0 }
    await expect.poll(() => read(page)).toEqual(merged)
    await expect.poll(() => read(peer)).toEqual(merged)
    await expect(page.getByRole('region', { name: '文本 生成器', exact: true })).toHaveCount(0)
    await expect(
      page.getByRole('treeitem', { name: '待删除正文 定位到画布', exact: true }),
    ).toHaveCount(0)
    await expect(
      page.getByRole('treeitem', { name: '保留的图片 定位到画布', exact: true }),
    ).toBeVisible()
    await expect(syncStatus(page)).toHaveAttribute('data-cache', 'saved')
    await page.reload()
    await waitEngine(page)
    await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected')
    await expect.poll(() => read(page)).toEqual(merged)
    expect(errors).toEqual([])
  } finally {
    await peerContext.close()
  }
})

test('离线缓存尚未落盘时保护刷新，事务完成后才显示已保存', async ({ page, context }) => {
  const net = await syncSwitch(context)
  await newProject(page)
  await addNode(page, '文本', { x: 400, y: 450 })
  await page.keyboard.press('Escape')
  await expect(syncStatus(page)).toHaveAttribute('data-cache', 'saved')
  const canvasId = page.url().split('#/c/')[1]!.split(/[/?]/)[0]!
  const blocker = await context.newPage()
  try {
    await blocker.goto('/')
    // 同一数据库的写事务持续排队，确定性地阻止主页面的缓存写入提交。
    await blocker.evaluate(
      (id) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open(`plein-canvas:${id}`)
          open.onerror = () => reject(open.error)
          open.onsuccess = () => {
            const db = open.result
            const tx = db.transaction('updates', 'readwrite')
            const store = tx.objectStore('updates')
            let held = true
            ;(window as unknown as { releaseCache(): void }).releaseCache = () => {
              held = false
            }
            const keep = () => {
              const count = store.count()
              count.onsuccess = () => {
                if (held) keep()
              }
            }
            keep()
            tx.oncomplete = () => db.close()
            resolve()
          }
        }),
      canvasId,
    )
    net.offline()
    await expect(syncStatus(page)).toHaveAttribute('data-sync', 'disconnected')
    await addNode(page, '文本', { x: 900, y: 450 })
    await page.keyboard.press('Escape')
    await expect.poll(() => nodeCount(page)).toBe(2)
    await expect(syncStatus(page)).toHaveAttribute('data-cache', 'saving')
    await expect(syncStatus(page)).toContainText('正在保存到本机')
    const dialog = page.waitForEvent('dialog')
    const reload = page.reload({ timeout: 2_000 }).catch(() => {})
    const warning = await dialog
    expect(warning.type()).toBe('beforeunload')
    await warning.dismiss()
    await reload
    expect(await nodeCount(page)).toBe(2)
    await blocker.evaluate(() => (window as unknown as { releaseCache(): void }).releaseCache())
    await expect(syncStatus(page)).toHaveAttribute('data-cache', 'saved')
    await page.reload()
    await waitEngine(page)
    await expect.poll(() => nodeCount(page)).toBe(2)
  } finally {
    await blocker.close()
  }
})

test('旧版本的缓存不先显示，等服务端同步', async ({ page, context }) => {
  const net = await syncSwitch(context)
  await newProject(page)
  await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected')

  // 断线后把本机文档的 schemaVersion 改旧（写进缓存，不会传到服务端）
  net.offline()
  await expect(syncStatus(page)).toHaveAttribute('data-sync', 'disconnected')
  await page.evaluate(() => {
    const doc = window.__plein.engine.doc as unknown as {
      ydoc: { getMap(n: string): { set(k: string, v: unknown): void } }
    }
    doc.ydoc.getMap('meta').set('schemaVersion', 0)
  })
  await expect(syncStatus(page)).toHaveAttribute('data-cache', 'saved')
  await page.reload()
  await expect(syncStatus(page)).toHaveAttribute('data-sync', /connecting|disconnected/)
  // 等一会儿：缓存已读完，但不是当前版本，画布不打开
  await page.waitForTimeout(1500)
  expect(await page.evaluate(() => !!window.__plein)).toBe(false)
})

test('打开已在别处删除的画布：清掉本机缓存并回首页', async ({ page, request }) => {
  await newProject(page)
  await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected')
  const url = page.url()
  const canvasId = decodeURIComponent(url.split('#/c/')[1]!.split(/[/?]/)[0]!)
  const cacheName = `plein-canvas:${canvasId}`
  const caches = () =>
    page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? ''))
  await expect.poll(caches).toContain(cacheName)

  // 离开画布后，在别处（另一个窗口、另一台设备）删掉它；再打开时服务端以 4404 关闭同步
  await page.goto('/')
  expect((await request.delete(`/api/canvases/${encodeURIComponent(canvasId)}`)).ok()).toBe(true)
  await page.goto(url)
  await expect(page.getByText('画布不存在或已被删除')).toBeVisible()
  await expect(page).not.toHaveURL(/#\/c\//)
  await expect.poll(caches).not.toContain(cacheName)
})

/** 64×48 的纯色 PNG */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAYklEQVR4nO3PUQkAIBTAwBfFqDbXEH4cwmABbnP2+rrhgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACx67GbZ1HuLZqnQAAAAASUVORK5CYII=',
  'base64',
)

test('断线期间没加载出来的预览图，重连后自动补上', async ({ page, context }) => {
  const net = await syncSwitch(context)
  await newProject(page)
  await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传' }).click()
  await (await chooser).setFiles({ name: 'still.png', mimeType: 'image/png', buffer: PNG })
  const images = async () => (await elements(page)).filter((e) => e.kind === 'image').length
  await expect.poll(images).toBe(1)

  // 断线并让素材请求失败（相当于服务停了），刷新：画布从缓存打开，预览图加载失败
  net.offline()
  const thumbs = /\/api\/assets\/[^/]+\/thumb-/
  await context.route(thumbs, (r) => r.abort('connectionrefused'))
  // 画布自己取的预览图走 fetch（侧栏缩略图是 <img>，不算）；镜头对准后会换大图，等大图也失败
  const canvasThumb = (r: { url(): string; resourceType(): string }) =>
    thumbs.test(r.url()) && r.resourceType() === 'fetch'
  const failed = page.waitForEvent(
    'requestfailed',
    (r) => canvasThumb(r) && r.url().endsWith('thumb-1024'),
  )
  await expect(syncStatus(page)).toHaveAttribute('data-cache', 'saved')
  await page.reload()
  await waitEngine(page)
  await expect.poll(images).toBe(1)
  await failed
  await page.waitForTimeout(500)

  await context.unroute(thumbs)
  const loaded = page.waitForResponse((r) => canvasThumb(r.request()) && r.ok())
  net.online()
  await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected', { timeout: 30_000 })
  await loaded
})

test('IndexedDB 不可用时照常从服务端打开，断线时提示改动没存下', async ({ page, context }) => {
  const net = await syncSwitch(context)
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      get() {
        throw new DOMException('blocked', 'SecurityError')
      },
    })
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await newProject(page)
  await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected')
  await addNode(page, '文本')
  await expect.poll(() => nodeCount(page)).toBe(1)
  net.offline()
  await expect(syncStatus(page)).toContainText('改动未保存')
  expect(errors).toEqual([])
})
