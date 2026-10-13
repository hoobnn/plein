import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import {
  addNode,
  byName,
  centerOf,
  clickElement,
  contextMenu,
  deselect,
  edgesInto,
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

/** 设定卡左边配的参考图节点名字后缀 */
const REF_SUFFIX: Record<string, string> = {
  'plein/character': '定妆图',
  'plein/scene': '场景图',
  'plein/prop': '道具图',
}

const KIND_TITLE: Record<string, string> = {
  'plein/character': '角色',
  'plein/scene': '场景',
  'plein/prop': '道具',
}

interface Card {
  id: string
  name: string
  nodeType: string
  voiceId: string
}

/** 生成设定卡新建的卡片（排除模板自带的示例卡「主角」「场景」「道具」） */
async function castCards(page: Page, names: string[]): Promise<Card[]> {
  return page.evaluate(
    ({ names, types }) =>
      [...window.__plein.engine.doc.elements()]
        .filter((e) => types.includes(e.nodeType ?? '') && names.includes(e.name ?? ''))
        .map((e) => ({
          id: e.id,
          name: e.name!,
          nodeType: e.nodeType!,
          voiceId: (e.params?.voice as { voiceId?: string } | undefined)?.voiceId ?? '',
        })),
    { names, types: Object.keys(REF_SUFFIX) },
  )
}

interface LibraryItem {
  id: string
  kind: string
  name: string
  tags: Record<string, string>
  images: Array<{ assetId: string }>
  voice: { voiceId: string } | null
}

/** 失败的节点：名字、错误码和错误信息 */
function failures(page: Page) {
  return page.evaluate(() =>
    [...window.__plein.engine.doc.elements()]
      .filter((e) => e.run?.status === 'failed')
      .map((e) => {
        const run = e.run as { error?: string; errorCode?: string }
        return { name: e.name ?? e.id, code: run.errorCode ?? '', error: run.error ?? '' }
      }),
  )
}

async function openBoard(page: Page, id: string) {
  await deselect(page)
  await zoomTo(page, [id])
  const p = await centerOf(page, id)
  await page.mouse.dblclick(p.x, p.y)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

test.describe.configure({ mode: 'serial' })

/** 第一个用例出片的画布；单独跑资产库用例时用 PLEIN_L4_CANVAS 指定，不给就取数据目录里最近的画布 */
let filmCanvas = process.env.PLEIN_L4_CANVAS ?? ''

test('真实平台：6 镜头短剧从模板到字幕成片，中途重启服务', async ({ page }) => {
  await startServer()
  test.info().annotations.push({ type: '数据目录', description: DATA! })
  await newProject(page)
  const canvas = page.url().split('#/c/')[1]!.split(/[/?]/)[0]!
  filmCanvas = canvas
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
  await clickElement(page, board.id)
  const prompt = page.getByRole('textbox', { name: '提示词' })
  await prompt.fill((await prompt.inputValue()).replace(/拆成 \d+ 个镜头/, `拆成 ${SHOTS} 个镜头`))
  await page
    .getByRole('button', { name: /参数/ })
    .first()
    .click()
  await page.getByText('更多参数').click()
  await page.getByLabel('镜头数').fill(String(SHOTS))
  await page.keyboard.press('Escape')

  // 分镜的上游是剧本和角色场景抽取（设定清单连进分镜，镜头按卡片名字写出场的角色、场景、道具）
  await contextMenu(page, board.id, '运行到此处')
  await waitNode(page, board.id, 10 * 60_000)

  const cast = await byName(page, '角色与场景抽取')
  expect(cast.status).toBe('succeeded')
  const entries = await page.evaluate((id) => {
    const v = window.__plein.engine.doc.get(id)!.results!.at(-1)!.value as { text?: string }
    return v.text ?? ''
  }, cast.id)
  note('抽取', entries.replace(/\n+/g, ' ').slice(0, 600))
  await zoomTo(page, [cast.id])
  await deselect(page)
  const p = await centerOf(page, cast.id)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page
    .getByRole('menu')
    .getByText(/^生成设定卡/)
    .click()
  await expect(page.locator('.ui-toast')).toContainText('设定卡')
  note('设定卡', (await page.locator('.ui-toast').textContent()) ?? '')

  // 抽取结果里的名字（### 标题）就是新卡的名字
  const names = [...entries.matchAll(/^###\s+(.+)$/gm)].map((m) =>
    m[1]!.replace(/\*\*/g, '').trim(),
  )
  const cards = await castCards(page, names)
  const ofType = (t: string) => cards.filter((c) => c.nodeType === t)
  note(
    '卡片',
    Object.keys(REF_SUFFIX)
      .map(
        (t) =>
          `${t}：${ofType(t)
            .map((c) => c.name)
            .join('、')}`,
      )
      .join('；'),
  )
  expect(ofType('plein/character').length).toBeGreaterThanOrEqual(2)
  expect(ofType('plein/scene').length).toBeGreaterThanOrEqual(1)
  // 一个上锁的铁盒贯穿全片，抽取得出道具
  expect(ofType('plein/prop').length).toBeGreaterThanOrEqual(1)
  // 每张卡左边配好参考图节点，连进卡片
  const all0 = await elements(page)
  for (const c of cards) {
    const ref = all0.find((e) => e.name === `${c.name} · ${REF_SUFFIX[c.nodeType]}`)
    expect(ref, `${c.name} 的${REF_SUFFIX[c.nodeType]}节点`).toBeTruthy()
    const into = await edgesInto(page, c.id)
    expect(into.map(([from]) => from)).toContain(ref!.id)
  }
  // 角色都配上音色，男女角色不共用一个声音
  const chars = ofType('plein/character')
  note('音色', chars.map((c) => `${c.name}=${c.voiceId || '（未配）'}`).join('；'))
  expect(chars.filter((c) => !c.voiceId).map((c) => c.name)).toEqual([])
  expect(new Set(chars.map((c) => c.voiceId)).size).toBeGreaterThanOrEqual(2)

  let dialog = await openBoard(page, board.id)
  await dialog.getByRole('button', { name: '展开为节点' }).click()
  await expect(page.locator('.ui-toast')).toContainText('已展开')
  note('展开', (await page.locator('.ui-toast').textContent()) ?? '')
  // 镜头图提示词 @ 到了角色、场景和道具卡
  const prompts = await page.evaluate(() =>
    [...window.__plein.engine.doc.elements()]
      // 展开出来的节点参数里带着分镜来源
      .filter((e) => e.nodeType === 'plein/image' && !!e.params?.source)
      .map((e) => String(e.params?.prompt ?? '')),
  )
  const mentioned = (t: string) =>
    ofType(t)
      .filter((c) => prompts.some((pr) => pr.includes(`@${c.name}`)))
      .map((c) => c.name)
  note(
    '镜头引用',
    Object.keys(REF_SUFFIX)
      .map((t) => `${t}：${mentioned(t).join('、') || '无'}`)
      .join('；'),
  )
  expect(mentioned('plein/character').length).toBeGreaterThan(0)
  expect(mentioned('plein/scene').length).toBeGreaterThan(0)
  expect(mentioned('plein/prop').length).toBeGreaterThan(0)

  dialog = await openBoard(page, board.id)
  await dialog.getByRole('button', { name: '批量出分镜图' }).click()
  await expect(page.locator('.ui-toast')).toContainText('已开始生成')
  await waitIdle(page, 20 * 60_000)
  // 平台审核偶尔拦下生成出来的图（不是提示词的问题，重出一次多半能过）：
  // 像用户那样再点一次批量，出过的沿用，只补失败和因此跳过的
  const rejected = await failures(page)
  if (rejected.length && rejected.every((f) => f.code === 'content_policy')) {
    note('审核重出', rejected.map((f) => `${f.name}：${f.error}`).join('；'))
    dialog = await openBoard(page, board.id)
    await dialog.getByRole('button', { name: '批量出分镜图' }).click()
    await expect(page.locator('.ui-toast')).toContainText('已开始生成')
    await waitIdle(page, 20 * 60_000)
  }
  // 重出一次还被审核拦下的只能是参考图（比如印着姓名的快递单）：@ 引用是软依赖，
  // 镜头不等它、只带文字设定照常出；其余节点一个都不许失败
  const isRef = (name: string) => / · (定妆图|场景图|道具图)$/.test(name)
  const still = await failures(page)
  if (still.length) note('审核未过', still.map((f) => `${f.name}：${f.error}`).join('；'))
  expect(still.filter((f) => !(isRef(f.name) && f.code === 'content_policy'))).toEqual([])
  const blocked = new Set(still.map((f) => f.name))
  // 批量出分镜图会先出镜头 @ 到的卡片的参考图：定妆图、场景图、道具图
  const refs = (await elements(page)).filter((e) => isRef(e.name ?? ''))
  note('参考图', refs.map((e) => `${e.name}：${e.results} 张`).join('；'))
  for (const t of Object.keys(REF_SUFFIX))
    for (const name of mentioned(t)) {
      const ref = refs.find((e) => e.name === `${name} · ${REF_SUFFIX[t]}`)
      if (blocked.has(ref?.name ?? '')) continue
      expect(ref?.results, `${name} 的${REF_SUFFIX[t]}`).toBeGreaterThan(0)
    }
  // 展开出来的镜头图一张不少
  const shots = await page.evaluate(() =>
    [...window.__plein.engine.doc.elements()]
      .filter((e) => e.nodeType === 'plein/image' && !!e.params?.source)
      .map((e) => ({ name: e.name, results: e.results?.length ?? 0 })),
  )
  expect(shots.length).toBeGreaterThan(0)
  expect(shots.filter((e) => e.results === 0).map((e) => e.name)).toEqual([])

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
  const failed = all.filter((e) => e.status === 'failed' && !blocked.has(e.name ?? ''))
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

  // 等这次运行的完成提示弹过：它晚一步到，会盖掉后面的提示
  await expect(page.locator('.ui-toast')).toContainText('运行到「序列」')
})

test('资产库：出片画布上的角色、场景、道具存进资产库，在新项目里取用', async ({ page }) => {
  if (!server) await startServer()
  if (!filmCanvas) {
    const out = execFileSync(
      'sqlite3',
      [join(DATA!, 'plein.db'), 'SELECT id FROM canvases ORDER BY created_at DESC LIMIT 1'],
      { encoding: 'utf8' },
    )
    filmCanvas = out.trim()
  }
  note('画布', filmCanvas)
  await page.goto(`/#/c/${filmCanvas}`)
  await waitEngine(page)
  const cast = await byName(page, '角色与场景抽取')
  const entries = await page.evaluate((id) => {
    const v = window.__plein.engine.doc.get(id)!.results!.at(-1)!.value as { text?: string }
    return v.text ?? ''
  }, cast.id)
  const names = [...entries.matchAll(/^###\s+(.+)$/gm)].map((m) =>
    m[1]!.replace(/\*\*/g, '').trim(),
  )
  const cards = await castCards(page, names)
  const library = async () =>
    (await (await page.request.get('/api/library')).json()) as LibraryItem[]

  // 出过参考图的角色、场景、道具卡逐个存进去（以资产库接口为准：提示可能被别的提示盖掉）
  const done = await elements(page)
  const saved: Card[] = []
  for (const c of cards) {
    const ref = done.find((e) => e.name === `${c.name} · ${REF_SUFFIX[c.nodeType]}`)
    if (!ref?.results) continue
    await clickElement(page, c.id)
    // 卡片已经存过时按钮是「更新资产库」
    await page.getByRole('button', { name: /^(存入|更新)资产库$/ }).click()
    await expect
      .poll(async () => (await library()).some((i) => i.name === c.name), {
        message: `「${c.name}」应已存入资产库`,
      })
      .toBe(true)
    saved.push(c)
  }
  await page.keyboard.press('Escape')
  const items = await library()
  const itemOf = (name: string) => items.find((i) => i.name === name)
  note(
    '资产库',
    saved
      .map((c) => {
        const i = itemOf(c.name)
        return `${i?.kind}/${c.name}：${i?.images.length ?? 0} 张图${i?.voice ? `，音色 ${i.voice.voiceId}` : ''}${i?.tags.gender ? `，${i.tags.gender}·${i.tags.age ?? ''}` : ''}`
      })
      .join('；'),
  )
  for (const kind of ['character', 'scene', 'prop'])
    expect(
      saved.some((c) => itemOf(c.name)?.kind === kind),
      `资产库里有 ${kind}`,
    ).toBe(true)
  for (const c of saved) {
    const i = itemOf(c.name)!
    expect(i.images.length, `${c.name} 的参考图`).toBeGreaterThan(0)
    if (c.nodeType === 'plein/character') {
      expect(i.voice?.voiceId).toBe(c.voiceId)
      expect(i.tags.gender).toBeTruthy()
    }
  }

  // 换一个项目，从资产库把角色、场景、道具各取一张放到画布：卡片带着设定、参考图和音色
  await newProject(page)
  const panel = page.getByRole('dialog', { name: '资产库' })
  const picks = ['character', 'scene', 'prop'].map((k) =>
    saved.find((c) => itemOf(c.name)?.kind === k)!,
  )
  // 添加到画布后面板会收起，每取一项重新打开
  for (const c of picks) {
    await deselect(page)
    await page.getByRole('button', { name: '资产库' }).click()
    await panel
      .getByRole('group', { name: '资产类别' })
      .getByRole('button', { name: KIND_TITLE[c.nodeType]!, exact: true })
      .click()
    await panel.getByRole('button', { name: '全部', exact: true }).click()
    const row = panel.getByRole('listitem').filter({ hasText: c.name })
    await row.first().hover()
    await row.first().getByRole('button', { name: '添加到画布' }).click()
    await expect(panel).toBeHidden()
  }
  for (const c of picks) {
    await expect
      .poll(async () => (await elements(page)).filter((e) => e.name === c.name).length)
      .toBe(1)
    const placed = await byName(page, c.name)
    expect(placed.nodeType).toBe(c.nodeType)
    const into = await edgesInto(page, placed.id)
    const assets = await page.evaluate(
      (ids) => ids.map((id) => window.__plein.engine.doc.get(id)?.assetId),
      into.map(([from]) => from),
    )
    expect(assets).toEqual(itemOf(c.name)!.images.map((i) => i.assetId))
    if (c.nodeType === 'plein/character') {
      const voice = await page.evaluate(
        (id) => (window.__plein.engine.doc.get(id)?.params?.voice as { voiceId?: string })?.voiceId,
        placed.id,
      )
      expect(voice).toBe(c.voiceId)
    }
  }
  note('新项目取用', picks.map((c) => c.name).join('、'))
})
