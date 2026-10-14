import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
 * 第三个用例在出片画布上验收 0.2：实际输入与提交一致、查看影响只重做第三镜头、
 * 项目包导入全新目录后重新合成、外部应用经 MCP 提修改方案并按范围批准。
 */
const DATA = process.env.PLEIN_L4_DATA
const PORT = Number(process.env.PLEIN_L4_PORT)
const ROOT = join(import.meta.dirname, '../..')
const SHOTS = 6
/** 镜头视频用的模型和分辨率；模型给空串就按模板默认 */
const VIDEO_MODEL = process.env.PLEIN_L4_VIDEO_MODEL ?? 'minimax/api:MiniMax-H3'
const VIDEO_RESOLUTION = process.env.PLEIN_L4_VIDEO_RESOLUTION ?? '768P'
const BOARD = '分镜（双击展开镜头）'

test.skip(!DATA, '需要 PLEIN_L4_DATA：配好平台密钥的数据目录（会产生真实费用）')

let server: ChildProcess | null = null

/** 在 dir 上起一个服务端，等它能响应；日志写到 dir/logs/l4-server.log */
async function spawnServer(dir: string, port: number, env: Record<string, string> = {}) {
  mkdirSync(join(dir, 'logs'), { recursive: true })
  const log = openSync(join(dir, 'logs', 'l4-server.log'), 'a')
  const proc = spawn(join(ROOT, 'apps/server/node_modules/.bin/tsx'), ['src/main.ts'], {
    cwd: join(ROOT, 'apps/server'),
    // 单独的进程组：强杀时连 tsx 起的 node 一起杀掉
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      PLEIN_PORT: String(port),
      PLEIN_DATA_DIR: dir,
      PLEIN_WEB_DIST: join(ROOT, 'apps/web/dist-e2e'),
      PLEIN_AGENT: '0',
      ...env,
    },
  })
  closeSync(log)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const ok = await fetch(`http://127.0.0.1:${port}/api/health`).then(
      (r) => r.ok,
      () => false,
    )
    if (ok) return proc
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`服务端没有起来，看 ${dir}/logs/l4-server.log`)
}

async function startServer() {
  server = await spawnServer(DATA!, PORT)
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

/** 镜头数改成 SHOTS（参数和提示词里的数字一起改），再运行到分镜：上游是剧本和角色场景抽取 */
async function prepareBoard(page: Page, id: string) {
  await clickElement(page, id)
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
  // 三次对话串行，平台慢时每次要三四分钟
  await contextMenu(page, id, '运行到此处')
  await waitNode(page, id, 30 * 60_000)
}

test.describe.configure({ mode: 'serial' })

/** 第一个用例出片的画布；单独跑资产库用例时用 PLEIN_L4_CANVAS 指定，不给就取数据目录里最近的画布 */
let filmCanvas = process.env.PLEIN_L4_CANVAS ?? ''
/** 接着跑一块已经铺好模板、出过设定卡并展开镜头的画布（前一次在出图之后断了），省掉前面的对话和出图 */
const RESUME = process.env.PLEIN_L4_RESUME ?? ''

test('真实平台：6 镜头短剧从模板到字幕成片，中途重启服务', async ({ page }) => {
  await startServer()
  test.info().annotations.push({ type: '数据目录', description: DATA! })
  if (RESUME) {
    await page.goto(`/#/c/${RESUME}`)
    await waitEngine(page)
  } else {
    await newProject(page)
    await addNode(page, '短剧')
    await expect(page.locator('.ui-toast')).toContainText('短剧模板已铺出')
  }
  const canvas = page.url().split('#/c/')[1]!.split(/[/?]/)[0]!
  filmCanvas = canvas
  note('画布', RESUME ? `${canvas}（接着跑）` : canvas)
  const models = await page.evaluate(() =>
    [...window.__plein.engine.doc.elements()]
      .filter((e) => e.kind === 'node')
      .map((e) => `${e.name}=${(e as { params?: { model?: string } }).params?.model ?? ''}`),
  )
  note('模型', models.join('；'))

  // 镜头数改成 6：参数和提示词里的数字一起改
  const board = await byName(page, BOARD)
  if (!RESUME) await prepareBoard(page, board.id)

  const cast = await byName(page, '角色与场景抽取')
  expect(cast.status).toBe('succeeded')
  const entries = await page.evaluate((id) => {
    const v = window.__plein.engine.doc.get(id)!.results!.at(-1)!.value as { text?: string }
    return v.text ?? ''
  }, cast.id)
  note('抽取', entries.replace(/\n+/g, ' ').slice(0, 600))
  if (!RESUME) {
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
  }

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

  let dialog: Awaited<ReturnType<typeof openBoard>>
  if (!RESUME) {
    dialog = await openBoard(page, board.id)
    await dialog.getByRole('button', { name: '展开为节点' }).click()
    await expect(page.locator('.ui-toast')).toContainText('已展开')
    note('展开', (await page.locator('.ui-toast').textContent()) ?? '')
  }
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
  // 平台审核偶尔拦下生成出来的图（不是提示词的问题，重出一次多半能过）；同步出图排队太久时
  // 连接也可能断在半路、记为提交结果未知（百炼没有按客户端标识查任务的接口，只能人工确认后重出）。
  // 像用户那样再点一次批量，出过的沿用，只补失败和因此跳过的
  const retryable = new Set(['content_policy', 'submit_unknown'])
  const rejected = await failures(page)
  if (rejected.length && rejected.every((f) => retryable.has(f.code))) {
    note('重出', rejected.map((f) => `${f.name}：${f.code}`).join('；'))
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

  // 视频平台只在生成视频期间启用：自动选模型按平台顺序取第一个，设定卡的音色也取第一个配音平台，
  // 一直启用会让其余环节换到它上面、已有结果也随之过期。镜头视频显式指定模型和分辨率
  const vendor = VIDEO_MODEL ? VIDEO_MODEL.split(':')[0]! : ''
  const toggleVideoVendor = async (enabled: boolean) => {
    if (!vendor) return
    const r = await page.request.put(`/api/providers/${vendor}/config`, { data: { enabled } })
    expect(r.status()).toBe(200)
  }
  if (VIDEO_MODEL) {
    await toggleVideoVendor(true)
    await page.evaluate(
      ({ model, resolution }) => {
        const doc = window.__plein.engine.doc
        for (const e of [...doc.elements()])
          if (e.nodeType === 'plein/video' && e.params?.source) {
            const params = doc.mutable(e.id)!.get('params') as Map<string, unknown>
            params.set('model', model)
            params.set('resolution', resolution)
          }
      },
      { model: VIDEO_MODEL, resolution: VIDEO_RESOLUTION },
    )
    note('镜头视频', `${VIDEO_MODEL}，${VIDEO_RESOLUTION}`)
  }

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
  await toggleVideoVendor(false)

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

interface ShotNodes {
  image?: string
  video?: string
  speech: string[]
}

/** 分镜里每个镜头展开出来的节点（按镜头顺序） */
function shotNodes(page: Page) {
  return page.evaluate((BOARD) => {
    const all = [...window.__plein.engine.doc.elements()]
    const board = all.find((e) => e.name === BOARD)!
    return (board.params!.shots as Array<{ id: string }>).map((s) => {
      const out: ShotNodes = { speech: [] }
      for (const e of all) {
        const src = e.params?.source as { shot?: string; role?: string } | undefined
        if (src?.shot !== s.id) continue
        if (src.role === 'speech') out.speech.push(e.id)
        else if (src.role === 'image' || src.role === 'video') out[src.role] = e.id
      }
      return out
    })
  }, BOARD)
}

/** 每个节点现在采用的结果和结果数：比对哪些镜头被动过 */
function adoption(page: Page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [...window.__plein.engine.doc.elements()]
        .filter((e) => !!e.params?.source)
        .map((e) => {
          const el = e as typeof e & { adopted?: string; results?: Array<{ id: string }> }
          return [e.id, `${el.adopted ?? el.results?.[0]?.id ?? ''}/${el.results?.length ?? 0}`]
        }),
    ),
  )
}

/** page.evaluate 里读当前结果用（类型只在编译期） */
type RawResultEl = { adopted?: string; results?: Array<{ id: string; value: unknown }> }

interface Job {
  id: string
  nodeId: string
  nodeType: string
  status: string
  createdAt: number
  input?: { inputHash?: string; refs: Array<{ name: string; sent: string[] }> }
}

test('0.2：实际输入、查看影响返工、项目包迁移、修改方案', async ({ page }) => {
  if (!server) await startServer()
  if (!filmCanvas) {
    const out = execFileSync(
      'sqlite3',
      [join(DATA!, 'plein.db'), 'SELECT id FROM canvases ORDER BY created_at DESC LIMIT 1'],
      { encoding: 'utf8' },
    )
    filmCanvas = out.trim()
  }
  const canvas = filmCanvas
  note('画布', canvas)
  await page.goto(`/#/c/${canvas}`)
  await waitEngine(page)
  const board = await byName(page, BOARD)
  const shots = await shotNodes(page)
  expect(shots).toHaveLength(SHOTS)
  const jobs = async () =>
    ((await (await page.request.get(`/api/canvases/${canvas}/jobs`)).json()) as { jobs: Job[] })
      .jobs
  const paidSince = async (t: number) =>
    (await jobs()).filter(
      (j) =>
        j.createdAt >= t && ['plein/image', 'plein/video', 'plein/speech'].includes(j.nodeType),
    )

  // W1：生成前预览的实际输入，和上次提交时冻结的一致（预览、缓存判断、提交共用一份准备结果）
  const history = await jobs()
  const w1: string[] = []
  for (const [i, s] of shots.entries()) {
    const preview = (await (
      await page.request.get(`/api/canvases/${canvas}/nodes/${s.image}/input`)
    ).json()) as Job['input'] & { referenceLimit?: number; status: string }
    const last = history.find((j) => j.nodeId === s.image && j.status === 'succeeded')
    expect(preview.inputHash, `镜头 ${i + 1} 的实际输入`).toBe(last?.input?.inputHash)
    const sent = preview.refs.reduce((n, r) => n + r.sent.length, 0)
    if (preview.referenceLimit) expect(sent).toBeLessThanOrEqual(preview.referenceLimit)
    w1.push(`${i + 1}：${preview.refs.map((r) => `${r.name}×${r.sent.length}`).join('、')}`)
  }
  note('实际输入', w1.join('；'))

  // W2：改第三镜头的台词和分镜图提示词，从分镜表进「查看影响」，按推荐默认只重做受影响的
  const before = await adoption(page)
  const t2 = Date.now()
  let dialog = await openBoard(page, board.id)
  const line = dialog.getByLabel('台词').nth(2)
  await line.fill(`${await line.inputValue()}……不，这盒子不是我的。`)
  const shotPrompt = dialog.getByLabel('分镜图提示词').nth(2)
  await shotPrompt.fill(`${await shotPrompt.inputValue()}，雨水顺着锁扣往下流`)
  await dialog.getByLabel('时长').first().click()
  await dialog.getByRole('button', { name: '查看影响' }).click()
  const impact = page.getByRole('dialog', { name: '查看影响' })
  await expect(impact).toBeVisible()
  await impact.getByRole('button', { name: '查看差异' }).click()
  const diff = page.getByRole('dialog', { name: '计划差异' })
  await diff.getByRole('button', { name: '同步计划改动' }).click()
  await expect(page.locator('.ui-toast')).toContainText('已把计划同步到')
  await page.keyboard.press('Escape')
  await expect(diff).toBeHidden()
  await expect(impact.getByText('分镜表有没同步的改动')).toBeHidden()
  // 面板在文档变化后停 0.8 秒再重新分析
  await page.waitForTimeout(2000)
  await expect(impact.locator('section', { hasText: '镜头 01' })).toHaveCount(0)
  const rerun = impact.getByRole('button', { name: /^重做选中的 \d+ 个$/ })
  note('查看影响', (await impact.locator('section').allInnerTexts()).join(' | ').slice(0, 600))
  await rerun.click()
  await expect(impact).toBeHidden()
  await waitIdle(page, 20 * 60_000)
  const w2 = await paidSince(t2)
  const after = await adoption(page)
  const shot3 = new Set([shots[2]!.image, shots[2]!.video, ...shots[2]!.speech])
  const touched = Object.keys(before).filter((id) => !shot3.has(id) && before[id] !== after[id])
  note(
    '局部返工',
    `付费提交 ${w2.length} 次（${w2.map((j) => `${j.nodeType}:${j.status}`).join('、')}），第三镜头以外被动到 ${touched.length} 个节点`,
  )
  expect(touched).toEqual([])
  expect(w2.every((j) => shot3.has(j.nodeId))).toBe(true)
  expect(w2.some((j) => j.nodeId === shots[2]!.image)).toBe(true)
  // 视频建议保留，没有重做
  expect(w2.some((j) => j.nodeType === 'plein/video')).toBe(false)

  // 只重新导出序列（本地加工，不跑上游）
  const seq = await byName(page, '序列')
  const res = await page.request.post(`/api/canvases/${canvas}/nodes/${seq.id}/run`, { data: {} })
  expect(res.status()).toBe(202)
  await waitNode(page, seq.id, 20 * 60_000)
  const cut = (await page.evaluate((id) => {
    // 结果新的在前；当前采用的是 adopted 指的那个，没指定时是最新的
    const el = window.__plein.engine.doc.get(id)! as RawResultEl
    return (el.results!.find((r) => r.id === el.adopted) ?? el.results![0]!).value
  }, seq.id)) as { assetId: string }
  note('返工后成片', cut.assetId)

  // W4：导出项目包，在全新数据目录导入，素材齐全、序列能重新合成
  const project = execFileSync(
    'sqlite3',
    [join(DATA!, 'plein.db'), `SELECT project_id FROM canvases WHERE id = '${canvas}'`],
    { encoding: 'utf8' },
  ).trim()
  const pkg = await page.request.get(`/api/projects/${project}/package`)
  expect(pkg.status()).toBe(200)
  const bytes = await pkg.body()
  const fresh = mkdtempSync(join(tmpdir(), 'plein-l4-import-'))
  const port2 = PORT + 1
  const other = await spawnServer(fresh, port2)
  try {
    const base2 = `http://127.0.0.1:${port2}`
    const preview = (await (
      await fetch(`${base2}/api/project-imports`, { method: 'POST', body: new Uint8Array(bytes) })
    ).json()) as { token: string }
    expect(preview.token, JSON.stringify(preview)).toBeTruthy()
    const done = (await (
      await fetch(`${base2}/api/project-imports/${preview.token}`, { method: 'POST' })
    ).json()) as { projectId: string; canvasId: string }
    expect(done.canvasId, JSON.stringify(done)).toBeTruthy()
    expect((await fetch(`${base2}/api/assets/${cut.assetId}/meta`)).status).toBe(200)
    await page.goto(`${base2}/#/c/${done.canvasId}`)
    await waitEngine(page)
    const seq2 = await byName(page, '序列')
    const r2 = await fetch(`${base2}/api/canvases/${done.canvasId}/nodes/${seq2.id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(r2.status).toBe(202)
    await waitNode(page, seq2.id, 20 * 60_000)
    const out2 = (await page.evaluate((id) => {
      // 结果新的在前；当前采用的是 adopted 指的那个，没指定时是最新的
      const el = window.__plein.engine.doc.get(id)! as RawResultEl
      return (el.results!.find((r) => r.id === el.adopted) ?? el.results![0]!).value
    }, seq2.id)) as { assetId: string }
    const meta2 = (await (await fetch(`${base2}/api/assets/${out2.assetId}/meta`)).json()) as {
      width: number
      height: number
      duration: number
    }
    note(
      '项目包迁移',
      `${(bytes.length / 1e6).toFixed(1)} MB，新目录重新合成 ${meta2.width}×${meta2.height}，${meta2.duration.toFixed(1)} 秒`,
    )
    expect([meta2.width, meta2.height]).toEqual([1080, 1920])
  } finally {
    if (other.pid) process.kill(-other.pid, 'SIGKILL')
    rmSync(fresh, { recursive: true, force: true })
  }

  // W5：外部应用经 MCP 提出修改方案，先只改文字（零调用），再只给第四镜头出候选图
  await page.goto(`/#/c/${canvas}`)
  await waitEngine(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置' })
  await settings.getByRole('button', { name: 'MCP', exact: true }).click()
  await settings.getByRole('button', { name: '生成连接令牌' }).click()
  const config = settings.getByTestId('external-mcp-config')
  const token = /Bearer (plein_[\w-]+)/.exec((await config.textContent()) ?? '')![1]!
  await page.keyboard.press('Escape')
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const r = await page.request.post('/mcp', {
      headers: { authorization: `Bearer ${token}` },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: { canvas_id: canvas, ...args } },
      },
    })
    const body = (await r.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean }
    }
    expect(body.result.isError, body.result.content[0]?.text).toBeFalsy()
    return JSON.parse(body.result.content[0]!.text) as {
      plan_id: string
      steps: Array<{ id: string; stage: string }>
      estimate: Record<string, string>
      status: string
    }
  }
  const shot4 = shots[3]!.image!
  const prompt4 = () =>
    page.evaluate((id) => String(window.__plein.engine.doc.get(id)!.params?.prompt ?? ''), shot4)
  const base4 = await prompt4()
  const t5 = Date.now()
  const textPlan = await mcp('propose_edit', {
    summary: '第四镜头更紧张',
    edits: [{ id: shot4, params: { prompt: `${base4}，手持镜头轻微晃动，压迫感` } }],
  })
  note('修改方案', JSON.stringify(textPlan.estimate))
  expect(textPlan.steps.some((s) => s.id === shot4)).toBe(true)
  await mcp('apply_edit_plan', { plan_id: textPlan.plan_id, scope: 'text' })
  await expect.poll(prompt4).toContain('压迫感')
  await page.waitForTimeout(3000)
  expect(await paidSince(t5)).toEqual([])

  const before5 = await adoption(page)
  const imagePlan = await mcp('propose_edit', {
    summary: '第四镜头再暗一点',
    edits: [{ id: shot4, params: { prompt: `${await prompt4()}，夜色更暗` } }],
  })
  await mcp('apply_edit_plan', { plan_id: imagePlan.plan_id, scope: 'images', only: [shot4] })
  await expect
    .poll(async () => (await paidSince(t5)).length, { timeout: 60_000 })
    .toBeGreaterThan(0)
  await waitIdle(page, 20 * 60_000)
  const w5 = await paidSince(t5)
  const after5 = await adoption(page)
  note('只出候选图', w5.map((j) => `${j.nodeType}:${j.status}`).join('、'))
  expect(w5.map((j) => j.nodeId)).toEqual([shot4])
  expect(Object.keys(before5).filter((id) => id !== shot4 && before5[id] !== after5[id])).toEqual(
    [],
  )
})
