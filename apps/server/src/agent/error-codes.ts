/**
 * 机器可读的错误码：调用方（外部应用或程序）按 code 分支，不用解析中文消息。
 * 在 MCP 工具调用的公共出口统一归类，各能力不用逐个声明。
 */
export type ErrorCode =
  | 'not_found'
  | 'stale'
  | 'needs_user'
  | 'input_changed'
  | 'forbidden_scope'
  | 'blocked'
  | 'invalid_params'
  | 'internal'
  | 'too_large'
  | 'rate_limited'
  | 'failed'

/** 结果体里 status 字段直接对应的码（成功返回但需要调用方处理的情形） */
const STATUS_CODES: Record<string, ErrorCode> = {
  stale: 'stale',
  input_changed: 'input_changed',
  needs_approval: 'needs_user',
  needs_user: 'needs_user',
  blocked: 'blocked',
}

/** 由错误消息归类。能力抛出的是中文说明，约定「code: 说明」前缀优先 */
export function classifyError(message: string): ErrorCode {
  const prefixed = /^([a-z][a-z_]+):/.exec(message)?.[1]
  if (prefixed === 'tool_result_too_large') return 'too_large'
  if (prefixed === 'expected_version_required' || prefixed === 'stale') return 'stale'
  if (prefixed === 'input_changed') return 'input_changed'
  if (prefixed === 'blocked') return 'blocked'
  if (message.startsWith('参数不对')) return 'invalid_params'
  if (/已变化|已经变化|过期|版本不一致|版本已变|不是最新|stale/.test(message)) return 'stale'
  if (/输入或任务已变化/.test(message)) return 'input_changed'
  if (
    /没有.{0,12}(画布|元素|节点|连线|能力|资产|运行记录|节点类型|结果|预设|确认单|方案)|不存在|找不到/.test(
      message,
    )
  )
    return 'not_found'
  if (/需要用户|请用户|用户跳过|确认单已经过期/.test(message)) return 'needs_user'
  if (/缺少|阻断|不能运行|无法运行|没有可用|未启用|还没有结果|需要先/.test(message))
    return 'blocked'
  return 'failed'
}

/** 成功结果的 JSON 正文里带 status 时返回对应的码 */
export function statusCode(text: string): ErrorCode | undefined {
  if (text.length > 64 * 1024 || text[0] !== '{') return undefined
  try {
    const status = (JSON.parse(text) as { status?: unknown }).status
    return typeof status === 'string' ? STATUS_CODES[status] : undefined
  } catch {
    return undefined
  }
}
