import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import {
  addNode,
  byName,
  centerOf,
  contextMenu,
  elements,
  newProject,
  waitEngine,
  waitIdle,
  waitNode,
  zoomTo,
} from '../canvas'

/**
 * L4：真实平台跑一部 6 镜头短剧，从模板到导出带字幕的 MP4。
 * 中途在镜头视频生成时强杀服务端再起来，核对任务按原来的远端任务续查、没有重复提交。
 * 产物和日志留在 PLEIN_L4_DATA 里，声画同步、衔接、字幕由人看成片判定。
 */
const DATA = process.env.PLEIN_L4_DATA
const PORT = Number(process.env.PLEIN_L4_PORT)
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = join(import.meta.dirname, '../..')
const SHOTS = 6

test.skip(!DATA, '需要 PLEIN_L4_DATA：配好平台密钥的数据目录（会产生真实费用）')

let server: ChildProcess | null = null

async function startServer() {
  mkdirSync(join(DATA!, 'logs'), { recursive: true })
  const log = openSync(join(DATA!, 'logs', 'l4-server.log'), 'a')
  server = spawn(join(ROOT, 'apps/server/node_modules/.bin/tsx'), ['src/main.ts'], {
    cwd: join(ROOT, 'apps/server'),
    // 单独的进程组：强杀时连 tsx 起的 node 一起杀掉
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      PLEIN_PORT: String(PORT),
      PLEIN_DATA_DIR: DATA,
      PLEIN_WEB_DIST: join(ROOT, 'apps/web/dist-e2e'),
      PLEIN_AGENT: '0',
    },
  })
  closeSync(log)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const ok = await fetch(`${BASE}/api/health`).then(
      (r) => r.ok,
      () => false,
    )
    if (ok) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('服务端没有起来，看 logs/l4-server.log')
}

/** 模拟崩溃：不给服务端保存和收尾的机会 */
function killServer() {
  if (server?.pid) process.kill(-server.pid, 'SIGKILL')
  server = null
}

test.afterAll(() => killServer())

/** 数据库里某块画布正在跑的任务和它们记下的远端调用 */
function activeJobs(canvas: string) {
  const out = execFileSync(
    'sqlite3',
    [
      '-json',
      join(DATA!, 'plein.db'),
      `SELECT id, node_id, status, attempts, calls FROM jobs WHERE canvas_id = '${canvas}' AND status IN ('queued', 'running')`,
    ],
    { encoding: 'utf8' },
  )
  return (out.trim() ? JSON.parse(out) : []) as Array<{
    id: string
    node_id: string
    status: string
    attempts: number
    calls: string
  }>
}

function jobCalls(ids: string[]) {
  const out = execFileSync(
    'sqlite3',
    [
      '-json',
      join(DATA!, 'plein.db'),
      `SELECT id, status, attempts, calls FROM jobs WHERE id IN (${ids.map((i) => `'${i}'`).join(',')})`,
    ],
    { encoding: 'utf8' },
  )
  return JSON.parse(out) as Array<{ id: string; status: string; attempts: number; calls: string }>
}

/** 调用记录里的远端任务 ID：提交后（pending）和完成后（done）都带着；没提交的调用没有 */
const remoteIds = (calls: string) =>
  Object.values(JSON.parse(calls) as Record<string, { remoteId?: string }>)
    .map((r) => r.remoteId)
    .filter((id): id is string => !!id)
    .sort()

const note = (type: string, description: string) => {
  test.info().annotations.push({ type, description })
  console.log(`[${type}] ${description}`)
}

async function openBoard(page: Page, id: string) {
  await page.keyboard.press('Escape')
  await zoomTo(page, [id])
  const p = await centerOf(page, id)
  await page.mouse.dblclick(p.x, p.y)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

test('真实平台：6 镜头短剧从模板到字幕成片，中途重启服务', async ({ page }) => {
  await startServer()
  test.info().annotations.push({ type: '数据目录', description: DATA! })
  await newProject(page)
  const canvas = page.url().split('#/c/')[1]!.split(/[/?]/)[0]!
  note('画布', canvas)
  await addNode(page, '短剧')
  await expect(page.locator('.ui-toast')).toContainText('短剧模板已铺出')
  const models = await page.evaluate(() =>
    [...window.__plein.engine.doc.elements()]
      .filter((e) => e.kind === 'node')
      .map((e) => `${e.name}=${(e as { params?: { model?: string } }).params?.model ?? ''}`),
  )
  note('模型', models.join('；'))

  // 镜头数改成 6：参数和提示词里的数字一起改
  const board = await byName(page, '分镜（双击展开镜头）')
  await page.keyboard.press('Escape')
  await zoomTo(page, [board.id])
  const bp = await centerOf(page, board.id)
  await page.mouse.click(bp.x, bp.y)
  const prompt = page.getByRole('textbox', { name: '提示词' })
  await prompt.fill((await prompt.inputValue()).replace(/拆成 \d+ 个镜头/, `拆成 ${SHOTS} 个镜头`))
  await page
    .getByRole('button', { name: /参数/ })
    .first()
    .click()
  await page.getByText('更多参数').click()
  await page.getByLabel('镜头数').fill(String(SHOTS))
  await page.keyboard.press('Escape')

  await contextMenu(page, board.id, '运行到此处')
  await waitNode(page, board.id, 10 * 60_000)

  const cast = await byName(page, '角色与场景抽取')
  await zoomTo(page, [cast.id])
  await contextMenu(page, cast.id, '运行到此处')
  await waitNode(page, cast.id, 5 * 60_000)
  const castMenu = page.getByRole('menu')
  const p = await centerOf(page, cast.id)
  await page.keyboard.press('Escape')
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await castMenu.getByText(/^生成设定卡/).click()
  await expect(page.locator('.ui-toast')).toContainText('设定卡')
  note('设定卡', (await page.locator('.ui-toast').textContent()) ?? '')
  const voices = await page.evaluate(() =>
    [...window.__plein.engine.doc.elements()]
      .filter((e) => e.nodeType === 'plein/character')
      .map((e) => {
        const v = (e as { params?: { voice?: { voiceId?: string } } }).params?.voice
        return `${e.name}=${v?.voiceId || '（未配）'}`
      }),
  )
  note('音色', voices.join('；'))

  let dialog = await openBoard(page, board.id)
  await dialog.getByRole('button', { name: '展开为节点' }).click()
  await expect(page.locator('.ui-toast')).toContainText('已展开')
  note('展开', (await page.locator('.ui-toast').textContent()) ?? '')

  dialog = await openBoard(page, board.id)
  await dialog.getByRole('button', { name: '批量出分镜图' }).click()
  await expect(page.locator('.ui-toast')).toContainText('已开始生成')
  await waitIdle(page, 20 * 60_000)
  // 批量出分镜图会先出镜头 @ 到的角色的定妆图
  const portraits = (await elements(page)).filter((e) => e.name?.endsWith(' · 定妆图'))
  note('定妆图', portraits.map((e) => `${e.name}：${e.results} 张`).join('；'))
  expect(portraits.some((e) => e.results > 0)).toBe(true)

  dialog = await openBoard(page, board.id)
  await dialog.getByRole('button', { name: '批量生成视频' }).click()
  await expect(page.locator('.ui-toast')).toContainText('已开始生成')

  // 等至少一个视频已经提交到平台（调用记录里有远端任务），再强杀服务端
  await expect
    .poll(() => activeJobs(canvas).filter((j) => remoteIds(j.calls).length > 0).length, {
      timeout: 10 * 60_000,
      intervals: [2_000],
    })
    .toBeGreaterThan(0)
  const before = activeJobs(canvas)
  note(
    '重启前',
    `${before.length} 个任务在跑，${before.filter((j) => remoteIds(j.calls).length > 0).length} 个已提交到平台`,
  )
  killServer()
  await startServer()
  await page.reload()
  await waitEngine(page)

  await waitIdle(page, 40 * 60_000)
  const after = jobCalls(before.map((j) => j.id))
  for (const b of before.filter((j) => remoteIds(j.calls).length > 0)) {
    const a = after.find((x) => x.id === b.id)!
    // 重启前已提交的远端任务，完成后记录里还是同一个 ID：续查原任务，没有再提交一次（不重复计费）
    expect(remoteIds(a.calls), `任务 ${b.id} 的远端任务`).toEqual(remoteIds(b.calls))
  }
  note(
    '续跑',
    before
      .filter((b) => remoteIds(b.calls).length)
      .map((b) => `${b.id} → ${remoteIds(b.calls).join('、')}`)
      .join('；'),
  )
  note('重启后', after.map((a) => `${a.id}:${a.status}（第 ${a.attempts} 次）`).join('，'))

  dialog = await openBoard(page, board.id)
  await dialog.getByRole('button', { name: '批量配音' }).click()
  await waitIdle(page, 20 * 60_000)

  const all = await elements(page)
  const failed = all.filter((e) => e.status === 'failed')
  expect(failed.map((e) => e.name)).toEqual([])

  const music = await byName(page, '配乐')
  await zoomTo(page, [music.id])
  await contextMenu(page, music.id, '运行到此处')
  await waitNode(page, music.id, 10 * 60_000)

  const seq = await byName(page, '序列')
  await zoomTo(page, [seq.id])
  await contextMenu(page, seq.id, '运行到此处')
  await waitNode(page, seq.id, 20 * 60_000)
  const out = (await page.evaluate((id) => {
    const el = window.__plein.engine.doc.get(id)!
    return el.results!.at(-1)!.value
  }, seq.id)) as { assetId: string; mime: string }
  expect(out.mime).toBe('video/mp4')
  const meta = (await (await page.request.get(`/api/assets/${out.assetId}/meta`)).json()) as {
    width: number
    height: number
    duration: number
  }
  note('成片', `${out.assetId}：${meta.width}×${meta.height}，${meta.duration.toFixed(1)} 秒`)
  expect([meta.width, meta.height]).toEqual([1080, 1920])
})
