import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { CapabilityError, capabilityFor } from '@plein/capabilities'
import { PanoramaCaptureRequest } from '@plein/nodes'
import {
  API,
  PROJECT_PACKAGE_EXT,
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
import { LocalPathError, openLocalFile } from '../files/local-path'
import { deliverFile, saveToField } from './tools-files'

/** 复用 UI 路由的文件与资产库操作。只允许这里登记的操作，不开放任意 HTTP。 */
const id = z.string().min(1).max(200)
/** 自己拼内部路径的操作不经过 pathname 复核，id 只放行安全字符，避免 ../ 或 ? 折到别的路由 */
const safeId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/, 'id 只能含字母、数字、- 和 _')
const empty = z.object({})
const item = z.object({ id })
type Action = {
  title: string
  effect: 'read' | 'edit' | 'run' | 'destructive'
  schema: z.ZodObject
  /** 不是单条路由的操作（多步或流式）自己实现；这时不需要下面的 method / path / pathname */
  custom?: (ctx: ServerContext, input: Record<string, unknown>) => Promise<unknown>
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path?: (a: Record<string, unknown>) => string
  /**
   * 允许请求的路径形状。参数里的 id 可能带 ../ 或 ?，URL 解析会把它们折成别的路由，
   * 所以按解析后的 pathname 复核，只放行登记在册的那条路由。
   */
  pathname?: RegExp
  body?: (a: Record<string, unknown>) => unknown
}
async function internalJson(ctx: ServerContext, path: string, init: RequestInit = {}) {
  if (!ctx.env.canvasApi) throw new CapabilityError('扩展画布服务不可用')
  const res = await ctx.env.canvasApi(
    ctx.env.ownerId,
    new Request(`http://plein.internal${path}`, {
      ...init,
      signal: ctx.env.execution?.abort.signal,
    }),
  )
  if (res.status === 204) return {}
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok)
    throw new CapabilityError(String(body.message ?? body.error ?? `操作失败 ${res.status}`))
  return body
}

/** 导出项目包：先取概要确认能导，再签发下载票据；包本身由下载时流式生成，不在这里缓存 */
async function exportProjectPackage(ctx: ServerContext, input: Record<string, unknown>) {
  const projectId = String(input.project_id)
  const history = input.include_history === true
  const project = await internalJson(ctx, API.project(projectId))
  const summary = await internalJson(ctx, API.projectPackageSummary(projectId, history))
  if (summary.tooLarge)
    throw new CapabilityError(
      '项目包超过单个包的 4 GB 上限，缩小范围（不带历史候选）或改用整目录备份',
    )
  const path = API.projectPackage(projectId, history)
  if (!ctx.env.files) return { summary, download_path: path }
  return deliverFile(
    ctx,
    { kind: 'proxy', path },
    {
      name: `${String(project.title ?? 'project')}${PROJECT_PACKAGE_EXT}`,
      mime: 'application/zip',
      extra: { project_id: projectId, summary },
    },
    typeof input.save_to === 'string' ? input.save_to : undefined,
  )
}

/** 导入项目包：与界面相同，先上传预检（校验、暂存），再确认写入；文件取自资产库或本机路径 */
async function importProjectPackage(ctx: ServerContext, input: Record<string, unknown>) {
  const assetId = typeof input.asset_id === 'string' ? input.asset_id : undefined
  const path = typeof input.path === 'string' ? input.path : undefined
  if ((assetId === undefined) === (path === undefined))
    throw new CapabilityError('asset_id 与 path 必须且只能给一个')
  let stream: Readable
  let close: () => Promise<void> = async () => {}
  if (assetId !== undefined) {
    const asset = ctx.env.assets.get(ctx.env.ownerId, assetId)
    if (!asset) throw new CapabilityError(`资产 ${assetId} 不存在`)
    stream = createReadStream(ctx.env.assets.originalPath(asset.id))
  } else {
    const local = ctx.env.files?.local
    if (!local)
      throw new CapabilityError('path 只在本机模式可用；请先用 request_upload 上传，再传 asset_id')
    try {
      const file = await openLocalFile(local, path!, ctx.env.files!.maxUpload)
      stream = file.handle.createReadStream({ autoClose: false })
      close = () => file.handle.close()
    } catch (err) {
      if (err instanceof LocalPathError) throw new CapabilityError(err.message)
      throw err
    }
  }
  let preview: Record<string, unknown>
  try {
    preview = await internalJson(ctx, API.projectImports, {
      method: 'POST',
      body: Readable.toWeb(stream) as ReadableStream,
      duplex: 'half',
    } as RequestInit)
  } finally {
    await close()
  }
  const token = String(preview.token)
  const { token: _token, expiresAt: _expires, ...review } = preview
  if (input.preview_only === true) {
    await internalJson(ctx, API.projectImport(token), { method: 'DELETE' })
    return { status: 'preview', ...review }
  }
  const result = await internalJson(ctx, API.projectImport(token), { method: 'POST' })
  return {
    status: 'imported',
    project_id: result.projectId,
    title: result.title,
    canvas_id: result.canvasId,
    copy: preview.copy,
    counts: preview.counts,
    notices: preview.notices,
    missing: preview.missing,
  }
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
    title: '读取素材元数据和下载地址（外部入口返回带票据的绝对地址与 resource_link）',
    effect: 'read',
    schema: item.extend({ save_to: saveToField }),
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
    title:
      '导出 OTIO/FCPXML/SRT 与素材工程包（返回短期下载地址；外部入口返回带票据的绝对地址与 resource_link）',
    effect: 'edit',
    schema: SequenceExportRequest.extend({ save_to: saveToField }),
    method: 'POST',
    path: () => API.sequenceExport,
    pathname: /^\/api\/media\/sequence-export$/,
    body: ({ save_to: _, ...request }) => request,
  },
  export_project_package: {
    title: '导出项目包（.plein；返回短期下载地址；外部入口返回带票据的绝对地址与 resource_link）',
    effect: 'edit',
    schema: z.object({
      project_id: safeId,
      include_history: z
        .boolean()
        .default(false)
        .describe('带上全部历史候选，默认只含当前采用的结果'),
      save_to: saveToField,
    }),
    custom: exportProjectPackage,
  },
  import_project_package: {
    title: '导入项目包（.plein；以新项目写入，同一项目已存在时作为新副本）',
    effect: 'edit',
    schema: z.object({
      asset_id: id
        .optional()
        .describe('已用 import_asset / request_upload 送进资产库的项目包；与 path 二选一'),
      path: z.string().min(1).max(4096).optional().describe('本机绝对路径（仅本机模式）'),
      preview_only: z.boolean().default(false).describe('只校验并返回概要，不写入'),
    }),
    custom: importProjectPackage,
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
  // 带 save_to 的取出会写本机文件，按 edit 处理
  effect: (a) =>
    action(a.action).effect === 'read' && a.input?.save_to ? 'edit' : action(a.action).effect,
  // 确认里写操作自己的标题（与列表里一致）
  approval: (a) => ({ reason: action(a.action).title, ids: [] }),
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
    const input = parsed.data as Record<string, unknown>
    if (spec.custom) return spec.custom(ctx, input)
    if (!ctx.env.canvasApi) throw new CapabilityError('扩展画布服务不可用')
    const body = spec.body?.(input)
    const url = new URL(`http://plein.internal${spec.path!(input)}`)
    // 参数里的 id 可能带 ../ 或 ?，URL 解析会把它们折成别的路由；按解析后的 pathname 复核。
    if (!spec.pathname!.test(url.pathname)) throw new CapabilityError('操作路径不合法')
    const response = await ctx.env.canvasApi(
      ctx.env.ownerId,
      new Request(url, {
        method: spec.method!,
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
    const saveTo = typeof input.save_to === 'string' ? input.save_to : undefined
    if (ctx.env.files && a.action === 'get_asset') {
      return deliverFile(
        ctx,
        { kind: 'asset', assetId: String(input.id) },
        {
          name: String(result.name ?? input.id),
          mime: typeof result.mime === 'string' ? result.mime : undefined,
          size: typeof result.size === 'number' ? result.size : undefined,
          extra: { asset_id: input.id, metadata: result },
        },
        saveTo,
      )
    }
    if (ctx.env.files && a.action === 'export_sequence_project' && typeof result.url === 'string') {
      return deliverFile(
        ctx,
        { kind: 'proxy', path: result.url },
        {
          name: `${input.spec ? String((input.spec as { name?: string }).name ?? 'sequence') : 'sequence'}.zip`,
          mime: 'application/zip',
        },
        saveTo,
      )
    }
    return a.action === 'get_asset'
      ? { ...result, download_url: `${API.asset(String(input.id))}?download=1` }
      : result
  },
})
export const actionCapabilities = [listCanvasActions, performCanvasAction]
