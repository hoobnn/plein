import type { Engine } from '@plein/canvas-core'
import { type ClipboardData, exportElements, importElements } from '@plein/doc'
import type { Catalog, FlowRunOptions, GroupRunStarted, GroupRunState } from '@plein/protocol'
import { ApiError, api } from '../api/client'
import { findNode, isPure } from './nodes'

/** Frame 即分组：运行整组、存为模板 */

/** 组内要调模型的节点（与服务端整组运行的范围一致） */
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

export interface GroupRun {
  succeeded: number
  /** 参数和输入都没变，沿用已有结果 */
  cached: number
  failed: number
  canceled: number
  /** 上游失败、取消而没有运行的 */
  skipped: number
  /** 整组被停止 */
  stopped: boolean
}

/** 轮询间隔；查询偶发失败时按次数翻倍退避，连续失败超过 POLL_RETRIES 次才放弃 */
const POLL_MS = 1000
const POLL_RETRIES = 4

export interface GroupRunHooks {
  /** 中止轮询（服务端的运行不受影响） */
  signal?: AbortSignal
  onStart?(groupId: string): void
}

/**
 * 整组运行：服务端按组内连线的依赖调度（上游成功才跑下游，上游失败的下游跳过），
 * 参数和输入都没变的节点沿用已有结果，force 为 true 时全部重跑。
 * 默认不跑视频节点（贵且慢），video 为 true 时一起跑。关掉页面不影响运行。
 * 没能开始或查不到进度时抛出错误，中止时抛出 signal 的原因。
 */
export function runGroup(
  canvasId: string,
  frameId: string,
  opts: { video?: boolean; force?: boolean } & GroupRunHooks = {},
): Promise<GroupRun> {
  const body = { video: opts.video ?? false, force: opts.force ?? false }
  return start(() => api.runFrame(canvasId, frameId, body), opts)
}

/**
 * 从一个节点出发运行：upstream 运行到此处（它和上游，没改动的沿用），
 * downstream 运行它和下游（它自己总是重跑，下游输入变了的跟着重跑）。
 */
export function runFlow(
  canvasId: string,
  nodeId: string,
  scope: FlowRunOptions['scope'],
  opts: { force?: boolean } & GroupRunHooks = {},
): Promise<GroupRun> {
  return start(() => api.runFlow(canvasId, nodeId, { scope, force: opts.force ?? false }), opts)
}

/** 发起运行并轮询到结束 */
async function start(
  begin: () => Promise<GroupRunStarted>,
  { signal, onStart }: GroupRunHooks,
): Promise<GroupRun> {
  signal?.throwIfAborted()
  const { groupId } = await begin()
  onStart?.(groupId)
  let failures = 0
  for (;;) {
    await wait(POLL_MS * 2 ** failures, signal)
    let state: GroupRunState
    try {
      state = await api.groupRun(groupId, signal)
      failures = 0
    } catch (err) {
      if (signal?.aborted) throw signal.reason
      // 网络抖动、服务端偶发 5xx 时运行还在继续，退避后再问
      const transient = !(err instanceof ApiError) || err.status >= 500
      if (!transient) throw err
      if (++failures > POLL_RETRIES)
        throw new Error('查不到整组运行的进度，运行仍在继续，可在任务面板查看')
      continue
    }
    if (state.status === 'running') continue
    const s = state.summary
    return {
      succeeded: s?.succeeded ?? 0,
      cached: s?.cached ?? 0,
      failed: s?.failed ?? 0,
      canceled: s?.canceled ?? 0,
      skipped: s?.skipped ?? 0,
      stopped: state.status === 'canceled',
    }
  }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((ok, fail) => {
    if (signal?.aborted) return fail(signal.reason)
    const onAbort = () => {
      clearTimeout(timer)
      fail(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      ok()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 停止整组运行：组内正在跑和排队的节点一起取消 */
export function cancelGroup(groupId: string): Promise<void> {
  return api.cancelGroup(groupId)
}

/** 整组运行结果的提示语 */
export function describeGroupRun(name: string, r: GroupRun) {
  return describeRun(`「${name}」`, r)
}

/** 运行到此处 / 运行下游的提示语 */
export function describeFlowRun(scope: FlowRunOptions['scope'], name: string, r: GroupRun) {
  return describeRun(scope === 'upstream' ? `运行到「${name}」` : `从「${name}」往下`, r)
}

function describeRun(title: string, r: GroupRun) {
  if (!r.stopped && r.succeeded === 0 && !r.failed && !r.canceled && !r.skipped)
    return `${title}：都没有改动，沿用原结果`
  const parts = [`${title}${r.stopped ? '已停止' : '运行完成'}：${r.succeeded} 个生成`]
  if (r.cached) parts.push(`${r.cached} 个没有改动沿用原结果`)
  if (r.failed) parts.push(`${r.failed} 个失败`)
  if (r.canceled) parts.push(`${r.canceled} 个已取消`)
  if (r.skipped) parts.push(`${r.skipped} 个${r.stopped ? '没有开始' : '因上游失败跳过'}`)
  return parts.join('，')
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
