import { expandedNodes, shotsOf, type ShotSource } from '@plein/capabilities'
import { currentResult, inputEdges, setParam, type PleinDoc } from '@plein/doc'
import { type Shot, SHOT_SIZES } from '@plein/nodes'
import type { ModelInfo } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'

export type ControlRole = 'image' | 'video'
export type ControlField = 'imagePrompt' | 'motionPrompt' | 'lighting' | 'shotSize'
export const CONTROL_FIELDS: ControlField[] = [
  'imagePrompt',
  'motionPrompt',
  'lighting',
  'shotSize',
]
export interface ShotControls {
  angle: string
  lens: string
  cameraMotion: string
  subjectMotion: string
  lightPosition: string
  lightDirection: string
  keep: string
  shotSize: '' | Shot['shotSize']
}
export const EMPTY_CONTROLS: ShotControls = {
  angle: '',
  lens: '',
  cameraMotion: '',
  subjectMotion: '',
  lightPosition: '',
  lightDirection: '',
  keep: '',
  shotSize: '',
}
const stable = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  )
const roleOf = (params: Record<string, unknown> | undefined) =>
  (params?.source as ShotSource | undefined)?.role

export interface ControlModel {
  nodeId?: string
  ref: string
  future: boolean
  info?: ModelInfo
}
export interface ControlContext {
  shot: Shot
  signature: string
  models: Record<ControlRole, ControlModel[]>
}

/** 读取实际角色节点及精确模型引用；不会用分镜的文本模型推测视频模型。 */
export function shotControlContext(
  doc: PleinDoc,
  boardId: string,
  shotId: string,
  catalog: Catalog | null,
): ControlContext | undefined {
  const board = doc.get(boardId)
  const raw = board?.params?.shots
  const shots = shotsOf(board)
  if (
    board?.nodeType !== 'plein/storyboard' ||
    !Array.isArray(raw) ||
    raw.length !== shots.length ||
    new Set(shots.map((s) => s.id)).size !== shots.length
  )
    return undefined
  const shot = shots.find((s) => s.id === shotId)
  if (!shot) return undefined
  const nodes = (expandedNodes(doc, boardId).get(shotId) ?? [])
    .filter((node) => ['image', 'video'].includes(String(roleOf(node.params))))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const resolve = (ref: string, role: ControlRole) => {
    for (const provider of catalog?.providers ?? []) {
      if (!provider.enabled || !provider.configured) continue
      const found = provider.models.find(
        (m) => `${provider.id}:${m.id}` === ref && m.capabilities.includes(`${role}.generate`),
      )
      if (found) return found
    }
    return undefined
  }
  const forRole = (role: ControlRole): ControlModel[] => {
    const actual = nodes.filter((n) => roleOf(n.params) === role)
    if (actual.length)
      return actual.map((node) => {
        const ref = String(node.params?.model ?? '')
        return { nodeId: node.id, ref, future: false, info: resolve(ref, role) }
      })
    const ref = catalog?.defaultModels[`${role}.generate`] ?? ''
    return [{ ref, future: true, info: resolve(ref, role) }]
  }
  const models = { image: forRole('image'), video: forRole('video') }
  const signature = stable({
    boardId,
    shotId,
    shot: raw.find(
      (s: unknown) => !!s && typeof s === 'object' && (s as { id?: unknown }).id === shotId,
    ),
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      type: node.nodeType,
      version: node.nodeVersion,
      params: node.params,
      inputs: inputEdges(doc, node.id).map((edge) => ({
        edge,
        source: (() => {
          const source = doc.get(edge.from[0])
          return source
            ? {
                id: source.id,
                assetId: source.assetId,
                type: source.nodeType,
                params: source.params,
                result: currentResult(source, edge.from[1]),
              }
            : null
        })(),
      })),
    })),
    models,
  })
  return { shot, signature, models }
}

export interface ControlDraft {
  signature: string
  role: ControlRole
  controls: ShotControls
  baseShot: Shot
  values: Pick<Shot, ControlField>
}

/** 原文保留为前缀，语义字段分别命名；光影/景别仍由已有planParams统一追加。 */
export function buildControlDraft(
  context: ControlContext,
  role: ControlRole,
  controls: ShotControls,
): ControlDraft {
  const shot = context.shot
  const camera = [
    controls.angle.trim() && `相机视角：${controls.angle.trim()}`,
    controls.lens.trim() && `焦段意图：${controls.lens.trim()}`,
  ]
  const keep = controls.keep.trim() && `保持：${controls.keep.trim()}`
  const imagePrompt = [
    shot.imagePrompt || shot.description,
    ...camera,
    controls.subjectMotion.trim() && `主体动作／姿态：${controls.subjectMotion.trim()}`,
    keep,
  ]
    .filter(Boolean)
    .join('；')
  const motionPrompt = [
    shot.motionPrompt || shot.description,
    ...camera,
    controls.cameraMotion.trim() && `相机运动：${controls.cameraMotion.trim()}`,
    controls.subjectMotion.trim() && `主体动作：${controls.subjectMotion.trim()}`,
    keep,
  ]
    .filter(Boolean)
    .join('；')
  const lighting = [
    shot.lighting,
    controls.lightPosition.trim() && `光源位置：${controls.lightPosition.trim()}`,
    controls.lightDirection.trim() && `照射方向：${controls.lightDirection.trim()}`,
  ]
    .filter(Boolean)
    .join('；')
  return {
    signature: context.signature,
    role,
    controls: { ...controls },
    baseShot: shot,
    values: { imagePrompt, motionPrompt, lighting, shotSize: controls.shotSize || shot.shotSize },
  }
}

/** 只写用户勾选字段；展开节点、模型、参考和其他镜头一律经过原有差异同步入口。 */
export function applyControlDraft(
  doc: PleinDoc,
  boardId: string,
  shotId: string,
  catalog: Catalog | null,
  draft: ControlDraft,
  fields: readonly ControlField[],
): boolean {
  if (doc.readOnly) return false
  const context = shotControlContext(doc, boardId, shotId, catalog)
  if (
    !context ||
    context.signature !== draft.signature ||
    !fields.length ||
    fields.some((f) => !CONTROL_FIELDS.includes(f))
  )
    return false
  if (
    !SHOT_SIZES.includes(draft.values.shotSize) ||
    fields.some((f) => typeof draft.values[f] !== 'string')
  )
    return false
  const board = doc.get(boardId)!
  const raw = board.params!.shots as Array<Record<string, unknown>>
  const patch = Object.fromEntries(
    [...new Set(fields)].map((field) => [field, draft.values[field]]),
  )
  doc.undo.stopCapturing()
  setParam(
    doc,
    boardId,
    'shots',
    raw.map((shot) => (shot.id === shotId ? { ...shot, ...patch, edited: true } : shot)),
  )
  doc.undo.stopCapturing()
  return true
}
