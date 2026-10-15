import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { clickElement, elements, newProject, zoomTo } from '../canvas'
import { B_PREFIX, E1_SHOTS } from './e1-shots'

/**
 * E1 静态 3D 构图对照实验（docs/plan/e1-3d-composition.md）：真实平台、真实计费。
 * 6 个镜头各摆一份 3D 构图并截图；A 组只用文字，B 组同样的文字加构图截图作参考图，
 * 每组每个镜头出 3 张，共 36 次 Seedream 调用。先跑一次试探，失败就整个停下，不往下花钱。
 * 产物写到 E1_OUT（默认 PLEIN_L4_DATA/e1-时间）：blind/ 下按镜头打乱、去掉组别的图，
 * key.json 是对照表（审完再看），manifest.json 记模型、提示词、场景和每次调用的结果。
 * E1_DRY=1 只摆场景和截图，不调平台，用临时数据目录。
 */
const DRY = process.env.E1_DRY === '1'
const DATA = DRY ? mkdtempSync(join(tmpdir(), 'plein-e1-')) : process.env.PLEIN_L4_DATA
const PORT = Number(process.env.PLEIN_L4_PORT)
const ROOT = join(import.meta.dirname, '../..')
const MODEL = process.env.E1_IMAGE_MODEL ?? 'volc/ark:doubao-seedream-5-0-pro-260628'
const SAMPLES = 3
const OUT =
  process.env.E1_OUT ?? join(DATA ?? tmpdir(), `e1-${new Date().toISOString().replace(/\W/g, '')}`)

test.skip(!DATA, '需要 PLEIN_L4_DATA：配好火山方舟密钥的数据目录（会产生真实费用），或 E1_DRY=1')

let server: ChildProcess | null = null

async function startServer() {
  mkdirSync(join(DATA!, 'logs'), { recursive: true })
  const log = openSync(join(DATA!, 'logs', 'e1-server.log'), 'a')
  server = spawn(join(ROOT, 'apps/server/node_modules/.bin/tsx'), ['src/main.ts'], {
    cwd: join(ROOT, 'apps/server'),
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      PLEIN_PORT: String(PORT),
      PLEIN_DATA_DIR: DATA!,
      PLEIN_WEB_DIST: join(ROOT, 'apps/web/dist-e2e'),
      PLEIN_AGENT: '0',
    },
  })
  closeSync(log)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const ok = await fetch(`http://127.0.0.1:${PORT}/api/health`).then(
      (r) => r.ok,
      () => false,
    )
    if (ok) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`服务端没有起来，看 ${DATA}/logs/e1-server.log`)
}

test.afterAll(() => {
  if (server?.pid) process.kill(-server.pid, 'SIGTERM')
})

const addNode = (
  page: Page,
  input: { type: string; name: string; params: Record<string, unknown>; x: number; y: number },
) => page.evaluate((input) => window.__plein.addNode(input), input)

interface NodeState {
  run?: { id: string; status: string; error?: string; errorCode?: string }
  results: Array<{ id: string; runId: string; value: { assetId?: string } }>
}

const nodeState = (page: Page, id: string) =>
  page.evaluate((id) => {
    const el = window.__plein.engine.doc.get(id) as unknown as {
      run?: NodeState['run']
      results?: NodeState['results']
    }
    return { run: el?.run, results: el?.results ?? [] } as NodeState
  }, id)

async function download(page: Page, assetId: string, path: string) {
  const res = await page.request.get(`/api/assets/${assetId}`)
  expect(res.ok()).toBe(true)
  const type = res.headers()['content-type'] ?? ''
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg'
  writeFileSync(`${path}.${ext}`, await res.body())
  return `${path}.${ext}`
}

interface Call {
  shot: number
  group: 'A' | 'B'
  sample: number
  status: string
  error?: string
  ms: number
  resultId?: string
  assetId?: string
}

/** 跑一次图片节点并等它结束；失败也算一次调用，照实记下，不重试 */
async function runOnce(
  page: Page,
  canvas: string,
  node: string,
): Promise<Omit<Call, 'shot' | 'group' | 'sample'>> {
  const started = Date.now()
  const res = await page.request.post(`/api/canvases/${canvas}/nodes/${node}/run`, { data: {} })
  expect(res.status(), await res.text()).toBe(202)
  const { runId } = (await res.json()) as { runId: string }
  let state: NodeState = { results: [] }
  await expect
    .poll(
      async () => {
        state = await nodeState(page, node)
        const s = state.run?.id === runId ? state.run.status : 'pending'
        return ['succeeded', 'failed', 'canceled'].includes(s)
      },
      { timeout: 10 * 60_000, intervals: [2000] },
    )
    .toBe(true)
  const result = state.results.find((r) => r.runId === runId)
  return {
    status: state.run!.status,
    error: state.run!.error
      ? `${state.run!.errorCode ?? ''} ${state.run!.error}`.trim()
      : undefined,
    ms: Date.now() - started,
    resultId: result?.id,
    assetId: result?.value.assetId,
  }
}

test('E1：3D 构图参考图对照实验', async ({ page }) => {
  test.setTimeout(120 * 60_000)
  await startServer()
  // 试跑用的空数据目录没有配平台，会弹欢迎引导
  if (DRY) await page.addInitScript(() => localStorage.setItem('plein.welcome', '1'))
  mkdirSync(join(OUT, 'snapshots'), { recursive: true })
  await newProject(page)
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]!

  // 1. 每个镜头一个 3D 构图节点，打开编辑器截图（场景按 e1-shots.ts 预先摆好）
  const stages: Record<number, { id: string; assetId: string; ms: number }> = {}
  for (const shot of E1_SHOTS) {
    const id = await addNode(page, {
      type: 'plein/stage',
      name: `构图 ${shot.id}`,
      params: { scene: { ...shot.scene, rev: 0 }, snapshots: [] },
      x: (shot.id - 1) * 900,
      y: 0,
    })
    await zoomTo(page, [id])
    await clickElement(page, id)
    const t0 = Date.now()
    await page.getByRole('button', { name: '打开 3D 构图' }).click()
    const dialog = page.getByRole('dialog', { name: '3D 构图' })
    await expect(dialog.locator('canvas.stage-canvas')).toBeVisible()
    await dialog.getByRole('button', { name: '截图', exact: true }).click()
    await expect.poll(async () => (await nodeState(page, id)).results.length).toBe(1)
    const ms = Date.now() - t0
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    const { results } = await nodeState(page, id)
    const assetId = results[0]!.value.assetId!
    await download(page, assetId, join(OUT, 'snapshots', `shot-${shot.id}`))
    stages[shot.id] = { id, assetId, ms }
  }
  expect((await elements(page)).filter((e) => e.nodeType === 'plein/stage')).toHaveLength(6)

  const manifest = {
    model: MODEL,
    samples: SAMPLES,
    bPrefix: B_PREFIX,
    startedAt: new Date().toISOString(),
    shots: E1_SHOTS.map((s) => ({ ...s, stage: stages[s.id] })),
    calls: [] as Call[],
  }
  const save = () => writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
  save()
  if (DRY) return

  // 2. 每个镜头两个图片节点：A 只有文字，B 同样文字加前缀并连上构图截图
  const nodes: Array<{ shot: number; group: 'A' | 'B'; id: string }> = []
  for (const shot of E1_SHOTS) {
    for (const group of ['A', 'B'] as const) {
      const id = await addNode(page, {
        type: 'plein/image',
        name: `镜头 ${shot.id} · ${group}`,
        params: {
          model: MODEL,
          prompt: group === 'A' ? shot.prompt : `${B_PREFIX}${shot.prompt}`,
          aspectRatio: shot.aspect,
          count: 1,
          options: { watermark: false },
        },
        x: (shot.id - 1) * 900,
        y: group === 'A' ? 700 : 1300,
      })
      if (group === 'B') {
        const linked = await page.evaluate(
          ([from, to]) => window.__plein.connect([from, 'image'], [to, 'references']),
          [stages[shot.id]!.id, id] as const,
        )
        expect(linked).toBe(true)
      }
      nodes.push({ shot: shot.id, group, id })
    }
  }

  // 新节点同步到服务端、B 组的参考图连上了，再开始花钱
  for (const n of nodes) {
    await expect
      .poll(
        async () => {
          const r = await page.request.get(`/api/canvases/${canvas}/nodes/${n.id}/input`)
          if (!r.ok()) return -1
          const body = (await r.json()) as { inputs?: { references?: unknown[] } }
          return body.inputs?.references?.length ?? 0
        },
        { timeout: 30_000 },
      )
      .toBe(n.group === 'B' ? 1 : 0)
  }

  // 3. 先试一次：密钥、模型或参数不对就在这里停下，只花一次调用
  const first = nodes[0]!
  const probe = await runOnce(page, canvas, first.id)
  manifest.calls.push({ shot: first.shot, group: first.group, sample: 1, ...probe })
  save()
  expect(probe.status, `试探调用失败：${probe.error}`).toBe('succeeded')

  // 4. 其余 35 次：各节点并行，同一节点内依次跑
  await Promise.all(
    nodes.map(async (n, i) => {
      for (let sample = i === 0 ? 2 : 1; sample <= SAMPLES; sample++) {
        const call = await runOnce(page, canvas, n.id)
        manifest.calls.push({ shot: n.shot, group: n.group, sample, ...call })
        save()
      }
    }),
  )
  expect(manifest.calls).toHaveLength(E1_SHOTS.length * 2 * SAMPLES)

  // 5. 盲审包：每个镜头 6 张图打乱、随机文件名，组别只在 key.json 里
  const key: Record<string, Omit<Call, 'ms' | 'status' | 'error'>> = {}
  const sheet = ['file,shot,位置,景别机位,朝向姿态,遮挡,外观跑偏']
  for (const shot of E1_SHOTS) {
    const dir = join(OUT, 'blind', `shot-${shot.id}`)
    mkdirSync(dir, { recursive: true })
    const calls = manifest.calls
      .filter((c) => c.shot === shot.id && c.assetId)
      .map((c) => ({ c, r: randomBytes(4).toString('hex') }))
      .sort((a, b) => a.r.localeCompare(b.r))
    for (const { c, r } of calls) {
      const file = await download(page, c.assetId!, join(dir, r))
      const name = file.slice(OUT.length + 1)
      key[name] = {
        shot: c.shot,
        group: c.group,
        sample: c.sample,
        resultId: c.resultId,
        assetId: c.assetId,
      }
      sheet.push(`${name},${shot.id},,,,,`)
    }
  }
  writeFileSync(join(OUT, 'key.json'), JSON.stringify(key, null, 2))
  writeFileSync(join(OUT, 'scores.csv'), `${sheet.join('\n')}\n`)
  manifest.calls.sort(
    (a, b) => a.shot - b.shot || a.group.localeCompare(b.group) || a.sample - b.sample,
  )
  save()
  const failed = manifest.calls.filter((c) => c.status !== 'succeeded')
  console.log(`[E1] ${manifest.calls.length} 次调用，失败 ${failed.length} 次，产物在 ${OUT}`)
})
