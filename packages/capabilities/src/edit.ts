import {
  arrangeElements,
  bringToFront,
  duplicateElements,
  groupElements,
  sendToBack,
  topLevel,
  ungroupElements,
} from '@plein/doc'
import { z } from 'zod'
import { CapabilityError, defineCapability } from './define'
import { need } from './place'

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
      return { ids: duplicateElements(doc, a.ids, a.dx, a.dy) }
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

export const editCapabilities = [duplicate, group, ungroup, arrange, reorder]
