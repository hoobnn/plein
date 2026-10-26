import { capabilityFor, CapabilityError } from '@plein/capabilities'
import { CheckpointQuery, MediaLibraryQuery, RecoverJobOptions } from '@plein/protocol'
import { z } from 'zod'
import * as Y from 'yjs'
import { CheckpointError } from '../checkpoints/service'
import { MediaIndexError } from '../media-index/service'
import { NodeRunError } from '../plugins/host'
import type { ServerContext } from './tools'

const cap = capabilityFor<ServerContext>()
const id = z.string().min(1).max(200)
function errors<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (
      error instanceof CheckpointError ||
      error instanceof MediaIndexError ||
      error instanceof NodeRunError
    )
      throw new CapabilityError(error.message)
    throw error
  }
}
const index = (ctx: ServerContext) => {
  if (!ctx.env.mediaIndex) throw new CapabilityError('素材索引不可用')
  return ctx.env.mediaIndex
}
const checkpoints = (ctx: ServerContext) => {
  if (!ctx.env.checkpoints) throw new CapabilityError('检查点服务不可用')
  return ctx.env.checkpoints
}

export const searchMedia = cap({
  name: 'search_media',
  title: '检索已有素材',
  group: 'media',
  where: 'server',
  effect: 'read',
  description:
    '与素材面板共用跨画布文件索引，按项目、类型和名称搜索当前用户已有素材，cursor 分页。返回资产 id 可用 create_element 放入画布；不会重新生成或复制文件。',
  input: MediaLibraryQuery,
  run: (ctx, a) => errors(() => index(ctx).list(ctx.env.ownerId, a)),
})
export const mediaSources = cap({
  name: 'get_media_sources',
  title: '读取素材来源',
  group: 'media',
  where: 'server',
  effect: 'read',
  description:
    '读取已有素材在画布、候选、任务、资产库与检查点中的来源，cursor 分页。只返回当前用户拥有的素材。',
  input: z.object({
    asset_id: id,
    cursor: z.string().max(2048).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  run: (ctx, a) => errors(() => index(ctx).sources(ctx.env.ownerId, a.asset_id, a)),
})
export const listJobs = cap({
  name: 'list_jobs',
  title: '读取生成任务',
  group: 'read',
  where: 'server',
  effect: 'read',
  description:
    '读取当前画布任务及恢复信息；给 node_ids 时逐节点查最新任务，不受最近列表窗口限制。核查平台是否受理、取消后的远端任务或失败恢复前先读取。',
  input: z.object({
    node_ids: z.array(id).min(1).max(500).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  run: (ctx, a) =>
    a.node_ids
      ? ctx.env.runs.latestForNodes(ctx.env.canvasId, a.node_ids)
      : ctx.env.runs.list(ctx.env.canvasId, a.limit),
})
export const recoverJob = cap({
  name: 'recover_job',
  title: '恢复生成任务',
  group: 'run',
  where: 'server',
  effect: (a) => (a.operation.action === 'resubmit' ? 'run' : 'edit'),
  description:
    '与任务面板共用恢复规则：refetch 重新获取已受理任务；attach 用平台任务 ID 续查；dismiss 标为已处理；resubmit 只用于用户已经核实平台未受理的未知任务，会重新提交并计费。不会创建新的输入方案。先 list_jobs 核对原任务。',
  input: z.object({
    job_id: id,
    operation: RecoverJobOptions,
    confirmed_not_accepted: z
      .boolean()
      .optional()
      .describe('resubmit 必须为 true，表示用户已核实平台未受理'),
  }),
  run: (ctx, a) =>
    errors(() => {
      if (a.operation.action === 'resubmit' && a.confirmed_not_accepted !== true)
        throw new CapabilityError(
          '重新提交前必须核实平台未受理，并设置 confirmed_not_accepted=true',
        )
      const job = ctx.env.runs.recoverJob(ctx.env.canvasId, a.job_id, ctx.env.ownerId, a.operation)
      if (!job) throw new CapabilityError('当前画布没有这个任务')
      // 恢复任务仍属于原任务；取消与历史由运行队列管理。
      return job
    }),
})
export const cancelGroup = cap({
  name: 'cancel_group',
  title: '取消整组运行',
  group: 'run',
  where: 'server',
  effect: 'edit',
  description: '取消当前用户的一组运行；平台已受理的远端任务仍保留原任务记录供核查。',
  input: z.object({ group_id: id }),
  run: (ctx, a) => ({ canceled: ctx.env.runs.cancelGroup(a.group_id, ctx.env.ownerId) }),
})
export const listCheckpoints = cap({
  name: 'list_checkpoints',
  title: '读取创作检查点',
  group: 'read',
  where: 'server',
  effect: 'read',
  description: '读取当前画布所在项目的命名检查点；canvasId 可筛选来源画布，cursor 分页。',
  input: CheckpointQuery,
  run: (ctx, a) =>
    errors(() => {
      const project = ctx.env.library?.projectOf(ctx.env.ownerId, ctx.env.canvasId)
      if (!project) throw new CapabilityError('当前画布不属于有效项目')
      return checkpoints(ctx).list(ctx.env.ownerId, project, a)
    }),
})
export const createCheckpoint = cap({
  name: 'create_checkpoint',
  title: '保存创作检查点',
  group: 'project',
  where: 'server',
  effect: 'edit',
  description:
    '命名保存服务端当前已经同步的画布（含历史结果、审片与素材引用），与检查点面板共用服务；未送达服务端的浏览器草稿不在其中。检查点独立保存，不随画布撤销删除。',
  input: z.object({ name: z.string().trim().min(1).max(100) }),
  run: (ctx, a) =>
    errors(() => {
      const expectedSnapshot = ctx.withDoc((doc) =>
        Buffer.from(Y.encodeSnapshot(Y.snapshot(doc.ydoc))).toString('base64'),
      )
      return checkpoints(ctx).create(ctx.env.ownerId, ctx.env.canvasId, {
        name: a.name,
        expectedSnapshot,
      })
    }),
})
export const restoreCheckpoint = cap({
  name: 'restore_checkpoint',
  title: '恢复检查点为新画布',
  group: 'project',
  where: 'server',
  effect: 'edit',
  description:
    '把当前用户的检查点恢复为新画布，返回 canvasId。原画布保留，不自动切换本轮工具目标；本轮仍操作原画布。',
  input: z.object({ checkpoint_id: id, title: z.string().trim().min(1).max(200).optional() }),
  run: (ctx, a) =>
    errors(() => checkpoints(ctx).restore(ctx.env.ownerId, a.checkpoint_id, a.title)),
})
export const deleteCheckpoint = cap({
  name: 'delete_checkpoint',
  title: '删除检查点',
  group: 'project',
  where: 'server',
  effect: 'destructive',
  description: '删除用户明确要求删除的命名检查点。独立存储，不能用画布撤销恢复。',
  input: z.object({ checkpoint_id: id }),
  run: (ctx, a) =>
    errors(() => {
      checkpoints(ctx).remove(ctx.env.ownerId, a.checkpoint_id)
      return { deleted: a.checkpoint_id }
    }),
})
export const workspaceCapabilities = [
  searchMedia,
  mediaSources,
  listJobs,
  recoverJob,
  cancelGroup,
  listCheckpoints,
  createCheckpoint,
  restoreCheckpoint,
  deleteCheckpoint,
]
