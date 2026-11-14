import type { NodeResult } from '../types'

/**
 * 同组关联：按候选关联键（outputGroup）取同次运行的指定端口结果；
 * 旧数据没有关联键时只有跨端口唯一配对才兼容，不猜第一条。
 */
export function relatedResult(
  all: readonly NodeResult[],
  chosen: NodeResult,
  port: string,
): NodeResult | undefined {
  const related = all.filter((r) => r.runId === chosen.runId)
  const list = related.filter((r) => r.port === port)
  if (chosen.outputGroup !== undefined) {
    const group = related.filter((r) => r.outputGroup === chosen.outputGroup)
    const outputs = group.filter((r) => r.port === port)
    return group.filter((r) => r.port === chosen.port).length === 1 && outputs.length === 1
      ? outputs[0]
      : undefined
  }
  return related.filter((r) => r.port === chosen.port).length === 1 &&
    list.length === 1 &&
    list[0]!.outputGroup === undefined
    ? list[0]
    : undefined
}
