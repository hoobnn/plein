import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import {
  addNode,
  byName,
  centerOf,
  clickElement,
  clickStoryboardAction,
  contextMenu,
  deselect,
  edgesInto,
  elements,
  newProject,
  showStoryboardCards,
  waitEngine,
  waitIdle,
  waitNode,
  zoomTo,
} from '../canvas'
import { lockReleaseData } from '../server-lifecycle'
import { startReleaseServer } from './release-server'
import { openLibraryPanel } from '../library-ui'
import { checkReleaseSubmissions, startReleaseBatch, waitReleaseGroup } from './release-batch'

/**
 * L4：真实平台把同人故事《环太平洋：彼岸》做成一部 6 镜头竖屏短剧，从模板到导出带字幕的 MP4。
 * 新建项目「环太平洋：彼岸」，铺短剧模板后把「创意 / 梗概」换成这部故事，剧本、设定卡、分镜都由它生成。
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
const TITLE = '环太平洋：彼岸'

/** 替换模板「创意 / 梗概」的故事：从长片大纲里截出能在 60–90 秒讲完的一段 */
const IDEA = `# 创意 / 梗概

一句话故事：2038 年，怪兽再次登陆。真子生前留下的原始记录指向一座藏在裂缝另一侧的设施，可那里也是敌人控制纽特的中继；赫尔曼必须在三台机甲远征的同时，把困在控制里的老朋友带回来。

- 片名：环太平洋：彼岸（同人短片，非官方）
- 类型：机甲科幻
- 画幅：竖屏 9:16
- 节奏：60–90 秒，开场三秒是港口巨物战斗，结尾留钩子：纽特问「如果回来的不是我」
- 故事线：
  1. 雨夜港口，怪兽撞向码头起重机；流浪者远征型挡在撤离人群前，一拳击倒怪兽
  2. 邵丽雯把真子生前要求保全的原始记录交给赫尔曼，纸上有真子用红笔圈出的两个对不上的批次编号
  3. 隔离监护室里，纽特隔着玻璃求赫尔曼「别连进来」，赫尔曼坐下戴上漂移头盔
  4. 驾驶舱模拟训练中断，阿玛拉解开固定装置质问杰克：「你又准备一个人留下？」
  5. 机甲拖着固定好的怪兽遗体沉入海底裂缝，前方是橙色雾霭里的巨大生物工厂
  6. 监护室监测数值报警，纽特第一次清醒地看着赫尔曼：「如果回来的不是我……」赫尔曼：「我不会只凭你的话判断。」
- 角色：
  - 杰克：男，三十多岁，流浪者远征型驾驶员，寸头，眼神倔，总想一个人扛下风险
  - 阿玛拉：女，二十岁出头，驾驶员兼机械工程师，深色卷发扎高马尾，脸上有机油印
  - 赫尔曼：男，四十多岁，数学家，拄手杖，一丝不苟的西装和细框眼镜
  - 纽特：男，四十多岁，生物学家，凌乱头发、手臂满是纹身，眼神时而空洞时而清醒
- 场景：雨夜港口与倒塌的起重机；昏暗的隔离监护室，冷白灯光与监测屏；海底裂缝与橙色雾霭中的异界工厂
- 关键道具：真子的原始记录（一沓泛黄的交付单，红笔圈注）；流浪者远征型（蓝灰色新造双人机甲，胸口有核心灯）`

test.skip(!DATA, '需要 PLEIN_L4_DATA：配好平台密钥的数据目录（会产生真实费用）')

let server: Awaited<ReturnType<typeof startReleaseServer>> | undefined
let runLease: DatabaseSync | undefined

test.beforeAll(() => {
  if (DATA) runLease = lockReleaseData(DATA, 'run')
})

/**
 * 序列导出要烧字幕，需要带 libass 的 ffmpeg；Homebrew 默认的没有。
 * 没指定 PLEIN_FFMPEG_PATH 时用桌面端打包好的（`pnpm --filter @plein/desktop ffmpeg` 构建）
 */
function ffmpegEnv(): Record<string, string> {
  if (process.env.PLEIN_FFMPEG_PATH) return {}
  const dir = join(ROOT, 'apps/desktop/stage/ffmpeg')
  if (!existsSync(join(dir, 'ffmpeg'))) return {}
  return { PLEIN_FFMPEG_PATH: join(dir, 'ffmpeg'), PLEIN_FFPROBE_PATH: join(dir, 'ffprobe') }
}

async function startServer() {
  server = await startReleaseServer(DATA!, PORT, 'l4-server.log', ffmpegEnv())
}

test.afterAll(async () => {
  try {
    await server?.stop()
  } finally {
    runLease?.close()
  }
})

/** 只取这一批视频的远端 ID 及提交次数，用同一份事务快照核对崩溃恢复。 */
function videoJobs(group: string) {
  const db = new DatabaseSync(join(DATA!, 'plein.db'), { readOnly: true })
  try {
    return db
      .prepare(`
      SELECT j.id, j.status,
        (SELECT json_group_array(json_extract(value, '$.remoteId')) FROM json_each(j.calls)
         WHERE json_extract(value, '$.remoteId') IS NOT NULL) AS remote_ids,
        EXISTS (SELECT 1 FROM json_each(j.calls) WHERE json_extract(value, '$.state') = 'submitting') AS submitting,
        (SELECT count(*) FROM json_each(j.call_history)
         WHERE json_extract(value, '$.kind') = 'submit_started') AS submits
      FROM jobs j WHERE j.group_id = ? AND j.node_type = 'plein/video' ORDER BY j.id
    `)
      .all(group) as Array<{
      id: string
      status: string
      remote_ids: string
      submitting: number
      submits: number
    }>
  } finally {
    db.close()
  }
}

const checkSubmissions = (canvas: string) =>
  checkReleaseSubmissions(join(DATA!, 'plein.db'), canvas)

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
  const dialog = page.getByRole('dialog', { name: '分镜表', exact: true })
  if (await dialog.isVisible()) return dialog
  await clickElement(page, id)
  const p = await centerOf(page, id)
  await page.mouse.dblclick(p.x, p.y)
  await expect(dialog).toBeVisible()
  return dialog
}

/** 镜头数改成 SHOTS（参数和提示词里的数字一起改），再运行到分镜：上游是剧本和角色场景抽取 */
async function prepareBoard(page: Page, canvas: string, id: string) {
  await clickElement(page, id)
  const prompt = page.getByRole('textbox', { name: '提示词' })
  const text = await prompt.inputValue()
  expect(text).toMatch(/拆成(?:约)? \d+ 个镜头/)
  await prompt.fill(text.replace(/拆成(?:约)? \d+ 个镜头/, `拆成 ${SHOTS} 个镜头`))
  await page.getByRole('button', { name: /参数/ }).first().click()
  await page.getByText('更多参数').click()
  await page.getByLabel('镜头数').fill(String(SHOTS))
  await page.keyboard.press('Escape')

  // 分镜的上游是剧本和角色场景抽取（设定清单连进分镜，镜头按卡片名字写出场的角色、场景、道具）
  // 三次对话串行，平台慢时每次要三四分钟
  const [response] = await Promise.all([
    page.waitForResponse('**/run-flow'),
    contextMenu(page, id, '运行到此处'),
  ])
  expect(response.status()).toBe(202)
  await waitReleaseGroup(
    page,
    (await response.json()).groupId,
    () => checkSubmissions(canvas),
    30 * 60_000,
  )
  await waitNode(page, id)
}

test.describe.configure({ mode: 'serial', retries: 0 })

/** 最近的同名样例排在最前。新命令也要先核对旧样例里未解决的提交。 */
function sampleCanvases() {
  const db = new DatabaseSync(join(DATA!, 'plein.db'), { readOnly: true })
  try {
    return db
      .prepare(`
      SELECT c.id, EXISTS(SELECT 1 FROM job_groups g WHERE g.canvas_id=c.id AND g.status='running') AS active
      FROM canvases c JOIN projects p ON p.id=c.project_id
      WHERE p.title=? ORDER BY c.created_at DESC
    `)
      .all(TITLE) as Array<{ id: string; active: number }>
  } finally {
    db.close()
  }
}

function checkSample(sample: { id: string; active: number }) {
  checkSubmissions(sample.id)
  if (sample.active) throw new Error(`画布 ${sample.id} 的原批次仍在运行，请在任务面板核对原批次。`)
  return sample.id
}

function selectSample(id: string) {
  const rows = sampleCanvases()
  const sample = id ? rows.find((row) => row.id === id) : rows[0]
  if (!sample) throw new Error(`找不到验收样例画布 ${id || TITLE}`)
  return checkSample(sample)
}

/** 第一个用例出片的画布；单独跑后两个用例时用 PLEIN_L4_CANVAS 指定，不给就取「环太平洋：彼岸」最近的画布 */
let filmCanvas = process.env.PLEIN_L4_CANVAS ?? ''
/** 接着跑一块已经铺好模板、出过设定卡并展开镜头的画布（前一次在出图之后断了），省掉前面的对话和出图 */
const RESUME = process.env.PLEIN_L4_RESUME ?? ''

async function projectOf(page: Page, canvas: string) {
  const response = await page.request.get(`/api/canvases/${encodeURIComponent(canvas)}`)
  expect(response.status()).toBe(200)
  return (await response.json()).projectId as string
}

/** 把模板的「创意 / 梗概」整段换成这部故事 */
async function writeIdea(page: Page) {
  const idea = await byName(page, '创意 / 梗概')
  await page.evaluate(
    ({ id, text }) => {
      const t = window.__plein.engine.doc.getText(id)!
      t.delete(0, t.length)
      t.insert(0, text)
    },
    { id: idea.id, text: IDEA },
  )
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.text ?? '', idea.id))
    .toContain(TITLE)
}

test('真实平台：《环太平洋：彼岸》6 镜头短剧从模板到字幕成片，中途重启服务', async ({ page }) => {
  await startServer()
  test.info().annotations.push({ type: '数据目录', description: DATA! })
  if (RESUME) {
    selectSample(RESUME)
    await page.goto(`/#/c/${RESUME}`)
    await waitEngine(page)
  } else {
    for (const prior of sampleCanvases()) checkSample(prior)
    await newProject(page)
    await addNode(page, '短剧')
    await expect(page.locator('.ui-toast')).toContainText('短剧模板已铺出')
  }
  const canvas = page.url().split('#/c/')[1]!.split(/[/?]/)[0]!
  if (!RESUME) {
    const project = await projectOf(page, canvas)
    const rename = await page.request.patch(`/api/projects/${encodeURIComponent(project)}`, {
      data: { title: TITLE },
    })
    expect(rename.status()).toBe(200)
    await writeIdea(page)
  }
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
  const check = () => checkSubmissions(canvas)
  check()
  if (!RESUME) await prepareBoard(page, canvas, board.id)
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.shots, board.id),
  ).toHaveLength(SHOTS)

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
  // 真子的原始记录贯穿全片，抽取得出道具
  expect(ofType('plein/prop').length).toBeGreaterThanOrEqual(1)
  // 每张卡左边配好参考图节点，连进卡片
  const all0 = await elements(page)
  for (const c of cards) {
    const ref = all0.find((e) => e.name === `${c.name} · ${REF_SUFFIX[c.nodeType]}`)
    expect(ref, `${c.name} 的${REF_SUFFIX[c.nodeType]}节点`).toBeTruthy()
    const into = await edgesInto(page, c.id)
    expect(into.map(([from]) => from)).toContain(ref!.id)
  }
  // 抽取标了男 / 女的角色都配上音色，男女角色不共用一个声音；看不出性别的（比如怪兽）按设计不配
  const chars = ofType('plein/character')
  note('音色', chars.map((c) => `${c.name}=${c.voiceId || '（未配）'}`).join('；'))
  // 抽取结果按 ### 切成每张卡的一段，段首是名字
  const sections = entries.split(/^###\s+/m)
  const gendered = (name: string) =>
    sections.some(
      (sec) => sec.replace(/\*\*/g, '').startsWith(name) && /性别[：:]\s*[男女]/.test(sec),
    )
  expect(chars.filter((c) => gendered(c.name) && !c.voiceId).map((c) => c.name)).toEqual([])
  expect(new Set(chars.map((c) => c.voiceId).filter(Boolean)).size).toBeGreaterThanOrEqual(2)

  let dialog: Awaited<ReturnType<typeof openBoard>>
  if (!RESUME) {
    dialog = await openBoard(page, board.id)
    await clickStoryboardAction(dialog, '展开为镜头')
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
  const images = await startReleaseBatch(dialog, board.id, 'image', check)
  if (images) await waitReleaseGroup(page, images.groupId, check, 20 * 60_000)
  await waitIdle(page)
  // 审核拦下的参考图是软依赖，保留原因并核验镜头图；验收不会再次付费补出。
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
  expect(shots).toHaveLength(SHOTS)
  expect(shots.filter((e) => e.results === 0).map((e) => e.name)).toEqual([])

  // 采用数据目录已启用的平台，不改动供配音、配乐等阶段共用的配置。
  if (VIDEO_MODEL) {
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
  const videos = await startReleaseBatch(dialog, board.id, 'video', check)
  if (!videos)
    throw new Error('视频均已复用，本次没有可验证的在途远端任务。请核对原批次的恢复记录。')
  let before: ReturnType<typeof videoJobs> = []
  await expect
    .poll(
      () => {
        check()
        const group = videoJobs(videos.groupId)
        if (group.some((j) => j.status === 'canceled' || j.status === 'failed'))
          throw new Error('视频批次已有失败或取消的任务，已停止崩溃演练')
        if (group.length < videos.total) return 0
        if (group.every((j) => j.status === 'succeeded'))
          throw new Error('本批视频已全部完成，没有可核验的在途远端任务')
        if (group.some((j) => j.submitting || j.remote_ids === '[]')) return 0
        before = group.filter((j) => j.status === 'running' && j.remote_ids !== '[]')
        return before.length
      },
      { timeout: 40 * 60_000, intervals: [100, 300, 1_000] },
    )
    .toBeGreaterThan(0)
  note('重启前', `${before.length} 个在途视频已记下远端任务 ID`)
  await server!.crash()
  await startServer()
  await page.reload()
  await waitEngine(page)
  await waitReleaseGroup(page, videos.groupId, check, 40 * 60_000)
  const after = videoJobs(videos.groupId)
  for (const b of before) {
    const a = after.find((j) => j.id === b.id)
    expect(a, `按原任务续查 ${b.id}`).toMatchObject({
      remote_ids: b.remote_ids,
      submits: b.submits,
    })
  }
  // 每个已批准的视频都已受理，既能检验续查，也不会在其他镜头提交时切断连接。
  expect(after).toHaveLength(videos.total)
  for (const j of after) expect(j).toMatchObject({ status: 'succeeded', submits: 1 })
  await expect.poll(async () => (await shotNodes(page)).filter((s) => s.video).length).toBe(SHOTS)
  const allShots = await shotNodes(page)
  for (const s of allShots) await waitNode(page, s.video!)
  note('续跑', after.map((j) => `${j.id} → ${j.remote_ids}`).join('；'))

  dialog = await openBoard(page, board.id)
  const speech = await startReleaseBatch(dialog, board.id, 'speech', check)
  if (speech) await waitReleaseGroup(page, speech.groupId, check, 20 * 60_000)
  for (const id of allShots.flatMap((s) => s.speech)) await waitNode(page, id)
  await waitIdle(page)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()

  const all = await elements(page)
  const failed = all.filter((e) => e.status === 'failed' && !blocked.has(e.name ?? ''))
  expect(failed.map((e) => e.name)).toEqual([])

  const music = await byName(page, '配乐')
  if (!music.results) await runReleaseNode(page, canvas, music.id, check, 10 * 60_000)
  const seq = await byName(page, '序列')
  const out = await runReleaseNode(page, canvas, seq.id, check, 20 * 60_000)
  expect(out.mime).toBe('video/mp4')
  const meta = (await (await page.request.get(`/api/assets/${out.assetId}/meta`)).json()) as {
    width: number
    height: number
    duration: number
  }
  note('成片', `${out.assetId}：${meta.width}×${meta.height}，${meta.duration.toFixed(1)} 秒`)
  expect([meta.width, meta.height]).toEqual([1080, 1920])
})

test('资产库：出片画布上的角色、场景、道具存进资产库，在新项目里取用', async ({ page }) => {
  if (!server) await startServer()
  filmCanvas = selectSample(filmCanvas)
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
    // 配了音色的角色连音色和性别一起存；怪兽这类没性别的不配音色
    if (c.nodeType === 'plein/character' && c.voiceId) {
      expect(i.voice?.voiceId).toBe(c.voiceId)
      expect(i.tags.gender).toBeTruthy()
    }
  }

  // 换一个项目，从资产库把角色、场景、道具各取一张放到画布：卡片带着设定、参考图和音色
  await newProject(page)
  // 角色取一个配了音色的，核对音色跟着过来
  const picks = ['character', 'scene', 'prop'].map((k) =>
    saved.find((c) => itemOf(c.name)?.kind === k && (k !== 'character' || c.voiceId))!,
  )
  // 添加到画布后面板会收起，每取一项重新打开
  for (const c of picks) {
    await deselect(page)
    const panel = await openLibraryPanel(page)
    await panel
      .getByRole('group', { name: '资产类别' })
      .getByRole('button', { name: KIND_TITLE[c.nodeType]!, exact: true })
      .click()
    await panel
      .getByRole('group', { name: '范围', exact: true })
      .getByRole('button', { name: '全部', exact: true })
      .click()
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

/** 同一节点可能已有成功记录，必须等本次 runId 入库、同步，再读其实际产物。 */
async function runReleaseNode(
  page: Page,
  canvas: string,
  id: string,
  check: () => void,
  timeout: number,
) {
  check()
  const base = new URL(`/api/canvases/${encodeURIComponent(canvas)}/`, page.url())
  const response = await page.request.post(
    new URL(`nodes/${encodeURIComponent(id)}/run`, base).href,
    { data: {} },
  )
  expect(response.status()).toBe(202)
  const { runId } = (await response.json()) as { runId: string }
  await expect
    .poll(
      async () => {
        check()
        const job = await page.request.get(new URL(`jobs/${encodeURIComponent(runId)}`, base).href)
        expect(job.status()).toBe(200)
        const { status } = (await job.json()) as Job
        if (status === 'failed' || status === 'canceled')
          throw new Error(`任务 ${runId} 已${status}`)
        return status
      },
      { timeout, intervals: [250, 1_000, 2_000] },
    )
    .toBe('succeeded')
  const result = () =>
    page.evaluate(
      ({ id, runId }) =>
        window.__plein.engine.doc.get(id)?.results?.find((r) => r.runId === runId)?.value,
      { id, runId },
    )
  await expect.poll(result).toBeTruthy()
  return (await result()) as { assetId: string; mime: string }
}

interface Job {
  id: string
  nodeId: string
  nodeType: string
  status: string
  createdAt: number
  submissionHistory?: Array<{ kind: string }>
  input?: { inputHash?: string; refs: Array<{ name: string; sent: string[] }> }
}

test('0.2：实际输入、查看影响返工、项目包迁移、修改方案', async ({ page }) => {
  if (!server) await startServer()
  filmCanvas = selectSample(filmCanvas)
  const canvas = filmCanvas
  note('画布', canvas)
  await page.goto(`/#/c/${canvas}`)
  await waitEngine(page)
  const check = () => checkSubmissions(canvas)
  check()
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
  const dialog = await openBoard(page, board.id)
  await showStoryboardCards(dialog)
  const line = dialog.getByLabel('台词').nth(2)
  await line.fill(`${await line.inputValue()}……先把记录核对清楚。`)
  const shotPrompt = dialog.getByLabel('分镜图提示词').nth(2)
  await shotPrompt.fill(`${await shotPrompt.inputValue()}，监测屏的冷光映在玻璃上`)
  await dialog.getByLabel('时长').first().click()
  await clickStoryboardAction(dialog, '查看影响')
  const impact = page.getByRole('dialog', { name: '查看影响' })
  await expect(impact).toBeVisible()
  await impact.getByRole('button', { name: '查看差异' }).click()
  const diff = page.getByRole('dialog', { name: '计划差异' })
  await diff.getByRole('button', { name: '同步计划改动' }).click()
  await expect(page.locator('.ui-toast')).toContainText('已把计划同步到')
  await page.keyboard.press('Escape')
  await expect(diff).toBeHidden()
  await expect(impact.getByText('分镜表有没同步的改动')).toBeHidden()
  const changedShot = impact
    .locator('section')
    .filter({ has: page.getByRole('checkbox', { name: '重做镜头图' }) })
    .filter({ hasText: '镜头 03' })
  await expect(changedShot.getByRole('checkbox', { name: '重做镜头图' })).toBeChecked()
  await expect(changedShot.getByRole('checkbox', { name: '重做视频' })).not.toBeChecked()
  await expect(
    impact
      .locator('section')
      .filter({ hasNotText: '镜头 03' })
      .getByRole('checkbox', { checked: true }),
  ).toHaveCount(0)
  const rerun = impact.getByRole('button', { name: /^重做选中的 \d+ 个$/ })
  note('查看影响', (await impact.locator('section').allInnerTexts()).join(' | ').slice(0, 600))
  check()
  const [rerunResponse] = await Promise.all([page.waitForResponse('**/impact/run'), rerun.click()])
  expect(rerunResponse.status()).toBe(202)
  await waitReleaseGroup(page, (await rerunResponse.json()).groupId, check, 20 * 60_000)
  await expect(impact).toBeHidden()
  await waitIdle(page)
  const w2 = await paidSince(t2)
  const after = await adoption(page)
  const shot3 = new Set([shots[2]!.image, shots[2]!.video, ...shots[2]!.speech])
  const touched = Object.keys(before).filter((id) => !shot3.has(id) && before[id] !== after[id])
  note(
    '局部返工',
    `平台提交 ${w2.reduce((total, j) => total + (j.submissionHistory ?? []).filter((e) => e.kind === 'submit_started').length, 0)} 次（${w2.map((j) => `${j.nodeType}:${j.status}`).join('、')}），第三镜头以外被动到 ${touched.length} 个节点`,
  )
  expect(touched).toEqual([])
  expect(w2.every((j) => shot3.has(j.nodeId) && j.status === 'succeeded')).toBe(true)
  expect(w2.some((j) => j.nodeId === shots[2]!.image)).toBe(true)
  // 视频建议保留，没有重做
  expect(w2.some((j) => j.nodeType === 'plein/video')).toBe(false)

  // 只重新导出序列（本地加工，不跑上游）
  const seq = await byName(page, '序列')
  const cut = await runReleaseNode(page, canvas, seq.id, check, 20 * 60_000)
  note('返工后成片', cut.assetId)

  // W4：导出项目包，在全新数据目录导入，素材齐全、序列能重新合成
  const project = await projectOf(page, canvas)
  const pkg = await page.request.get(`/api/projects/${project}/package`)
  expect(pkg.status()).toBe(200)
  const bytes = await pkg.body()
  const fresh = mkdtempSync(join(tmpdir(), 'plein-l4-import-'))
  let other: Awaited<ReturnType<typeof startReleaseServer>> | undefined
  try {
    other = await startReleaseServer(fresh, 0, 'l4-server.log', ffmpegEnv())
    const base2 = other.server.baseURL
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
    const out2 = await runReleaseNode(page, done.canvasId, seq2.id, check, 20 * 60_000)
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
    await other?.stop()
    rmSync(fresh, { recursive: true, force: true })
  }

  // W5：外部应用经 MCP 提出修改方案，先只改文字（零调用），再只给第四镜头出候选图
  await page.goto(`/#/c/${canvas}`)
  await waitEngine(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置' })
  await settings.getByRole('button', { name: 'MCP', exact: true }).click()
  await settings.getByLabel('令牌名称').fill('L4 短片验收')
  await settings.getByLabel('每日运行次数上限').fill('1')
  const [issued] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/api/mcp/external'),
    ),
    settings.getByRole('button', { name: /^(生成连接令牌|新增令牌)$/ }).click(),
  ])
  expect(issued.status()).toBe(201)
  const { id: tokenId, token } = (await issued.json()) as { id: string; token: string }
  try {
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
        applied?: { nodes: string[]; group_id?: string }
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
    const textApplied = await mcp('apply_edit_plan', { plan_id: textPlan.plan_id, scope: 'text' })
    expect(textApplied).toMatchObject({ status: 'applied', applied: { nodes: [] } })
    await expect.poll(prompt4).toContain('压迫感')
    expect(await paidSince(t5)).toEqual([])

    const before5 = await adoption(page)
    const imagePlan = await mcp('propose_edit', {
      summary: '第四镜头再暗一点',
      edits: [{ id: shot4, params: { prompt: `${await prompt4()}，夜色更暗` } }],
    })
    check()
    const imageApplied = await mcp('apply_edit_plan', {
      plan_id: imagePlan.plan_id,
      scope: 'images',
      only: [shot4],
      confirm: true,
      client_request_id: imagePlan.plan_id,
    })
    expect(imageApplied).toMatchObject({
      status: 'applied',
      applied: { nodes: [shot4], group_id: expect.any(String) },
    })
    await waitReleaseGroup(page, imageApplied.applied!.group_id!, check, 20 * 60_000)
    await waitIdle(page)
    const w5 = await paidSince(t5)
    const after5 = await adoption(page)
    note('只出候选图', w5.map((j) => `${j.nodeType}:${j.status}`).join('、'))
    expect(w5.map((j) => ({ nodeId: j.nodeId, status: j.status }))).toEqual([
      { nodeId: shot4, status: 'succeeded' },
    ])
    expect(Object.keys(before5).filter((id) => id !== shot4 && before5[id] !== after5[id])).toEqual(
      [],
    )
  } finally {
    const revoked = await page.request.delete(`/api/mcp/external/${encodeURIComponent(tokenId)}`)
    expect(revoked.status()).toBe(204)
  }
})
