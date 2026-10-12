import type { Engine } from '@plein/canvas-core'
import { type ClipboardData, exportElements, importElements } from '@plein/doc'
import type { Catalog } from '@plein/protocol'
import { findNode, isPure } from './nodes'
import { runNode } from './runner'

/**
 * Frame 即分组：运行整组、存为模板。
 * 运行整组目前在前端按依赖顺序逐个调单节点运行接口；M3 任务队列落地后换成服务端整组调度，界面不变。
 */

/** 组内要调模型的节点 */
export function groupNodes(
  engine: Engine,
  frameId: string,
  catalog: Catalog | null,
  video: boolean,
) {
  return engine.doc.descendants(frameId).filter((el) => {
    if (el.kind !== 'node') return false
    const info = findNode(catalog, el.nodeType)
    if (!info || isPure(info) || !info.executable) return false
    return video || info.outputs[0]?.type !== 'video'
  })
}

/** 等某次运行结束：成功返回 true；失败、取消、节点被删或被另一次运行取代返回 false */
function waitRun(engine: Engine, id: string, runId: string): Promise<boolean> {
  return new Promise((resolve) => {
    // 服务端先写状态再返回 runId，但同步可能晚到：见过这次运行后，run.id 变了才算被取代
    let seen = false
    let finished = false
    const done = (ok: boolean) => {
      if (finished) return
      finished = true
      engine.doc.ydoc.off('afterTransaction', check)
      resolve(ok)
    }
    const check = () => {
      const el = engine.doc.get(id)
      if (!el) return done(false)
      const run = el.run
      if (run?.id !== runId) {
        if (seen) done(false)
        return
      }
      seen = true
      if (run.status === 'succeeded') done(true)
      else if (run.status === 'failed' || run.status === 'canceled') done(false)
    }
    engine.doc.ydoc.on('afterTransaction', check)
    check()
  })
}

export interface GroupRun {
  succeeded: number
  failed: number
  /** 上游失败而没有运行的 */
  skipped: number
}

/**
 * 按组内连线的依赖顺序运行：上游都成功后才开始，同一层并发；上游失败的下游跳过。
 * 默认不跑视频节点（贵且慢），video 为 true 时一起跑。
 */
export async function runGroup(
  engine: Engine,
  frameId: string,
  catalog: Catalog | null,
  opts: { video?: boolean } = {},
): Promise<GroupRun> {
  const targets = groupNodes(engine, frameId, catalog, opts.video ?? false)
  const ids = new Set(targets.map((el) => el.id))
  const deps = new Map<string, Set<string>>(targets.map((el) => [el.id, new Set()]))
  for (const e of engine.doc.edges()) {
    if (ids.has(e.to[0]) && ids.has(e.from[0])) deps.get(e.to[0])!.add(e.from[0])
  }

  const result: GroupRun = { succeeded: 0, failed: 0, skipped: 0 }
  const ok = new Set<string>()
  const bad = new Set<string>()
  const pending = new Set(ids)
  const running = new Map<string, Promise<void>>()

  while (pending.size || running.size) {
    for (const id of [...pending]) {
      const up = deps.get(id)!
      if ([...up].some((u) => bad.has(u))) {
        pending.delete(id)
        bad.add(id)
        result.skipped++
      } else if ([...up].every((u) => ok.has(u))) {
        pending.delete(id)
        running.set(
          id,
          (async () => {
            const runId = await runNode(id)
            const success = runId ? await waitRun(engine, id, runId) : false
            if (success) {
              ok.add(id)
              result.succeeded++
            } else {
              bad.add(id)
              result.failed++
            }
            running.delete(id)
          })(),
        )
      }
    }
    // 组内连线成环时剩下的节点永远等不到上游
    if (!running.size) {
      result.skipped += pending.size
      break
    }
    await Promise.race(running.values())
  }
  return result
}

/** 导出 Frame 为模板数据：去掉生成结果和运行状态，只留结构和参数 */
export function templateData(engine: Engine, frameId: string): ClipboardData {
  const data = exportElements(engine.doc, [frameId])
  return {
    ...data,
    elements: data.elements.map(({ results: _r, adopted: _a, run: _run, ...el }) => el),
  }
}

/** 在世界坐标 at 铺出模板（Frame 左上角对齐 at），返回新的顶层 id */
export function placeTemplate(engine: Engine, data: ClipboardData, at: { x: number; y: number }) {
  const root = data.elements[0]
  const ids = importElements(engine.doc, data, {
    dx: Math.round(at.x - (root?.x ?? 0)),
    dy: Math.round(at.y - (root?.y ?? 0)),
  })
  engine.doc.flush()
  engine.selection.set(ids)
  engine.setTool('select')
  return ids
}
