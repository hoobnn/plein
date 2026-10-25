import { z } from 'zod'
import { AssetVariant } from './assets'

export const API = {
  session: '/api/session',
  /** Better Auth 接口前缀：sign-up/email、sign-in/email、sign-out */
  auth: '/api/auth',
  templates: '/api/templates',
  template: (id: string) => `/api/templates/${encodeURIComponent(id)}`,
  projects: '/api/projects',
  project: (id: string) => `/api/projects/${encodeURIComponent(id)}`,
  /** 项目下的画布，按最近修改排序 */
  projectCanvases: (id: string) => `/api/projects/${encodeURIComponent(id)}/canvases`,
  /** 下载项目包（.plein）；history=1 时带上全部历史候选 */
  projectPackage: (id: string, history = false) =>
    `/api/projects/${encodeURIComponent(id)}/package${history ? '?history=1' : ''}`,
  /** 导出前的概要，返回 ProjectPackageSummary */
  projectPackageSummary: (id: string, history = false) =>
    `/api/projects/${encodeURIComponent(id)}/package/summary${history ? '?history=1' : ''}`,
  /** 导入项目包：POST 包文件本身，校验后返回 ProjectImportPreview */
  projectImports: '/api/project-imports',
  /** 预检过的导入：POST 确认写入（返回 ProjectImportResult），DELETE 放弃 */
  projectImport: (token: string) => `/api/project-imports/${encodeURIComponent(token)}`,
  canvases: '/api/canvases',
  canvas: (id: string) => `/api/canvases/${encodeURIComponent(id)}`,
  /** 资产库：GET 列表（?kind=），POST 新建，body 为 CreateLibraryItem */
  library: '/api/library',
  libraryItem: (id: string) => `/api/library/${encodeURIComponent(id)}`,
  /** 记一次「用到画布上」，最近使用按它排 */
  libraryUse: (id: string) => `/api/library/${encodeURIComponent(id)}/use`,
  /** 我的音色：GET 列表（顺带刷新训练中的状态），POST 复刻或登记，body 为 CreateVoice */
  voices: '/api/voices',
  voice: (id: string) => `/api/voices/${encodeURIComponent(id)}`,
  /** 立即向平台查一次训练状态 */
  voiceRefresh: (id: string) => `/api/voices/${encodeURIComponent(id)}/refresh`,
  assets: '/api/assets',
  asset: (id: string) => `/api/assets/${id}`,
  assetMeta: (id: string) => `/api/assets/${id}/meta`,
  assetVariant: (id: string, v: AssetVariant) => `/api/assets/${id}/${v}`,
  /** 媒体加工：裁剪 / 旋转 / 镜像 / 截取 / 变速 / 切分 / 音视频分离 / 抽帧，body 为 MediaDeriveRequest */
  mediaDerive: '/api/media/derive',
  mediaCollage: '/api/media/collage',
  /** 本机媒体能力，返回 MediaCapsInfo */
  mediaCaps: '/api/media/caps',
  /** 字幕字体：导出烧字幕用的那个字体，预览加载同一个文件；返回 SubtitleFontInfo，没有时 404 */
  subtitleFont: '/api/media/subtitle-font',
  subtitleFontFile: (version: string) =>
    `/api/media/subtitle-font/file?v=${encodeURIComponent(version)}`,
  /** 导出剪辑工程：POST SequenceExportRequest，返回 { url }，再 GET 那个地址下载 zip */
  sequenceExport: '/api/media/sequence-export',
  subtitleRecognize: '/api/media/subtitle-recognize',
  subtitleRecognition: '/api/media/subtitle-recognition',
  subtitleRecover: '/api/media/subtitle-recover',
  sequenceExportFile: (token: string) => `/api/media/sequence-export/${encodeURIComponent(token)}`,
  catalog: '/api/catalog',
  /** 本机第三方插件：列表（GET）、重新扫描（POST …/rescan） */
  localPlugins: '/api/plugins/local',
  localPlugin: (id: string) => `/api/plugins/local/${id}`,
  /** 优化 / 翻译提示词，见 RewritePrompt */
  promptRewrite: '/api/prompt/rewrite',
  /** Provider id 形如 vendor/name，直接作为两段路径 */
  providerConfig: (id: string) => `/api/providers/${id}/config`,
  providerTest: (id: string) => `/api/providers/${id}/test`,
  modelDefaults: '/api/model-defaults',
  /** 运行画布上的一个节点；状态与结果经 Yjs 同步回画布 */
  nodeRun: (canvasId: string, nodeId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/nodes/${encodeURIComponent(nodeId)}/run`,
  nodeCancel: (canvasId: string, nodeId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/nodes/${encodeURIComponent(nodeId)}/cancel`,
  /** 节点的实际输入预览，返回 PreparedInput；不调用付费生成 */
  nodeInput: (canvasId: string, nodeId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/nodes/${encodeURIComponent(nodeId)}/input`,
  /** 运行到此处 / 运行下游，body 为 FlowRunOptions，返回 GroupRunStarted */
  nodeFlowRun: (canvasId: string, nodeId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/nodes/${encodeURIComponent(nodeId)}/run-flow`,
  /** 批量运行，body 为 BatchRunOptions，返回 GroupRunStarted */
  nodeBatchRun: (canvasId: string, nodeId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/nodes/${encodeURIComponent(nodeId)}/run-batch`,
  storyboardBatchPreview: (canvasId: string, nodeId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/nodes/${encodeURIComponent(nodeId)}/storyboard-batch/preview`,
  storyboardBatchCommit: (canvasId: string, nodeId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/nodes/${encodeURIComponent(nodeId)}/storyboard-batch/commit`,
  /** 需要重跑的节点，返回 StaleNodes */
  canvasStale: (canvasId: string) => `/api/canvases/${encodeURIComponent(canvasId)}/stale`,
  /** 修改的影响，返回 ImpactReport；只读，不调用付费平台 */
  canvasImpact: (canvasId: string) => `/api/canvases/${encodeURIComponent(canvasId)}/impact`,
  /** 保留过期结果，body 为 KeepResults，返回 ImpactDecision[] */
  impactKeep: (canvasId: string) => `/api/canvases/${encodeURIComponent(canvasId)}/impact/keep`,
  /** 撤销一条保留决定（记录留着，标为已撤销） */
  impactDecision: (canvasId: string, id: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/impact/keep/${encodeURIComponent(id)}`,
  /** 只运行勾选的受影响节点，body 为 ImpactRunOptions，返回 GroupRunStarted */
  impactRun: (canvasId: string) => `/api/canvases/${encodeURIComponent(canvasId)}/impact/run`,
  /** 整组运行 Frame 里的节点，返回 GroupRunStarted */
  frameRun: (canvasId: string, frameId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/frames/${encodeURIComponent(frameId)}/run`,
  groupRun: (groupId: string) => `/api/runs/groups/${encodeURIComponent(groupId)}`,
  groupCancel: (groupId: string) => `/api/runs/groups/${encodeURIComponent(groupId)}/cancel`,
  /** 批次快照：启动时定下的目标、阶段、批准的输入与结局，返回 BatchItem[] */
  groupItems: (groupId: string) => `/api/runs/groups/${encodeURIComponent(groupId)}/items`,
  /** 任务恢复操作，body 为 RecoverJobOptions，返回处理后的 JobInfo */
  jobRecover: (canvasId: string, jobId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/jobs/${encodeURIComponent(jobId)}/recover`,
  /** 画布最近的运行记录，返回 JobList */
  canvasJobs: (canvasId: string) => `/api/canvases/${encodeURIComponent(canvasId)}/jobs`,
  /** 按精确作业 ID 读取历史记录，返回 JobInfo；不受最近任务数量限制 */
  canvasJob: (canvasId: string, jobId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/jobs/${encodeURIComponent(jobId)}`,
  /** Yjs 同步（y-websocket 协议），房间名为画布 id */
  sync: '/sync',
  /** 本机智能体是否可用，返回 AgentStatus */
  agent: '/api/agent',
  /** 本机 CLI 的安装、登录和版本，返回 LocalCliInfo[]；?refresh=1 重新检测 */
  agentClis: '/api/agent/clis',
  /** 运行 CLI 的更新命令，返回 LocalCliUpdateResult */
  agentCliUpdate: (id: string) => `/api/agent/clis/${encodeURIComponent(id)}/update`,
  /** 画布上的智能体会话：GET 列表，POST 新建 */
  agentSessions: (canvasId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/agent/sessions`,
  agentSession: (id: string) => `/api/agent/sessions/${encodeURIComponent(id)}`,
  agentModels: (agent: string) => `/api/agent/models/${encodeURIComponent(agent)}`,
  agentSkills: (agent: string) => `/api/agent/skills/${encodeURIComponent(agent)}`,
  agentSkill: (agent: string, id: string) =>
    `/api/agent/skills/${encodeURIComponent(agent)}/${encodeURIComponent(id)}`,
  agentContextReset: (id: string) => `/api/agent/sessions/${encodeURIComponent(id)}/context/reset`,
  agentMessages: (id: string) => `/api/agent/sessions/${encodeURIComponent(id)}/messages`,
  agentStop: (id: string) => `/api/agent/sessions/${encodeURIComponent(id)}/stop`,
  /** 允许或跳过一张确认单，body 为 DecideAgentApproval */
  agentApproval: (id: string, approvalId: string) =>
    `/api/agent/sessions/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}`,
  /** 逐项编辑修改方案卡片：POST { edits }，重新检查后返回新方案 */
  agentEditPlan: (id: string, approvalId: string) =>
    `/api/agent/sessions/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}/plan`,
  /** 对外开放的 MCP：GET 状态，POST 生成新令牌（旧的作废），DELETE 关闭 */
  mcpExternal: '/api/mcp/external',
  /** 插件贡献的能力，返回 PluginCapabilityInfo[] */
  capabilities: '/api/capabilities',
  /** 在画布上调用一个插件能力，body 为 CapabilityCall，返回 CapabilityCallResult */
  capabilityCall: (canvasId: string, name: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/capabilities/${encodeURIComponent(name)}`,
  /** 撤销一次能力调用对画布的改动 */
  capabilityUndo: (id: string) => `/api/capability-calls/${encodeURIComponent(id)}/undo`,
  /** 撤销智能体某一轮对画布的改动 */
  agentUndo: (id: string, turn: string) =>
    `/api/agent/sessions/${encodeURIComponent(id)}/turns/${encodeURIComponent(turn)}/undo`,
  /** 会话事件流（SSE），见 AgentEvent */
  agentEvents: (id: string) => `/api/agent/sessions/${encodeURIComponent(id)}/events`,
} as const

export const ApiError = z.object({ error: z.string(), message: z.string() })
export type ApiError = z.infer<typeof ApiError>
