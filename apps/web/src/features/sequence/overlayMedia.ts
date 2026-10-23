import {
  sequenceOverlays,
  type ArrangedClip,
  type SequenceParams,
  type Timeline,
} from '@plein/nodes'
import type { PortValue } from '@plein/plugin-sdk'
/** 与宿主导出窗口相同的门禁：预览不得把超出源结尾的停帧伪装为可导出视频。 */
export function overlayMediaProblem(
  params: Pick<SequenceParams, 'overlays'>,
  rows: ArrangedClip[],
  inputs: PortValue[],
  timeline: Timeline,
  duration: (assetId: string) => number | undefined,
): string | undefined {
  for (const overlay of sequenceOverlays(params, rows, inputs, timeline)) {
    const full = duration(overlay.asset.assetId)
    if (full === undefined || !Number.isFinite(full) || full <= 0)
      return '叠加素材时长尚未就绪，请等待或重新加载预览后再导出'
    if (overlay.in + overlay.duration * overlay.speed > full + 1e-3)
      return '叠加素材窗口超出源视频结尾，请缩短时长、减小入点或速度'
  }
  return undefined
}
