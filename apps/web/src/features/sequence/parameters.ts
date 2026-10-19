import { animaticNode, sequenceNode } from '@plein/nodes'

/** 只提出恢复建议，读取旧文档时不自动修改原始数据。 */
export function sequenceParameterProblem(value: unknown, animatic = false) {
  const schema = animatic ? animaticNode.params : sequenceNode.params
  const parsed = schema.safeParse(value === undefined ? {} : value)
  if (parsed.success) return null
  const shape = schema.shape
  const whole = parsed.error.issues.some((issue) => !issue.path.length)
  const keys = whole
    ? Object.keys(shape)
    : [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].filter((key) =>
        Object.hasOwn(shape, key),
      )
  const defaults: Record<string, unknown> = schema.parse({})
  return {
    whole,
    labels: keys.map((key) => {
      const field = shape[key as keyof typeof shape]
      return String(field?.meta()?.title ?? key)
    }),
    lists: keys.some((key) => ['clips', 'shots', 'subtitleTrack'].includes(key)),
    patch: Object.fromEntries(keys.map((key) => [key, defaults[key]])),
  }
}
