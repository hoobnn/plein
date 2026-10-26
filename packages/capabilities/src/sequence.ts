import {
  addFixedSequenceInstance,
  createDoc,
  currentResult,
  type PleinDoc,
  duplicateSequenceInstance,
  editSequenceInstance,
  fixSequenceInstance,
  materializeSequenceV1,
  removeSequenceInstance,
  reorderSequenceInstances,
  replaceSequenceSegment,
  sequenceInstancesOf,
  setParams,
} from '@plein/doc'
import { SequenceClip } from '@plein/nodes'
import { z } from 'zod'
import * as Y from 'yjs'
import { CapabilityError, defineCapability } from './define'
import { need } from './place'

const id = z.string().min(1).max(200)
const sound = z.enum(['native', 'voice', 'mix'])
const patch = SequenceClip.omit({
  source: true,
  clipInstanceId: true,
  port: true,
  edgeId: true,
  segment: true,
}).partial()

export const getSequence = defineCapability({
  name: 'get_sequence',
  title: '读取剪辑序列',
  group: 'read',
  where: 'doc',
  effect: 'read',
  description:
    '读取序列的剪辑实例、固定素材、音画模式、剪辑点、对白与字幕参数。返回 version，用 edit_sequence 的 expected_version 防止覆盖其他人的修改；不运行或导出。其他全局参数用 get_element_field /params 读取。',
  input: z.object({ id }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const el = need(doc, a.id)
      if (el.nodeType !== 'plein/sequence') throw new CapabilityError('需要 plein/sequence 节点')
      const params = materializeSequenceV1(el.id, el.params ?? {}, [...doc.edges()], (id) =>
        doc.has(id),
      )
      return {
        id: el.id,
        version: JSON.stringify(params.clips ?? []),
        clips: sequenceInstancesOf({ ...el, params }),
      }
    }),
})

export const editSequence = defineCapability({
  name: 'edit_sequence',
  title: '编辑剪辑实例',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  description:
    '与序列编辑器共用命令：edit 修改单次使用的剪辑/速度/音量/对白/转场；reorder 按完整实例 ID 排序；fix 固定当前或指定视频候选；duplicate 复制固定片段；add 加入已有固定视频；replace 替换一次使用的固定片段；remove 移除一次使用。仅修改序列，不删除源素材，不生成。先 get_sequence，携带 version 为 expected_version。字幕、配乐、画幅等全局参数用 update_element.params，字段见 list_node_types。',
  input: z.object({
    id,
    action: z.enum(['edit', 'reorder', 'fix', 'duplicate', 'add', 'replace', 'remove']),
    expected_version: z.string().max(1024 * 1024),
    clip_id: id.optional(),
    patch: patch.optional(),
    order: z.array(id).max(500).optional(),
    video_id: id.optional().describe('add / replace 的固定视频素材元素'),
    result_id: id.optional().describe('fix 的视频候选；不填固定当前采用'),
    sound: sound
      .optional()
      .describe('fix / duplicate / add 必填：native 原声，voice 配音，mix 混合'),
  }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const el = need(doc, a.id)
      if (el.nodeType !== 'plein/sequence' || el.locked)
        throw new CapabilityError('需要未锁定的序列节点')
      const params = materializeSequenceV1(el.id, el.params ?? {}, [...doc.edges()], (id) =>
        doc.has(id),
      )
      if (a.expected_version !== JSON.stringify(params.clips ?? []))
        throw new CapabilityError('序列已变化，请重新 get_sequence')
      const clips = sequenceInstancesOf({ ...el, params })
      const row = clips.find((c) => c.clipInstanceId === a.clip_id)
      if (!['add', 'reorder'].includes(a.action) && !row)
        throw new CapabilityError('需要有效的 clip_id')
      if (['fix', 'duplicate', 'add'].includes(a.action) && !a.sound)
        throw new CapabilityError('需要 sound')
      if (['add', 'replace'].includes(a.action) && !a.video_id)
        throw new CapabilityError('需要 video_id')
      if (a.action === 'edit' && !a.patch) throw new CapabilityError('需要 patch')
      if (
        a.action === 'reorder' &&
        (!a.order ||
          a.order.length !== clips.length ||
          new Set(a.order).size !== clips.length ||
          a.order.some((id) => !clips.some((c) => c.clipInstanceId === id)))
      )
        throw new CapabilityError('order 必须完整且不重复地列出全部实例 ID')
      let fixed: { assetId: string; duration: number } | undefined
      if (a.action === 'fix') {
        if (!ctx.canvasId) throw new CapabilityError('无法确定当前画布身份')
        const source = need(doc, row!.source)
        const result = a.result_id
          ? source.results?.find((r) => r.id === a.result_id && r.port === row!.port)
          : currentResult(source, row!.port)
        const assetId =
          source.kind === 'video'
            ? source.assetId
            : result?.value.type === 'video'
              ? result.value.assetId
              : undefined
        const meta = assetId ? ctx.assetMeta(assetId) : undefined
        if (!assetId || meta?.kind !== 'video' || !meta.duration)
          throw new CapabilityError('候选没有有效的视频资产或时长')
        fixed = { assetId, duration: meta.duration }
      }
      // 旧序列先使用界面相同的迁移规则固化实例身份。
      let changed: boolean | string | undefined
      const execute = (target: PleinDoc) =>
        target.ydoc.transact(() => {
          if (el.params?.instanceVersion !== 2) setParams(target, a.id, params)
          switch (a.action) {
            case 'edit':
              changed = editSequenceInstance(target, a.id, a.clip_id!, a.patch!)
              break
            case 'reorder':
              changed = reorderSequenceInstances(target, a.id, a.order!)
              break
            case 'fix':
              changed = fixSequenceInstance(target, a.id, a.clip_id!, {
                ...fixed!,
                canvasId: ctx.canvasId!,
                resultId: a.result_id,
                sound: a.sound!,
              })
              break
            case 'duplicate':
              changed = duplicateSequenceInstance(target, a.id, a.clip_id!, { sound: a.sound! })
              break
            case 'add':
              changed = addFixedSequenceInstance(target, a.id, a.video_id!, { sound: a.sound! })
              break
            case 'replace':
              changed = replaceSequenceSegment(target, a.id, a.clip_id!, a.video_id!)
              break
            case 'remove':
              changed = removeSequenceInstance(target, a.id, a.clip_id!)
              break
          }
        }, target.origin)
      // Yjs 事务不回滚抛错；先在快照上验证整个命令，失败不能留下半次旧格式迁移。
      const preview = new Y.Doc()
      let previewDoc: PleinDoc | undefined
      try {
        Y.applyUpdate(preview, Y.encodeStateAsUpdate(doc.ydoc))
        previewDoc = createDoc(preview, { schedule: () => {} })
        execute(previewDoc)
        if (!changed) throw new CapabilityError('无法执行：检查固定素材、实例状态及剪辑参数后重试')
      } finally {
        previewDoc?.destroy()
        preview.destroy()
      }
      execute(doc)
      if (!changed) throw new CapabilityError('无法执行：检查固定素材、实例状态及剪辑参数后重试')
      return {
        id: a.id,
        ...(typeof changed === 'string' ? { clip_id: changed } : {}),
        clips: sequenceInstancesOf(need(doc, a.id)),
      }
    }),
})

export const sequenceCapabilities = [getSequence, editSequence]
