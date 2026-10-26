import { MediaDerivationOrigin, type MediaDerivation } from '@plein/protocol'

/** Loaded when a derivation finishes; the media schemas do not belong to Home's startup. */
export function persistedMediaOrigin(made: MediaDerivation) {
  return MediaDerivationOrigin.safeParse({
    version: 1,
    op: made.op,
    source: made.source,
    params: made.params,
  })
}
