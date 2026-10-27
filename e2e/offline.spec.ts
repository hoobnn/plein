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
})
