import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  type CapabilityContext,
  CapabilityError,
  CapabilityRegistry,
  type ContentBlock,
  canvasCapabilities,
  readViewCapabilities,
  capabilityFor,
  content,
  editCapabilities,
  link,
  mentionElements,
  nodeElementOf,
  promptCapabilities,
  promptField,
  storyCapabilities,
  need,
  placeNew,
  resultSummary,
  runExpanded,
  shotsOf,
  summarize,
} from '@plein/capabilities'
import {
  clearShotGroup,
  currentResult,
  elementMedia,
  groupShots,
  layoutShotGroup,
  makeShotGroup,
  mediaSize,
  moveShot,
  type PleinDoc,
  setParams,
  shotGroupOf,
} from '@plein/doc'
import { type ContinuesFrom, continueShotParams, nearestAspect } from '@plein/nodes'
import { describeNode, executionOf, withDefaultModel } from '@plein/plugin-sdk'
import {
  type AgentApprovalMode,
  type EditPlan,
  ApplyEditPlan,
  MediaDeriveRequest,
  type MediaDerivation,
  MediaOp,
} from '@plein/protocol'
import sharp, { type Sharp } from 'sharp'
import { z } from 'zod'
import { collageAssets } from '../assets/collage'
import { DeriveError, deriveAsset } from '../assets/derive'
import { PromptError, rewritePrompt } from '../prompt/rewrite'
import { ffmpegBin, hasFfmpeg } from '../assets/media'
import type { AssetStore } from '../assets/store'
import { NodeRunError, type PluginHost } from '../plugins/host'
import type { EditPlans } from '../runs/edit-plan'
import type { NodeRuns } from '../runs/runs'
import type { LibraryStore } from '../library/store'
import type { Rooms } from '../sync/rooms'
import { type Approvals, approvalFor } from './approvals'
import type { AgentChanges } from './changes'
import { APPLY_EDIT, editPlanCapabilities, planBrief, PROPOSE_EDIT } from './edit-plan'
import { libraryCapabilities } from './library'
import type { AgentPlan } from './plan'
import { pluginCapabilities } from './plugin-caps'
import { capabilityTools, type McpTool, type ToolResult } from './mcp'
import type { TurnExecution } from './execution'

const exec = promisify(execFile)

/** 能力运行时绑定的画布与身份 */
export interface ToolEnv {
  /** Present only for session tools; captured once per turn, never retargeted. */
  execution?: TurnExecution
  canvasId: string
  ownerId: string
  rooms: Rooms
  runs: NodeRuns
  host: PluginHost
  assets: AssetStore
  /** 资产库（测试里可以不给） */
  library?: LibraryStore
  /** 修改方案（测试里可以不给） */
  plans?: EditPlans
  /** 文档写入的事务 origin：智能体会话用自己的 origin，改动集和撤销按它归属 */
  origin?: unknown
  /** 发起了一次运行（记进改动集，撤销这一轮时一并取消） */
  onRun?(nodeId: string, runId: string): void
  /** 发起了一次整组 / 上下游运行 */
  onGroup?(groupId: string): void
  /** 调用方给定的选区（从 ⌘K 调用时）；不给时读用户屏幕上的选区 */
  selection?: string[]
  /** 推给用户屏幕的界面动作；返回 false 表示没有人在看这块画布 */
  ui?(action: UiAction, ids: string[]): boolean
}

/** 能让用户屏幕执行的界面动作 */
export type UiAction = 'focus' | 'select'

/** 前端经 awareness 发布的界面状态（选区、视口），见 apps/web/src/canvas/CanvasView.tsx */
export interface ViewState {
  selection: string[]
  viewport: { x: number; y: number; w: number; h: number }
  at: number
}

/** 读这块画布最近活跃的那个标签页的选区和视口 */
export function viewOf(rooms: Rooms, canvasId: string): ViewState | undefined {
  let best: ViewState | undefined
  for (const st of rooms.get(canvasId).awareness.getStates().values()) {
    const v = (st as { view?: ViewState }).view
    if (v && Array.isArray(v.selection) && v.viewport && (!best || v.at > best.at)) best = v
  }
  return best
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
  const guard = env.execution?.assertOpen
  const scoped = <T extends object>(value: T): T =>
    guard
      ? new Proxy(value, {
          get(target, key) {
            const member = Reflect.get(target, key, target)
            return typeof member === 'function'
              ? (...args: unknown[]) => {
                  guard()
                  return member.apply(target, args)
                }
              : member
          },
        })
      : value
  const safeEnv = {
    ...env,
    runs: scoped(env.runs),
    host: scoped(env.host),
    assets: scoped(env.assets),
    library: env.library ? scoped(env.library) : undefined,
  }
  const info = (key: string, n: NonNullable<ReturnType<typeof host.registry.latestNode>>) => ({
    def: n.def,
    descriptor: withDefaultModel(describeNode(n.def, n.plugin), (c) => host.defaultModel(c)),
    runnable: executionOf(n.def) === 'inline' || host.registry.executors.has(key),
  })
  return {
    env: safeEnv,
    withDoc: (fn) => {
      guard?.()
      return env.rooms.withDoc(env.canvasId, fn, undefined, env.origin)
    },
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
      models: (capability) =>
        host.models(capability).map((m) => ({ ref: m.ref, title: m.title, voices: m.voices })),
      defaultModel: (capability) => host.defaultModel(capability),
      prompts: () => [...host.registry.prompts.values()].map((p) => p.def),
    },
    assetMeta: (assetId) => env.assets.get(env.ownerId, assetId) ?? undefined,
    viewport: () => viewOf(env.rooms, env.canvasId)?.viewport,
    library: env.library
      ? () => ({
          items: env.library!.list(env.ownerId),
          projectId: env.library!.projectOf(env.ownerId, env.canvasId),
        })
      : undefined,
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
    const info = `${meta.kind}，${meta.mime}${meta.width ? `，${meta.width}×${meta.height}` : ''}${meta.duration ? `，${meta.duration.toFixed(1)} 秒` : ''}；source_asset_id=${assetId}${a.element_id ? `；element_id=${a.element_id}` : ''}`
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

const continueShot = serverCapability({
  name: 'continue_shot',
  title: '取帧续镜',
  description:
    '取帧续镜：从一段视频（视频素材或视频节点的当前结果）取一帧（不给 at 时取尾帧），在右边接一个图生视频节点，那一帧连成它的首帧，并在新节点上记下父视频；父镜头是同类视频节点时沿用模型、时长、画幅。只建不跑，写好 prompt 后用 run_node 生成。和画布上的「续镜」按钮是同一套规则。',
  group: 'media',
  where: 'server',
  effect: 'edit',
  input: z.object({
    element_id: id.describe('父镜头：视频元素或已出视频的节点'),
    at: z.number().min(0).optional().describe('取帧时刻（秒），不填取尾帧'),
    prompt: z.string().max(4000).optional().describe('下一个镜头的提示词'),
    name: z.string().max(100).optional(),
  }),
  run: async (ctx, a) => {
    const src = ctx.withDoc((doc) => {
      const el = need(doc, a.element_id)
      const media = elementMedia(el)
      if (media?.kind !== 'video') throw new CapabilityError(`${a.element_id} 当前没有视频`)
      const own =
        a.at === undefined && el.kind === 'node' ? currentResult(el, 'lastFrame') : undefined
      return {
        assetId: media.assetId,
        name: el.name ?? '视频',
        nodeType: el.kind === 'node' ? el.nodeType : undefined,
        params: el.params,
        lastFrame: own?.value.type === 'image' ? own.value.assetId : undefined,
      }
    })
    const same = src.nodeType ? ctx.nodes.latest(src.nodeType) : undefined
    const info = same?.def.capability === 'video.generate' ? same : ctx.nodes.latest('plein/video')
    if (!info) throw new CapabilityError('没有能做图生视频的节点')
    const last = a.at === undefined
    let frame:
      | { id: string; name: string; width?: number; height?: number; at?: number }
      | undefined
    if (!src.lastFrame) {
      try {
        const made = await deriveAsset(ctx.env.assets, ctx.env.ownerId, {
          op: 'frame',
          assetId: src.assetId,
          at: a.at ?? 0,
          ...(last ? { last: true } : {}),
          name: `${src.name} · ${last ? '尾帧' : `${a.at}s`}`,
        })
        const out = made.assets[0]
        if (!out) throw new CapabilityError('没取到画面')
        const at = typeof made.params.at === 'number' ? made.params.at : undefined
        frame = { id: out.id, name: out.name, width: out.width, height: out.height, at }
      } catch (err) {
        if (err instanceof DeriveError) throw new CapabilityError(err.message)
        throw err
      }
    }
    const from: ContinuesFrom = {
      elementId: a.element_id,
      assetId: src.assetId,
      ...(last ? { last: true } : {}),
      ...(frame?.at !== undefined ? { at: frame.at } : a.at !== undefined ? { at: a.at } : {}),
      frameAssetId: frame?.id ?? src.lastFrame,
    }
    const { descriptor: desc } = info
    const props =
      (desc.paramsSchema as { properties?: Record<string, { enum?: unknown[] }> }).properties ?? {}
    const aspect = nearestAspect(props.aspectRatio?.enum ?? [], frame?.width, frame?.height)
    const params = continueShotParams({
      defaults: desc.defaults,
      keys: Object.keys(props),
      parent: same === info ? src.params : undefined,
      aspect: aspect !== undefined ? { key: 'aspectRatio', value: aspect } : undefined,
      from,
      prompt: a.prompt,
    })
    return ctx.withDoc((doc) => {
      need(doc, a.element_id)
      let fromId = a.element_id
      let fromPort = 'lastFrame'
      if (frame) {
        const size = mediaSize('image', frame.width, frame.height)
        fromId = placeNew(
          doc,
          { near: a.element_id },
          { kind: 'image', assetId: frame.id, name: frame.name.replace(/\.png$/, ''), ...size },
        )
        fromPort = 'image'
      }
      const nodeId = placeNew(
        doc,
        { near: fromId },
        { ...nodeElementOf(desc, params), name: a.name ?? `${src.name} · 续镜` },
      )
      link(doc, fromId, fromPort, nodeId, 'images')
      return {
        id: nodeId,
        frame_element_id: frame ? fromId : undefined,
        continues_from: from,
        element: summarize(doc, need(doc, nodeId), false),
        next: a.prompt ? '用 run_node 生成' : '先写 prompt（update_element 改参数），再 run_node',
      }
    })
  },
})

const shotGroup = serverCapability({
  name: 'shot_group',
  title: '分镜组',
  description:
    '把一个 Frame 设成分镜组：组里的图片按顺序编号（画布上显示角标），能排版、拼成大图。order 给出的元素按给定顺序排在最前；arrange 为 true 时按顺序排成 cols 列网格（只挪位置不改大小，Frame 收到刚好包住）；clear 为 true 时取消分镜组，图片都留着。返回组里镜头的顺序。和 Frame 工具条上的「分镜组」是同一套规则。',
  group: 'edit',
  where: 'server',
  effect: 'edit',
  input: z.object({
    frame_id: id.describe('Frame 元素'),
    order: z.array(id).max(64).optional().describe('想要的镜头顺序（元素 id），没列的接在后面'),
    arrange: z.boolean().default(false),
    cols: z.number().int().min(1).max(16).optional(),
    clear: z.boolean().default(false),
  }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const frame = need(doc, a.frame_id)
      if (frame.kind !== 'frame') throw new CapabilityError(`${a.frame_id} 不是 Frame`)
      if (a.clear) {
        clearShotGroup(doc, a.frame_id)
        return { frame_id: a.frame_id, shot_group: false }
      }
      if (!shotGroupOf(frame)) makeShotGroup(doc, a.frame_id, a.cols ? { cols: a.cols } : {})
      a.order?.forEach((el, i) => moveShot(doc, a.frame_id, el, i))
      const cols = a.arrange ? layoutShotGroup(doc, a.frame_id, a.cols) : undefined
      return {
        frame_id: a.frame_id,
        shot_group: true,
        cols: cols ?? shotGroupOf(doc.get(a.frame_id))?.cols,
        shots: groupShots(doc, a.frame_id).map((el, i) => ({ n: i + 1, id: el.id, name: el.name })),
      }
    }),
})

const makeCollage = serverCapability({
  name: 'make_collage',
  title: '拼成大图',
  description:
    '把分镜组（不是分镜组的 Frame 先按阅读顺序编号）里的图片按顺序拼成一张大图，放在 Frame 右边；每格大小一致（取第一张的比例），等比放进格子，numbers 为 true 时在左上角印序号。返回新图片元素和实际像素。本地加工，不调模型。',
  group: 'media',
  where: 'server',
  effect: 'edit',
  input: z.object({
    frame_id: id.describe('Frame 元素'),
    cols: z.number().int().min(1).max(16).optional().describe('列数，不填按分镜组记的列数'),
    numbers: z.boolean().default(true),
    name: z.string().max(100).optional(),
  }),
  run: async (ctx, a) => {
    const src = ctx.withDoc((doc) => {
      const frame = need(doc, a.frame_id)
      if (frame.kind !== 'frame') throw new CapabilityError(`${a.frame_id} 不是 Frame`)
      const assetIds = groupShots(doc, a.frame_id).flatMap((el) => {
        const m = elementMedia(el)
        return m?.kind === 'image' ? [m.assetId] : []
      })
      return { assetIds, name: frame.name ?? '分镜组', cols: shotGroupOf(frame)?.cols }
    })
    if (src.assetIds.length < 2) throw new CapabilityError('组里至少要两张图才能拼')
    const cols = a.cols ?? src.cols ?? Math.ceil(Math.sqrt(src.assetIds.length))
    let made
    try {
      made = await collageAssets(ctx.env.assets, ctx.env.ownerId, {
        assetIds: src.assetIds,
        cols,
        numbers: a.numbers,
        name: a.name ?? `${src.name} · 拼图`,
      })
    } catch (err) {
      if (err instanceof DeriveError) throw new CapabilityError(err.message)
      throw err
    }
    return ctx.withDoc((doc) => {
      // 画布上和分镜组一样宽
      const fw = need(doc, a.frame_id).w
      const size = { w: fw, h: Math.round((fw * made.height) / made.width) }
      const elId = placeNew(
        doc,
        { near: a.frame_id },
        {
          kind: 'image',
          assetId: made.asset.id,
          name: `${a.name ?? `${src.name} · 拼图`} ${made.width}×${made.height}`,
          ...size,
        },
      )
      return {
        id: elId,
        asset_id: made.asset.id,
        width: made.width,
        height: made.height,
        cols: made.cols,
        rows: made.rows,
      }
    })
  },
})

const runFlow = serverCapability({
  name: 'run_flow',
  title: '运行上下游',
  description:
    '从一个节点出发批量运行，和画布上的“运行到此处 / 运行下游”是同一套调度：upstream 运行它和它的全部上游（没改动的沿用旧结果），downstream 重新运行它并跟着重跑输入变了的下游。会产生费用，通常需要用户确认。立即返回 group_id，用 wait_for_group 等结果。',
  group: 'run',
  where: 'server',
  effect: 'run',
  input: z.object({
    id,
    scope: z.enum(['upstream', 'downstream']),
    force: z.boolean().default(false).describe('忽略缓存，范围内全部重新运行'),
  }),
  run: (ctx, a) => {
    const { env } = ctx
    try {
      const started = env.runs.runFlow(env.canvasId, a.id, env.ownerId, {
        scope: a.scope,
        force: a.force,
      })
      env.onGroup?.(started.groupId)
      return { group_id: started.groupId, total: started.total }
    } catch (err) {
      if (err instanceof NodeRunError) throw new CapabilityError(err.message)
      throw err
    }
  },
})

const runFrame = serverCapability({
  name: 'run_frame',
  title: '整组运行',
  description:
    '整组运行一个 Frame 里的节点（按连线顺序，没改动的沿用旧结果）。默认不含视频节点，video=true 才包括。会产生费用，需要用户确认。立即返回 group_id，用 wait_for_group 等结果。',
  group: 'run',
  where: 'server',
  effect: 'run',
  input: z.object({
    frame_id: id,
    video: z.boolean().default(false).describe('是否包含视频节点（贵且慢）'),
    force: z.boolean().default(false),
  }),
  run: (ctx, a) => {
    const { env } = ctx
    try {
      const started = env.runs.runGroup(env.canvasId, a.frame_id, env.ownerId, {
        video: a.video,
        force: a.force,
      })
      env.onGroup?.(started.groupId)
      return { group_id: started.groupId, total: started.total }
    } catch (err) {
      if (err instanceof NodeRunError) throw new CapabilityError(err.message)
      throw err
    }
  },
})

const waitForGroup = serverCapability({
  name: 'wait_for_group',
  title: '等待整组结果',
  description: `等待一次整组 / 上下游运行结束，最多 ${MAX_WAIT_S} 秒；返回各状态的节点数。`,
  group: 'run',
  where: 'server',
  effect: 'read',
  input: z.object({
    group_id: id,
    wait_seconds: z.number().min(0).max(MAX_WAIT_S).default(MAX_WAIT_S),
  }),
  run: async (ctx, { group_id, wait_seconds }) => {
    const deadline = Date.now() + wait_seconds * 1000
    for (;;) {
      const state = ctx.env.runs.groupState(group_id, ctx.env.ownerId)
      if (!state) throw new CapabilityError(`没有运行记录 ${group_id}`)
      if (state.status !== 'running' || Date.now() >= deadline) return state
      await new Promise((r) => setTimeout(r, 500))
    }
  },
})

const listStale = serverCapability({
  name: 'list_stale',
  title: '检查过期结果',
  description:
    '列出结果已经过期、需要重跑的节点：stale 是自己的参数或输入改了的，upstream 是因为上游过期跟着要重跑的。',
  group: 'run',
  where: 'server',
  effect: 'read',
  input: z.object({}),
  run: (ctx) => ctx.env.runs.staleNodes(ctx.env.canvasId, ctx.env.ownerId),
})

const getSelection = serverCapability({
  name: 'ui_get_selection',
  title: '查看选区',
  description: '读取用户现在在画布上选中的元素（用户可能在对话过程中改了选区）。',
  group: 'ui',
  where: 'client',
  effect: 'read',
  input: z.object({}),
  run: (ctx) => {
    const view = viewOf(ctx.env.rooms, ctx.env.canvasId)
    if (!view) return '用户现在没有打开这块画布'
    return ctx.withDoc((doc) => ({
      elements: view.selection.flatMap((i) => {
        const el = doc.get(i)
        return el ? [summarize(doc, el, false)] : []
      }),
    }))
  },
})

const getViewport = serverCapability({
  name: 'ui_get_viewport',
  title: '查看视口',
  description:
    '读取用户屏幕上正在看的画布区域（世界坐标）和区域内的元素，用来理解“这里”“这些”指什么。',
  group: 'ui',
  where: 'client',
  effect: 'read',
  input: z.object({ limit: z.number().int().min(1).max(100).default(40) }),
  run: (ctx, { limit }) => {
    const view = viewOf(ctx.env.rooms, ctx.env.canvasId)
    if (!view) return '用户现在没有打开这块画布'
    const v = view.viewport
    return ctx.withDoc((doc) => {
      const inside = [...doc.elements()].filter((el) => {
        const r = doc.worldRect(el.id)
        return r && r.x < v.x + v.w && r.x + r.w > v.x && r.y < v.y + v.h && r.y + r.h > v.y
      })
      return {
        viewport: [v.x, v.y, v.w, v.h].map(Math.round),
        total: inside.length,
        elements: inside.slice(0, limit).map((el) => summarize(doc, el, false)),
      }
    })
  },
})

const uiAction = (action: UiAction, title: string, description: string) =>
  serverCapability({
    name: `ui_${action}`,
    title,
    description,
    group: 'ui',
    where: 'client',
    effect: 'read',
    input: z.object({ ids: z.array(id).min(1).max(200) }),
    run: (ctx, { ids }) => {
      const known = ctx.withDoc((doc) => ids.filter((i) => doc.get(i)))
      if (!known.length) throw new CapabilityError('这些元素都不存在')
      return ctx.env.ui?.(action, known) ? '已在用户屏幕上完成' : '用户现在没有打开这块画布'
    },
  })

const focus = uiAction(
  'focus',
  '带用户看',
  '把用户的镜头平滑移动到这些元素并让它们闪一下。做完一件事后用它把用户带到结果那里。',
)
const select = uiAction('select', '选中', '在用户的画布上选中这些元素，方便用户接着操作。')

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

const rewrite = serverCapability({
  name: 'rewrite_prompt',
  title: '改写提示词',
  description:
    '用对话模型改写节点的提示词：optimize 补全画面 / 镜头细节，translate 中英互译。@ 引用和【占位】原样保留。默认直接写回节点，apply=false 时只返回结果。',
  group: 'edit',
  where: 'server',
  effect: (a) => (a.apply === false ? 'read' : 'edit'),
  input: z.object({
    id,
    mode: z.enum(['optimize', 'translate']).default('optimize'),
    apply: z.boolean().default(true),
  }),
  run: async (ctx, a) => {
    const { key, text, target, mentions } = ctx.withDoc((doc) => {
      const el = need(doc, a.id)
      const key = promptField(el.params)
      const text = key ? String(el.params?.[key] ?? '').trim() : ''
      if (!key || !text) throw new CapabilityError('这个节点没有可改写的提示词')
      const capability = el.nodeType ? ctx.nodes.latest(el.nodeType)?.def.capability : undefined
      return {
        key,
        text,
        target: capability?.startsWith('video.') ? ('video' as const) : ('image' as const),
        mentions: [...mentionElements(doc).keys()],
      }
    })
    try {
      const out = await rewritePrompt(
        ctx.env.host,
        { text, mode: a.mode, target, mentions },
        {
          ownerId: ctx.env.ownerId,
          signal: AbortSignal.any([
            AbortSignal.timeout(120_000),
            ...(ctx.env.execution ? [ctx.env.execution.abort.signal] : []),
          ]),
        },
      )
      if (a.apply) ctx.withDoc((doc) => setParams(doc, a.id, { [key]: out.text }))
      return { [key]: out.text, applied: a.apply }
    } catch (err) {
      if (err instanceof PromptError) throw new CapabilityError(err.message)
      throw err
    }
  },
})

const runStoryboard = serverCapability({
  name: 'run_storyboard',
  title: '批量运行分镜',
  description:
    '批量运行分镜展开出来的某一类节点：image（分镜图）、video（镜头视频，要等分镜图有结果）、speech（配音）。会产生费用，需要用户确认。image 作为一组运行：镜头 @ 到的角色、场景卡还没出定妆图的先出，返回 group_id，用 wait_for_group 等结果；video、speech 返回发起的运行和跳过的原因，之后用 wait_for_run 逐个等结果。',
  group: 'run',
  where: 'server',
  effect: 'run',
  input: z.object({
    id: id.describe('分镜节点'),
    role: z.enum(['image', 'video', 'speech']),
    shot_ids: z.array(z.string()).optional().describe('只跑这些镜头；不填跑全部'),
  }),
  run: (ctx, a) => {
    const { env } = ctx
    const picked: string[] = []
    const batch = ctx.withDoc((doc) => {
      const shots = shotsOf(need(doc, a.id))
      if (!shots.length) throw new CapabilityError(`${a.id} 不是分镜节点，或还没有镜头`)
      return runExpanded(doc, a.id, a.shot_ids ?? shots.map((s) => s.id), a.role, (n) =>
        picked.push(n),
      )
    })
    if (a.role === 'image' && picked.length) {
      try {
        const group = env.runs.runBatch(env.canvasId, a.id, picked, env.ownerId)
        env.onGroup?.(group.groupId)
        return {
          group_id: group.groupId,
          images: picked.length,
          portraits: group.total - picked.length,
          skipped: batch.skipped,
          reasons: batch.reasons,
        }
      } catch (err) {
        if (err instanceof NodeRunError) throw new CapabilityError(err.message)
        throw err
      }
    }
    const started: Array<{ id: string; run_id: string }> = []
    const failed: Array<{ id: string; error: string }> = []
    for (const nodeId of picked) {
      try {
        const runId = env.runs.start(env.canvasId, nodeId, env.ownerId)
        env.onRun?.(nodeId, runId)
        started.push({ id: nodeId, run_id: runId })
      } catch (err) {
        if (!(err instanceof NodeRunError)) throw err
        failed.push({ id: nodeId, error: err.message })
      }
    }
    return { started, skipped: batch.skipped, reasons: batch.reasons, failed }
  },
})

/** 服务端可用的全部能力：画布读写（前后端共用）+ 运行、媒体 */
export const serverCapabilities = new CapabilityRegistry<ServerContext>([
  ...(canvasCapabilities as never[]),
  ...(readViewCapabilities as never[]),
  ...(editCapabilities as never[]),
  ...(storyCapabilities as never[]),
  ...(promptCapabilities as never[]),
  ...libraryCapabilities,
  runStoryboard,
  ...editPlanCapabilities,
  rewrite,
  runNode,
  waitForRun,
  cancelRun,
  viewMedia,
  editMedia,
  continueShot,
  shotGroup,
  makeCollage,
  runFlow,
  runFrame,
  waitForGroup,
  listStale,
  getSelection,
  getViewport,
  focus,
  select,
])

const withPlugins = new WeakMap<PluginHost, CapabilityRegistry<ServerContext>>()

/** 自带能力 + 已加载插件贡献的能力（插件在启动时登记，之后不变，所以按宿主缓存） */
export function capabilitiesOf(host: PluginHost): CapabilityRegistry<ServerContext> {
  let reg = withPlugins.get(host)
  if (!reg) {
    reg = new CapabilityRegistry<ServerContext>([
      ...serverCapabilities.list(),
      ...pluginCapabilities(host, serverCapabilities),
    ])
    withPlugins.set(host, reg)
  }
  return reg
}

/** 智能体用的 MCP 工具：全部服务端能力（MCP 无状态，CLI 握手后只拉一次列表，所以给全量） */
export function canvasTools(env: ToolEnv): McpTool[] {
  return capabilityTools(capabilitiesOf(env.host), serverContext(env))
}

/**
 * 智能体会话用的 MCP 工具：能力 + 确认关卡 + await_approval。
 * 需要确认的调用立即返回确认单，用户在面板里允许后服务端直接执行原调用，
 * 模型用 await_approval 取结果（CLI 的工具调用有超时，不能一直挂着等用户）。
 */
export function agentTools(
  env: ToolEnv,
  opts: {
    changes: AgentChanges
    approvals: Approvals
    mode: () => AgentApprovalMode
    /** 计划模式：计划被同意前拦下改动；也提供 propose_plan / update_plan */
    plan?: AgentPlan
    /** 修改方案卡片出现或方案状态变了（id 是确认单 id） */
    onEditPlan?(approvalId: string, plan: EditPlan): void
  },
): McpTool[] {
  const ctx = serverContext(env)
  const registry = capabilitiesOf(env.host)
  const tools = capabilityTools(registry, ctx, (cap, args, run) => {
    const blocked = opts.plan?.blocked(registry.effectOf(cap, args, ctx))
    if (blocked) return { content: [{ type: 'text', text: blocked }], isError: true }
    const req = approvalFor(opts.mode(), cap, args, ctx, opts.changes)
    if (!req) return null
    const approved = async () => {
      env.execution?.assertOpen()
      return run()
    }
    const a = opts.approvals.create(cap.name, req, () =>
      env.execution ? env.execution.serialize(approved) : approved(),
    )
    return JSON.stringify({
      status: 'needs_approval',
      approval_id: a.id,
      reason: req.reason,
      next: '已请用户在面板里确认。调用 await_approval 等待：用户允许后会直接执行并返回结果，不要重复调用原工具；用户跳过就换个做法或问用户。',
    })
  })
  // 修改方案：方案本身就是确认单，用户在卡片上选范围后服务端按范围执行
  const propose = tools.find((t) => t.name === PROPOSE_EDIT)
  if (propose && env.plans) {
    const plans = env.plans
    propose.run = async (args) => {
      const brief = (await registry.invoke(PROPOSE_EDIT, ctx, args)) as { plan_id: string }
      const plan = plans.get(brief.plan_id, env.ownerId)!
      let approvalId = ''
      const a = opts.approvals.create(
        PROPOSE_EDIT,
        { reason: plan.summary, ids: plan.targets.map((t) => t.nodeId) },
        async (choice) => {
          const pick = ApplyEditPlan.catch({ scope: 'text' }).parse(choice)
          try {
            const apply = async () => {
              env.execution?.assertOpen()
              return registry.invoke(APPLY_EDIT, ctx, {
                plan_id: plan.id,
                scope: pick.scope,
                ...(pick.only ? { only: pick.only } : {}),
                ...(pick.skip ? { skip: pick.skip } : {}),
              })
            }
            const out = (await (env.execution
              ? env.execution.serialize(apply)
              : apply())) as Record<string, unknown>
            return JSON.stringify(
              {
                ...out,
                scope: pick.scope,
                ...(pick.skip?.length ? { skipped_by_user: pick.skip } : {}),
              },
              null,
              1,
            )
          } catch (err) {
            if (!(err instanceof CapabilityError)) throw err
            return { content: [{ type: 'text', text: err.message }], isError: true }
          } finally {
            const now = plans.get(plan.id, env.ownerId)
            if (now) opts.onEditPlan?.(approvalId, now)
          }
        },
      )
      approvalId = a.id
      opts.onEditPlan?.(a.id, plan)
      return JSON.stringify({
        status: 'needs_approval',
        approval_id: a.id,
        plan: planBrief(plan),
        next: '方案卡片已经给用户看了，用户会选只改文字、只出候选图或完整方案，也可能在卡片上逐项改字段、去掉某个目标或某个步骤。用一句话说明方案要点，然后调用 await_approval 等用户选择；用户批准后服务端直接按范围执行并返回最终方案（以返回里的 targets、applied 为准，revised_by_user / skipped_by_user 表示用户改过），不要再调用 apply_edit_plan。',
      })
    }
  }
  if (opts.plan) tools.push(...opts.plan.tools(opts.approvals))
  tools.push({
    name: 'await_approval',
    description: `等待用户确认一次需要确认的操作，最多 ${MAX_WAIT_S} 秒。允许后返回原操作的执行结果；还没决定时返回 pending，可以再调一次继续等。`,
    input: z.object({
      approval_id: id,
      wait_seconds: z.number().min(0).max(MAX_WAIT_S).default(MAX_WAIT_S),
    }),
    run: async (raw) => {
      const { approval_id, wait_seconds } = raw as { approval_id: string; wait_seconds: number }
      const a = await opts.approvals.wait(approval_id, wait_seconds)
      if (!a) throw new CapabilityError(`没有确认单 ${approval_id}`)
      if (a.status === 'pending') return JSON.stringify({ status: 'pending' })
      if (a.status === 'denied') return '用户跳过了这个操作，不要再重复，换个做法或问问用户'
      if (a.status === 'expired') return '确认单已经过期'
      try {
        return (await a.result) as ToolResult | string
      } catch (err) {
        if (err instanceof CapabilityError)
          return { content: [{ type: 'text', text: err.message }], isError: true }
        throw err
      }
    },
  })
  if (!env.execution) return tools
  const execution = env.execution
  return tools.map((tool) => ({
    ...tool,
    run: async (args) => {
      const invoke = () => execution.invoke(tool.name, args, async () => tool.run(args))
      const cap = registry.get(tool.name)
      return cap && registry.effectOf(cap, args, ctx) !== 'read'
        ? execution.serialize(invoke)
        : invoke()
    },
  }))
}
