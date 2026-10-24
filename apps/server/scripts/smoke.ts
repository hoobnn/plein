/**
 * L3 运行冒烟：真的起一个服务端进程，用 HTTP 与 Yjs WebSocket 走一遍用户路径。
 *
 * 与 vitest 里的进程内集成测试不同，这里验证的是「服务真能起来、真能连、
 * 重启后数据还在」，是 CONTRIBUTING.md「验收分层」里 L3 层的自动化部分。
 * 界面点击仍需人工或后续的 Playwright 用例。
 *
 * 用法：pnpm smoke                    （临时数据目录，结束即清理）
 *      PLEIN_KEEP_DATA=1 pnpm smoke   （保留数据目录便于排查）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { connect, createDoc, createElement } from '@plein/doc'
import type { Catalog } from '@plein/protocol'
import { WebSocket } from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { loadConfig } from '../src/config'
import { startServer, type RunningServer } from '../src/start'

const dataDir = mkdtempSync(join(tmpdir(), 'plein-smoke-'))
const config = {
  ...loadConfig({ PLEIN_DATA_DIR: dataDir, PLEIN_MOCK_PROVIDER: '1', PLEIN_PORT: '0' }),
  webDist: null,
}

const checks: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  checks.push(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  // 边跑边打，卡住时能看出停在哪一步
  process.stderr.write(`${checks.at(-1)}\n`)
  if (!ok) failed++
}

/** 用 y-websocket 连上画布，等同步完成 */
async function openSync(base: string, canvasId: string) {
  const ydoc = new Y.Doc()
  // Node 自带的 WebSocket 发的是 Blob，服务端只收 ArrayBuffer，这里显式用 ws
  // y-websocket 会在末尾拼 /<房间名>，所以基址要带 /sync
  const provider = new WebsocketProvider(`${base}/sync`, canvasId, ydoc, {
    connect: true,
    WebSocketPolyfill: WebSocket as never,
  })
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error('同步超时')), 5000)
    provider.on('sync', (synced: boolean) => {
      if (!synced) return
      clearTimeout(timer)
      res()
    })
    provider.on('connection-error', () => {
      clearTimeout(timer)
      rej(new Error('同步连接失败'))
    })
  })
  const doc = createDoc(ydoc, { schedule: () => {} })
  return {
    doc,
    async close() {
      doc.destroy()
      provider.destroy()
    },
  }
}

let url = ''
const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${url}${path}`, init)
  const body = res.status === 204 ? null : await res.json().catch(() => null)
  return { status: res.status, body: body as Record<string, never> }
}

let running: RunningServer | undefined
try {
  running = await startServer(config)
  url = running.url
  check('服务启动并监听本机端口', true, url)

  const session = await api('/api/session')
  check(
    '会话接口可用且本机默认放行',
    session.status === 200 &&
      (session.body as { principal?: { id?: string } })?.principal?.id === 'local',
  )

  const catalog = await api('/api/catalog')
  const nodeTypes = ((catalog.body as { nodes?: { type: string }[] })?.nodes ?? []).map(
    (n) => n.type,
  )
  check(
    '模型目录包含内置节点',
    nodeTypes.includes('plein/image') && nodeTypes.includes('plein/storyboard'),
    `${nodeTypes.length} 个节点`,
  )

  const imageModel = (catalog.body as unknown as Catalog).defaultModels?.['image.generate']
  check('生成图片默认模型可用', Boolean(imageModel), imageModel ?? '未配置')

  const created = await api('/api/canvases', {
    method: 'POST',
    body: JSON.stringify({ title: '冒烟' }),
  })
  const canvasId = (created.body as { id?: string }).id!
  check('新建画布', created.status === 201 && Boolean(canvasId), canvasId)

  // 通过 WebSocket 同步建节点：文本 → 图片，验证连线与任务队列
  const conn = await openSync(url, canvasId)
  const textPorts = { inputs: [], outputs: [{ id: 'text', label: '文本', type: 'text' as const }] }
  const imagePorts = {
    inputs: [
      { id: 'prompt', label: '提示词', type: 'text' as const, multiple: true },
      { id: 'references', label: '参考图', type: 'image' as const, multiple: true },
    ],
    outputs: [{ id: 'images', label: '图片', type: 'image' as const }],
  }
  let imageId = ''
  conn.doc.ydoc.transact(() => {
    const text = createElement(conn.doc, {
      kind: 'node',
      nodeType: 'plein/text',
      nodeVersion: 1,
      name: '创意',
      params: { text: '雨夜天台' },
      ports: textPorts,
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    })
    const image = createElement(conn.doc, {
      kind: 'node',
      nodeType: 'plein/image',
      nodeVersion: 1,
      name: '分镜图',
      params: { count: 1, model: imageModel },
      ports: imagePorts,
      x: 300,
      y: 0,
      w: 200,
      h: 200,
    })
    imageId = image
    connect(conn.doc, [text, 'text'], [image, 'prompt'])
  })
  conn.doc.flush()
  await new Promise((r) => setTimeout(r, 400))
  check('WebSocket 同步把节点写进画布', conn.doc.get(imageId)?.nodeType === 'plein/image')

  const run = await api(`/api/canvases/${canvasId}/nodes/${imageId}/run`, { method: 'POST' })
  check('提交节点运行', run.status === 202, `HTTP ${run.status}`)

  let jobDone = false
  for (let i = 0; i < 150 && !jobDone; i++) {
    await new Promise((r) => setTimeout(r, 100))
    const jobs = await api(`/api/canvases/${canvasId}/jobs`)
    const job = ((jobs.body as { jobs?: { status: string; error?: string }[] }).jobs ?? [])[0]
    if (!job || job.status === 'queued' || job.status === 'running') continue
    check('任务队列跑完并记录状态', job.status === 'succeeded', `${job.status}${job.error ?? ''}`)
    check('结果写回画布（上游文本参与计算）', Boolean(conn.doc.get(imageId)?.results?.length))
    jobDone = true
  }
  if (!jobDone) check('任务队列跑完并记录状态', false, '超时')
  await conn.close()

  // 上传资产：请求体就是文件内容，文件名走 X-File-Name
  const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#6366f1' } })
    .png()
    .toBuffer()
  const upload = await api('/api/assets', {
    method: 'POST',
    body: png,
    headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('冒烟.png') },
  })
  const uploaded = upload.body as { id?: string; width?: number; mime?: string }
  check(
    '上传资产并生成缩略图元数据',
    upload.status === 201 &&
      Boolean(uploaded.id) &&
      uploaded.width === 32 &&
      uploaded.height === 24,
    `HTTP ${upload.status} ${uploaded.id} ${uploaded.width}×${uploaded.height ?? '?'} ${uploaded.mime}`,
  )

  // 媒体加工：产出新资产并记来源，源资产不动
  const derive = await api('/api/media/derive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 'crop',
      assetId: uploaded.id,
      left: 4,
      top: 4,
      width: 16,
      height: 8,
    }),
  })
  const derived = derive.body as {
    assets?: { id: string; width?: number; height?: number }[]
    op?: string
  }
  const out = derived.assets?.[0]
  check(
    '媒体加工产出新资产并带来源',
    derive.status === 201 && derived.op === 'crop' && out?.id !== uploaded.id,
    `${derived.op} → ${out?.id} ${out?.width}×${out?.height}`,
  )
  check(
    '裁剪坐标对应实际像素',
    out?.width === 16 && out?.height === 8,
    `${out?.width}×${out?.height}`,
  )
  const source = await api(`/api/assets/${uploaded.id}/meta`)
  check(
    '源资产没有被加工改写',
    source.status === 200 && (source.body as { width?: number }).width === 32,
  )

  await running.close()

  // 重启：同一数据目录，元素与资产都应还在
  running = await startServer(config)
  url = running.url
  const back = await openSync(url, canvasId)
  check('重启后画布元素不丢', back.doc.get(imageId)?.nodeType === 'plein/image')
  const meta = await api(`/api/assets/${uploaded.id}/meta`)
  check('重启后资产仍在', meta.status === 200 && (meta.body as { id?: string }).id === uploaded.id)
  await back.close()
} finally {
  await running?.close()
  if (process.env.PLEIN_KEEP_DATA) console.log(`数据目录保留在 ${dataDir}`)
  else rmSync(dataDir, { recursive: true, force: true })
}

console.log(checks.join('\n'))
console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
