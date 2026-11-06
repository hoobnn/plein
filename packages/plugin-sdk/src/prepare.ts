/**
 * 能力执行前流程的声明类型：覆盖批次计划（run_storyboard）、输入预检（run_node）、
 * 方案确认（propose_edit）三种形态。调度器读到声明后通用分派：answer 直接返回给调用方；
 * 否则按 request（或审批模式）建确认单，批准后运行 run，未声明时运行原调用。
 */

/** 与 MCP 工具结果同形；形状声明在 SDK，宿主各自实现序列化 */
export interface CapabilityToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'resource_link'; uri: string; name: string; mimeType?: string; description?: string }
  >
  isError?: boolean
}

/** 声明了 prepare 的能力在建确认单前给出的准备结果 */
export interface PreparedCall {
  /** 不建确认单、直接返回给调用方的结果（预检清单、无待运行项、输入预检不通过） */
  answer?: CapabilityToolResult | string
  /**
   * 确认单的内容：给了 reason 就不经审批模式直接建单（方案即确认单，用户要在卡片上选范围）；
   * 只给 storyboardBatch 等附加内容时，是否建单仍按审批模式。
   */
  request?: { reason?: string; ids?: string[]; storyboardBatch?: unknown }
  /** 建单后回传给宿主的完整对象（修改方案卡片用它跟踪状态） */
  card?: unknown
  /** needs_approval 返回里的附加字段（给用户审阅的计划） */
  detail?: Record<string, unknown>
  /** needs_approval 返回里给模型的下一步提示；不填用通用文案 */
  next?: string
  /**
   * 批准（或无需批准直接执行）时运行的调用，替代原调用；只写执行体，自己负责回合校验。
   * 串行化：无需确认的直接执行沿用外层工具调用已有的串行化，不重复排队；
   * 用户批准后的异步恢复入口由调度器 serialize（设 serialize: true）。
   */
  serialize?: boolean
  run?(choice: unknown, approvalId: string | undefined): Promise<CapabilityToolResult | string>
}

/** 调度器提供给 prepare 的宿主回调 */
export interface CapabilityPrepareContext {
  /** 方案卡片出现或状态变了（id 是确认单 id） */
  onEditPlan?(approvalId: string, plan: unknown): void
}
