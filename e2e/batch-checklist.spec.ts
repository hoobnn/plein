import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, type Page, type WebSocketRoute } from './fixtures'
import { clickElement, clickStoryboardAction, newProject } from './canvas'
import { checkReleaseSubmissions, startReleaseBatch, waitReleaseGroup } from './real/release-batch'

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
  await clickStoryboardAction(initial, '展开为镜头')
  await expect(initial).toBeHidden()
  return { board, open }
}

test('发布验收遇到未核实的旧任务会停下，已有分镜图会复用', async ({ page }) => {
  const f = await fixture(page)
  const dialog = await f.open()
  const dir = mkdtempSync(join(tmpdir(), 'plein-release-check-'))
  const file = join(dir, 'check.db')
  const db = new DatabaseSync(file)
  try {
    db.exec(`CREATE TABLE jobs (id TEXT, canvas_id TEXT, status TEXT, recovery TEXT, calls TEXT);
      INSERT INTO jobs VALUES ('lost', 'film', 'failed', NULL, '{"main":{"state":"unknown"}}')`)
    const check = () => checkReleaseSubmissions(file, 'film')
    let commits = 0
    page.on('request', (r) => {
      if (r.url().endsWith('/storyboard-batch/commit')) commits++
    })
    await expect(startReleaseBatch(dialog, f.board, 'image', check)).rejects.toThrow(
      /submit_unknown：lost.*核对远端任务 ID/,
    )
    expect(commits).toBe(0)
    db.exec(`UPDATE jobs SET status='succeeded', recovery='{"state":"adopted"}', calls='{}'`)
    const batch = await startReleaseBatch(dialog, f.board, 'image', check)
    expect(batch?.total).toBe(2)
    await waitReleaseGroup(page, batch!.groupId, check, 30_000)
    expect(await startReleaseBatch(dialog, f.board, 'image', check)).toBeNull()
    expect(commits).toBe(1)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('发布验收的确认响应中断后不再提交，同一批次仍可查到', async ({ page }) => {
  const f = await fixture(page)
  const dialog = await f.open()
  let commits = 0
  let group = ''
  await page.route('**/storyboard-batch/commit', async (route) => {
    commits++
    const result = await route.fetch()
    expect(result.status()).toBe(202)
    group = (await result.json()).groupId
    await route.abort('connectionreset')
  })
  const check = () =>
    checkReleaseSubmissions(
      join(process.env.PLEIN_E2E_DATA!, 'plein.db'),
      /#\/c\/([^/?]+)/.exec(page.url())![1]!,
    )
  await expect(startReleaseBatch(dialog, f.board, 'image', check)).rejects.toThrow(
    '批量确认结果未知',
  )
  await waitReleaseGroup(page, group, check, 30_000)
  expect(commits).toBe(1)
})

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
