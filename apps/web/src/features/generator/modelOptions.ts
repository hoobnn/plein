/** 损坏的历史值仅在显示时按空表单呈现；用户明确修改或恢复默认才写回。 */
export function optionRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function replaceModelOptions(value: unknown, model: string, next: Record<string, unknown>) {
  return { ...optionRecord(value), [model]: next }
}
