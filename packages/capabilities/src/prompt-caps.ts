import { aspectSize, type PleinDoc, parseAspect, setParams, updateElement } from '@plein/doc'
import { presetsFor } from '@plein/nodes'
import { z } from 'zod'
import { type CapabilityContext, CapabilityError, defineCapability } from './define'
import { need } from './place'

/** 提示词预设：查看、套用。与生成器里的 / 预设菜单是同一份数据 */

const id = z.string().min(1).max(200)

/** 节点的主提示词字段：prompt 优先，其次 text */
export function promptField(params: Record<string, unknown> | undefined): string | undefined {
  return ['prompt', 'text'].find((k) => params && k in params)
}

function nodeOf(ctx: CapabilityContext, doc: PleinDoc, nodeId: string) {
  const el = need(doc, nodeId)
  const info = el.kind === 'node' && el.nodeType ? ctx.nodes.latest(el.nodeType) : undefined
  if (!info) throw new CapabilityError(`${nodeId} 不是工作流节点`)
  return { el, info }
}

const presetsOf = (ctx: CapabilityContext, info: { def: { type: string; capability?: string } }) =>
  presetsFor(ctx.nodes.prompts(), { type: info.def.type, capability: info.def.capability })

export const listPresets = defineCapability({
  name: 'list_presets',
  title: '查看提示词预设',
  description: '列出某个节点可用的提示词预设（id、标题、说明、模板）。模板里【】是要替换的占位。',
  group: 'edit',
  where: 'doc',
  effect: 'read',
  input: z.object({ id: id.describe('节点') }),
  run: (ctx, a) =>
    ctx.withDoc((doc) =>
      presetsOf(ctx, nodeOf(ctx, doc, a.id).info).map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        template: p.template,
      })),
    ),
})

export const applyPreset = defineCapability({
  name: 'apply_preset',
  title: '套用提示词预设',
  description:
    '把预设的提示词模板和参数（如画幅）写进节点。写完通常还要用 update_element 把模板里的【占位】换成具体内容。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z.object({ id: id.describe('节点'), preset_id: z.string() }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const { el, info } = nodeOf(ctx, doc, a.id)
      const preset = presetsOf(ctx, info).find((p) => p.id === a.preset_id)
      if (!preset)
        throw new CapabilityError(`节点不能用预设 ${a.preset_id}，先用 list_presets 查看`)
      const keys = new Set(Object.keys(info.descriptor.defaults))
      const params = Object.fromEntries(
        Object.entries(preset.params ?? {}).filter(([k]) => keys.has(k)),
      )
      const pk = promptField(info.descriptor.defaults)
      doc.ydoc.transact(() => {
        setParams(doc, a.id, { ...params, ...(pk ? { [pk]: preset.template } : {}) })
        // 画幅变了卡片跟着变形：保持长边
        const ratio = parseAspect(params.aspectRatio)
        if (ratio) updateElement(doc, a.id, aspectSize(ratio, Math.max(el.w, el.h)))
      }, doc.origin)
      return { params: Object.keys(params), prompt: pk ? preset.template : undefined }
    }),
})

export const promptCapabilities = [listPresets, applyPreset]
