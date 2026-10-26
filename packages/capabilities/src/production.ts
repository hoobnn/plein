import {
  appendProductionDecision,
  appendProductionGoal,
  editDelivery,
  isProductionGoal,
  selectProductionTarget,
  type ProductionGoal,
} from '@plein/doc'
import { z } from 'zod'
import { CapabilityError, defineCapability } from './define'
import { need } from './place'

const id = z.string().min(1).max(200)
const requirement = z.enum(['unspecified', 'required', 'none'])
const goal = z.object({
  aspectRatio: z.enum(['9:16', '16:9']).optional(),
  resolution: z.enum(['720p', '1080p']).optional(),
  duration: z
    .object({
      min: z.number().positive().max(86400).optional(),
      max: z.number().positive().max(86400).optional(),
    })
    .optional(),
  dialogue: requirement,
  originalAudio: requirement,
  music: requirement,
  sfx: requirement,
  subtitles: requirement,
  allowSilence: z.boolean(),
  allowBlack: z.boolean(),
  requirements: z.string().max(4000),
})
const operation = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('select'),
    trialShotId: id.nullable().optional(),
    sequenceId: id.nullable().optional(),
  }),
  z.object({
    action: z.literal('goal'),
    sequenceId: id.optional(),
    expectedHeads: z.array(id).max(100),
    content: goal,
  }),
  z.object({
    action: z.literal('decision'),
    category: z.enum(['model', 'style', 'other']),
    subject: z.string().min(1).max(120),
    value: z.string().min(1).max(2000),
    note: z.string().max(2000).optional(),
  }),
])
export const editProduction = defineCapability({
  name: 'edit_production',
  title: '编辑制作目标与决策',
  group: 'story',
  where: 'doc',
  effect: 'edit',
  description:
    '设置分镜的试制镜头/目标序列、追加制作目标版本或记录模型/风格决策。先用 get_element_field /production 读取当前状态；goal 必须给 expectedHeads。Agent 写入明确标记 source=agent，不产生用户内容确认或交付批准。',
  input: z.object({ id, operation }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const el = need(doc, a.id),
        op = a.operation
      if (el.nodeType !== 'plein/storyboard' || el.locked || !ctx.canvasId)
        throw new CapabilityError('需要未锁定的分镜节点与当前画布身份')
      const scope = { canvasId: ctx.canvasId, boardId: a.id }
      let result: unknown
      if (op.action === 'select') {
        const shots = el.params?.shots
        if (
          op.trialShotId &&
          (!Array.isArray(shots) || !shots.some((shot) => shot?.id === op.trialShotId))
        )
          throw new CapabilityError('试制镜头不存在')
        if (op.sequenceId && need(doc, op.sequenceId).nodeType !== 'plein/sequence')
          throw new CapabilityError('目标必须是序列节点')
        result = selectProductionTarget(doc, a.id, {
          ...('trialShotId' in op ? { trialShotId: op.trialShotId ?? undefined } : {}),
          ...('sequenceId' in op ? { sequenceId: op.sequenceId ?? undefined } : {}),
        })
      } else if (op.action === 'goal') {
        if (!isProductionGoal(op.content)) throw new CapabilityError('制作目标不合法，检查时长范围')
        result = appendProductionGoal(doc, {
          scope: { ...scope, sequenceId: op.sequenceId },
          expectedHeads: op.expectedHeads,
          content: op.content as ProductionGoal,
          userId: 'agent',
          actorSource: 'agent',
        })
      } else
        result = appendProductionDecision(doc, {
          scope,
          userId: 'agent',
          actorSource: 'agent',
          category: op.category,
          subject: op.subject,
          value: op.value,
          note: op.note,
        })
      if (!result) throw new CapabilityError('目标或版本已变化，请重新读取制作状态')
      return { result }
    }),
})
export const editDeliveryNotes = defineCapability({
  name: 'edit_delivery_notes',
  title: '编辑成片反馈',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  description:
    '替换指定成片交付版本的反馈列表，支持时间点、镜头/实例定位与解决状态。必须携带读取时的 expected_notes（JSON 原文）防止覆盖并发修改；会撤销旧交付确认，不会替用户批准交付。',
  input: z.object({
    id,
    delivery_id: id,
    expected_notes: z.string().max(1024 * 1024),
    notes: z
      .array(
        z.object({
          id,
          time: z.number().min(0),
          text: z.string().trim().min(1).max(4000),
          resolved: z.boolean(),
          source: id.optional(),
          shotId: id.optional(),
          clipInstanceId: id.optional(),
        }),
      )
      .max(500),
  }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const el = need(doc, a.id),
        record = el.deliveries?.find((r) => r.id === a.delivery_id)
      if (el.locked || !record || JSON.stringify(record.notes) !== a.expected_notes)
        throw new CapabilityError('交付版本已变化或锁定')
      if (!editDelivery(doc, a.id, a.delivery_id, { notes: a.notes }))
        throw new CapabilityError('反馈不合法或交付版本已成为历史')
      return { id: a.id, delivery_id: a.delivery_id, notes: a.notes }
    }),
})
export const productionCapabilities = [editProduction, editDeliveryNotes]
