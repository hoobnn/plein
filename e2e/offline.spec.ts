import { type BrowserContext, expect, type Page, test, type WebSocketRoute } from './fixtures'
import { addNode, clickElement, elements, newProject, revealGenerator, waitEngine } from './canvas'

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

  /** 另开一个不带同步拦截的上下文，读服务端那边这个节点的提示词 */
  async function serverPrompt(context: BrowserContext, url: string, id: string) {
    const fresh = await context.browser()!.newContext()
    const page = await fresh.newPage()
    try {
      await page.goto(url)
      await waitEngine(page)
      await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected')
      return page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.prompt, id)
    } finally {
      await fresh.close()
    }
  }

  const canvasIdOf = (page: Page) =>
    decodeURIComponent(page.url().split('#/c/')[1]!.split(/[/?]/)[0]!)

  interface JobRow {
    nodeId: string
    input?: { prompt?: string }
  }

  const jobsOf = (page: Page, canvasId: string) =>
    page.evaluate(
      async (canvasId) =>
        ((await (await fetch(`/api/canvases/${canvasId}/jobs`)).json()) as { jobs: JobRow[] }).jobs,
      canvasId,
    )

  test.describe('同步尚未确认时的预览、提交与离开保护', { tag: '@core' }, () => {
    test('同步连接断了但 HTTP 通：本机输入没到服务端不能生成，重连后按新输入只生成一次', async ({
      page,
      context,
    }) => {
      const net = await syncSwitch(context)
      await newProject(page)
      const id = await page.evaluate(() =>
        window.__plein.addNode({
          type: 'plein/image',
          name: '同步屏障',
          params: { prompt: '断线前的提示词' },
          x: 400,
          y: 200,
        }),
      )
      await clickElement(page, id)
      await revealGenerator(page)
      const panel = page.getByTestId('generator')
      const prompt = panel.getByRole('textbox', { name: '提示词', exact: true })
      await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected')
      await expect(panel.getByRole('button', { name: /实际输入/ })).toBeVisible()
      const run = panel.getByRole('button', { name: '生成', exact: true })
      await expect(run).toBeEnabled()

      // 只断文档同步，HTTP 仍然可用
      net.offline()
      await expect(syncStatus(page)).toHaveAttribute('data-sync', 'disconnected')
      await prompt.fill('断线后改的提示词')
      await expect(panel.getByText(/本机改动还没有同步到服务端/).first()).toBeVisible()
      await expect(run).toBeDisabled()
      const canvasId = canvasIdOf(page)
      // 按钮禁用之外：快捷键也不能让服务端受理还没同步的输入
      await page.keyboard.press('ControlOrMeta+Enter')
      await page.waitForTimeout(500)
      expect(await jobsOf(page, canvasId)).toHaveLength(0)

      // HTTP 通：另一个上下文读回服务端文档，仍是断线前那一版
      expect(await serverPrompt(context, page.url(), id)).toBe('断线前的提示词')

      net.online()
      await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected', { timeout: 30_000 })
      // 重连后系统自己重取当前预览（不用再点「重新读取」），但不会替用户提交
      await expect(run).toBeEnabled()
      expect(await jobsOf(page, canvasId)).toHaveLength(0)
      await panel.getByRole('button', { name: /实际输入/ }).click()
      await expect(panel.getByTestId('final-prompt')).toContainText('断线后改的提示词')

      // 用户明确运行：只生成这一份，输入是新的
      await run.click()
      await expect.poll(() => jobsOf(page, canvasId).then((jobs) => jobs.length)).toBe(1)
      const jobs = await jobsOf(page, canvasId)
      expect(jobs[0]?.input?.prompt).toContain('断线后改的提示词')
    })

    test('没有 IndexedDB 时离线改动受离开保护，留在编辑不丢稿，重连后才能直接离开', async ({
      page,
      context,
    }) => {
      await context.addInitScript(() => {
        Object.defineProperty(window, 'indexedDB', { get: () => undefined, configurable: true })
      })
      const net = await syncSwitch(context)
      // 先过首页：浏览器历史里有首页这一条，后面才能用真实 history.back() 回到首页
      await newProject(page, { visitHome: true })
      const id = await page.evaluate(() =>
        window.__plein.addNode({
          type: 'plein/image',
          name: '内存里的改动',
          params: { prompt: '离线前的提示词' },
          x: 400,
          y: 200,
        }),
      )
      await clickElement(page, id)
      await revealGenerator(page)
      const panel = page.getByTestId('generator')
      const prompt = panel.getByRole('textbox', { name: '提示词', exact: true })
      await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected')

      net.offline()
      await expect(syncStatus(page)).toHaveAttribute('data-sync', 'disconnected')
      await expect(syncStatus(page)).toHaveAttribute('data-cache', 'unavailable')
      await prompt.fill('离线时唯一的改动')
      await expect(prompt).toHaveValue('离线时唯一的改动')

      // 回首页：先询问，留在编辑则地址、画布和改动都在
      await page.getByRole('link', { name: 'Plein', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '还有改动没有保存' })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: '留在编辑' }).click()
      await expect(dialog).toHaveCount(0)
      expect(page.url()).toContain('#/c/')
      expect(
        await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.prompt, id),
      ).toBe('离线时唯一的改动')

      // 真实浏览器后退：先恢复地址再询问，用户留下则仍在原画布
      const canvasUrl = page.url()
      await page.goBack()
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: '留在编辑' }).click()
      await expect(page).toHaveURL(canvasUrl)
      expect(
        await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.prompt, id),
      ).toBe('离线时唯一的改动')

      // 刷新：浏览器原生提示，取消后仍在原页且改动还在
      const warning = page.waitForEvent('dialog')
      const reload = page.reload({ timeout: 2_000 }).catch(() => {})
      const confirm = await warning
      expect(confirm.type()).toBe('beforeunload')
      await confirm.dismiss()
      await reload
      await expect.poll(() => page.url()).toContain('#/c/')
      await expect(prompt).toHaveValue('离线时唯一的改动')

      // 重连并确认服务端已保存后，离开不再询问
      net.online()
      await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected', { timeout: 30_000 })
      // 连接恢复不等于保存完成：等服务端确认落库后才解除保护
      await page.waitForFunction(() => !window.__plein.unsaved(), undefined, { timeout: 30_000 })
      // 另一个上下文真实读回离线时那次改动，而不是只看原页表情
      expect(await serverPrompt(context, page.url(), id)).toBe('离线时唯一的改动')
      await page.getByRole('link', { name: 'Plein', exact: true }).click()
      await expect(page).toHaveURL(/#\/$/)
      await expect(page.getByRole('dialog', { name: '还有改动没有保存' })).toHaveCount(0)
    })
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
