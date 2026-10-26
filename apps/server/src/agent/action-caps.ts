import { CapabilityError, capabilityFor } from '@plein/capabilities'
import { PanoramaCaptureRequest } from '@plein/nodes'
import {
  API,
  CreateLibraryItem,
  UpdateLibraryItem,
  CreateTemplate,
  CreateVoice,
  UpdateVoice,
  SequenceExportRequest,
  SubtitleRecognizeRequest,
  SubtitleRecognitionLookup,
  SubtitleRecoverRequest,
  ApplyLibraryUpdates,
  ArchiveCharacterImage,
} from '@plein/protocol'
import { z } from 'zod'
import type { ServerContext } from './tools'

/** 复用 UI 路由的文件与资产库操作。只允许这里登记的操作，不开放任意 HTTP。 */
const id = z.string().min(1).max(200)
const empty = z.object({})
const item = z.object({ id })
type Action = {
  title: string
  effect: 'read' | 'edit' | 'run' | 'destructive'
  schema: z.ZodObject
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: (a: Record<string, unknown>) => string
  /**
   * 允许请求的路径形状。参数里的 id 可能带 ../ 或 ?，URL 解析会把它们折成别的路由，
   * 所以按解析后的 pathname 复核，只放行登记在册的那条路由。
   */
  pathname: RegExp
  body?: (a: Record<string, unknown>) => unknown
}
const actions: Record<string, Action> = {
  get_media_caps: {
    title: '查看本机媒体处理能力',
    effect: 'read',
    schema: empty,
    method: 'GET',
    path: () => API.mediaCaps,
    pathname: /^\/api\/media\/caps$/,
  },
  get_asset: {
    title: '读取素材元数据和下载地址',
    effect: 'read',
    schema: item,
    method: 'GET',
    path: (a) => API.assetMeta(String(a.id)),
    pathname: /^\/api\/assets\/[^/]+\/meta$/,
  },
  get_library_item: {
    title: '读取资产库完整条目',
    effect: 'read',
    schema: item,
    method: 'GET',
    path: (a) => API.libraryItem(String(a.id)),
    pathname: /^\/api\/library\/[^/]+$/,
  },
  create_library_item: {
    title: '新建资产库条目（独立保存）',
    effect: 'edit',
    schema: CreateLibraryItem,
    method: 'POST',
    path: () => API.library,
    pathname: /^\/api\/library$/,
    body: (a) => a,
  },
  update_library_item: {
    title: '更新资产库条目（独立保存，不自动同步画布）',
    effect: 'edit',
    schema: z.object({ id, patch: UpdateLibraryItem }),
    method: 'PATCH',
    path: (a) => API.libraryItem(String(a.id)),
    pathname: /^\/api\/library\/[^/]+$/,
    body: (a) => a.patch,
  },
  delete_library_item: {
    title: '删除资产库条目（不能通过画布撤销）',
    effect: 'destructive',
    schema: item,
    method: 'DELETE',
    path: (a) => API.libraryItem(String(a.id)),
    pathname: /^\/api\/library\/[^/]+$/,
  },
  capture_panorama: {
    title: '从全景保存命名视角',
    effect: 'edit',
    schema: z.object({ id, request: PanoramaCaptureRequest }),
    method: 'POST',
    path: (a) => `${API.libraryItem(String(a.id))}/panorama-view`,
    pathname: /^\/api\/library\/[^/]+\/panorama-view$/,
    body: (a) => a.request,
  },
  archive_character_image: {
    title: '归档已采用的角色图片',
    effect: 'edit',
    schema: z.object({ id, request: ArchiveCharacterImage }),
    method: 'POST',
    path: (a) => `${API.libraryItem(String(a.id))}/character-image`,
    pathname: /^\/api\/library\/[^/]+\/character-image$/,
    body: (a) => a.request,
  },
  get_library_updates: {
    title: '读取跨画布版本差异',
    effect: 'read',
    schema: item,
    method: 'GET',
    path: (a) => `${API.libraryItem(String(a.id))}/updates`,
    pathname: /^\/api\/library\/[^/]+\/updates$/,
  },
  apply_library_updates: {
    title: '按版本凭据同步、固定或解除固定画布资产（跨画布独立保存）',
    effect: 'edit',
    schema: z.object({ id, request: ApplyLibraryUpdates }),
    method: 'POST',
    path: (a) => `${API.libraryItem(String(a.id))}/updates`,
    pathname: /^\/api\/library\/[^/]+\/updates$/,
    body: (a) => a.request,
  },
  list_templates: {
    title: '读取已保存的工作流模板',
    effect: 'read',
    schema: empty,
    method: 'GET',
    path: () => API.templates,
    pathname: /^\/api\/templates$/,
  },
  save_template: {
    title: '保存工作流模板（独立保存）',
    effect: 'edit',
    schema: CreateTemplate,
    method: 'POST',
    path: () => API.templates,
    pathname: /^\/api\/templates$/,
    body: (a) => a,
  },
  delete_template: {
    title: '删除工作流模板（不能通过画布撤销）',
    effect: 'destructive',
    schema: item,
    method: 'DELETE',
    path: (a) => API.template(String(a.id)),
    pathname: /^\/api\/templates\/[^/]+$/,
  },
  list_voices: {
    title: '读取音色和训练状态',
    effect: 'read',
    schema: empty,
    method: 'GET',
    path: () => API.voices,
    pathname: /^\/api\/voices$/,
  },
  create_voice: {
    title: '设计、复刻或登记音色（设计和复刻调用平台）',
    effect: 'run',
    schema: CreateVoice,
    method: 'POST',
    path: () => API.voices,
    pathname: /^\/api\/voices$/,
    body: (a) => a,
  },
  update_voice: {
    title: '修改音色名称与属性',
    effect: 'edit',
    schema: z.object({ id, patch: UpdateVoice }),
    method: 'PATCH',
    path: (a) => API.voice(String(a.id)),
    pathname: /^\/api\/voices\/[^/]+$/,
    body: (a) => a.patch,
  },
  refresh_voice: {
    title: '重新查询音色训练状态',
    effect: 'edit',
    schema: item,
    method: 'POST',
    path: (a) => API.voiceRefresh(String(a.id)),
    pathname: /^\/api\/voices\/[^/]+\/refresh$/,
  },
  delete_voice: {
    title: '删除已登记音色（不能通过画布撤销）',
    effect: 'destructive',
    schema: item,
    method: 'DELETE',
    path: (a) => API.voice(String(a.id)),
    pathname: /^\/api\/voices\/[^/]+$/,
  },
  recognize_subtitles: {
    title: '识别对白时间戳（调用平台，复用既有识别记录）',
    effect: 'run',
    schema: SubtitleRecognizeRequest,
    method: 'POST',
    path: () => API.subtitleRecognize,
    pathname: /^\/api\/media\/subtitle-recognize$/,
    body: (a) => a,
  },
  get_subtitle_recognition: {
    title: '核查字幕识别任务',
    effect: 'read',
    schema: SubtitleRecognitionLookup,
    method: 'GET',
    path: (a) => `${API.subtitleRecognition}?${new URLSearchParams(a as Record<string, string>)}`,
    pathname: /^\/api\/media\/subtitle-recognition$/,
  },
  recover_subtitle_recognition: {
    title: '恢复字幕识别任务（重新提交须核实未受理）',
    effect: 'run',
    schema: SubtitleRecoverRequest,
    method: 'POST',
    path: () => API.subtitleRecover,
    pathname: /^\/api\/media\/subtitle-recover$/,
    body: (a) => a,
  },
  export_sequence_project: {
    title: '导出 OTIO/FCPXML/SRT 与素材工程包（返回短期下载地址）',
    effect: 'edit',
    schema: SequenceExportRequest,
    method: 'POST',
    path: () => API.sequenceExport,
    pathname: /^\/api\/media\/sequence-export$/,
    body: (a) => a,
  },
}
const cap = capabilityFor<ServerContext>()
function action(name: string) {
  const a = actions[name]
  if (!a || !Object.hasOwn(actions, name))
    throw new CapabilityError(`没有画布操作 ${name}，先用 list_canvas_actions 查询`)
  return a
}
export const canvasActionInfo = (name: string) => ({
  title: action(name).title,
  effect: action(name).effect,
})

export const listCanvasActions = cap({
  name: 'list_canvas_actions',
  title: '查询扩展画布操作',
  group: 'read',
  where: 'server',
  effect: 'read',
  description:
    '发现与界面共用服务的素材、资产库、场景全景、跨画布资产同步、模板、音色、字幕识别及剪辑工程导出操作。指定 action 返回完整输入契约；不填返回目录。',
  input: z.object({ action: id.optional() }),
  run: (_ctx, a) =>
    a.action
      ? {
          action: a.action,
          title: action(a.action).title,
          effect: action(a.action).effect,
          input_schema: z.toJSONSchema(action(a.action).schema),
        }
      : Object.entries(actions).map(([name, a]) => ({
          action: name,
          title: a.title,
          effect: a.effect,
        })),
})
export const performCanvasAction = cap({
  name: 'perform_canvas_action',
  title: '执行扩展画布操作',
  group: 'project',
  where: 'server',
  effect: (a) => action(a.action).effect,
  description:
    '执行 list_canvas_actions 列出的操作。必须先查询具体 action 的 schema，input 按契约填写。调用与界面相同的服务及所有权校验。资产库、模板、音色、字幕记录和跨画布同步独立保存，不属于当前轮画布撤销；导出只返回下载地址。付费操作与删除遵循原确认规则。',
  input: z
    .object({ action: id, input: z.record(z.string(), z.unknown()).default({}) })
    .superRefine((value, ctx) => {
      if (!Object.hasOwn(actions, value.action)) {
        ctx.addIssue({
          code: 'custom',
          path: ['action'],
          message: '操作不存在，先用 list_canvas_actions 查询',
        })
        return
      }
      const parsed = action(value.action).schema.safeParse(value.input)
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          ctx.addIssue({ code: 'custom', path: ['input', ...issue.path], message: issue.message })
    }),
  run: async (ctx, a) => {
    const spec = action(a.action)
    const parsed = spec.schema.safeParse(a.input)
    if (!parsed.success) throw new CapabilityError(`参数不对：${z.prettifyError(parsed.error)}`)
    if (!ctx.env.canvasApi) throw new CapabilityError('扩展画布服务不可用')
    const input = parsed.data as Record<string, unknown>
    const body = spec.body?.(input)
    const url = new URL(`http://plein.internal${spec.path(input)}`)
    // 参数里的 id 可能带 ../ 或 ?，URL 解析会把它们折成别的路由；按解析后的 pathname 复核。
    if (!spec.pathname.test(url.pathname)) throw new CapabilityError('操作路径不合法')
    const response = await ctx.env.canvasApi(
      ctx.env.ownerId,
      new Request(url, {
        method: spec.method,
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
        signal: ctx.env.execution?.abort.signal,
      }),
    )
    if (response.status === 204) return { success: true }
    const result = (await response.json()) as Record<string, unknown>
    if (!response.ok)
      throw new CapabilityError(
        String(result.message ?? result.error ?? `操作失败 ${response.status}`),
      )
    return a.action === 'get_asset'
      ? { ...result, download_url: `${API.asset(String(input.id))}?download=1` }
      : result
  },
})
export const actionCapabilities = [listCanvasActions, performCanvasAction]
