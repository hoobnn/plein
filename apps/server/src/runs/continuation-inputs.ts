import { videoAssetOf, currentResult, type CanvasElement, type PleinDoc } from '@plein/doc'
import { ContinuesFrom } from '@plein/nodes'
import type { NodeDefinition, PortValue } from '@plein/plugin-sdk'
import type { InputIssue } from '@plein/protocol'

/** 续镜接续帧属于实际输入：即使旧连线丢失，也按保存的帧资产补在图片首位。 */
export function continuationInputs(
  doc: PleinDoc,
  el: CanvasElement,
  def: NodeDefinition,
  inputs: Record<string, PortValue[]>,
): { inputs: Record<string, PortValue[]>; issue?: InputIssue } {
  const parsed = ContinuesFrom.safeParse(el.params?.continuesFrom)
  if (def.capability !== 'video.generate' || !parsed.success) return { inputs }
  const from = parsed.data
  const port = def.inputs.find((p) => p.type === 'image')?.id
  const fail = (message: string) => ({
    inputs,
    issue: { code: 'prepare_failed' as const, message },
  })
  if (!port || el.params?.mode === 'text')
    return fail('续镜需要接续帧，请选择图生视频或多模态参考模式')
  const parent = doc.get(from.elementId)
  const live = from.last && parent ? currentResult(parent, 'lastFrame')?.value : undefined
  const liveEdge = [...doc.edges()].some(
    (edge) =>
      edge.from[0] === from.elementId &&
      edge.from[1] === 'lastFrame' &&
      edge.to[0] === el.id &&
      edge.to[1] === port,
  )
  const parentAsset = videoAssetOf(parent)
  const assetId =
    liveEdge && live?.type === 'image'
      ? live.assetId
      : (from.frameAssetId ??
        (parentAsset === from.assetId && live?.type === 'image' ? live.assetId : undefined))
  if (!assetId) return fail('续镜缺少接续帧，请重新取帧后再生成')
  const own = inputs[port] ?? []
  const existing = own.find((v) => v.type === 'image' && v.assetId === assetId)
  const source = [...doc.elements()].find((e) => e.kind === 'image' && e.assetId === assetId)
  const frame: PortValue = existing ?? {
    type: 'image',
    kind: 'image',
    assetId,
    source: source?.id ?? from.elementId,
  }
  return {
    ...(parentAsset && parentAsset !== from.assetId && !liveEdge
      ? {
          issue: {
            code: 'prepare_failed' as const,
            message: '前镜视频已更新，接续帧已旧，请先换成新画面',
          },
        }
      : {}),
    inputs: {
      ...inputs,
      [port]: [frame, ...own.filter((v) => v.type !== 'image' || v.assetId !== assetId)],
    },
  }
}
