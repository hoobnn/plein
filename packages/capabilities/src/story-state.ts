import {
  addAdaptationProposal,
  addSourceUnit,
  appendShotPlan,
  captureSourceSnapshot,
  continuityOf,
  listSourceInputs,
  registerContinuitySubject,
  removeSourceLink,
  removeSourceUnit,
  setSourceLink,
  setUnitDisposition,
} from '@plein/doc'
import { z } from 'zod'
import { CapabilityError, defineCapability } from './define'
import { need } from './place'

const id = z.string().min(1).max(200)
const state = z.object({
  worldPosition: z.string().max(2000).optional(),
  screenPosition: z.string().max(2000).optional(),
  pose: z.string().max(2000).optional(),
  condition: z.string().max(2000).optional(),
  holder: z.object({ subjectId: id, hand: z.enum(['left', 'right', 'both']) }).optional(),
})
const operation = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('capture_source'),
    elementId: id,
    port: id,
    expectedText: z.string(),
    expectedResultId: id.optional(),
  }),
  z.object({
    action: z.literal('add_unit'),
    snapshotId: id,
    start: z.number().int().min(0),
    end: z.number().int().positive(),
    kind: z.enum(['event', 'dialogue']),
  }),
  z.object({
    action: z.literal('set_unit_scope'),
    unitId: id,
    disposition: z.enum(['in_scope', 'out_of_scope']),
  }),
  z.object({
    action: z.literal('link_source'),
    unitId: id,
    shotId: id,
    dialogueId: id.optional(),
    treatment: z.enum(['retain', 'compress', 'merge']),
  }),
  z.object({ action: z.literal('remove_link'), linkId: id }),
  z.object({ action: z.literal('remove_unit'), unitId: id }),
  z.object({
    action: z.literal('add_proposal'),
    shotIds: z.array(id).max(500),
    note: z.string().trim().min(1).max(4000),
  }),
  z.object({
    action: z.literal('register_subject'),
    kind: z.enum(['character', 'scene', 'prop']),
    label: z.string().min(1).max(120),
    binding: z.object({ elementId: id.optional(), libraryId: id.optional() }).nullable().optional(),
  }),
  z.object({
    action: z.literal('append_plan'),
    shotId: id,
    expectedHeads: z.array(id).max(500),
    content: z.object({
      intent: z.string().max(4000).optional(),
      start: z.record(id, state),
      end: z.record(id, state),
      inherits: z
        .array(
          z.object({
            fromShotId: id,
            planRevisionId: id,
            subjectId: id,
            fields: z.array(
              z.enum(['worldPosition', 'screenPosition', 'pose', 'holder', 'condition']),
            ),
          }),
        )
        .max(500),
      reset: z
        .object({
          kind: z.enum(['time_jump', 'new_scene', 'flashback']),
          reason: z.string().min(1).max(2000),
        })
        .optional(),
    }),
  }),
])
export const getStoryInputs = defineCapability({
  name: 'get_story_inputs',
  title: '读取分镜原文来源',
  group: 'read',
  where: 'doc',
  effect: 'read',
  description:
    '读取分镜连接的原文来源标识；完整正文用 get_element_field 读取来源元素。来源映射、状态主体及计划修订用 get_element_field 的 /production/sourceMap 和 /production/continuity 分页读取。',
  input: z.object({ id }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      if (need(doc, a.id).nodeType !== 'plein/storyboard') throw new CapabilityError('需要分镜节点')
      return listSourceInputs(doc, a.id).map(({ text, ...input }) => ({
        ...input,
        characters: text?.length,
      }))
    }),
})
export const editStoryState = defineCapability({
  name: 'edit_story_state',
  title: '编辑来源映射与连续性计划',
  group: 'story',
  where: 'doc',
  effect: 'edit',
  description:
    '与分镜工作台共用命令：固定原文快照、标记事件/对白范围、绑定镜头来源、调整范围、改编提案、登记连续性主体、追加带父版本校验的镜头状态计划。只编辑创作资料，不确认用户已读、不代替人工内容确认或观片证据。计划修订署名明确标为 agent。',
  input: z.object({ id, operation }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const el = need(doc, a.id)
      if (el.nodeType !== 'plein/storyboard' || el.locked || !ctx.canvasId)
        throw new CapabilityError('需要当前画布中未锁定的分镜节点')
      const op = a.operation,
        scope = { canvasId: ctx.canvasId, boardId: a.id }
      let result: unknown
      switch (op.action) {
        case 'capture_source':
          result = captureSourceSnapshot(doc, a.id, { ...op, canvasId: ctx.canvasId })
          break
        case 'add_unit':
          result = addSourceUnit(doc, a.id, {
            snapshotId: op.snapshotId,
            start: op.start,
            end: op.end,
            kind: op.kind,
          })
          break
        case 'set_unit_scope':
          result = setUnitDisposition(doc, a.id, op.unitId, op.disposition)
          break
        case 'link_source':
          result = setSourceLink(doc, a.id, {
            unitId: op.unitId,
            shotId: op.shotId,
            dialogueId: op.dialogueId,
            treatment: op.treatment,
          })
          break
        case 'remove_link':
          result = removeSourceLink(doc, a.id, op.linkId)
          break
        case 'remove_unit':
          result = removeSourceUnit(doc, a.id, op.unitId)
          break
        case 'add_proposal':
          result = addAdaptationProposal(doc, a.id, op.shotIds, op.note)
          break
        case 'register_subject':
          result = registerContinuitySubject(doc, {
            scope,
            kind: op.kind,
            label: op.label,
            binding: op.binding,
          })
          break
        case 'append_plan':
          result = appendShotPlan(doc, {
            scope,
            shotId: op.shotId,
            expectedHeads: op.expectedHeads,
            content: op.content,
            userId: 'agent',
          })
          break
      }
      if (!result) throw new CapabilityError('来源、范围或计划版本不匹配，请重新读取当前状态')
      return {
        result,
        ...(op.action === 'append_plan' ? { continuity: continuityOf(doc, a.id) } : {}),
      }
    }),
})
export const storyStateCapabilities = [getStoryInputs, editStoryState]
