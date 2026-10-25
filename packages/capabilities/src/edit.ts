import {
  arrangeElements,
  bringToFront,
  elementPorts,
  groupElements,
  inputEdges,
  portsCompatible,
  reorderInputs,
  replaceInput,
  sendToBack,
  topLevel,
  ungroupElements,
} from '@plein/doc'
import { z } from 'zod'
import { CapabilityError, defineCapability } from './define'
import { need } from './place'
import { referenceClipboard } from './clipboard'

/** 整理类编辑：复制、打组、解组、整理布局、层级。与右键菜单、快捷键是同一套命令 */

const id = z.string().min(1).max(200)
const ids = z.array(id).min(1).max(500)

const some = (sel: string[]) => (sel.length ? { ids: sel } : null)

export const duplicate = defineCapability({
  name: 'duplicate_elements',
  title: '复制一份',
  description: '原地复制元素（连同它们之间的连线），放在右下方一点。返回新元素的 id。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z.object({
    ids,
    dx: z.number().default(24).describe('相对原位置的偏移'),
    dy: z.number().default(24),
  }),
  palette: { fromSelection: some, shortcut: 'mod+d' },
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      for (const i of a.ids) need(doc, i)
      return {
        ids: referenceClipboard.paste(doc, referenceClipboard.copy(doc, a.ids), {
          canvasId: ctx.canvasId,
          dx: a.dx,
          dy: a.dy,
        }),
      }
    }),
})

export const group = defineCapability({
  name: 'group_elements',
  title: '打组',
  description: '用一个 Frame 包住这些元素（可命名，如“第一场”）。返回 Frame id。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z.object({ ids, name: z.string().max(100).optional() }),
  palette: { fromSelection: some, shortcut: 'mod+g' },
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      for (const i of a.ids) need(doc, i)
      const frame = groupElements(doc, a.ids, { name: a.name })
      if (!frame) throw new CapabilityError('没有可以打组的元素')
      return { frame_id: frame }
    }),
})

export const ungroup = defineCapability({
  name: 'ungroup',
  title: '解组',
  description: '去掉 Frame、保留里面的元素（位置不变）。返回原来里面的元素 id。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z.object({ frame_id: id }),
  palette: {
    fromSelection: (sel, doc) =>
      sel.length === 1 && doc.get(sel[0]!)?.kind === 'frame' ? { frame_id: sel[0]! } : null,
    shortcut: 'mod+shift+g',
  },
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      if (need(doc, a.frame_id).kind !== 'frame')
        throw new CapabilityError(`${a.frame_id} 不是 Frame`)
      return { ids: ungroupElements(doc, a.frame_id) }
    }),
})

export const arrange = defineCapability({
  name: 'arrange_elements',
  title: '整理布局',
  description:
    '按连线自动排版：上游在左、下游在右，同层纵向排开，Frame 内的元素在 Frame 内整理。不给 ids 时整理整个画布。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z.object({ ids: ids.optional() }),
  palette: {
    fromSelection: (sel) => (sel.length > 1 ? { ids: sel } : {}),
    shortcut: 'alt+shift+f',
  },
  run: (ctx, a) => ctx.withDoc((doc) => ({ moved: arrangeElements(doc, a.ids) })),
})

export const reorder = defineCapability({
  name: 'reorder_elements',
  title: '调整层级',
  description: '把元素置于同级的最上层（front）或最下层（back）。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z.object({ ids, to: z.enum(['front', 'back']) }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const tops = topLevel(doc, a.ids)
      if (a.to === 'front') bringToFront(doc, tops)
      else sendToBack(doc, tops)
      return '已调整'
    }),
})

export const reorderInput = defineCapability({
  name: 'reorder_inputs',
  title: '调整参考顺序',
  description:
    '按连线 id 调整同一多输入端口的参考顺序（例如视频首帧、尾帧）。edge_ids 必须完整列出该端口现有的全部连线，不能缺项、重复或混入其他端口；保留连线 id 和素材。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z.object({
    id: id.describe('目标节点 id'),
    port: id.describe('目标输入端口 id，例如 images'),
    edge_ids: z.array(id).min(1).max(500).describe('这个端口全部连线 id，按希望送入的顺序排列'),
  }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const port = elementPorts(need(doc, a.id))?.inputs.find((p) => p.id === a.port)
      if (!port) throw new CapabilityError(`${a.id} 没有输入端口 ${a.port}`)
      if (!port.multiple) throw new CapabilityError(`${a.id}.${a.port} 不是多输入端口`)
      const edges = inputEdges(doc, a.id, a.port)
      const known = new Set(edges.map((e) => e.id))
      if (
        a.edge_ids.length !== edges.length ||
        new Set(a.edge_ids).size !== a.edge_ids.length ||
        a.edge_ids.some((edge) => !known.has(edge))
      )
        throw new CapabilityError('edge_ids 必须完整且不重复地列出这个输入端口的全部连线')
      const changed = reorderInputs(doc, [a.id, a.port], a.edge_ids)
      return { id: a.id, port: a.port, edge_ids: a.edge_ids, changed }
    }),
})

export const replaceInputCap = defineCapability({
  name: 'replace_input',
  title: '替换参考槽位',
  description:
    '替换一条输入连线的来源，保留这条连线的 id、目标端口和顺序。适合只换视频首帧或某张参考图；不会删除旧素材。先读取连线，再给 edge_id、from 和 from_port。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z.object({
    edge_id: id,
    from: id.describe('新来源元素 id'),
    from_port: id.describe('新来源的输出端口 id，例如 image'),
  }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const edge = doc.getEdge(a.edge_id)
      if (!edge) throw new CapabilityError(`没有连线 ${a.edge_id}`)
      const source = elementPorts(need(doc, a.from))?.outputs.find((p) => p.id === a.from_port)
      if (!source) throw new CapabilityError(`${a.from} 没有输出端口 ${a.from_port}`)
      const target = elementPorts(need(doc, edge.to[0]))?.inputs.find((p) => p.id === edge.to[1])
      if (!target || !portsCompatible(source.type, target.type))
        throw new CapabilityError('新来源与目标输入端口类型不兼容')
      if (a.from === edge.to[0]) throw new CapabilityError('不能把节点连接到自身')
      if (edge.from[0] === a.from && edge.from[1] === a.from_port)
        return { edge_id: edge.id, from: edge.from, to: edge.to, changed: false }
      if (!replaceInput(doc, a.edge_id, [a.from, a.from_port]))
        throw new CapabilityError('这个来源已经连接到目标端口，不能重复引用')
      return { edge_id: edge.id, from: [a.from, a.from_port], to: edge.to, changed: true }
    }),
})

export const editCapabilities = [
  duplicate,
  group,
  ungroup,
  arrange,
  reorder,
  reorderInput,
  replaceInputCap,
]
