import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  type CapabilityContext,
  CapabilityError,
  CapabilityRegistry,
  type ContentBlock,
  canvasCapabilities,
  capabilityFor,
  content,
  need,
  placeNew,
  resultSummary,
} from '@plein/capabilities'
import { currentResult, elementMedia, mediaSize, type PleinDoc } from '@plein/doc'
import { describeNode, executionOf } from '@plein/plugin-sdk'
import { MediaDeriveRequest, type MediaDerivation, MediaOp } from '@plein/protocol'
import sharp, { type Sharp } from 'sharp'
import { z } from 'zod'
import { DeriveError, deriveAsset } from '../assets/derive'
import { ffmpegBin, hasFfmpeg } from '../assets/media'
import type { AssetStore } from '../assets/store'
import { NodeRunError, type PluginHost } from '../plugins/host'
import type { NodeRuns } from '../runs/runs'
import type { Rooms } from '../sync/rooms'
import { capabilityTools, type McpTool } from './mcp'

const exec = promisify(execFile)

/** 能力运行时绑定的画布与身份 */
export interface ToolEnv {
  canvasId: string
  ownerId: string
  rooms: Rooms
  runs: NodeRuns
  host: PluginHost
  assets: AssetStore
  /** 文档写入的事务 origin：智能体会话用自己的 origin，改动集和撤销按它归属 */
  origin?: unknown
  /** 发起了一次运行（记进改动集，撤销这一轮时一并取消） */
  onRun?(nodeId: string, runId: string): void
}

/** 服务端能力的上下文：画布读写之外还能用运行队列、资产文件 */
export interface ServerContext extends CapabilityContext {
  env: ToolEnv
}

/** 单次等待运行结果的上限：Codex 默认 60 秒工具超时，留出余量 */
const MAX_WAIT_S = 50

const id = z.string().min(1).max(200)
const serverCapability = capabilityFor<ServerContext>()

export function serverContext(env: ToolEnv): ServerContext {
  const { host } = env
  const info = (key: string, n: NonNullable<ReturnType<typeof host.registry.latestNode>>) => ({
    def: n.def,
    descriptor: describeNode(n.def, n.plugin),
    runnable: executionOf(n.def) === 'inline' || host.registry.executors.has(key),
  })
  return {
    env,
    withDoc: (fn) => env.rooms.withDoc(env.canvasId, fn, undefined, env.origin),
    nodes: {
      latest: (type) => {
        const n = host.registry.latestNode(type)
        return n ? info(`${n.def.type}@${n.def.version}`, n) : undefined
      },
      all: () => {
        const out = []
        for (const [key, n] of host.registry.nodes) {
          if (host.registry.latestNode(n.def.type)?.def.version !== n.def.version) continue
          out.push(info(key, n))
        }
        return out
      },
      models: (capability) => host.models(capability).map((m) => ({ ref: m.ref, title: m.title })),
    },
    assetMeta: (assetId) => env.assets.get(env.ownerId, assetId) ?? undefined,
  }
}

const asset = (ctx: ServerContext, assetId: string) => {
  const a = ctx.env.assets.get(ctx.env.ownerId, assetId)
  if (!a) throw new CapabilityError(`资产 ${assetId} 不存在`)
  return a
}

const runNode = serverCapability({
  name: 'run_node',
  title: '运行节点',
  description: `运行节点（调用模型生成，会产生费用）并等待结果，最多等 ${MAX_WAIT_S} 秒；超时则返回 running，之后用 wait_for_run 继续等。上游节点需要先有结果。`,
  group: 'run',
  where: 'server',
  effect: 'run',
  input: z.object({
    id,
    wait_seconds: z.number().min(0).max(MAX_WAIT_S).default(MAX_WAIT_S),
  }),
  run: async (ctx, { id, wait_seconds }) => {
    const { env } = ctx
    let runId: string
    try {
      runId = env.runs.start(env.canvasId, id, env.ownerId)
    } catch (err) {
      if (err instanceof NodeRunError) throw new CapabilityError(err.message)
      throw err
    }
    env.onRun?.(id, runId)
    return waitRun(ctx, id, runId, wait_seconds)
  },
})

const waitForRun = serverCapability({
  name: 'wait_for_run',
  title: '等待结果',
  description: `继续等待节点当前这次运行，最多 ${MAX_WAIT_S} 秒。`,
  group: 'run',
  where: 'server',
  effect: 'read',
  input: z.object({
    id,
    wait_seconds: z.number().min(0).max(MAX_WAIT_S).default(MAX_WAIT_S),
  }),
  run: (ctx, { id, wait_seconds }) => {
    const run = ctx.withDoc((doc) => need(doc, id).run)
    if (!run) throw new CapabilityError('这个节点还没运行过')
    return waitRun(ctx, id, run.id, wait_seconds)
  },
})

const cancelRun = serverCapability({
  name: 'cancel_run',
  title: '取消运行',
  description: '取消节点正在进行的运行。',
  group: 'run',
  where: 'server',
  effect: 'edit',
  input: z.object({ id }),
  run: (ctx, { id }) => {
    ctx.env.runs.cancel(ctx.env.canvasId, id)
    return '已取消'
  },
})

const viewMedia = serverCapability({
  name: 'view_media',
  title: '查看效果',
  description:
    '查看图片 / 视频 / 音频的内容：图片返回缩略图，视频按时间均匀抽帧，音频返回时长和台词。用来检查生成效果。传资产 id，或传元素 id（取它的素材或当前结果）。',
  group: 'media',
  where: 'server',
  effect: 'read',
  input: z.object({
    asset_id: z.string().optional(),
    element_id: id.optional(),
    frames: z.number().int().min(1).max(8).default(4).describe('视频抽几帧'),
  }),
  run: async (ctx, a) => {
    const assetId =
      a.asset_id ??
      (a.element_id
        ? ctx.withDoc((doc) => elementMedia(need(doc, a.element_id!))?.assetId)
        : undefined)
    if (!assetId) throw new CapabilityError('需要 asset_id，或一个有媒体内容的 element_id')
    const meta = asset(ctx, assetId)
    const src = ctx.env.assets.originalPath(assetId)
    const info = `${meta.kind}，${meta.mime}${meta.width ? `，${meta.width}×${meta.height}` : ''}${meta.duration ? `，${meta.duration.toFixed(1)} 秒` : ''}`
    if (meta.kind === 'image') {
      return content([{ type: 'text', text: info }, await jpeg(sharp(src).rotate())])
    }
    if (meta.kind === 'video') {
      if (!(await hasFfmpeg())) return `${info}；本机没有 ffmpeg，无法抽帧`
      const d = meta.duration ?? 1
      const blocks: ContentBlock[] = [{ type: 'text', text: info }]
      for (let i = 0; i < a.frames; i++) {
        const t = (d * (i + 0.5)) / a.frames
        const { stdout } = await exec(
          ffmpegBin(),
          [
            '-v',
            'error',
            '-ss',
            t.toFixed(2),
            '-i',
            src,
            '-frames:v',
            '1',
            '-f',
            'image2pipe',
            '-c:v',
            'png',
            '-',
          ],
          { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
        )
        blocks.push({ type: 'text', text: `${t.toFixed(1)} 秒` }, await jpeg(sharp(stdout), 640))
      }
      return content(blocks)
    }
    const caption = a.element_id
      ? ctx.withDoc((doc) => {
          const v = currentResult(need(doc, a.element_id!))?.value
          return v && 'caption' in v ? v.caption : undefined
        })
      : undefined
    return caption ? `${info}；台词：${caption}` : info
  },
})

const editMedia = serverCapability({
  name: 'edit_media',
  title: '加工素材',
  description:
    '加工素材，与画布上的加工工具条是同一套实现：trim 截取片段（start、end 秒）、speed 变速（speed 倍数）、separate 把视频分离成音轨和无声视频（要去掉原声就用分出来的无声视频）、frame 抽一帧成图片（at 秒）、crop / rotate / flip 处理图片、split 把音频按区间切开（segments）。结果是新资产，作为元素放在原元素旁边，原素材不变；要做多步就依次调用。',
  group: 'media',
  where: 'server',
  effect: 'edit',
  input: z.object({
    element_id: id.optional().describe('素材元素或节点（取当前结果）'),
    asset_id: z.string().optional(),
    op: MediaOp,
    start: z.number().min(0).optional().describe('trim 入点（秒）'),
    end: z.number().positive().optional().describe('trim 出点（秒）'),
    speed: z.number().min(0.25).max(4).optional().describe('speed 倍数'),
    at: z.number().min(0).optional().describe('frame 取帧时刻（秒）'),
    left: z.number().int().optional(),
    top: z.number().int().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    angle: z.number().int().optional().describe('rotate：90 / 180 / 270'),
    axis: z.enum(['horizontal', 'vertical']).optional().describe('flip 方向'),
    segments: z
      .array(z.object({ start: z.number(), end: z.number() }))
      .optional()
      .describe('split 的区间（秒）'),
    name: z.string().max(100).optional(),
  }),
  run: async (ctx, { element_id, asset_id, ...edit }) => {
    const assetId =
      asset_id ??
      (element_id ? ctx.withDoc((doc) => elementMedia(need(doc, element_id))?.assetId) : undefined)
    if (!assetId) throw new CapabilityError('需要素材的 asset_id 或 element_id')
    const req = MediaDeriveRequest.safeParse({ ...edit, assetId })
    if (!req.success) throw new CapabilityError(`参数不对：${z.prettifyError(req.error)}`)
    let made: MediaDerivation
    try {
      made = await deriveAsset(ctx.env.assets, ctx.env.ownerId, req.data)
    } catch (err) {
      if (err instanceof DeriveError) throw new CapabilityError(err.message)
      throw err
    }
    return ctx.withDoc((doc: PleinDoc) => {
      const elements = made.assets.flatMap((out) => {
        const kind = out.kind
        if (kind !== 'image' && kind !== 'video' && kind !== 'audio') return []
        const size = mediaSize(kind, out.width, out.height)
        const elId = placeNew(
          doc,
          { near: element_id },
          { kind, assetId: out.id, name: out.name, ...size },
        )
        return [{ id: elId, kind, asset_id: out.id, duration: out.duration }]
      })
      return { elements, ...(made.note ? { note: made.note } : {}) }
    })
  },
})

async function waitRun(ctx: ServerContext, nodeId: string, runId: string, seconds: number) {
  const status = await Promise.race([
    ctx.env.runs.wait(runId),
    new Promise<'running'>((r) => setTimeout(() => r('running'), seconds * 1000)),
  ])
  return ctx.withDoc((doc) => {
    const el = need(doc, nodeId)
    const run = el.run?.id === runId ? el.run : undefined
    const results = (el.results ?? []).filter((r) => r.runId === runId).map(resultSummary)
    return {
      status,
      ...(run?.progress !== undefined && status === 'running' ? { progress: run.progress } : {}),
      ...(run?.error ? { error: run.error } : {}),
      ...(run?.message && status === 'running' ? { message: run.message } : {}),
      results,
    }
  })
}

async function jpeg(img: Sharp, size = 768): Promise<ContentBlock> {
  const buf = await img
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer()
  return { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }
}

/** 服务端可用的全部能力：画布读写（前后端共用）+ 运行、媒体 */
export const serverCapabilities = new CapabilityRegistry<ServerContext>([
  ...(canvasCapabilities as never[]),
  runNode,
  waitForRun,
  cancelRun,
  viewMedia,
  editMedia,
])

/** 智能体用的 MCP 工具：全部服务端能力（MCP 无状态，CLI 握手后只拉一次列表，所以给全量） */
export function canvasTools(env: ToolEnv): McpTool[] {
  return capabilityTools(serverCapabilities, serverContext(env))
}
