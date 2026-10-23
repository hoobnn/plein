import { CompositionSourceRef } from '@plein/plugin-sdk/ports'

/** 所有消费方共享的显式来源根：源包、冻结参数清单与原素材。 */
export function compositionAssetIds(source: CompositionSourceRef | undefined): string[] {
  const parsed = CompositionSourceRef.safeParse(source)
  if (!parsed.success) return []
  const value = parsed.data
  return [...new Set([value.bundleAssetId, value.manifestAssetId, ...value.dependencyAssetIds])]
}
