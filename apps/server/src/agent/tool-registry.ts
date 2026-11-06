import {
  type CapabilityContext,
  CapabilityError,
  CapabilityRegistry,
  canvasCapabilities,
  sequenceCapabilities,
  storyStateCapabilities,
  productionCapabilities,
  reviewCapabilities,
  motionCapabilities,
  readViewCapabilities,
  capabilityFor,
  editCapabilities,
  storyCapabilities,
  promptCapabilities,
  summarize,
} from '@plein/capabilities'
import { describeNode, executionOf, withDefaultModel } from '@plein/plugin-sdk'
import { type AgentApprovalMode, type EditPlan } from '@plein/protocol'
import { z } from 'zod'
import { type PluginHost } from '../plugins/host'
import type { AssetStore } from '../assets/store'
import type { EditPlans } from '../runs/edit-plan'
import type { NodeRuns } from '../runs/runs'
import { storyboardBatchesOf, type StoryboardBatches } from '../runs/storyboard-batch'
import type { LibraryStore } from '../library/store'
import type { Rooms } from '../sync/rooms'
import type { CheckpointService } from '../checkpoints/service'
import type { MediaIndex } from '../media-index/service'
import { type Approvals, approvalFor, type ApprovalRequest } from './approvals'
import type { AgentChanges } from './changes'
import { editPlanCapabilities } from './edit-plan'
import { libraryCapabilities } from './library'
import type { AgentPlan } from './plan'
import { pluginCapabilities } from './plugin-caps'
import { capabilityTools, type McpTool, type ToolResult } from './mcp'
import type { TurnExecution } from './execution'
import { analysisCapabilities } from './analysis-caps'
import { templateCapabilities } from './template-caps'
import { captureStage } from './client-render'
import { actionCapabilities } from './action-caps'
import { workspaceCapabilities } from './workspace-caps'
import { modelCapabilities } from './model-caps'
import { projectCapabilities } from './project-caps'
import { impactCapabilities } from './impact-caps'
import { estimateCost } from './estimate-caps'
import { editMedia, continueShot, makeCollage, rewrite, shotGroup, viewMedia } from './tools-media'
import {
  cancelRun,
  inspectNodeInput,
  listStale,
  MAX_WAIT_S,
  runFlow,
  runFrame,
  runNode,
  runStoryboard,
  waitForGroup,
  waitForRun,
} from './tools-runs'

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
  canvasApi?: (ownerId: string, request: Request) => Promise<Response>
  mediaIndex?: MediaIndex
  checkpoints?: CheckpointService
  library?: LibraryStore
  /** 修改方案（测试里可以不给） */
  plans?: EditPlans
  /** 文档写入的事务 origin：智能体会话用自己的 origin，改动集和撤销按它归属 */
  origin?: unknown
  /** 发起了一次运行（记进改动集，撤销这一轮时一并取消） */
  onRun?(nodeId: string, runId: string): void
  /** 发起了一次整组 / 上下游运行 */
  onGroup?(groupId: string): void
  /** 本轮发送或命令调用时附带的选区快照；未附带时为空，不回退实时选区。 */
  selection?: readonly string[]
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

export interface ServerContext extends CapabilityContext {
  env: ToolEnv
  storyboardBatches: StoryboardBatches
}

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
    selection: Object.freeze([...new Set(env.selection ?? [])]),
    runs: scoped(env.runs),
    host: scoped(env.host),
    assets: scoped(env.assets),
    library: env.library ? scoped(env.library) : undefined,
    mediaIndex: env.mediaIndex ? scoped(env.mediaIndex) : undefined,
    checkpoints: env.checkpoints ? scoped(env.checkpoints) : undefined,
  }
  const info = (key: string, n: NonNullable<ReturnType<typeof host.registry.latestNode>>) => ({
    def: n.def,
    descriptor: withDefaultModel(
      describeNode(n.def, n.plugin),
      (c) => host.defaultModel(c),
      (cap, ref) => host.models(cap).find((m) => m.ref === ref)?.limits,
    ),
    runnable: executionOf(n.def) === 'inline' || host.registry.executors.has(key),
  })
  return {
    canvasId: env.canvasId,
    env: safeEnv,
    storyboardBatches: scoped(storyboardBatchesOf(env.runs)),
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

const getSelection = serverCapability({
  name: 'ui_get_selection',
  title: '查看选区',
  description:
    '读取本轮发送时附带的选区快照。用户后来在画布上换选区不会改变这些目标；未附带选区时返回空。',
  group: 'ui',
  where: 'client',
  effect: 'read',
  input: z.object({
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const ids = ctx.env.selection ?? []
      const elements = []
      const missing: string[] = []
      let next = a.offset
      for (const i of ids.slice(a.offset, a.offset + a.limit)) {
        const el = doc.get(i)
        const item = el
          ? { id: i, kind: el.kind, name: el.name?.slice(0, 100), type: el.nodeType?.slice(0, 100) }
          : undefined
        if (
          Buffer.byteLength(
            JSON.stringify({ elements: [...elements, item], missing: [...missing, i] }),
          ) >
          20 * 1024
        )
          break
        if (item) elements.push(item)
        else missing.push(i)
        next++
      }
      return {
        source: 'request',
        total: ids.length,
        elements,
        missing,
        complete: next >= ids.length,
        ...(next < ids.length ? { next_offset: next } : {}),
      }
    }),
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

const listCanvasCapabilities = serverCapability({
  name: 'list_canvas_capabilities',
  title: '查询画布能力契约',
  description:
    '查询实时能力目录（含插件）。不填 name 返回名称、用途、分组与运行位置；指定 name 返回完整输入 JSON Schema。先查契约再操作，不猜参数；节点的嵌套参数用 list_node_types 指定 type 查询。',
  group: 'read',
  where: 'server',
  effect: 'read',
  input: z.object({ name: id.optional() }),
  run: (ctx, a) => {
    const registry = capabilitiesOf(ctx.env.host)
    if (a.name) {
      const cap = registry.get(a.name)
      if (!cap) throw new CapabilityError(`没有能力 ${a.name}`)
      return {
        name: cap.name,
        description: cap.description,
        where: cap.where,
        input_schema: z.toJSONSchema(cap.input),
      }
    }
    return registry
      .list()
      .map((cap) => ({ name: cap.name, title: cap.title, group: cap.group, where: cap.where }))
  },
})

export const serverCapabilities = new CapabilityRegistry<ServerContext>([
  listCanvasCapabilities,
  ...(canvasCapabilities as never[]),
  ...(sequenceCapabilities as never[]),
  ...(storyStateCapabilities as never[]),
  ...(productionCapabilities as never[]),
  ...(reviewCapabilities as never[]),
  ...(motionCapabilities as never[]),
  ...(readViewCapabilities as never[]),
  ...(editCapabilities as never[]),
  ...(storyCapabilities as never[]),
  ...(promptCapabilities as never[]),
  ...libraryCapabilities,
  ...workspaceCapabilities,
  ...actionCapabilities,
  ...modelCapabilities,
  ...projectCapabilities,
  ...impactCapabilities,
  estimateCost,
  captureStage,
  ...templateCapabilities,
  ...analysisCapabilities,
  runStoryboard,
  ...editPlanCapabilities,
  rewrite,
  inspectNodeInput,
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
  const tools = capabilityTools(registry, ctx, async (cap, args, run) => {
    const blocked = opts.plan?.blocked(registry.effectOf(cap, args, ctx))
    if (blocked) return { content: [{ type: 'text', text: blocked }], isError: true }
    // 声明了 prepare 的能力先走自己的执行前流程（批次计划、输入预检、方案确认）
    const prepared = cap.prepare
      ? await cap.prepare(args, ctx, {
          onEditPlan: (approvalId, plan) => opts.onEditPlan?.(approvalId, plan as EditPlan),
        })
      : null
    if (prepared?.answer !== undefined) return prepared.answer
    let approvalId: string | undefined
    const resume = prepared?.run
    const approved = async (choice?: unknown) => {
      env.execution?.assertOpen()
      return resume ? resume(choice, approvalId) : run()
    }
    // 声明自带 reason 的（方案卡片）不经审批模式直接建单；其余按审批策略分派
    const declared = prepared?.request?.reason
    const req =
      declared !== undefined
        ? { reason: declared, ids: prepared!.request!.ids ?? [] }
        : approvalFor(opts.mode(), cap, args, ctx, opts.changes)
    if (!req) return resume ? await approved() : null
    // 无需确认的直接执行沿用外层工具调用的串行化（不再排队）；
    // 用户批准后的异步恢复入口才进回合队列：带 serialize 标志的声明由这里 serialize，
    // 不带的（方案卡片自己串行化内部调用）由声明自己负责；未声明 prepare 的照旧串行化原调用。
    const resumeSerialized = prepared?.serialize === true
    const approval = opts.approvals.create(
      cap.name,
      {
        ...req,
        ...(prepared?.request?.storyboardBatch !== undefined
          ? {
              storyboardBatch: prepared.request
                .storyboardBatch as ApprovalRequest['storyboardBatch'],
            }
          : {}),
      },
      resume
        ? (choice) =>
            resumeSerialized && env.execution
              ? env.execution.serialize(() => resume(choice, approvalId))
              : resume(choice, approvalId)
        : (choice) =>
            env.execution ? env.execution.serialize(() => approved(choice)) : approved(choice),
    )
    approvalId = approval.id
    if (prepared?.card !== undefined) opts.onEditPlan?.(approval.id, prepared.card as EditPlan)
    return JSON.stringify({
      status: 'needs_approval',
      approval_id: approval.id,
      // 方案卡片的 reason 就是方案摘要，已在 plan 里，不再重复一个字段
      ...(declared !== undefined ? {} : { reason: req.reason }),
      ...prepared?.detail,
      next:
        prepared?.next ??
        '已请用户在面板里确认。调用 await_approval 等待：用户允许后会直接执行并返回结果，不要重复调用原工具；用户跳过就换个做法或问用户。',
    })
  })
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
