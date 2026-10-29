import { referenceAssets, shotsOf } from '@plein/capabilities'
import { continuityOf, currentShotPlan, type PleinDoc } from '@plein/doc'
import {
  findMentions,
  mentionName,
  sceneViewsOf,
  type MentionTarget,
  type SceneView,
} from '@plein/nodes'
import { createShotSceneIndex, shotScenes } from '../storyboard/prepModel'

export interface ScenePrepSubject {
  subjectId: string
  label: string
  start?: string
  end?: string
  startPose?: string
  endPose?: string
}

export type ScenePrepContinuity =
  | { state: 'none' }
  | { state: 'conflict' }
  | { state: 'current'; subjects: ScenePrepSubject[] }

export interface ScenePrepShot {
  boardId: string
  boardName: string
  shotId: string
  no: number
  continuity: ScenePrepContinuity
}

export interface ScenePrepMissingReference {
  /** 提示词里没有匹配上的视角名，保留原文供核对。 */
  viewName: string
  reference: string
}

export interface ScenePrepMissingShot extends ScenePrepShot {
  references: ScenePrepMissingReference[]
}

export interface ScenePrepView {
  view: SceneView
  shots: ScenePrepShot[]
}

export interface ScenePrepResult {
  sceneId: string
  name: string
  description: string
  references: string[]
  views: ScenePrepView[]
  unspecified: ScenePrepShot[]
  missing: ScenePrepMissingShot[]
}

const compareShots = (a: ScenePrepShot, b: ScenePrepShot) =>
  a.boardName.localeCompare(b.boardName) ||
  a.boardId.localeCompare(b.boardId) ||
  a.no - b.no ||
  a.shotId.localeCompare(b.shotId)

/** 只读汇总一个场景在当前画布全部镜头里的视角与人物站位，不推测失效或不唯一的绑定。 */
export function scenePrep(doc: PleinDoc, sceneElementId: string): ScenePrepResult | null {
  const scene = doc.get(sceneElementId)
  if (scene?.nodeType !== 'plein/scene') return null
  const views = sceneViewsOf(scene.params?.sceneViews)
  const targets: MentionTarget[] = [...doc.elements()].flatMap((el) => {
    const name = mentionName(el)
    return name
      ? [
          {
            id: el.id,
            name,
            ...(el.nodeType === 'plein/scene'
              ? { sceneViews: sceneViewsOf(el.params?.sceneViews) }
              : {}),
          },
        ]
      : []
  })
  const sceneIndex = createShotSceneIndex(doc)
  const byView = new Map(views.map((view) => [view.id, [] as ScenePrepShot[]]))
  const unspecified: ScenePrepShot[] = []
  const missing: ScenePrepMissingShot[] = []
  const boards = [...doc.elements()]
    .filter((el) => el.nodeType === 'plein/storyboard')
    .sort(
      (a, b) => (a.name ?? '分镜表').localeCompare(b.name ?? '分镜表') || a.id.localeCompare(b.id),
    )

  for (const board of boards) {
    const record = continuityOf(doc, board.id)
    const boardName = board.name?.trim() || '分镜表'
    const shots = shotsOf(board).sort((a, b) => a.no - b.no || a.id.localeCompare(b.id))
    for (const shot of shots) {
      if (!shotScenes(doc, shot, sceneIndex).some((item) => item.key === `asset:${scene.id}`))
        continue
      const current = currentShotPlan(record, shot.id)
      const continuity: ScenePrepContinuity =
        current.state === 'conflict'
          ? { state: 'conflict' }
          : current.state === 'none'
            ? { state: 'none' }
            : {
                state: 'current',
                subjects: [
                  ...new Set([
                    ...Object.keys(current.plan!.content.start),
                    ...Object.keys(current.plan!.content.end),
                  ]),
                ].map((subjectId) => {
                  const start = current.plan!.content.start[subjectId]
                  const end = current.plan!.content.end[subjectId]
                  return {
                    subjectId,
                    label:
                      record.subjects.find((subject) => subject.id === subjectId)?.label ??
                      subjectId,
                    ...(start?.worldPosition !== undefined ? { start: start.worldPosition } : {}),
                    ...(end?.worldPosition !== undefined ? { end: end.worldPosition } : {}),
                    ...(start?.pose !== undefined ? { startPose: start.pose } : {}),
                    ...(end?.pose !== undefined ? { endPose: end.pose } : {}),
                  }
                }),
              }
      const base: ScenePrepShot = {
        boardId: board.id,
        boardName,
        shotId: shot.id,
        no: shot.no,
        continuity,
      }
      const mentions = [shot.imagePrompt, shot.motionPrompt].flatMap((text) =>
        findMentions(text, targets).map((mention) => ({ mention, text })),
      )
      const own = mentions.filter(({ mention }) => mention.id === scene.id)
      let hasUnspecified = own.length === 0
      const mentionedViews = new Set<string>()
      const problems: ScenePrepMissingShot['references'] = []
      for (const { mention, text } of own) {
        if (mention.sceneView) {
          if (!mentionedViews.has(mention.sceneView.id)) {
            byView.get(mention.sceneView.id)?.push(base)
            mentionedViews.add(mention.sceneView.id)
          }
        } else if (mention.sceneViewMiss !== undefined) {
          const problem = {
            viewName: mention.sceneViewMiss,
            reference: text.slice(mention.start, mention.end + mention.sceneViewMiss.length + 1),
          }
          if (
            !problems.some(
              (item) => item.viewName === problem.viewName && item.reference === problem.reference,
            )
          )
            problems.push(problem)
        } else {
          hasUnspecified = true
        }
      }
      if (problems.length) missing.push({ ...base, references: problems })
      if (hasUnspecified) unspecified.push(base)
    }
  }

  return {
    sceneId: scene.id,
    name: scene.name?.trim() || '场景',
    description: String(scene.params?.description ?? ''),
    references: referenceAssets(doc, scene, 'image'),
    views: views.map((view) => ({
      view,
      shots: (byView.get(view.id) ?? []).sort(compareShots),
    })),
    unspecified: unspecified.sort(compareShots),
    missing: missing.sort(compareShots),
  }
}
