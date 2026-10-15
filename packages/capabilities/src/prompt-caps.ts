import { aspectSize, type PleinDoc, parseAspect, setParams, updateElement } from '@plein/doc'
import { pickShotPresets, presetsFor, SHOT_PRESETS_KEY, shotStateOf, slotsFor } from '@plein/nodes'
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

const pick = z.string().nullable().optional()

export const applyShotPresets = defineCapability({
  name: 'apply_shot_presets',
  title: '镜头与风格预设',
  description:
    '给图片 / 视频节点选运镜、景别、角度、光影、风格（和生成器里提示词上方的镜头条是同一套）：每栏单选，拼成提示词末尾的「镜头：…」「风格：…」两行，只改这两行。给 null 清掉一栏。这些只是提示词，效果因模型而异。不带参数调用会列出各栏可选的 id。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z.object({
    id: id.describe('图片或视频节点'),
    move: pick.describe('运镜（只有视频）'),
    shot: pick.describe('景别'),
    angle: pick.describe('角度'),
    light: pick.describe('光影'),
    style: pick.describe('风格'),
    speed: z.enum(['slow', 'normal', 'fast']).optional().describe('运镜速度'),
  }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const { el, info } = nodeOf(ctx, doc, a.id)
      const capability = info.def.capability
      const slots = slotsFor(capability)
      if (!slots.length) throw new CapabilityError('只有图片和视频节点能用镜头与风格预设')
      const all = ctx.nodes
        .prompts()
        .filter(
          (p) =>
            p.slot &&
            slots.includes(p.slot) &&
            (!p.appliesTo?.length || (capability && p.appliesTo.includes(capability))),
        )
      const keyed = {
        'camera.move': a.move,
        'camera.shot': a.shot,
        'camera.angle': a.angle,
        'camera.light': a.light,
        style: a.style,
      } as const
      const picks = Object.fromEntries(
        Object.entries(keyed).filter(([, v]) => v !== undefined),
      ) as Record<string, string | null>
      for (const [slot, v] of Object.entries(picks)) {
        if (v && !all.some((p) => p.id === v && p.slot === slot))
          throw new CapabilityError(`${v} 不是这个节点「${slot}」栏的选项`)
      }
      const options = Object.fromEntries(
        slots.map((s) => [s, all.filter((p) => p.slot === s).map((p) => `${p.id}（${p.title}）`)]),
      )
      if (!Object.keys(picks).length && !a.speed) return { options }
      const pk = promptField(info.descriptor.defaults)
      if (!pk) throw new CapabilityError('节点没有提示词')
      const next = pickShotPresets({
        prompt: String(el.params?.[pk] ?? ''),
        state: shotStateOf(el.params?.[SHOT_PRESETS_KEY]),
        change: { picks, speed: a.speed },
        presets: all,
        capability,
      })
      setParams(doc, a.id, { [pk]: next.prompt, [SHOT_PRESETS_KEY]: next.state })
      return { prompt: next.prompt, picks: next.state.picks }
    }),
})

export const promptCapabilities = [listPresets, applyPreset, applyShotPresets]
