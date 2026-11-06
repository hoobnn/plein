export interface NumberRange {
  type?: string
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
}

/** 按字段约定取整、收拢范围；不依赖浏览器的 stepMismatch。 */
export function clampNumber(range: NumberRange, value: number) {
  let result = range.type === 'integer' ? Math.round(value) : value
  if (range.minimum !== undefined) result = Math.max(range.minimum, result)
  if (range.maximum !== undefined) result = Math.min(range.maximum, result)
  return result
}

export interface NumberDraft {
  text: string
  base: number | undefined
}

type Resolution =
  | { kind: 'conflict' }
  | { kind: 'invalid' }
  | { kind: 'commit'; value: number | undefined }

/** 冻结编辑基线并在提交时对照最新值；无效数字与主动清空有不同含义。 */
export function resolveNumberDraft(
  draft: NumberDraft,
  current: number | undefined,
  range: NumberRange,
  badInput: boolean,
  force = false,
): Resolution {
  if (!force && !Object.is(draft.base, current)) return { kind: 'conflict' }
  if (badInput) return { kind: 'invalid' }
  const text = draft.text.trim()
  if (!text) return { kind: 'commit', value: undefined }
  const number = Number(text)
  if (!Number.isFinite(number)) return { kind: 'invalid' }
  // 开区间边界没有「最近的合法值」可夹，越界按无效输入处理并保留原值
  if (range.exclusiveMinimum !== undefined && number <= range.exclusiveMinimum)
    return { kind: 'invalid' }
  if (range.exclusiveMaximum !== undefined && number >= range.exclusiveMaximum)
    return { kind: 'invalid' }
  return { kind: 'commit', value: clampNumber(range, number) }
}
