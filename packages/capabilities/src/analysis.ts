import {
  createElement,
  currentResult,
  groupElements,
  inputEdges,
  type PleinDoc,
  ReadOnlyDocError,
  spotRightOf,
} from '@plein/doc'
import { SHOT_ANALYSIS_TYPE, ShotAnalysisManifest } from '@plein/nodes'

export function analysisManifest(doc: PleinDoc, nodeId: string, resultId?: string) {
  const node = doc.get(nodeId)
  if (node?.nodeType !== SHOT_ANALYSIS_TYPE) return undefined
  const result = resultId
    ? node.results?.find((result) => result.id === resultId && result.port === 'analysis')
    : currentResult(node, 'analysis')
  const parsed = ShotAnalysisManifest.safeParse(
    result?.value.type === 'json' ? result.value.value : undefined,
  )
  return result && parsed.success ? { result, manifest: parsed.data } : undefined
}

/** Resolve the connected output port, including a non-primary video output. */
export function analysisInputAssetId(doc: PleinDoc, nodeId: string) {
  const edges = inputEdges(doc, nodeId, 'video')
  if (edges.length !== 1) return undefined
  const [sourceId, port] = edges[0]!.from
  const source = doc.get(sourceId)
  if (source?.kind === 'video') return port === 'video' ? source.assetId : undefined
  const value = source?.kind === 'node' ? currentResult(source, port)?.value : undefined
  return value?.type === 'video' ? value.assetId : undefined
}

/** Place immutable assets from the exact selected report, as one undoable command. */
export function placeAnalysisAssets(
  doc: PleinDoc,
  nodeId: string,
  resultId: string,
  selected: readonly string[],
  kind: 'frames' | 'clips' | 'audio',
) {
  if (doc.readOnly) throw new ReadOnlyDocError()
  const report = analysisManifest(doc, nodeId, resultId)
  if (!report) throw new Error('拉片清单已变化或无法读取，请重新选择')
  const { manifest } = report
  const selection = new Set(selected)
  const scenes = manifest.scenes.filter((scene) => selection.has(scene.id))
  const files =
    kind === 'audio'
      ? manifest.audio
        ? [{ asset: manifest.audio, name: '原音轨', start: 0, end: manifest.duration }]
        : []
      : scenes.flatMap((scene) => {
          const asset = kind === 'frames' ? scene.frame : scene.clip
          return asset
            ? [
                {
                  asset,
                  name: `镜头 ${manifest.scenes.indexOf(scene) + 1} · ${kind === 'frames' ? '关键帧' : '片段'}`,
                  start: scene.start,
                  end: scene.end,
                },
              ]
            : []
        })
  if (!files.length)
    throw new Error(kind === 'audio' ? '这份清单没有原音轨' : '请勾选已有对应素材的镜头')
  const at = spotRightOf(doc, nodeId, 1040, Math.ceil(files.length / 3) * 240)
  const ids: string[] = []
  doc.undo.stopCapturing()
  doc.ydoc.transact(() => {
    for (const [index, file] of files.entries())
      ids.push(
        createElement(doc, {
          kind: file.asset.kind,
          assetId: file.asset.assetId,
          name: file.name,
          x: at.x + (index % 3) * 340,
          y: at.y + Math.floor(index / 3) * 240,
          w: file.asset.kind === 'audio' ? 300 : 320,
          h: file.asset.kind === 'audio' ? 160 : 200,
          params: {
            shotAnalysisOrigin: {
              sourceAssetId: manifest.source.assetId,
              start: file.start,
              end: file.end,
              timeBasis: manifest.timeBasis,
            },
          },
        }),
      )
    groupElements(doc, ids, {
      name: `拉片 · ${kind === 'frames' ? '关键帧' : kind === 'clips' ? '视频片段' : '原音轨'}`,
    })
  }, doc.origin)
  doc.undo.stopCapturing()
  return ids
}
