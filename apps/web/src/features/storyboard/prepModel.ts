import {
  expandedNodes,
  mentionElements,
  referenceAssets,
  resolveShotAsset,
} from '@plein/capabilities'
import { getCreativeReview, sourceMapOf, type CanvasElement, type PleinDoc } from '@plein/doc'
import { mentionName, type Shot } from '@plein/nodes'
import { continuityIssueText } from './CreativeReviewForm'
import { reviewNodesForShot, shotReviewStatus } from './reviewModel'
import { sourceExcerpt, sourceUnitStatus } from './sourceMapping'

export type PrepCategory = 'missing' | 'source' | 'review'
export type PrepField = 'description' | 'characters' | 'imagePrompt' | 'motionPrompt' | 'dialogue'

export interface PrepIssue {
  id: string
  category: PrepCategory
  label: string
  detail?: string
  shotId?: string
  field?: PrepField
  assetName?: string
  assetId?: string
  dialogueId?: string
  sourceUnitId?: string
  /** 在镜头工作台处理（如衔接意见），不去分镜表定位字段 */
  workbench?: boolean
}

export interface ShotPrep {
  shotId: string
  no: number
  issues: PrepIssue[]
  missingCount: number
}

export interface StoryboardPrep {
  shots: ShotPrep[]
  sourceIssues: PrepIssue[]
  count: number
  missingCount: number
}

export interface ShotScene {
  key: string
  label: string
}

/** 只读汇总当前事实；名称能唯一解析时沿用现有绑定规则，重名或失效绑定绝不猜测。 */
export function storyboardPrep(
  doc: PleinDoc,
  boardId: string,
  shots: readonly Shot[],
): StoryboardPrep {
  const named = mentionElements(doc)
  const groups = expandedNodes(doc, boardId)
  const rows = shots.map((shot) => {
    const issues: PrepIssue[] = []
    const add = (issue: Omit<PrepIssue, 'shotId'>) => issues.push({ ...issue, shotId: shot.id })
    if (!shot.description.trim())
      add({ id: 'description', category: 'missing', label: '填写画面描述', field: 'description' })
    if (!shot.imagePrompt.trim())
      add({
        id: 'image-prompt',
        category: 'missing',
        label: '填写分镜图提示词',
        field: 'imagePrompt',
      })
    if (!shot.motionPrompt.trim())
      add({
        id: 'motion-prompt',
        category: 'missing',
        label: '填写视频运动提示词',
        field: 'motionPrompt',
      })

    const referenced = new Set<string>()
    const checkAsset = (
      name: string,
      binding: Parameters<typeof resolveShotAsset>[2],
      target: { id: string; field: PrepField; dialogueId?: string; prefix?: string },
    ) => {
      const el = resolveShotAsset(doc, name, binding)
      if (!el) {
        const count = named.get(name)?.length ?? 0
        const problem = binding
          ? `「${name}」的绑定已失效或不唯一，请重新选择`
          : count > 1
            ? `「${name}」有重名，需要选择唯一资产卡`
            : `「${name}」尚未绑定资产卡`
        add({
          id: target.id,
          category: 'missing',
          label: `${target.prefix ?? ''}${problem}`,
          field: target.field,
          assetName: name,
          dialogueId: target.dialogueId,
        })
        return
      }
      if (
        !referenced.has(el.id) &&
        (el.nodeType === 'plein/character' || el.nodeType === 'plein/scene') &&
        referenceAssets(doc, el, 'image').length === 0
      ) {
        referenced.add(el.id)
        add({
          id: `reference:${name}:${el.id}`,
          category: 'missing',
          label: `${el.nodeType === 'plein/character' ? '角色卡' : '场景卡'}「${mentionName(el) ?? name}」缺少参考图`,
          field: target.field,
          assetName: name,
          dialogueId: target.dialogueId,
          assetId: el.id,
        })
      }
    }
    for (const name of new Set(shot.characters))
      checkAsset(name, shot.assetBindings?.[name], { id: `binding:${name}`, field: 'characters' })
    shot.dialogue.forEach((line, index) => {
      if (!line.line.trim()) return
      const name = line.character.trim()
      if (!name) {
        add({
          id: `dialogue-character:${line.id ?? index}`,
          category: 'missing',
          label: `第 ${index + 1} 句台词缺少角色`,
          field: 'dialogue',
          dialogueId: line.id,
        })
      } else {
        // 展开优先使用逐句 speaker；出场绑定有效不能掩盖某一句的失效绑定。
        checkAsset(name, line.speaker ?? shot.assetBindings?.[name], {
          id: `dialogue-binding:${line.id ?? index}`,
          field: 'dialogue',
          dialogueId: line.id,
          prefix: `第 ${index + 1} 句台词：`,
        })
      }
    })

    const nodes = reviewNodesForShot(shot, groups.get(shot.id) ?? [])
    if (nodes.length) {
      const status = shotReviewStatus(nodes, shot)
      if (status !== 'usable') {
        // 衔接细分项来自采用候选的验收标签；列出后直接去镜头工作台处理
        const tags = new Set(
          nodes.flatMap((node) => {
            const review = getCreativeReview(node)
            return review?.status === 'changes' ? review.tags : []
          }),
        )
        const continuity = continuityIssueText([...tags])
        add({
          id: 'review',
          category: 'review',
          label:
            status === 'changes' ? (continuity ?? '审核提出的修改待处理') : '已有节点待人工审核',
          ...(continuity ? { workbench: true as const } : {}),
        })
      }
    }
    return {
      shotId: shot.id,
      no: shot.no,
      issues,
      missingCount: issues.filter((issue) => issue.category === 'missing').length,
    }
  })

  const record = sourceMapOf(doc, boardId)
  const activeSnapshots = new Set(record.sources.map((source) => source.activeSnapshotId))
  const currentShots = new Set(shots.map((shot) => shot.id))
  const sourceIssues = record.units
    .filter((unit) => activeSnapshots.has(unit.snapshotId) && unit.disposition === 'in_scope')
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
    .flatMap((unit): PrepIssue[] => {
      const status = sourceUnitStatus(doc, boardId, record, unit)
      if (status === '未读') return []
      const linked = record.links.some(
        (link) => link.unitId === unit.id && currentShots.has(link.shotId),
      )
      if (linked && status !== '待复核') return []
      const snapshot = record.snapshots.find((item) => item.id === unit.snapshotId)
      return [
        {
          id: `source:${unit.id}`,
          category: 'source',
          label: linked ? '原文关联已变化，建议复核' : '原文段落尚未关联镜头，建议核对',
          detail: snapshot ? sourceExcerpt(snapshot.text, unit.start, unit.end, 80) : undefined,
          sourceUnitId: unit.id,
        },
      ]
    })
  return {
    shots: rows,
    sourceIssues,
    count: rows.reduce((total, row) => total + row.issues.length, 0) + sourceIssues.length,
    missingCount: rows.reduce((total, row) => total + row.missingCount, 0),
  }
}

export interface ShotSceneIndex {
  byName: ReadonlyMap<string, CanvasElement[]>
}

export function createShotSceneIndex(doc: PleinDoc): ShotSceneIndex {
  const byName = new Map<string, CanvasElement[]>()
  for (const el of doc.elements()) {
    if (el.nodeType !== 'plein/scene') continue
    const name = mentionName(el)
    if (!name) continue
    byName.set(name, [...(byName.get(name) ?? []), el])
  }
  return { byName }
}

/** 场景筛选沿用镜头资产绑定；尚未唯一绑定的场景名仍可作为显示分组。 */
export function shotScenes(
  doc: PleinDoc,
  shot: Shot,
  index = createShotSceneIndex(doc),
): ShotScene[] {
  const out = new Map<string, ShotScene>()
  for (const name of new Set(shot.characters)) {
    const el = resolveShotAsset(doc, name, shot.assetBindings?.[name])
    if (el?.nodeType === 'plein/scene') {
      const title = mentionName(el) ?? name
      const duplicate = (index.byName.get(title)?.length ?? 0) > 1
      out.set(`asset:${el.id}`, {
        key: `asset:${el.id}`,
        label: duplicate ? `${title} · ${el.id.slice(-6)}` : title,
      })
    } else if (index.byName.has(name)) {
      out.set(`name:${name}`, { key: `name:${name}`, label: `${name}（待绑定）` })
    }
  }
  return [...out.values()]
}

export function storyboardSceneOptions(
  doc: PleinDoc,
  shots: readonly Shot[],
  index = createShotSceneIndex(doc),
): ShotScene[] {
  const out = new Map<string, ShotScene>()
  for (const shot of shots)
    for (const scene of shotScenes(doc, shot, index)) out.set(scene.key, scene)
  return [...out.values()]
}
