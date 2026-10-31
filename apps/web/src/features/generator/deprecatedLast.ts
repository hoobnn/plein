/** 弃用模型保留给旧画布引用，选择列表稳定置后且不改动目录原数组 */
export function deprecatedLast<T extends { deprecated?: true }>(models: readonly T[]): T[] {
  return [...models].sort((a, b) => Number(Boolean(a.deprecated)) - Number(Boolean(b.deprecated)))
}
