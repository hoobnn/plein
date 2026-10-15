/**
 * W3 任务恢复操作的真实平台验收（L4，真实计费）：在真实视频平台上注入故障，
 * 走任务面板的「填写平台任务 ID」「重新获取」「确认未受理，重新提交」，确认拿到结果、不多提交。
 *
 * 故障在本进程里注入（包住平台插件的 submit / poll 和资产入库），平台那边是真实调用：
 * - R1 提交后回应丢失 → 填平台任务 ID：1 次提交
 * - R2 轮询连续 3 次失败 → 重新获取；结果写入资产库失败一次 → 再重新获取：1 次提交
 * - R3 提交请求没发出去就断了（平台没受理）→ 确认未受理，重新提交：1 次提交
 * 共 3 段视频。只在显式运行时执行，不进 `pnpm test` 和 CI：
 *
 *   PLEIN_L4_DATA=<配好平台的数据目录> pnpm --filter @plein/server bench:recovery:real
 *
 * 数据目录先复制一份再用，原目录不动。视频模型、分辨率、时长可用
 * PLEIN_L4_VIDEO_MODEL / PLEIN_L4_VIDEO_RESOLUTION / PLEIN_L4_VIDEO_DURATION 改。
 */
import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PleinDoc } from '@plein/doc'
import { type ProviderDefinition, ProviderError } from '@plein/plugin-sdk'
import { arkProvider, bailianProvider, minimaxProvider, mockProvider } from '@plein/providers'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import type { Server } from '../src/app'
import {
  addNode,
  bootServer,
  createCanvas,
  mockSettings,
  request,
  tempDir,
  until,
} from '../src/testing'

/** 先用 mock 平台把流程走一遍（不计费）：PLEIN_L4_DRY_RUN=1 */
const DRY = process.env.PLEIN_L4_DRY_RUN === '1'
const SOURCE = process.env.PLEIN_L4_DATA
const MODEL = DRY
  ? 'plein/mock:video'
  : (process.env.PLEIN_L4_VIDEO_MODEL ?? 'minimax/api:MiniMax-H3')
const RESOLUTION = process.env.PLEIN_L4_VIDEO_RESOLUTION ?? '768P'
const DURATION = Number(process.env.PLEIN_L4_VIDEO_DURATION ?? 6)
/** 真实视频生成要几分钟，给足 */
const WAIT_MS = 20 * 60_000

/** 平台 id（如 minimax/api），和它的插件实现 */
const providerId = MODEL.split(':')[0]!
const providers: Record<string, ProviderDefinition> = {
  minimax: minimaxProvider,
  ark: arkProvider,
  bailian: bailianProvider,
  plein: mockProvider,
}
const provider = providers[providerId.split('/')[0]!]

interface Row {
  id: string
  fault: string
  actions: string[]
  submits: number
  results: number
  minutes: string
  note: string
}
const rows: Row[] = []

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  const head = ['场景', '故障', '用户操作', '平台提交', '入库结果', '耗时', '备注']
  const lines = rows.map((r) => [
    r.id,
    r.fault,
    r.actions.join('；') || '无',
    String(r.submits),
    String(r.results),
    r.minutes,
    r.note,
  ])
  const table = [head, head.map(() => '---'), ...lines].map((l) => `| ${l.join(' | ')} |`)
  process.stdout.write(
    `\n任务恢复真实平台验收（${MODEL}，${RESOLUTION}，${DURATION} 秒）\n\n${table.join('\n')}\n`,
  )
})

async function setup() {
  const dataDir = tempDir('plein-l4-recovery-')
  if (!DRY) cpSync(SOURCE!, dataDir, { recursive: true })
  const boot = await bootServer({ dataDir, mock: DRY })
  // mock 平台给了耗时才走「提交 → 轮询」
  if (DRY) mockSettings(boot.server, { latencyMs: 600 })
  if (!DRY) {
    const enable = await request(boot.server, `/api/providers/${providerId}/config`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    })
    expect(enable.status).toBe(200)
  }
  const { id, doc } = await createCanvas(boot.server)
  const node = addNode(doc, 'plein/video', {
    params: {
      prompt: '清晨的城市街道，一位穿蓝色外套的快递员骑车穿过镜头，固定机位',
      model: MODEL,
      resolution: RESOLUTION,
      duration: DURATION,
    },
  })
  return { ...boot, canvasId: id, doc, node }
}

type Setup = Awaited<ReturnType<typeof setup>>

async function runNode(s: Setup) {
  const res = await request(s.server, `/api/canvases/${s.canvasId}/nodes/${s.node}/run`, {
    method: 'POST',
    body: '{}',
  })
  expect(res.status).toBe(202)
  return ((await res.json()) as { runId: string }).runId
}

const results = (doc: PleinDoc, node: string) => doc.get(node)?.results?.length ?? 0
const status = (server: Server, job: string) => server.runs.store.get(job)?.status

function recoveryOf(s: Setup, job: string) {
  const info = s.server.runs.list(s.canvasId).jobs.find((j) => j.id === job)
  return info?.recovery?.state
}

/** 等到有结果或任务失败 */
async function settle(s: Setup, job: string) {
  await until(() => {
    const st = status(s.server, job)
    return results(s.doc, s.node) > 0 || st === 'failed' || st === 'canceled'
  }, WAIT_MS)
}

async function recover(s: Setup, job: string, body: Record<string, unknown>) {
  const res = await request(s.server, `/api/canvases/${s.canvasId}/jobs/${job}/recover`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
}

/** 数真实提交次数：包一层，照常调平台 */
function countSubmits() {
  const real = provider!.submit.bind(provider)
  const spy = vi.spyOn(provider!, 'submit')
  return { count: () => spy.mock.calls.length, spy, real }
}

const minutes = (from: number) => `${((Date.now() - from) / 60_000).toFixed(1)} 分钟`

describe.skipIf(!(SOURCE || DRY) || !provider)(
  '任务恢复（真实平台）',
  { timeout: 3 * WAIT_MS },
  () => {
    if (SOURCE && !existsSync(join(SOURCE, 'plein.db')))
      throw new Error(`PLEIN_L4_DATA 不像数据目录：${SOURCE}`)
    // 内置真实平台都没有按幂等键查询的合同；mock 有，演练时去掉，走同一条人工核查路径
    if (DRY) {
      const saved = mockProvider.lookup
      beforeAll(() => {
        ;(mockProvider as { lookup?: unknown }).lookup = undefined
      })
      afterAll(() => {
        mockProvider.lookup = saved
      })
    }

    it('R1 提交后回应丢失：填写平台任务 ID 续查', async () => {
      // 先包平台插件再起服务：服务启动时登记的是当时的方法
      const submits = countSubmits()
      let remoteId: string | undefined
      submits.spy.mockImplementationOnce(async (req, ctx) => {
        const r = await submits.real(req, ctx)
        if (r.state === 'pending') remoteId = r.remoteId
        throw new ProviderError('unavailable', '模拟：提交回应丢失', {
          retryable: false,
          outcome: 'unknown',
        })
      })
      const s = await setup()
      const t = Date.now()
      const job = await runNode(s)
      await settle(s, job)
      expect(results(s.doc, s.node)).toBe(0)
      expect(recoveryOf(s, job)).toBe('submit_unknown')
      expect(remoteId, '平台应已返回任务 ID').toBeTruthy()
      // 用户从平台控制台查到任务 ID 后填进来
      await recover(s, job, { action: 'attach', remoteId })
      await settle(s, job)
      expect(results(s.doc, s.node)).toBe(1)
      rows.push({
        id: 'R1',
        fault: '提交后回应丢失',
        actions: ['「填写平台任务 ID」'],
        submits: submits.count(),
        results: results(s.doc, s.node),
        minutes: minutes(t),
        note: `远端任务 ${remoteId}`,
      })
      expect(submits.count()).toBe(1)
    })

    it('R2 轮询连续失败、保存失败：两次重新获取', async () => {
      // 先包平台插件再起服务：服务启动时登记的是当时的方法
      const submits = countSubmits()
      const realPoll = provider!.poll!.bind(provider)
      let failing = 3
      vi.spyOn(provider!, 'poll').mockImplementation(async (remoteId, ctx) => {
        if (failing > 0) {
          failing--
          throw new ProviderError('unavailable', '模拟：轮询网络失败')
        }
        return realPoll(remoteId, ctx)
      })
      const s = await setup()
      let ingestFailed = false
      const realIngest = s.server.assets.ingest.bind(s.server.assets)
      vi.spyOn(s.server.assets, 'ingest').mockImplementation(async (...args) => {
        if (!ingestFailed) {
          ingestFailed = true
          throw new Error('模拟：磁盘已满')
        }
        return realIngest(...args)
      })
      const t = Date.now()
      const job = await runNode(s)
      await settle(s, job)
      const notes = [`轮询失败后 ${recoveryOf(s, job)}`]
      expect(recoveryOf(s, job)).toBe('remote_pending')
      await recover(s, job, { action: 'refetch' })
      await settle(s, job)
      notes.push(`保存失败后 ${recoveryOf(s, job)}`)
      expect(ingestFailed).toBe(true)
      expect(results(s.doc, s.node)).toBe(0)
      expect(recoveryOf(s, job)).toBe('fetch_failed')
      await recover(s, job, { action: 'refetch' })
      await settle(s, job)
      expect(results(s.doc, s.node)).toBe(1)
      rows.push({
        id: 'R2',
        fault: '轮询连续 3 次失败；写入资产库失败一次',
        actions: ['「重新获取」', '「重新获取」'],
        submits: submits.count(),
        results: results(s.doc, s.node),
        minutes: minutes(t),
        note: notes.join('，'),
      })
      expect(submits.count()).toBe(1)
    })

    it('R3 提交没发出去：确认未受理后重新提交', async () => {
      // 先包平台插件再起服务：服务启动时登记的是当时的方法
      const submits = countSubmits()
      submits.spy.mockImplementationOnce(async () => {
        throw new ProviderError('unavailable', '模拟：请求发出前断网', {
          retryable: false,
          outcome: 'unknown',
        })
      })
      const s = await setup()
      const t = Date.now()
      const job = await runNode(s)
      await settle(s, job)
      expect(recoveryOf(s, job)).toBe('submit_unknown')
      await recover(s, job, { action: 'resubmit' })
      await settle(s, job)
      expect(results(s.doc, s.node)).toBe(1)
      rows.push({
        id: 'R3',
        fault: '提交请求没发出去',
        actions: ['「确认未受理，重新提交」'],
        // 第一次被拦下、没到平台
        submits: submits.count() - 1,
        results: results(s.doc, s.node),
        minutes: minutes(t),
        note: '',
      })
      expect(submits.count() - 1).toBe(1)
    })
  },
)
