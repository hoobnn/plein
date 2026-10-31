import { mentionTargetsIn, referenceAssets, shotsOf } from '@plein/capabilities'
import { continuityOf, currentShotPlan, type PleinDoc } from '@plein/doc'
import {
  findMentions,
  matchSceneView,
  mentionProblem,
  sceneViewsOf,
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

export interface ScenePrepAmbiguousReference {
  reference: string
  problem: string
}

export interface ScenePrepAmbiguousShot extends ScenePrepShot {
  ambiguities: ScenePrepAmbiguousReference[]
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
  ambiguous: ScenePrepAmbiguousShot[]
  missing: ScenePrepMissingShot[]
}

// 镜头号平级时按 id 兜底：numeric 让 a2 < a10 按数值比较，不随运行环境变。
const collate = new Intl.Collator(['en'], { numeric: true }).compare

/** 只读汇总一个场景在当前画布全部镜头里的视角与人物站位，不推测失效或不唯一的绑定。 */
export function scenePrep(doc: PleinDoc, sceneElementId: string): ScenePrepResult | null {
  const scene = doc.get(sceneElementId)
  if (scene?.nodeType !== 'plein/scene') return null
  const views = sceneViewsOf(scene.params?.sceneViews)
  const targets = mentionTargetsIn(doc)
  const sceneIndex = createShotSceneIndex(doc)
  const byView = new Map(views.map((view) => [view.id, [] as ScenePrepShot[]]))
  const unspecified: ScenePrepShot[] = []
  const ambiguous: ScenePrepAmbiguousShot[] = []
  const missing: ScenePrepMissingShot[] = []
  // 分镜表按 doc.elements() 的枚举顺序排，与创建引导、序列实例选择器、交付检查等其他
  // 分镜列表一致；z 只在同级内有意义，跨 Frame 全局比较不代表绘制顺序，置顶也会改 z，
  // 表名更不参与排序（中文数字的码点/拼音序都不等于集数顺序）。
  const boards = [...doc.elements()].filter((el) => el.nodeType === 'plein/storyboard')
  const boardRank = new Map(boards.map((board, index) => [board.id, index]))
  const compareShots = (a: ScenePrepShot, b: ScenePrepShot) =>
    (boardRank.get(a.boardId) ?? 0) - (boardRank.get(b.boardId) ?? 0) ||
    a.no - b.no ||
    collate(a.shotId, b.shotId)

  for (const board of boards) {
    const record = continuityOf(doc, board.id)
    const boardName = board.name?.trim() || '分镜表'
    const shots = shotsOf(board).sort((a, b) => a.no - b.no || collate(a.id, b.id))
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
      const own = mentions.filter(
        ({ mention }) =>
          mention.id === scene.id || (mention.id === undefined && mention.ids.includes(scene.id)),
      )
      let hasUnspecified = own.length === 0
      const mentionedViews = new Set<string>()
      const ambiguities: ScenePrepAmbiguousShot['ambiguities'] = []
      const problems: ScenePrepMissingShot['references'] = []
      for (const { mention, text } of own) {
        if (mention.id === undefined) {
          // 没有唯一目标时 findMentions 不解析 / 视角；这里只按原词边界取出原文，不猜目标。
          const suffix = matchSceneView(text.slice(mention.end), [])
          const reference = `${text.slice(mention.start, mention.end)}${
            suffix?.miss === undefined ? '' : `/${suffix.miss}`
          }`
          const problem = mentionProblem(mention)
          if (
            problem &&
            !ambiguities.some((item) => item.reference === reference && item.problem === problem)
          )
            ambiguities.push({ reference, problem })
        } else if (mention.sceneView) {
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
      if (ambiguities.length) ambiguous.push({ ...base, ambiguities })
      if (problems.length) missing.push({ ...base, references: problems })
      if (
        hasUnspecified &&
        mentionedViews.size === 0 &&
        problems.length === 0 &&
        ambiguities.length === 0
      )
        unspecified.push(base)
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
    ambiguous: ambiguous.sort(compareShots),
    missing: missing.sort(compareShots),
  }
}
