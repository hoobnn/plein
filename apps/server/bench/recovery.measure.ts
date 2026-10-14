/**
 * 失败恢复时间测量（0.2 发布指标）：按提交未知、轮询、下载、保存四种故障，
 * 用 mock 平台注入固定故障，记录能否拿到结果、用户操作、平台提交次数、恢复耗时和入库结果数。
 *
 * 不进默认 `pnpm test`；运行：`pnpm --filter @plein/server bench:recovery`。
 * 自动重试的退避用服务默认值（2 s、8 s），耗时就是用户实际等待的时间。
 * 用户操作在故障可见后立刻经 HTTP 接口发出，耗时不含人反应的时间。
 * 没有恢复接口的版本里，需要用户处理的故障一律按「重新运行」计。
 */
import type { PleinDoc } from '@plein/doc'
import { ProviderError } from '@plein/plugin-sdk'
import { mockProvider } from '@plein/providers'
import sharp from 'sharp'
import { afterAll, afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Server } from '../src/app'
import { addNode, bootServer, createCanvas, mockSettings, request, until } from '../src/testing'

/** mock 平台的生成耗时：固定值，提交后约每 200 ms 轮询一次 */
const LATENCY_MS = 600
/** 等结果的上限：最长的场景是两次退避（2 s + 8 s）再加生成 */
const WAIT_MS = 30_000
const FILE_HOST = 'files.mock.test'

type Action = 'refetch' | 'attach' | 'resubmit'

interface Row {
  id: string
  fault: string
  ok: boolean
  actions: string[]
  submits: number
  /** 故障发生到结果入库 */
  recoverMs: number | null
  /** 故障发生到任务失败、可以操作（自动恢复时为空） */
  visibleMs: number | null
  results: number
  note: string
}

const rows: Row[] = []

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  const head = [
    '场景',
    '故障',
    '拿到结果',
    '用户操作',
    'submit 次数',
    '恢复耗时',
    '可操作',
    '入库结果数',
    '备注',
  ]
  const lines = rows.map((r) => [
    r.id,
    r.fault,
    r.ok ? '是' : '否',
    r.actions.length ? r.actions.join('；') : '无',
    String(r.submits),
    r.recoverMs === null ? '—' : `${(r.recoverMs / 1000).toFixed(2)} s`,
    r.visibleMs === null ? '—' : `${(r.visibleMs / 1000).toFixed(2)} s`,
    String(r.results),
    r.note,
  ])
  const table = [head, head.map(() => '---'), ...lines].map((l) => `| ${l.join(' | ')} |`)
  process.stdout.write(
    `\n失败恢复测量（mock 平台，生成耗时 ${LATENCY_MS} ms）\n\n${table.join('\n')}\n`,
  )
})

/** 这个版本有没有任务恢复接口 */
const canRecover = (server: Server) =>
  typeof (server.runs as unknown as { recoverJob?: unknown }).recoverJob === 'function'

const jobStatus = (server: Server, id: string) => server.runs.store.get(id)?.status

function recoveryOf(server: Server, canvasId: string, jobId: string) {
  const job = server.runs.list(canvasId).jobs.find((j) => j.id === jobId) as
    | { recovery?: { state?: string } }
    | undefined
  return job?.recovery?.state
}

/** 节点 ▶ 运行：POST /nodes/:node/run */
async function runNode(server: Server, canvasId: string, node: string) {
  const res = await request(server, `/api/canvases/${canvasId}/nodes/${node}/run`, {
    method: 'POST',
    body: '{}',
  })
  expect(res.status).toBe(202)
  return ((await res.json()) as { runId: string }).runId
}

const resultCount = (doc: PleinDoc, node: string) => doc.get(node)?.results?.length ?? 0

interface Measure {
  server: Server
  canvasId: string
  doc: PleinDoc
  node: string
  /** 故障发生的时刻，注入故障时填 */
  faultAt: () => number | undefined
  /** 任务失败后用户要做的事；没有恢复接口时按重新运行计 */
  action?: Action
  /** 填平台任务 ID 时用的远端 ID */
  remoteId?: () => string | undefined
  /** 先跑起来的任务 id（服务重启等场景自己启动） */
  runId?: string
  /** 换了服务实例时用新的 */
  current?: () => { server: Server; doc: PleinDoc }
}

/** 从运行开始等到结果入库或任务失败；失败时按场景执行用户操作，再等结果 */
async function measure(
  m: Measure,
  row: Omit<Row, 'ok' | 'actions' | 'recoverMs' | 'visibleMs' | 'results'>,
) {
  let { server, doc } = m
  const actions: string[] = []
  let runId = m.runId ?? (await runNode(server, m.canvasId, m.node))
  const settled = async () => {
    await until(() => {
      if (m.current) ({ server, doc } = m.current())
      const s = jobStatus(server, runId)
      return resultCount(doc, m.node) > 0 || s === 'failed' || s === 'canceled'
    }, WAIT_MS)
  }
  await settled()
  let visibleMs: number | null = null
  const notes: string[] = []
  if (resultCount(doc, m.node) === 0) {
    visibleMs = Date.now() - (m.faultAt() ?? Date.now())
    if (canRecover(server))
      notes.push(`失败后恢复状态 ${recoveryOf(server, m.canvasId, runId) ?? '无'}`)
    if (m.action && canRecover(server)) {
      const body =
        m.action === 'attach'
          ? { action: 'attach', remoteId: m.remoteId?.() }
          : { action: m.action }
      const res = await request(server, `/api/canvases/${m.canvasId}/jobs/${runId}/recover`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const label = {
        refetch: '任务面板「重新获取」',
        attach: '任务面板「填写平台任务 ID」',
        resubmit: '任务面板「确认未受理，重新提交」',
      }[m.action]
      actions.push(`${label}（POST /jobs/:job/recover ${m.action}，${res.status}）`)
      if (res.status !== 200) {
        // 恢复接口拒绝：用户只剩重新运行
        notes.push(`恢复接口拒绝：${((await res.json()) as { message?: string }).message}`)
        runId = await runNode(server, m.canvasId, m.node)
        actions.push('重新运行节点（POST /nodes/:node/run）')
      }
    } else {
      runId = await runNode(server, m.canvasId, m.node)
      actions.push('重新运行节点（POST /nodes/:node/run）')
    }
    await settled().catch(() => {})
  }
  const end = Date.now()
  const ok = resultCount(doc, m.node) > 0
  // 结果入库后任务落定，再数结果
  await until(
    () => jobStatus(server, runId) !== 'running' && jobStatus(server, runId) !== 'queued',
    WAIT_MS,
  ).catch(() => {})
  const fault = m.faultAt()
  rows.push({
    ...row,
    ok,
    actions,
    submits:
      (mockProvider.submit as unknown as { mock?: { calls: unknown[] } }).mock?.calls.length ?? -1,
    recoverMs: ok && fault ? end - fault : null,
    visibleMs,
    results: resultCount(doc, m.node),
    note: [row.note, ...notes].filter(Boolean).join('；'),
  })
}

async function setup() {
  const boot = await bootServer()
  mockSettings(boot.server, { latencyMs: LATENCY_MS })
  const { id, doc } = await createCanvas(boot.server)
  const node = addNode(doc, 'plein/image', { params: { prompt: 'bench', count: 1 } })
  return { ...boot, canvasId: id, doc, node }
}

/** 平台受理了提交，但回应在路上丢了（POST 断在半路：不可重试，结果未知） */
function loseSubmitResponse() {
  const real = mockProvider.submit
  let remoteId: string | undefined
  let at: number | undefined
  vi.spyOn(mockProvider, 'submit').mockImplementationOnce(async (req, ctx) => {
    const r = await real(req, ctx)
    if (r.state === 'pending') remoteId = r.remoteId
    at = Date.now()
    throw new ProviderError('unavailable', '网络断开', {
      retryable: false,
      // 没有这个字段的版本会忽略它
      ...({ outcome: 'unknown' } as object),
    })
  })
  return { remoteId: () => remoteId, faultAt: () => at }
}

/** 不提供按幂等键查询的平台 */
function withoutLookup() {
  const p = mockProvider as { lookup?: unknown }
  const saved = p.lookup
  p.lookup = undefined
  return () => {
    p.lookup = saved
  }
}

/** 轮询前 n 次网络失败 */
function failPolls(n: number) {
  const real = mockProvider.poll!
  let left = n
  let at: number | undefined
  vi.spyOn(mockProvider, 'poll').mockImplementation(async (remoteId, ctx) => {
    if (left > 0) {
      left--
      at ??= Date.now()
      throw new ProviderError('unavailable', '模拟轮询网络失败')
    }
    return real(remoteId, ctx)
  })
  return () => at
}

/**
 * 平台给结果地址而不是字节；同一个任务再查询时给新地址。
 * 第一个地址的第一次下载返回 status。
 */
async function urlResults(server: Server, status: number) {
  server.plugins.registry.plugin('plein/mock')!.manifest.permissions.network.push(FILE_HOST)
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#f00' } })
    .png()
    .toBuffer()
  const real = mockProvider.poll!
  const done = new Set<string>()
  let seq = 0
  const success = () => ({
    state: 'succeeded' as const,
    outputs: [
      {
        type: 'file' as const,
        kind: 'image' as const,
        mime: 'image/png',
        url: `https://${FILE_HOST}/r-${++seq}.png`,
      },
    ],
  })
  vi.spyOn(mockProvider, 'poll').mockImplementation(async (remoteId, ctx) => {
    if (done.has(remoteId)) return success()
    const r = await real(remoteId, ctx)
    if (r.state !== 'succeeded') return r
    done.add(remoteId)
    return success()
  })
  let failed = false
  let at: number | undefined
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith(`https://${FILE_HOST}/`)) return realFetch(input, init)
    if (!failed) {
      failed = true
      at = Date.now()
      return new Response('fail', { status })
    }
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
  })
  return () => at
}

describe('失败恢复', { timeout: 60_000 }, () => {
  it('U1 提交未知：平台有 lookup', async () => {
    const s = await setup()
    const lost = loseSubmitResponse()
    await measure(
      { ...s, faultAt: lost.faultAt, action: 'resubmit' },
      { id: 'U1', fault: '提交未知（有 lookup）', submits: 0, note: '' },
    )
  })

  it('U2 提交未知：没有 lookup，填平台任务 ID', async () => {
    const restore = withoutLookup()
    try {
      const s = await setup()
      const lost = loseSubmitResponse()
      await measure(
        { ...s, faultAt: lost.faultAt, action: 'attach', remoteId: lost.remoteId },
        { id: 'U2', fault: '提交未知（无 lookup，填任务 ID）', submits: 0, note: '' },
      )
    } finally {
      restore()
    }
  })

  it('U3 提交未知：没有 lookup，确认未受理重新提交', async () => {
    const restore = withoutLookup()
    try {
      const s = await setup()
      const lost = loseSubmitResponse()
      await measure(
        { ...s, faultAt: lost.faultAt, action: 'resubmit' },
        { id: 'U3', fault: '提交未知（无 lookup，确认后重提）', submits: 0, note: '' },
      )
    } finally {
      restore()
    }
  })

  it('P1 轮询连续 2 次网络失败', async () => {
    vi.spyOn(mockProvider, 'submit')
    const s = await setup()
    const faultAt = failPolls(2)
    await measure(
      { ...s, faultAt, action: 'refetch' },
      { id: 'P1', fault: '轮询连续 2 次失败', submits: 0, note: '' },
    )
  })

  it('P2 轮询连续 3 次网络失败（超出自动重试）', async () => {
    vi.spyOn(mockProvider, 'submit')
    const s = await setup()
    const faultAt = failPolls(3)
    await measure(
      { ...s, faultAt, action: 'refetch' },
      { id: 'P2', fault: '轮询连续 3 次失败', submits: 0, note: '' },
    )
  })

  it('P3 轮询期间服务重启', async () => {
    vi.spyOn(mockProvider, 'submit')
    const first = await setup()
    const runId = await runNode(first.server, first.canvasId, first.node)
    await until(() => first.server.runs.store.get(runId)?.calls.includes('pending'), WAIT_MS)
    const at = Date.now()
    first.close()
    const second = await bootServer({ dataDir: first.dataDir })
    const { createDoc } = await import('@plein/doc')
    const doc = createDoc(second.server.rooms.get(first.canvasId).doc, { schedule: () => {} })
    await measure(
      {
        server: second.server,
        canvasId: first.canvasId,
        doc,
        node: first.node,
        runId,
        faultAt: () => at,
        action: 'refetch',
      },
      { id: 'P3', fault: '轮询期间服务重启', submits: 0, note: '耗时含进程内重启' },
    )
  })

  it('D1 结果下载临时失败（503 一次）', async () => {
    vi.spyOn(mockProvider, 'submit')
    const s = await setup()
    const faultAt = await urlResults(s.server, 503)
    await measure(
      { ...s, faultAt, action: 'refetch' },
      { id: 'D1', fault: '下载 503 一次', submits: 0, note: '' },
    )
  })

  it('D2 结果地址过期（403 一次）', async () => {
    vi.spyOn(mockProvider, 'submit')
    const s = await setup()
    const faultAt = await urlResults(s.server, 403)
    await measure(
      { ...s, faultAt, action: 'refetch' },
      { id: 'D2', fault: '结果地址过期 403', submits: 0, note: '' },
    )
  })

  it('S1 结果写入资产库失败一次', async () => {
    vi.spyOn(mockProvider, 'submit')
    const s = await setup()
    let at: number | undefined
    vi.spyOn(s.server.assets, 'ingest').mockImplementationOnce(async () => {
      at = Date.now()
      throw new Error('磁盘已满')
    })
    await measure(
      { ...s, faultAt: () => at, action: 'refetch' },
      { id: 'S1', fault: '保存失败一次', submits: 0, note: '' },
    )
  })
})
