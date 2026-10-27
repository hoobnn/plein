import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Browser, type Page, test } from './fixtures'
import { addNode, elements, waitEngine } from './canvas'
import { slowFile } from './slow-file'

/**
 * 服务停掉再起来：验证文档同步在服务端重启后自动重连并合并。
 *
 * 这条用例自己管服务（还要把服务杀掉再起），所以单独成文件：
 * worker 作用域的开关只能按文件切换，不能在 describe 分组里改。
 * 断线但服务还活着的场景在 `offline.spec.ts` 里，用 WebSocket 拦截实现。
 */

/** 画布上的节点数 */
const nodeCount = async (page: Page) =>
  (await elements(page)).filter((e) => e.kind === 'node').length

const syncStatus = (page: Page) => page.getByTestId('sync-status')

/** 不带缓存的新页面打开画布，读出服务端那边的节点数 */
async function serverNodes(browser: Browser, url: string) {
  const fresh = await browser.newContext()
  const page = await fresh.newPage()
  await page.goto(url)
  await waitEngine(page)
  await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected')
  const n = await nodeCount(page)
  await fresh.close()
  return n
}

// 首次由服务自身分配空闲端口；崩溃后复用它，保证原页面能重连。
let port = 0
let base = ''
let dataDir = ''
let server: ChildProcess | null = null

const start = async () => {
  const root = join(import.meta.dirname, '..')
  const child = spawn(
    join(root, 'apps/server/node_modules/.bin/tsx'),
    [join(root, 'apps/server/src/main.ts')],
    {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PLEIN_PORT: String(port),
        PLEIN_DATA_DIR: dataDir,
        PLEIN_WEB_DIST: process.env.PLEIN_E2E_DIST ?? join(root, 'apps/web/dist-e2e'),
        PLEIN_MOCK_PROVIDER: '1',
        PLEIN_AGENT: '0',
      },
    },
  )
  server = child
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  base = await new Promise<string>((resolve, reject) => {
    let output = ''
    let errors = ''
    const finish = (url?: string, error?: Error) => {
      clearTimeout(timer)
      child.stdout?.off('data', read)
      child.off('error', failed)
      child.off('exit', exited)
      if (error) reject(error)
      else resolve(url!)
    }
    const read = (chunk: string) => {
      output = (output + chunk.toString()).slice(-8192)
      const match = /plein 已启动：(http:\/\/[^\s]+)/.exec(output)
      if (match) finish(match[1])
    }
    const failed = (error: Error) => finish(undefined, error)
    const exited = (code: number | null) =>
      failed(new Error(`重启测试服务提前退出 (${code}): ${errors}`))
    const timer = setTimeout(() => failed(new Error(`重启测试服务启动超时: ${errors}`)), 60_000)
    child.stdout?.on('data', read)
    child.stderr?.on('data', (chunk: string) => {
      errors = (errors + chunk.toString()).slice(-8192)
    })
    child.once('error', failed)
    child.once('exit', exited)
  })
  const reportedPort = Number(new URL(base).port)
  if (port && port !== reportedPort) throw new Error('重启后的服务没有复用原端口')
  port = reportedPort
  await expect
    .poll(
      () =>
        fetch(`${base}/api/health`).then(
          (r) => r.ok,
          () => false,
        ),
      { timeout: 60_000 },
    )
    .toBe(true)
}

/** 直接杀掉整个进程组，模拟服务崩溃 */
const kill = async () => {
  if (!server?.pid) return
  const child = server
  server = null
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((done) => child.once('exit', done))
  process.kill(-child.pid!, 'SIGKILL')
  await exited
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'plein-e2e-restart-'))
  await start()
})
test.afterAll(async () => {
  await kill()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

test(
  '服务停掉期间继续编辑，重启后自动重连并合并',
  { tag: '@core' },
  async ({ page, context, browser }) => {
    await page.goto(`${base}/`)
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    await expect(page).toHaveURL(/#\/c\//)
    await waitEngine(page)
    await page.waitForFunction(
      () => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName === 'CANVAS',
    )
    const url = page.url()
    await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected')
    await addNode(page, '文本', { x: 400, y: 450 })
    await page.keyboard.press('Escape')
    await expect.poll(() => nodeCount(page)).toBe(1)
    // 等服务端攒批写库（50ms）
    await page.waitForTimeout(500)

    await kill()
    await expect(syncStatus(page)).toHaveAttribute('data-sync', 'disconnected')
    await addNode(page, '文本', { x: 900, y: 450 })
    await page.keyboard.press('Escape')
    await expect.poll(() => nodeCount(page)).toBe(2)
    // 入口由服务托管：服务停着时新开页面打不开
    const other = await context.newPage()
    await expect(other.goto(url)).rejects.toThrow()
    await other.close()

    await start()
    await expect(syncStatus(page)).toHaveAttribute('data-sync', 'connected', { timeout: 60_000 })
    await expect.poll(() => serverNodes(browser, url)).toBe(2)
  },
)

// 服务要杀掉再起，单条本来就慢
slowFile(test)
