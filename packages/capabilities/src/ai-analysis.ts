import {
  createElement,
  connect,
  captureSourceSnapshot,
  addSourceUnit,
  setSourceLink,
  spotRightOf,
  ReadOnlyDocError,
  type PleinDoc,
} from '@plein/doc'
import {
  AI_SCENE_TYPE,
  AI_SUMMARY_TYPE,
  AiSceneRequest,
  AiSceneResult,
  AiSummaryRequest,
  Shot,
  type AiDraftReference,
  type AiLocalScope,
} from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { nodeElementOf as nodeElement } from './story/nodes'
import { analysisManifest } from './analysis'

type ReportOrigin = Pick<AiLocalScope['origin'], 'canvasId' | 'nodeId' | 'resultId'>
export function sameReportOrigin(left: ReportOrigin, right: ReportOrigin) {
  return (
    left.canvasId === right.canvasId &&
    left.nodeId === right.nodeId &&
    left.resultId === right.resultId
  )
}

export function aiModels(catalog: Catalog | null, vision: boolean) {
  return (catalog?.providers ?? [])
    .filter((provider) => provider.enabled && provider.configured)
    .flatMap((provider) =>
      provider.models
        .filter(
          (model) =>
            model.capabilities.includes('text.chat') &&
            (!vision || model.features?.includes('vision')),
        )
        .map((model) => ({
          ref: `${provider.id}:${model.id}`,
          title: `${provider.title} · ${model.title}`,
          price: model.price,
        })),
    )
}
function descriptor(catalog: Catalog, type: string) {
  const node = catalog.nodes.find((node) => node.type === type)
  if (!node) throw new Error('分析节点目录不可用，请刷新')
  return node
}
function writable(doc: PleinDoc) {
  if (doc.readOnly) throw new ReadOnlyDocError()
}
export async function createScenePlan(
  doc: PleinDoc,
  catalog: Catalog,
  canvasId: string,
  sourceId: string,
  resultId: string,
  scenes: readonly string[],
  model: string,
  focus: string,
  stillCurrent: () => boolean = () => true,
) {
  writable(doc)
  if (!canvasId || !aiModels(catalog, true).some((item) => item.ref === model))
    throw new Error('请明确选择已配置的视觉模型')
  if (!scenes.length || scenes.length > 3 || new Set(scenes).size !== scenes.length)
    throw new Error('每份分析请选择 1 至 3 个不同镜头')
  const report = analysisManifest(doc, sourceId, resultId)
  if (!report || scenes.some((id) => !report.manifest.scenes.some((scene) => scene.id === id)))
    throw new Error('本地清单已变化，请重新打开')
  const raw = JSON.stringify(report.manifest)
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  writable(doc)
  if (!stillCurrent()) throw new Error('查看对象已变化，未建立分析计划')
  if (JSON.stringify(analysisManifest(doc, sourceId, resultId)?.manifest) !== raw)
    throw new Error('本地清单已变化，未建立分析计划')
  const node = descriptor(catalog, AI_SCENE_TYPE)
  const at = spotRightOf(doc, sourceId, 300, scenes.length * 230)
  const ids: string[] = []
  doc.undo.stopCapturing()
  doc.ydoc.transact(() => {
    for (const [index, id] of scenes.entries()) {
      const scene = report.manifest.scenes.find((scene) => scene.id === id)!
      const scope: AiLocalScope = {
        origin: { canvasId, nodeId: sourceId, resultId, digest },
        source: report.manifest.source,
        duration: report.manifest.duration,
        firstVideoPts: report.manifest.firstVideoPts,
        totalScenes: report.manifest.scenes.length,
        timeBasis: report.manifest.timeBasis,
        scene: { id: scene.id, start: scene.start, end: scene.end, frame: scene.frame },
      }
      const request = AiSceneRequest.parse({
        id: crypto.randomUUID(),
        modelRef: model,
        focus,
        scope,
      })
      ids.push(
        createElement(doc, {
          ...nodeElement(node, { model, request }),
          x: at.x,
          y: at.y + index * 230,
          name: `模型逐镜草稿 · ${id}`,
        }),
      )
    }
  }, doc.origin)
  doc.undo.stopCapturing()
  return ids
}
export function draftReference(
  doc: PleinDoc,
  canvasId: string,
  nodeId: string,
  resultId: string,
): AiDraftReference | undefined {
  const node = doc.get(nodeId)
  if (node?.nodeType !== AI_SCENE_TYPE) return undefined
  const result = node.results?.find((result) => result.id === resultId && result.port === 'draft')
  const value = AiSceneResult.safeParse(
    result?.value.type === 'json' ? result.value.value : undefined,
  )
  return value.success ? { origin: { canvasId, nodeId, resultId }, value: value.data } : undefined
}
function exactDrafts(doc: PleinDoc, drafts: readonly AiDraftReference[]) {
  for (const draft of drafts)
    if (
      JSON.stringify(
        draftReference(doc, draft.origin.canvasId, draft.origin.nodeId, draft.origin.resultId),
      ) !== JSON.stringify(draft)
    )
      throw new Error('所选模型草稿已变化，请重新选择')
}
export function createSummaryPlan(
  doc: PleinDoc,
  catalog: Catalog,
  canvasId: string,
  drafts: AiDraftReference[],
  model: string,
  focus: string,
) {
  writable(doc)
  if (!aiModels(catalog, false).some((item) => item.ref === model))
    throw new Error('请明确选择已配置的归纳模型')
  if (drafts.some((draft) => draft.origin.canvasId !== canvasId))
    throw new Error('草稿不属于当前画布')
  exactDrafts(doc, drafts)
  const request = AiSummaryRequest.parse({
    id: crypto.randomUUID(),
    modelRef: model,
    focus,
    drafts,
  })
  const near = drafts[0]!.origin.nodeId
  const at = spotRightOf(doc, near, 300, 200)
  doc.undo.stopCapturing()
  const id = createElement(doc, {
    ...nodeElement(descriptor(catalog, AI_SUMMARY_TYPE), { model, request }),
    ...at,
    name: '模型采样归纳 · 需独立确认',
  })
  doc.undo.stopCapturing()
  return id
}
/** Data conversion only: no generation, adoption, character binding, speech, or motion claims. */
export function convertAiDrafts(doc: PleinDoc, canvasId: string, drafts: AiDraftReference[]) {
  writable(doc)
  AiSummaryRequest.parse({ id: 'conversion', modelRef: 'data-only', focus: '', drafts })
  if (drafts.some((draft) => draft.origin.canvasId !== canvasId))
    throw new Error('草稿不属于当前画布')
  exactDrafts(doc, drafts)
  const blocks = drafts.map(
    (draft, index) =>
      `模型分析草稿 ${index + 1}（未经人工核实；声音与完整运动未知）\n\`\`\`json\n${JSON.stringify(draft, null, 2)}\n\`\`\``,
  )
  const prefix =
    '# 模型分析草稿 · 非原剧情事实\n\n仅用于可编辑计划，不代表已经看完视频或听取声音。\n\n'
  const text = prefix + blocks.join('\n\n')
  const at = spotRightOf(doc, drafts[0]!.origin.nodeId, 960, 400)
  let source = '',
    board = ''
  doc.undo.stopCapturing()
  doc.ydoc.transact(() => {
    source = createElement(doc, {
      kind: 'markdown',
      name: '模型分析草稿 · 非原剧情事实',
      text,
      params: { aiDraftOrigin: { version: 1, kind: 'ai-shot-draft-origin', drafts } },
      ...at,
      w: 440,
      h: 360,
    })
    const shots = drafts.map((draft, index) =>
      Shot.parse({
        id: crypto.randomUUID(),
        no: index + 1,
        description: draft.value.draft.description,
        duration: 5,
        dialogue: [],
        characters: [],
        motionPrompt: '',
        sfx: '',
      }),
    )
    board = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/storyboard',
      nodeVersion: 1,
      name: '模型分镜草稿 · 待人工核对',
      x: at.x + 500,
      y: at.y,
      w: 320,
      h: 240,
      params: { shots, model: '' },
      ports: {
        inputs: [{ id: 'script', label: '模型草稿来源', type: 'text', multiple: true }],
        outputs: [{ id: 'shots', label: '分镜', type: 'json' }],
      },
    })
    // P05 requires a real current input binding before capture.
    connect(doc, [source, 'text'], [board, 'script'])
    const snapshotId = captureSourceSnapshot(doc, board, {
      canvasId,
      elementId: source,
      port: 'text',
      expectedText: text,
    })!
    let offset = prefix.length
    for (const [index, block] of blocks.entries()) {
      const unitId = addSourceUnit(doc, board, {
        snapshotId,
        start: offset,
        end: offset + block.length,
        kind: 'event',
      })!
      setSourceLink(doc, board, { unitId, shotId: shots[index]!.id, treatment: 'retain' })
      offset += block.length + 2
    }
  }, doc.origin)
  doc.undo.stopCapturing()
  return { source, board }
}
