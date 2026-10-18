/** 用独立的选项标识保持枚举原始类型，避免 1、'1' 或默认占位符互相混淆。 */
export function enumField(values: unknown[], current: unknown, labels?: Record<string, string>) {
  const options = values.map((original, index) => ({
    value: `option:${index}`,
    label: labels?.[String(original)] ?? String(original),
    original,
  }))
  const selected = options.find((option) => Object.is(option.original, current))
  // 历史值不在枚举中时仍显示实际值，等用户明确选择后再替换。
  if (!selected && current !== undefined)
    options.push({ value: 'unknown', label: String(current), original: current })
  return {
    value: selected?.value ?? (current === undefined ? 'default' : 'unknown'),
    options,
    read: (value: string) => options.find((option) => option.value === value)?.original,
  }
}
