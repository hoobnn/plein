import {
  API,
  type AgentAccess,
  type AgentApprovalMode,
  type AgentKind,
  type AgentSession,
  type AgentSessionSummary,
  type AgentStatus,
  type Asset,
  type AssetVariant,
  type Canvas,
  type Catalog,
  type CreateLibraryItem,
  type DefaultModelUpdate,
  type JobList,
  type JobInfo,
  type BatchItem,
  type RecoverJobOptions,
  type LibraryItem,
  type LibraryKind,
  type BatchRunOptions,
  type FlowRunOptions,
  type GroupRunOptions,
  type GroupRunStarted,
  type GroupRunState,
  type MediaCapsInfo,
  type MediaDerivation,
  type MediaDeriveRequest,
  type SequenceExportRequest,
  type NodeRunOptions,
  type NodeRunStarted,
  type PreparedInput,
  type Project,
  type ProjectImportPreview,
  type ProjectImportResult,
  type ProjectPackageSummary,
  type ProviderConfigUpdate,
  type ProviderConfigView,
  type ProviderTestResult,
  type RewritePrompt,
  type RewritePromptResult,
  type SessionInfo,
  type StaleNodes,
  type ImpactDecision,
  type ImpactReport,
  type ImpactRunOptions,
  type KeepResults,
  type UpdateLibraryItem,
  type UserTemplate,
  type CapabilityCall,
  type CapabilityCallResult,
  type PluginCapabilityInfo,
  type ExternalMcpStatus,
  type LocalCliInfo,
  type LocalCliUpdateResult,
  type ExternalMcpToken,
  type ApplyEditPlan,
  type EditPlan,
  type ReviseEditPlan,
} from '@plein/protocol'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** 错误响应的完整内容（如 input_changed 带回的新实际输入） */
    readonly body?: unknown,
  ) {
    super(message)
  }
}

/** 401 时通知外壳回到登录页 */
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn
}

/** 发请求并把非 2xx 统一转成 ApiError */
async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, { credentials: 'same-origin', ...init })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string
      message?: string
      code?: string
    } | null
    if (res.status === 401 && !path.startsWith(API.auth)) onUnauthorized?.()
    throw new ApiError(
      res.status,
      body?.error ?? body?.code ?? 'http_error',
      body?.message ?? res.statusText,
      body ?? undefined,
    )
  }
  return res
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await send(path, init)
  // 204 / 202 这类没有响应体的应答
  const body = await res.text()
  return (body ? JSON.parse(body) : undefined) as T
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export const api = {
  session: () => request<SessionInfo>(API.session),
  /** 首次创建所有者账号（Better Auth 注册，成功后即登录） */
  setup: (input: { name: string; email: string; password: string }) =>
    request(`${API.auth}/sign-up/email`, json('POST', input)),
  login: (input: { email: string; password: string }) =>
    request(`${API.auth}/sign-in/email`, json('POST', input)),
  logout: () => request(`${API.auth}/sign-out`, json('POST', {})),

  projects: () => request<Project[]>(API.projects),
  project: (id: string) => request<Project>(API.project(id)),
  /** 新建项目，服务端同时建好第一张画布（lastCanvasId） */
  createProject: (title?: string) =>
    request<Project>(API.projects, json('POST', title ? { title } : {})),
  renameProject: (id: string, title: string) =>
    request<Project>(API.project(id), json('PATCH', { title })),
  deleteProject: (id: string) => request<void>(API.project(id), { method: 'DELETE' }),
  projectCanvases: (id: string) => request<Canvas[]>(API.projectCanvases(id)),
  /** 导出前的概要：范围、数量和大小 */
  projectPackageSummary: (id: string, history: boolean) =>
    request<ProjectPackageSummary>(API.projectPackageSummary(id, history)),
  /** 上传项目包做预检，通过时返回预检结果（还没写入） */
  inspectProjectPackage: (file: File) =>
    request<ProjectImportPreview>(API.projectImports, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    }),
  commitProjectImport: (token: string) =>
    request<ProjectImportResult>(API.projectImport(token), { method: 'POST' }),
  discardProjectImport: (token: string) =>
    request<void>(API.projectImport(token), { method: 'DELETE' }),
  canvases: () => request<Canvas[]>(API.canvases),
  createCanvas: (projectId: string, title?: string) =>
    request<Canvas>(API.canvases, json('POST', { projectId, ...(title ? { title } : {}) })),
  canvas: (id: string) => request<Canvas>(API.canvas(id)),
  renameCanvas: (id: string, title: string) =>
    request<Canvas>(API.canvas(id), json('PATCH', { title })),
  deleteCanvas: (id: string) => request<void>(API.canvas(id), { method: 'DELETE' }),
  templates: () => request<UserTemplate[]>(API.templates),
  /** data 是 ClipboardData（Frame 及其内容），服务端按 TemplateData 校验 */
  saveTemplate: (title: string, data: object) =>
    request<UserTemplate>(API.templates, json('POST', { title, data })),
  deleteTemplate: (id: string) => request<void>(API.template(id), { method: 'DELETE' }),

  library: (kind?: LibraryKind) =>
    request<LibraryItem[]>(kind ? `${API.library}?kind=${kind}` : API.library),
  createLibraryItem: (body: CreateLibraryItem) =>
    request<LibraryItem>(API.library, json('POST', body)),
  updateLibraryItem: (id: string, body: UpdateLibraryItem) =>
    request<LibraryItem>(API.libraryItem(id), json('PATCH', body)),
  deleteLibraryItem: (id: string) => request<void>(API.libraryItem(id), { method: 'DELETE' }),
  markLibraryUsed: (id: string) => request<void>(API.libraryUse(id), json('POST', {})),

  catalog: () => request<Catalog>(API.catalog),
  /** 画布最近的运行记录（任务面板） */
  canvasJobs: (id: string) => request<JobList>(API.canvasJobs(id)),
  providerConfig: (id: string) => request<ProviderConfigView>(API.providerConfig(id)),
  updateProviderConfig: (id: string, body: ProviderConfigUpdate) =>
    request<ProviderConfigView>(API.providerConfig(id), json('PUT', body)),
  setDefaultModel: (body: DefaultModelUpdate) =>
    request<{ defaultModels: Catalog['defaultModels'] }>(API.modelDefaults, json('PUT', body)),
  testProvider: (id: string) => request<ProviderTestResult>(API.providerTest(id), json('POST', {})),
  rewritePrompt: (body: RewritePrompt) =>
    request<RewritePromptResult>(API.promptRewrite, json('POST', body)),

  agentStatus: (refresh = false) =>
    request<AgentStatus>(refresh ? `${API.agent}?refresh=1` : API.agent),
  agentSessions: (canvasId: string) => request<AgentSessionSummary[]>(API.agentSessions(canvasId)),
  createAgentSession: (canvasId: string, agent: AgentKind) =>
    request<AgentSession>(API.agentSessions(canvasId), json('POST', { agent })),
  agentSession: (id: string) => request<AgentSession>(API.agentSession(id)),
  deleteAgentSession: (id: string) => request<void>(API.agentSession(id), { method: 'DELETE' }),
  sendAgentMessage: (
    id: string,
    text: string,
    selection?: string[],
    opts: { approval?: AgentApprovalMode; plan?: boolean; access?: AgentAccess } = {},
  ) => request<void>(API.agentMessages(id), json('POST', { text, selection, ...opts })),
  decideAgentApproval: (id: string, approvalId: string, allow: boolean, pick?: ApplyEditPlan) =>
    request<void>(API.agentApproval(id, approvalId), json('POST', { allow, ...pick })),
  reviseAgentEditPlan: (id: string, approvalId: string, edits: ReviseEditPlan['edits']) =>
    request<EditPlan>(API.agentEditPlan(id, approvalId), json('POST', { edits })),
  stopAgent: (id: string) => request<void>(API.agentStop(id), json('POST', {})),
  undoAgentTurn: (id: string, turn: string) =>
    request<void>(API.agentUndo(id, turn), json('POST', {})),
  capabilities: () => request<PluginCapabilityInfo[]>(API.capabilities),
  localClis: (refresh = false) =>
    request<LocalCliInfo[]>(refresh ? `${API.agentClis}?refresh=1` : API.agentClis),
  updateLocalCli: (id: string) =>
    request<LocalCliUpdateResult>(API.agentCliUpdate(id), json('POST', {})),
  externalMcp: () => request<ExternalMcpStatus>(API.mcpExternal),
  issueExternalMcp: () => request<ExternalMcpToken>(API.mcpExternal, json('POST', {})),
  revokeExternalMcp: () => request<void>(API.mcpExternal, { method: 'DELETE' }),
  callCapability: (canvasId: string, name: string, body: Partial<CapabilityCall>) =>
    request<CapabilityCallResult>(API.capabilityCall(canvasId, name), json('POST', body)),
  undoCapabilityCall: (id: string) => request<void>(API.capabilityUndo(id), json('POST', {})),

  /** expect 为用户看过的实际输入哈希：输入在那之后变了，服务端返回 409 input_changed */
  runNode: (canvasId: string, nodeId: string, opts: NodeRunOptions = {}) =>
    request<NodeRunStarted>(API.nodeRun(canvasId, nodeId), json('POST', opts)),
  /** 节点的实际输入预览（不调用付费生成） */
  nodeInput: (canvasId: string, nodeId: string) =>
    request<PreparedInput>(API.nodeInput(canvasId, nodeId)),
  cancelNode: (canvasId: string, nodeId: string) =>
    request<void>(API.nodeCancel(canvasId, nodeId), { method: 'POST' }),
  /** 整组运行 Frame 里的节点 */
  runFrame: (canvasId: string, frameId: string, body: GroupRunOptions) =>
    request<GroupRunStarted>(API.frameRun(canvasId, frameId), json('POST', body)),
  /** 运行到此处 / 运行下游 */
  runFlow: (canvasId: string, nodeId: string, body: FlowRunOptions) =>
    request<GroupRunStarted>(API.nodeFlowRun(canvasId, nodeId), json('POST', body)),
  /** 批量运行一组节点，它们 @ 到的卡片的上游先跑 */
  runBatch: (canvasId: string, nodeId: string, body: BatchRunOptions) =>
    request<GroupRunStarted>(API.nodeBatchRun(canvasId, nodeId), json('POST', body)),
  groupRun: (groupId: string, signal?: AbortSignal) =>
    request<GroupRunState>(API.groupRun(groupId), { signal }),
  cancelGroup: (groupId: string) => request<void>(API.groupCancel(groupId), { method: 'POST' }),
  groupItems: (groupId: string) => request<BatchItem[]>(API.groupItems(groupId)),
  /** 任务恢复：重新获取、填任务 ID 续查、核查后重新提交、标记已处理 */
  recoverJob: (canvasId: string, jobId: string, body: RecoverJobOptions) =>
    request<JobInfo>(API.jobRecover(canvasId, jobId), json('POST', body)),
  canvasStale: (canvasId: string) => request<StaleNodes>(API.canvasStale(canvasId)),
  /** 修改的影响（只读，不调用付费平台） */
  canvasImpact: (canvasId: string) => request<ImpactReport>(API.canvasImpact(canvasId)),
  /** 保留过期结果；输入在查看后又变了时服务端返回 409 input_changed */
  keepResults: (canvasId: string, body: KeepResults) =>
    request<ImpactDecision[]>(API.impactKeep(canvasId), json('POST', body)),
  revokeKeep: (canvasId: string, id: string) =>
    request<void>(API.impactDecision(canvasId, id), { method: 'DELETE' }),
  /** 只运行勾选的受影响节点 */
  runImpact: (canvasId: string, body: ImpactRunOptions) =>
    request<GroupRunStarted>(API.impactRun(canvasId), json('POST', body)),

  mediaDerive: (body: MediaDeriveRequest) =>
    request<MediaDerivation>(API.mediaDerive, json('POST', body)),
  /** 剪辑工程（OTIO / FCPXML + 素材）：返回一个短期下载地址 */
  sequenceExport: (body: SequenceExportRequest) =>
    request<{ url: string }>(API.sequenceExport, json('POST', body)),
  mediaCaps: () => request<MediaCapsInfo>(API.mediaCaps),

  assetMeta: (id: string) => request<Asset>(API.assetMeta(id)),
  /** 资产原文件 */
  assetBlob: async (id: string) => (await send(API.asset(id))).blob(),
  upload: (file: File) =>
    request<Asset>(API.assets, {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name),
      },
      body: file,
    }),
}

export const assetUrls = {
  original: (id: string) => API.asset(id),
  variant: (id: string, v: AssetVariant) => API.assetVariant(id, v),
}

/** 同步地址：与页面同源（开发时经 Vite 代理） */
export function syncUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${API.sync}`
}
