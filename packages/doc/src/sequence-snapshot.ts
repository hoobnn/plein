/** Sequence JSON owns its values. A shared object must never bypass Yjs transactions. */
export function sequenceSnapshot<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => sequenceSnapshot(item))) as T
  if (value && typeof value === 'object')
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sequenceSnapshot(item)])),
    ) as T
  return value
}

/** Fixed video values and every new original-result tuple own their evidence independently. */
export function snapshotResultEvidence<T>(value: T): T {
  const protectedResult = (
    result: { value?: { type?: unknown }; generationOrigin?: unknown } | null | undefined,
  ) => result?.value?.type === 'video' || result?.generationOrigin !== undefined
  if (!Array.isArray(value) || !value.some(protectedResult)) return value
  return Object.freeze(
    value.map((result) => {
      if (result?.value?.type === 'video') return sequenceSnapshot(result)
      if (result?.generationOrigin === undefined) return result
      // Only the new metadata is isolated for non-video results; legacy payload semantics stay intact.
      const snapshot = { ...result }
      Object.defineProperty(snapshot, 'generationOrigin', {
        value: sequenceSnapshot(result.generationOrigin),
        enumerable: true,
        writable: false,
        configurable: false,
      })
      return snapshot
    }),
  ) as T
}

/** New executed provenance is immutable evidence; legacy delivery shape keeps its existing path. */
export function snapshotTypedDeliveries<T>(value: T): T {
  const typed =
    Array.isArray(value) &&
    value.some(
      (record) =>
        record &&
        typeof record === 'object' &&
        (record.historical === true ||
          (Array.isArray(record.sources) &&
            record.sources.some(
              (source: unknown) =>
                source &&
                typeof source === 'object' &&
                ('clipInstanceId' in source || 'segmentId' in source),
            ))),
    )
  return typed ? sequenceSnapshot(value) : value
}
