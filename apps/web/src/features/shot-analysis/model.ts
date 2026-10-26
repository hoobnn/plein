import { shotAnalysisRanges } from '@plein/nodes'
import { parseTimecode } from '../../canvas/media'
export { analysisManifest, analysisInputAssetId, placeAnalysisAssets } from '@plein/capabilities'

export function parseAnalysisCuts(text: string, duration: number) {
  const points = text.trim()
    ? text
        .trim()
        .split(/[,，;；\s]+/)
        .map((value) => {
          const point = parseTimecode(value)
          if (point === null) throw new Error('切点须为秒数或时间码，用逗号分隔')
          return point
        })
    : []
  shotAnalysisRanges(duration, points)
  return points
}
