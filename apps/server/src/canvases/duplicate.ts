import { randomBytes } from 'node:crypto'
import type { DuplicateCanvas } from '@plein/protocol'
import { canvasState } from '../media-index/references'
import type { MediaIndex } from '../media-index/service'
import { remapDoc } from '../projects/package-remap'
import {
  getCanvas,
  insertCanvasCopy,
  listCanvasJobs,
  moveCanvas,
  newCanvasId,
  ownsProject,
  toCanvas,
} from '../storage/canvases'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'

/** 画布复制与移动：HTTP 路由和智能体工具共用（工具经内部 HTTP 调到路由，走的就是这里） */

export class CanvasOpError extends Error {
  constructor(
    readonly status: 404 | 400,
    message: string,
  ) {
    super(message)
  }
}

export interface CanvasOpDeps {
  db: DB
  rooms: Rooms
  mediaIndex?: MediaIndex
}

const COPY_SUFFIX = ' 副本'
const RUNNING_NOTE = '复制时仍在运行；副本里不会自动续查或重新提交'

/**
 * 复制一张画布，返回新画布。
 * - 文档：取房间里（或库里重放出）的完整 Yjs 状态，元素 id 不变；
 *   画布 id 与运行记录 id 按映射改写（运行记录主键全局唯一，副本拿一套新 id）。
 * - 运行记录：复制为只读历史，进行中的记为已取消，不会续查或重新提交。
 * - 不复制：检查点、撤销历史、智能体会话；资产文件同一所有者下共享，不复制。
 */
export function duplicateCanvas(
  deps: CanvasOpDeps,
  owner: string,
  id: string,
  opts: DuplicateCanvas,
) {
  const source = getCanvas(deps.db, owner, id)
  if (!source) throw new CanvasOpError(404, '画布不存在')
  const projectId = opts.projectId ?? source.project_id
  if (!ownsProject(deps.db, owner, projectId)) throw new CanvasOpError(404, '项目不存在')

  const newId = newCanvasId()
  const map = new Map<string, string>([[id, newId]])
  const now = Date.now()
  const jobs = listCanvasJobs(deps.db, owner, id).map((j) => {
    const next = `run_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
    map.set(j.id, next)
    const active = j.status === 'queued' || j.status === 'running'
    return {
      ...j,
      id: next,
      status: active ? ('canceled' as const) : j.status,
      error: active ? RUNNING_NOTE : j.error,
      finished_at: active ? now : j.finished_at,
    }
  })
  const state = remapDoc(canvasState(deps.db, deps.rooms, id), map)
  insertCanvasCopy(deps.db, owner, {
    id: newId,
    projectId,
    title: opts.title ?? `${source.title}${COPY_SUFFIX}`.slice(0, 200),
    state,
    jobs,
  })
  deps.mediaIndex?.refreshCanvasSafely(newId)
  for (const j of jobs) deps.mediaIndex?.refreshJobSafely(j.id)
  return toCanvas(getCanvas(deps.db, owner, newId)!)
}

/** 把画布移到同一所有者的另一个项目；画布内容、运行记录都不动，只刷新媒体索引里的项目归属 */
export function moveCanvasTo(deps: CanvasOpDeps, owner: string, id: string, projectId: string) {
  if (!getCanvas(deps.db, owner, id)) throw new CanvasOpError(404, '画布不存在')
  if (!ownsProject(deps.db, owner, projectId)) throw new CanvasOpError(404, '项目不存在')
  moveCanvas(deps.db, owner, id, projectId)
  deps.mediaIndex?.refreshCanvasSafely(id)
  for (const j of listCanvasJobs(deps.db, owner, id)) deps.mediaIndex?.refreshJobSafely(j.id)
  return toCanvas(getCanvas(deps.db, owner, id)!)
}
