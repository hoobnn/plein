import type { CanvasElement } from '@plein/doc'
import type { ArrangedClip } from '@plein/nodes'

export interface Row extends ArrangedClip {
  el?: CanvasElement
  /** 上游还没有结果 */
  pending: boolean
}
