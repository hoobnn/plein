import {
  currentResult,
  elementPorts,
  setParamEntry,
  setParams,
  type CanvasElement,
  type PleinDoc,
} from '@plein/doc'
import {
  applyMotionEdit,
  MOTION_TYPE,
  MOTION_TEMPLATE_LABELS,
  motionEditable,
  MotionEditOperation,
  motionNode,
  MotionParams,
} from '@plein/nodes'
import { z } from 'zod'
import { type CapabilityContext, CapabilityError, defineCapability } from './define'
import { link, need, placeNew } from './place'
import { nodeElementOf } from './story/nodes'

const id = z.string().min(1).max(200)
// Zod 4 会执行 optional 内的 default；补丁必须先移除默认值，避免只改颜色却重置整段。
const basePatch = z
  .object(
    Object.fromEntries(
      Object.entries(MotionParams.shape)
        .filter(([key]) => key !== 'overrides')
        .map(([key, field]) => [key, field.removeDefault().optional()]),
    ),
  )
  .strict()

function parseParams(raw: unknown): MotionParams {
  const parsed = MotionParams.safeParse(raw)
  if (!parsed.success)
    throw new CapabilityError(`动态合成参数不对：${z.prettifyError(parsed.error)}`)
  return parsed.data
}
function needMotion(doc: PleinDoc, nodeId: string) {
  const el = need(doc, nodeId)
  if (el.kind !== 'node' || el.nodeType !== MOTION_TYPE)
    throw new CapabilityError(`${nodeId} 不是动态合成节点`)
  return el
}
function checkSource(doc: PleinDoc, sourceId: string | undefined, kind: 'image' | 'video') {
  if (!sourceId) return
  const source = need(doc, sourceId)
  if (!elementPorts(source)?.outputs.some((port) => port.type === kind))
    throw new CapabilityError(`${sourceId} 没有 ${kind} 输出，无法接入动态合成`)
}
function snapshot(doc: PleinDoc, el: CanvasElement) {
  const params = parseParams(el.params)
  const adopted = currentResult(el)?.id ?? null
  return {
    id: el.id,
    name: el.name,
    type: MOTION_TYPE,
    params,
    editable: motionEditable,
    templates: MOTION_TEMPLATE_LABELS,
    inputs: [...doc.edges()]
      .filter((edge) => edge.to[0] === el.id && ['image', 'video'].includes(edge.to[1]))
      .map((edge) => ({
        elementId: edge.from[0],
        fromPort: edge.from[1],
        toPort: edge.to[1],
      })),
    candidates: (el.results ?? []).flatMap((result) =>
      result.value.type === 'video'
        ? [
            {
              id: result.id,
              assetId: result.value.assetId,
              at: result.at,
              adopted: result.id === adopted,
            },
          ]
        : [],
    ),
    run: el.run ? { id: el.run.id, status: el.run.status, progress: el.run.progress } : undefined,
  }
}

export const createMotion = defineCapability({
  name: 'create_motion',
  title: '创建动态合成',
  description:
    '用内置模板创建可编辑的片头、角色介绍或视频标题包装。仅创建不渲染；输入可连接已有图片或视频节点，渲染用 run_node。默认静音，不生成素材。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z
    .object({
      params: MotionParams.optional(),
      name: z.string().max(100).optional(),
      image_id: id.optional().describe('图片素材或有图片输出的上游节点'),
      video_id: id.optional().describe('视频素材或有视频输出的上游节点'),
      near: id.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      parent_id: id.optional(),
    })
    .strict(),
  run: (ctx, input) =>
    ctx.withDoc((doc) => {
      const info = ctx.nodes.latest(MOTION_TYPE)
      if (!info) throw new CapabilityError('动态合成节点尚未启用')
      checkSource(doc, input.image_id, 'image')
      checkSource(doc, input.video_id, 'video')
      const params = parseParams(input.params ?? {})
      let nodeId = ''
      doc.ydoc.transact(() => {
        nodeId = placeNew(
          doc,
          input,
          { ...nodeElementOf(info.descriptor, params), name: input.name ?? motionNode.title },
          ctx.viewport?.(),
        )
        if (input.image_id) link(doc, input.image_id, undefined, nodeId, 'image')
        if (input.video_id) link(doc, input.video_id, undefined, nodeId, 'video')
      }, doc.origin)
      return snapshot(doc, needMotion(doc, nodeId))
    }),
})

export const editMotion = defineCapability({
  name: 'edit_motion',
  title: '编辑动态合成',
  description:
    '按受控字段修改动态合成。params修改模板、文案或规格；operations修改单元素文字、允许的样式或出现时间。覆盖按字段合并，保留其他编辑；不接收HTML、脚本、任意属性、外链或SDK原始patch，不触发渲染。',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  input: z
    .object({
      id,
      params: basePatch.optional(),
      operations: z.array(MotionEditOperation).min(1).max(100).optional(),
    })
    .strict()
    .refine(
      (value) => Object.keys(value.params ?? {}).length > 0 || !!value.operations?.length,
      '需要提供参数或编辑操作',
    ),
  run: (ctx, input) =>
    ctx.withDoc((doc) => {
      const el = needMotion(doc, input.id)
      const prior = parseParams(el.params)
      let next = parseParams({ ...prior, ...input.params })
      try {
        for (const operation of input.operations ?? []) next = applyMotionEdit(next, operation)
      } catch (error) {
        throw new CapabilityError(`动态合成编辑无效：${(error as Error).message}`)
      }
      const touched = Object.entries(next.overrides).filter(
        ([key, value]) => prior.overrides[key] !== value,
      )
      doc.ydoc.transact(() => {
        if (input.params) setParams(doc, el.id, input.params)
        for (const [key, value] of touched) setParamEntry(doc, el.id, 'overrides', key, value)
      }, doc.origin)
      return snapshot(doc, needMotion(doc, el.id))
    }),
})

export const getMotion = defineCapability({
  name: 'get_motion',
  title: '查看动态合成',
  description:
    '读取动态合成的受限编辑快照、可编辑字段、输入连线和视频候选身份。不返回可执行HTML、源码文件或本机路径。',
  group: 'read',
  where: 'doc',
  effect: 'read',
  input: z.object({ id }).strict(),
  run: (ctx: CapabilityContext, input) =>
    ctx.withDoc((doc) => snapshot(doc, needMotion(doc, input.id))),
})

export const motionCapabilities = [createMotion, editMotion, getMotion]
