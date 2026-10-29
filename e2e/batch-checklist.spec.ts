import { expect, test, type Page, type WebSocketRoute } from './fixtures'
import { clickElement, clickStoryboardAction, newProject } from './canvas'

/** 一个分镜节点并展开成节点，作为批量清单的输入。 */
async function fixture(page: Page) {
  await newProject(page)
  const board = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/storyboard',
      name: '清单分镜',
      x: 200,
      y: 200,
      params: {
        shots: [1, 2].map((no) => ({
          id: `checklist-${no}`,
          no,
          duration: 2,
          shotSize: '中景',
          description: `画面${no}`,
          characters: [],
          emotion: '',
          lighting: '',
          sfx: '',
          dialogue: [],
          imagePrompt: `清单构图${no}`,
          motionPrompt: '慢慢推进',
        })),
      },
    }),
  )
  const open = async () => {
    await clickElement(page, board)
    await page
      .getByTestId('generator')
      .getByRole('button', { name: /^编辑分镜表/ })
      .click()
    const dialog = page.getByRole('dialog', { name: '分镜表', exact: true })
    return dialog
  }
  const initial = await open()
  await clickStoryboardAction(initial, '展开为节点')
  await expect(initial).toBeHidden()
  return { board, open }
}

test(
  '清单断线重连后必须重新预检，断线前的迟到响应不能恢复提交',
  { tag: '@core' },
  async ({ page, context }) => {
    let online = true
    let commits = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/storyboard-batch/commit'))
        commits++
    })
    // 真断线：把同步用的 WebSocket 直接关掉，页面上的连接状态随之变化。
    const sockets = new Set<WebSocketRoute>()
    await context.routeWebSocket(/\/sync\//, (socket) => {
      if (!online) return void socket.close()
      socket.connectToServer()
      sockets.add(socket)
      socket.onClose(() => sockets.delete(socket))
    })
    const f = await fixture(page)
    const board = await f.open()
    await board.getByRole('button', { name: '批量出分镜图', exact: true }).click()
    const checklist = page.getByRole('dialog', { name: '批量生成清单', exact: true })
    const confirm = checklist.getByRole('button', { name: '确认并开始生成', exact: true })
    const refresh = checklist.getByRole('button', { name: '重新检查清单', exact: true })
    await expect(confirm).toBeEnabled()
    // 把一次预检的响应扣住，等断线之后才放回来。
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let waiting = false
    await page.route('**/storyboard-batch/preview', async (route) => {
      const response = await route.fetch()
      waiting = true
      await gate
      await route.fulfill({ response })
    })
    await refresh.click()
    await expect.poll(() => waiting).toBe(true)
    online = false
    for (const socket of sockets) await socket.close()
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-sync', 'disconnected')
    await expect(confirm).toBeDisabled()
    online = true
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected', {
      timeout: 30_000,
    })
    const late = page.waitForResponse('**/storyboard-batch/preview')
    release()
    await (await late).finished()
    await expect(refresh).toBeEnabled()
    // 等断线前请求的响应更新落地，不能在它仍未处理时提前通过。
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    )
    await expect(confirm).toBeDisabled()
    await expect(checklist).toContainText('请重新检查清单')
    await refresh.click()
    await expect(confirm).toBeEnabled()
    // 已完成的清单同样需要在下一次重连后重新检查。
    online = false
    for (const socket of sockets) await socket.close()
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-sync', 'disconnected')
    online = true
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected', {
      timeout: 30_000,
    })
    await expect(confirm).toBeDisabled()
    await refresh.click()
    await expect(confirm).toBeEnabled()
    expect(commits).toBe(0)
  },
)
