import { type BrowserContext, expect, type Page, test, type WebSocketRoute } from './fixtures'
import { addNode, elements, newProject, waitEngine } from './canvas'

/**
 * 浏览器文档缓存（y-indexeddb）与断线重连的关键旅程。
 *
 * 断线用拦截同步 WebSocket（`routeWebSocket`）实现：页面和素材照常从服务端取，
 * 只断文档同步。服务重启后重连合并的旅程在 `offline-restart.spec.ts`；
 * 会话、路由与任务面板的失败恢复由组件测试覆盖。
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

test.describe('离线编辑与本机缓存', { tag: '@core' }, () => {
  test('断线编辑，断线时刷新从本机缓存恢复，重连后合并到服务端', async ({ page, context }) => {
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
})
