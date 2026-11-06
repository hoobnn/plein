import {
  adoptResult,
  deleteElements,
  mediaSize,
  removalChangesCurrent,
  removeEdges,
  removeResults,
  setParams,
  setParent,
  setText,
  updateElement,
} from '@plein/doc'
import { z } from 'zod'
import { modelParamOf } from '@plein/plugin-sdk'
import { CapabilityError, defineCapability } from './define'
import { renameElement } from './rename'
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
    '列出可以创建的节点类型：用途、输入输出端口、参数 JSON Schema 与默认值，以及当前已启用、可选的模型（model 参数填 ref；不填时用 defaults 里的默认模型，没有默认模型就必须填）。',
  group: 'read',
  where: 'doc',
  effect: 'read',
  input: z.object({
    type: z
      .string()
      .optional()
      .describe('指定节点类型时返回完整参数 schema（含必填项、嵌套字段和约束）；不填列出全部类型'),
  }),
  run: (ctx, a) =>
    ctx.nodes
      .all()
      .filter((n) => !a.type || n.descriptor.type === a.type)
      .map(({ descriptor: d, runnable }) => ({
        type: d.type,
        title: d.title,
        description: d.description,
        runnable,
        inputs: d.inputs,
        outputs: d.outputs,
        params: (d.paramsSchema as { properties?: unknown }).properties,
        ...(a.type ? { params_schema: d.paramsSchema } : {}),
        version: d.version,
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
    const params = { ...desc.defaults, ...a.params }
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
    '修改元素：节点参数（按键合并，只改给出的键）、名称、Markdown 正文、位置尺寸、所属 Frame。改提示词后需要 run_node 才会出新结果。' +
    '换模型不要在 params 里直接写 model：用 set_node_model，它会像界面一样同步校正画幅、分辨率、时长、种子等参数。' +
    '改名会同步所有 @ 引用（与 rename_element 相同），返回里的 renamed 列出被改写的引用数和受影响元素；清空名称（传空字符串）不做同步。',
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
    rotation: z.number().finite().optional(),
    locked: z.boolean().optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
    asset_id: id.optional().describe('替换媒体元素的素材，必须与元素类型相同'),
  }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const el = need(doc, a.id)
      const warnings: string[] = []
      if (a.asset_id !== undefined) {
        const meta = ctx.assetMeta(a.asset_id)
        if (!meta || meta.kind !== el.kind || !['image', 'video', 'audio'].includes(el.kind))
          throw new CapabilityError('需要与媒体元素类型相同的有效资产')
        if (el.videoSegment)
          throw new CapabilityError('固定视频素材不可替换，请用 replace_sequence_segment')
      }
      if (a.text !== undefined && el.kind !== 'markdown')
        throw new CapabilityError('只有 markdown 元素有正文')
      if (a.parent_id && need(doc, a.parent_id).kind !== 'frame')
        throw new CapabilityError('parent_id 必须是 Frame')
      if (a.params) {
        if (el.kind !== 'node') throw new CapabilityError('只有节点有参数')
        const def = el.nodeType ? ctx.nodes.latest(el.nodeType)?.def : undefined
        if (def) {
          const check = def.params.safeParse({ ...el.params, ...a.params })
          if (!check.success) throw new CapabilityError(`参数不对：${z.prettifyError(check.error)}`)
        }
        // 直接写模型不会校正依赖它的参数（画幅、分辨率、时长、种子……），提示改用 set_node_model
        const modelKey = el.nodeType
          ? modelParamOf(ctx.nodes.latest(el.nodeType)?.descriptor ?? { paramsSchema: {} })
          : undefined
        if (modelKey && modelKey in a.params && a.params[modelKey] !== el.params?.[modelKey])
          warnings.push(
            `已直接写入 params.${modelKey}，没有校正与模型相关的参数（画幅、分辨率、时长、种子等），运行前可能被模型拒绝。换模型请用 set_node_model。`,
          )
        setParams(doc, a.id, a.params)
      }
      if (a.text !== undefined) {
        if (el.kind !== 'markdown') throw new CapabilityError('只有 markdown 元素有正文')
        setText(doc, a.id, a.text)
      }
      if (a.parent_id !== undefined) setParent(doc, [a.id], a.parent_id)
      // 改名走与界面相同的 renameElement：同步 @ 引用与绑定；清空名称不属于改名
      let renamed: ReturnType<typeof renameElement> | undefined
      if (a.name?.trim()) {
        try {
          renamed = renameElement(doc, a.id, a.name)
        } catch (err) {
          throw new CapabilityError(err instanceof Error ? err.message : String(err))
        }
      }
      const cur = need(doc, a.id)
      const world = doc.worldRect(a.id)!
      updateElement(doc, a.id, {
        ...(a.rotation !== undefined ? { rotation: a.rotation } : {}),
        ...(a.locked !== undefined ? { locked: a.locked } : {}),
        ...(a.color !== undefined ? { color: a.color ?? undefined } : {}),
        ...(a.asset_id !== undefined ? { assetId: a.asset_id } : {}),
        ...(a.name !== undefined && !a.name.trim() ? { name: a.name } : {}),
        ...(a.x !== undefined ? { x: Math.round(cur.x + a.x - world.x) } : {}),
        ...(a.y !== undefined ? { y: Math.round(cur.y + a.y - world.y) } : {}),
        ...(a.w !== undefined ? { w: Math.round(a.w) } : {}),
        ...(a.h !== undefined ? { h: Math.round(a.h) } : {}),
      })
      return {
        ...summarize(doc, need(doc, a.id), false),
        ...(renamed ? { renamed: { references: renamed.references, elements: renamed.ids } } : {}),
        ...(warnings.length ? { warnings } : {}),
      }
    }),
})

export const renameElementCap = defineCapability({
  name: 'rename_element',
  title: '重命名元素',
  description:
    '给元素改名，并同步所有引用它的 @名称（提示词、节点文本、分镜角色与对白、参考绑定），与界面重命名相同；已固化的历史输入和来源记录不改。名称 1–200 字，不能含换行或 @。' +
    '返回 references（改写的引用数）和 elements（受影响的其他元素 id）。同名元素会按序号消歧（@名称#2），改名后可能让别处的引用变成 #n。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z.object({ id: id.describe('要改名的元素'), name: z.string().min(1).max(200) }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      need(doc, a.id)
      try {
        const out = renameElement(doc, a.id, a.name)
        return { id: a.id, name: a.name.trim(), references: out.references, elements: out.ids }
      } catch (err) {
        throw new CapabilityError(err instanceof Error ? err.message : String(err))
      }
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
  // 删本轮自己建的不问；删用户已有的要问，范围写进确认（always 模式下同样不问自建的）
  approval: (a, _ctx, { changes }) => {
    const ids = a.ids.filter((i) => !changes.createdThisTurn(i))
    // 删本轮自建的东西任何模式都不问（显式豁免，仅此能力使用）
    if (!ids.length) return { exempt: '本轮新建' }
    return { reason: `删除你已有的 ${ids.length} 个元素`, ids }
  },
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
  input: z.object({ id, result_id: id.nullable().describe('null 恢复默认采用规则（最新候选）') }),
  run: (ctx, { id, result_id }) =>
    ctx.withDoc((doc) => {
      const el = need(doc, id)
      if (result_id !== null && !el.results?.some((r) => r.id === result_id))
        throw new CapabilityError(`节点没有结果 ${result_id}`)
      adoptResult(doc, id, result_id)
      return '已采用'
    }),
})

export const deleteResults = defineCapability({
  name: 'delete_results',
  title: '删除历史结果',
  description:
    '删除节点生成历史里的候选结果记录（与历史面板的删除一致）。只删画布里的记录，不删素材文件；删到节点当前采用的结果时，节点回到「尚未采用」，不会自动换成别的候选。可在本轮撤销。先用 get_element 看 results 里的 id；返回 removed 个数、current_changed（是否改变了节点当前输出）和没找到的 id。',
  group: 'edit',
  where: 'doc',
  effect: 'destructive',
  approval: () => ({ reason: '删除生成历史里的结果记录', ids: [] }),
  input: z.object({
    id,
    result_ids: z.array(id).min(1).max(200).describe('要删除的结果 id，来自节点的 results'),
  }),
  run: (ctx, { id, result_ids }) =>
    ctx.withDoc((doc) => {
      const el = need(doc, id)
      const have = new Set((el.results ?? []).map((r) => r.id))
      const missing = result_ids.filter((r) => !have.has(r))
      const present = new Set(result_ids.filter((r) => have.has(r)))
      if (!present.size)
        throw new CapabilityError(
          `节点 ${id} 没有这些结果：${missing.join('、')}，先用 get_element 查看 results`,
        )
      const currentChanged = removalChangesCurrent(el, present)
      const removed = removeResults(
        doc,
        [...present].map((resultId) => ({ elementId: id, resultId })),
      )
      return {
        removed,
        current_changed: currentChanged,
        ...(missing.length ? { not_found: missing } : {}),
      }
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
  renameElementCap,
  connectCap,
  disconnect,
  deleteElementsCap,
  adopt,
  deleteResults,
]
