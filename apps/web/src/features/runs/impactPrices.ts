import type { ImpactNode } from '@plein/protocol'

/** 各币种分别估算，沿用候选不计入调用费用。 */
export function impactPrices(nodes: ImpactNode[]) {
  const amounts = new Map<string, number>()
  let unknown = 0
  for (const node of nodes) {
    if (node.cached) continue
    if (node.price)
      amounts.set(node.price.currency, (amounts.get(node.price.currency) ?? 0) + node.price.amount)
    else unknown++
  }
  return { prices: [...amounts].map(([currency, amount]) => ({ currency, amount })), unknown }
}
