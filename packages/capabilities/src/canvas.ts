import {
  adoptResult,
  deleteElements,
  mediaSize,
  removeEdges,
  setParams,
  setParent,
  setText,
  updateElement,
} from '@plein/doc'
import { z } from 'zod'
import { CapabilityError, defineCapability } from './define'
import { link, need, placeNew } from './place'
import { nodeElementOf } from './story/nodes'
import { summarize } from './summary'

/** 画布读写能力：只依赖文档和节点目录，前后端共用 */

const id = z.string().min(1).max(200)
const position = {
  near: id.optional().describe('放在这个元素右侧的空位；不填且没给 x/y 时放在画布内容右侧'),
  x: z.number().optional().describe('世界坐标 x（左上角），与 near 二选一'),
  y: z.number().optional(),
  parent_id: id.optional().describe('放进这个 Frame（分组）里'),
}

export const getCanvas = defineCapability({
  name: 'get_canvas',
  title: '查看画布',
  description:
    '读取当前画布：所有元素（id、类型、名称、位置、节点参数、运行状态、当前结果）和连线。开始工作前先调用它。',
  group: 'read',
  where: 'doc',
  effect: 'read',
  input: z.object({ frame_id: id.optional().describe('只看这个 Frame 里的内容') }),
  run: (ctx, { frame_id }) =>
    ctx.withDoc((doc) => {
      const els = frame_id
        ? [need(doc, frame_id), ...doc.descendants(frame_id)]
        : [...doc.elements()]
      const ids = new Set(els.map((e) => e.id))
      const edges = [...doc.edges()]
        .filter((e) => ids.has(e.from[0]) || ids.has(e.to[0]))
        .map((e) => `${e.id}: ${e.from[0]}.${e.from[1]} → ${e.to[0]}.${e.to[1]}`)
      return { elements: els.map((el) => summarize(doc, el, false)), edges }
    }),
})

export const getElement = defineCapability({
  name: 'get_element',
  title: '查看元素',
  description: '读取一个元素的完整信息：全部参数、Markdown 正文、所有历史结果（含结果 id）。',
  group: 'read',
  where: 'doc',
  effect: 'read',
  input: z.object({ id }),
  run: (ctx, { id }) => ctx.withDoc((doc) => summarize(doc, need(doc, id), true)),
})

export const findElements = defineCapability({
  name: 'find_elements',
  title: '查找元素',
  description:
    '按名称、正文、提示词关键字或类型查找元素，返回精简摘要。画布很大时用它代替 get_canvas。',
  group: 'read',
  where: 'doc',
  effect: 'read',
  input: z.object({
    query: z.string().max(200).optional().describe('关键字，匹配名称、Markdown 正文和文本参数'),
    kind: z.string().optional().describe('元素类型：node、image、video、audio、markdown、frame'),
    node_type: z.string().optional().describe('节点类型，如 plein/image'),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const q = a.query?.trim().toLowerCase()
      const text = (v: unknown) => typeof v === 'string' && v.toLowerCase().includes(q!)
      const hits = [...doc.elements()].filter((el) => {
        if (a.kind && el.kind !== a.kind) return false
        if (a.node_type && el.nodeType !== a.node_type) return false
        if (!q) return true
        return text(el.name) || text(el.text) || Object.values(el.params ?? {}).some(text)
      })
      return {
        total: hits.length,
        elements: hits.slice(0, a.limit).map((el) => summarize(doc, el, false)),
      }
    }),
})

export const listNodeTypes = defineCapability({
  name: 'list_node_types',
  title: '查看可用节点',
  description:
    '列出可以创建的节点类型：用途、输入输出端口、参数 JSON Schema 与默认值，以及当前已启用、可选的模型（model 参数填 ref；留空则自动选择）。',
  group: 'read',
  where: 'doc',
  effect: 'read',
  input: z.object({}),
  run: (ctx) =>
    ctx.nodes.all().map(({ descriptor: d, runnable }) => ({
      type: d.type,
      title: d.title,
      description: d.description,
      runnable,
      inputs: d.inputs,
      outputs: d.outputs,
      params: (d.paramsSchema as { properties?: unknown }).properties,
      defaults: d.defaults,
      models: d.capability ? ctx.nodes.models(d.capability) : undefined,
    })),
})

export const createNode = defineCapability({
  name: 'create_node',
  title: '新建节点',
  description:
    '新建一个工作流节点（如 plein/image、plein/video、plein/speech、plein/sequence）。可同时把上游元素连到它的输入端口。只建不跑，运行用 run_node。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z.object({
    type: z.string().describe('节点类型，见 list_node_types'),
    params: z.record(z.string(), z.unknown()).optional().describe('参数，未给的取默认值'),
    name: z.string().max(100).optional().describe('卡片标题，便于在提示词里 @ 引用'),
    inputs: z
      .array(
        z.object({
          from: id.describe('上游元素 id'),
          from_port: z.string().optional().describe('上游输出端口，不填自动选择'),
          to_port: z.string().optional().describe('本节点输入端口，不填按类型自动选择'),
        }),
      )
      .optional(),
    ...position,
  }),
  run: (ctx, a) => {
    const info = ctx.nodes.latest(a.type)
    if (!info) throw new CapabilityError(`没有节点类型 ${a.type}，先用 list_node_types 查看`)
    const { def, descriptor: desc } = info
    const params = { ...desc.defaults, ...(a.params ?? {}) }
    const check = def.params.safeParse(params)
    if (!check.success) throw new CapabilityError(`参数不对：${z.prettifyError(check.error)}`)
    return ctx.withDoc((doc) => {
      const elId = placeNew(
        doc,
        a,
        { ...nodeElementOf(desc, params), name: a.name ?? def.title },
        ctx.viewport?.(),
      )
      const edges = (a.inputs ?? []).map((i) => link(doc, i.from, i.from_port, elId, i.to_port))
      return { id: elId, element: summarize(doc, need(doc, elId), false), edges }
    })
  },
})

export const createElement = defineCapability({
  name: 'create_element',
  title: '新建元素',
  description:
    '新建非节点元素：markdown（文字笔记 / 剧本）、frame（分组框）、image / video / audio（用已有资产 id 摆到画布上，例如把某个结果单独放出来）。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z.object({
    kind: z.enum(['markdown', 'frame', 'image', 'video', 'audio']),
    text: z.string().optional().describe('markdown 正文'),
    asset_id: z.string().optional().describe('image / video / audio 的资产 id'),
    name: z.string().max(100).optional(),
    w: z.number().positive().optional(),
    h: z.number().positive().optional(),
    ...position,
  }),
  run: (ctx, a) => {
    let size = { w: a.w ?? 320, h: a.h ?? 200 }
    if (a.kind === 'frame') size = { w: a.w ?? 800, h: a.h ?? 600 }
    if (a.kind === 'image' || a.kind === 'video' || a.kind === 'audio') {
      if (!a.asset_id) throw new CapabilityError(`${a.kind} 元素需要 asset_id`)
      const meta = ctx.assetMeta(a.asset_id)
      if (!meta) throw new CapabilityError(`资产 ${a.asset_id} 不存在`)
      if (meta.kind !== a.kind) throw new CapabilityError(`资产是 ${meta.kind}，不是 ${a.kind}`)
      size = a.w && a.h ? { w: a.w, h: a.h } : mediaSize(a.kind, meta.width, meta.height)
    }
    return ctx.withDoc((doc) => {
      const elId = placeNew(
        doc,
        a,
        {
          kind: a.kind,
          name: a.name,
          text: a.kind === 'markdown' ? (a.text ?? '') : undefined,
          assetId: a.asset_id,
          ...size,
        },
        ctx.viewport?.(),
      )
      return { id: elId, element: summarize(doc, need(doc, elId), false) }
    })
  },
})

export const updateElementCap = defineCapability({
  name: 'update_element',
  title: '修改元素',
  description:
    '修改元素：节点参数（按键合并，只改给出的键）、名称、Markdown 正文、位置尺寸、所属 Frame。改提示词后需要 run_node 才会出新结果。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z.object({
    id,
    params: z.record(z.string(), z.unknown()).optional(),
    name: z.string().max(100).optional(),
    text: z.string().optional().describe('替换 Markdown 正文'),
    x: z.number().optional().describe('世界坐标'),
    y: z.number().optional(),
    w: z.number().positive().optional(),
    h: z.number().positive().optional(),
    parent_id: id.nullable().optional().describe('移入 Frame；null 移出到画布根'),
  }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const el = need(doc, a.id)
      if (a.params) {
        if (el.kind !== 'node') throw new CapabilityError('只有节点有参数')
        const def = el.nodeType ? ctx.nodes.latest(el.nodeType)?.def : undefined
        if (def) {
          const check = def.params.safeParse({ ...el.params, ...a.params })
          if (!check.success) throw new CapabilityError(`参数不对：${z.prettifyError(check.error)}`)
        }
        setParams(doc, a.id, a.params)
      }
      if (a.text !== undefined) {
        if (el.kind !== 'markdown') throw new CapabilityError('只有 markdown 元素有正文')
        setText(doc, a.id, a.text)
      }
      if (a.parent_id !== undefined) setParent(doc, [a.id], a.parent_id)
      const cur = need(doc, a.id)
      const world = doc.worldRect(a.id)!
      updateElement(doc, a.id, {
        ...(a.name !== undefined ? { name: a.name } : {}),
        ...(a.x !== undefined ? { x: Math.round(cur.x + a.x - world.x) } : {}),
        ...(a.y !== undefined ? { y: Math.round(cur.y + a.y - world.y) } : {}),
        ...(a.w !== undefined ? { w: Math.round(a.w) } : {}),
        ...(a.h !== undefined ? { h: Math.round(a.h) } : {}),
      })
      return summarize(doc, need(doc, a.id), false)
    }),
})

export const connectCap = defineCapability({
  name: 'connect',
  title: '连线',
  description:
    '把上游元素的输出连到节点的输入端口。端口不填时按类型自动匹配；单输入端口会替换已有连线。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z.object({
    from: id,
    from_port: z.string().optional(),
    to: id,
    to_port: z.string().optional(),
  }),
  run: (ctx, a) => ctx.withDoc((doc) => link(doc, a.from, a.from_port, a.to, a.to_port)),
})

export const disconnect = defineCapability({
  name: 'disconnect',
  title: '断开连线',
  description: '删除连线（连线 id 见 get_canvas 的 edges）。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z.object({ edge_ids: z.array(id).min(1) }),
  run: (ctx, { edge_ids }) =>
    ctx.withDoc((doc) => {
      removeEdges(doc, edge_ids)
      return '已删除'
    }),
})

export const deleteElementsCap = defineCapability({
  name: 'delete_elements',
  title: '删除',
  description: '删除元素（连同相关连线；删除 Frame 会删掉里面的内容）。只删用户要求删的东西。',
  group: 'edit',
  where: 'doc',
  effect: 'destructive',
  input: z.object({ ids: z.array(id).min(1) }),
  run: (ctx, { ids }) =>
    ctx.withDoc((doc) => {
      for (const i of ids) need(doc, i)
      deleteElements(doc, ids)
      return `已删除 ${ids.length} 个元素`
    }),
})

export const adopt = defineCapability({
  name: 'adopt_result',
  title: '采用结果',
  description: '把节点的某个历史结果设为当前采用的结果（卡片显示它，下游读取它）。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z.object({ id, result_id: id }),
  run: (ctx, { id, result_id }) =>
    ctx.withDoc((doc) => {
      const el = need(doc, id)
      if (!el.results?.some((r) => r.id === result_id))
        throw new CapabilityError(`节点没有结果 ${result_id}`)
      adoptResult(doc, id, result_id)
      return '已采用'
    }),
})

/** 画布读写的全部能力，顺序即工具列表顺序 */
export const canvasCapabilities = [
  getCanvas,
  getElement,
  findElements,
  listNodeTypes,
  createNode,
  createElement,
  updateElementCap,
  connectCap,
  disconnect,
  deleteElementsCap,
  adopt,
]
