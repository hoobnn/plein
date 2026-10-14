import { spotAfterContent, spotRightOf } from '@plein/doc'
import { dramaTemplate, STORYBOARD_TYPE } from '@plein/nodes'
import type { Capability } from '@plein/plugin-sdk'
import { z } from 'zod'
import { type CapabilityContext, CapabilityError, defineCapability } from './define'
import { need } from './place'
import { applyCast, castOf, describeCast } from './story/cast'
import { dramaNotice, placeDramaTemplate } from './story/drama'
import { type NodeFactory, nodeElementOf } from './story/nodes'
import { expandShots, planDiffs, shotsOf, syncExpanded } from './story/storyboard'

/** 短剧创作流程：铺模板、抽取角色场景、展开 / 同步分镜。与右键菜单、分镜编辑器是同一套操作 */

const id = z.string().min(1).max(200)

/** 节点目录 → 卡片骨架 */
export const nodeFactoryOf =
  (ctx: CapabilityContext): NodeFactory =>
  (type) => {
    const info = ctx.nodes.latest(type)
    return info && nodeElementOf(info.descriptor)
  }

/** 默认配音模型及其音色表：设定卡按它配音色，和新建的配音节点用同一个模型 */
export function defaultSpeech(ctx: Pick<CapabilityContext, 'nodes'>) {
  const ref = ctx.nodes.defaultModel('audio.speech')
  return ref ? ctx.nodes.models('audio.speech').find((m) => m.ref === ref) : undefined
}

const isBoard = (ctx: CapabilityContext, boardId: string) =>
  ctx.withDoc((doc) => {
    const el = need(doc, boardId)
    if (el.nodeType !== STORYBOARD_TYPE) throw new CapabilityError(`${boardId} 不是分镜节点`)
    return shotsOf(el)
  })

export const placeDrama = defineCapability({
  name: 'place_drama_template',
  title: '铺短剧模板',
  description:
    '铺一套短剧工作流骨架（剧本 → 角色 / 场景设定 → 分镜 → 镜头 → 配音 → 成片），只建不跑。适合从零开始做一部短剧。返回新建的分组和缺的模型。',
  group: 'story',
  where: 'doc',
  effect: 'edit',
  input: z.object({
    near: id.optional().describe('放在这个元素右侧；不填时放在画布内容右侧'),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  palette: { fromSelection: () => ({}) },
  run: (ctx, a) => {
    const template = dramaTemplate()
    const tops = template.elements.filter((e) => !e.parent)
    const w = Math.max(...tops.map((e) => e.x + e.w))
    const h = Math.max(...tops.map((e) => e.y + e.h))
    const pick = (c: string) => ctx.nodes.defaultModel(c as Capability)
    return ctx.withDoc((doc) => {
      if (a.near) need(doc, a.near)
      const at =
        a.x !== undefined && a.y !== undefined
          ? { x: a.x, y: a.y }
          : a.near
            ? spotRightOf(doc, a.near, w, h)
            : spotAfterContent(doc, w, h)
      const r = placeDramaTemplate(doc, nodeFactoryOf(ctx), pick, at, template)
      return { frames: r.frames, created: r.created, notice: dramaNotice(r) }
    })
  },
})

export const extractCast = defineCapability({
  name: 'extract_cast',
  title: '生成设定卡',
  description:
    '把文本节点（如“抽取角色场景”）当前结果里的角色 / 场景 / 道具建成设定卡：同名卡已有设定的不覆盖，只补空的。',
  group: 'story',
  where: 'doc',
  effect: 'edit',
  input: z.object({ id: id.describe('有抽取结果的文本节点') }),
  palette: {
    fromSelection: (sel, doc) =>
      sel.length === 1 && castOf(doc, sel[0]!).length ? { id: sel[0]! } : null,
  },
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      need(doc, a.id)
      const entries = castOf(doc, a.id)
      if (!entries.length)
        throw new CapabilityError('这个节点还没有可用的抽取结果（先运行它，或换一个节点）')
      const lib = ctx.library?.()
      const r = applyCast(doc, nodeFactoryOf(ctx), a.id, entries, {
        speech: defaultSpeech(ctx),
        library: lib && { ...lib, assetMeta: (assetId) => ctx.assetMeta(assetId) },
      })
      return { ...r, notice: describeCast(r) }
    }),
})

export const expandStoryboard = defineCapability({
  name: 'expand_storyboard',
  title: '展开分镜',
  description:
    '把分镜节点里的镜头展开成节点：每个镜头一个 Frame（分镜图 → 视频，每句台词一个配音），并接到序列。只建不跑。mode=update 时只给已展开的镜头补缺的节点，不改已有参数。',
  group: 'story',
  where: 'doc',
  effect: 'edit',
  input: z.object({
    id: id.describe('分镜节点'),
    shot_ids: z.array(z.string()).optional().describe('只展开这些镜头；不填展开全部'),
    mode: z.enum(['new', 'update']).default('new'),
  }),
  palette: {
    fromSelection: (sel, doc) =>
      sel.length === 1 && doc.get(sel[0]!)?.nodeType === STORYBOARD_TYPE ? { id: sel[0]! } : null,
  },
  run: (ctx, a) => {
    const shots = isBoard(ctx, a.id)
    if (!shots.length) throw new CapabilityError('分镜里还没有镜头，先运行分镜节点')
    const ids = a.shot_ids ?? shots.map((s) => s.id)
    return ctx.withDoc((doc) => expandShots(doc, a.id, ids, nodeFactoryOf(ctx), { mode: a.mode }))
  },
})

export const syncStoryboard = defineCapability({
  name: 'sync_storyboard',
  title: '同步分镜改动',
  description:
    '分镜表改过之后，把改动同步到已展开的节点。unmodified：只更新没被手改过的字段；keep-overrides：同上，并记住手改过的字段以后不再提示。不填 mode 时只返回差异，不改。',
  group: 'story',
  where: 'doc',
  effect: (a) => (a.mode ? 'edit' : 'read'),
  input: z.object({
    id: id.describe('分镜节点'),
    shot_ids: z.array(z.string()).optional(),
    mode: z.enum(['unmodified', 'keep-overrides']).optional(),
  }),
  run: (ctx, a) => {
    isBoard(ctx, a.id)
    return ctx.withDoc((doc) => {
      const diffs = planDiffs(doc, a.id)
      const ids = a.shot_ids ?? [...diffs.keys()]
      if (!a.mode)
        return {
          diffs: ids.map((shot) => ({
            shot,
            nodes: (diffs.get(shot) ?? []).map((d) => ({
              id: d.el.id,
              role: d.role,
              diffs: d.diffs,
            })),
          })),
        }
      return syncExpanded(doc, a.id, ids, a.mode)
    })
  },
})

export const storyCapabilities = [placeDrama, extractCast, expandStoryboard, syncStoryboard]
