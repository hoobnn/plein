import type { FlowRunOptions, PreparedInput } from '@plein/protocol'
import { ApiError, api } from '../../api/client'
import * as groups from '../../canvas/groups'
import { useCanvas } from '../../stores/canvas'
import { groupRunSignal, useGroupRuns } from './groupRuns'
import { cancelRequestKey, useCancelRequests } from './cancelRequests'

/** 界面上的运行操作：取当前画布、发起请求，把结果和错误提示给用户 */

/** 本地演示画布没有服务端文档，不能运行 */
const DEMO_RUN_NOTICE = '演示画布不能运行节点，请在首页新建画布'

const notify = (msg: string) => useCanvas.getState().notify(msg)
const fail = (err: unknown) => notify((err as Error).message)

/** 当前远端画布；本地演示时提示并返回 null */
function remoteCanvas() {
  const { canvasId } = useCanvas.getState()
  if (!canvasId) notify(DEMO_RUN_NOTICE)
  return canvasId
}

/**
 * 返回这次运行的 id；没能开始时返回 null（错误已提示）。
 * 带上用户看过的实际输入（expect）时，输入在那之后变了就不运行，新的实际输入交给 onChanged
 */
export async function runNode(
  id: string,
  check?: { expect?: string; onChanged?(input: PreparedInput): void; retryOf?: string },
): Promise<string | null> {
  const canvasId = remoteCanvas()
  if (!canvasId) return null
  try {
    return (await api.runNode(canvasId, id, { expect: check?.expect, retryOf: check?.retryOf }))
      .runId
  } catch (err) {
    const input = (err instanceof ApiError && err.code === 'input_changed' && err.body) as
      | { input?: PreparedInput }
      | false
    if (check && input && input.input) check.onChanged?.(input.input)
    fail(err)
    return null
  }
}

export async function cancelNode(id: string, runId?: string) {
  const { canvasId, engine } = useCanvas.getState()
  if (!canvasId) return
  const expected = runId ?? engine?.doc.get(id)?.run?.id
  const key = cancelRequestKey(canvasId, id, expected)
  if (!useCancelRequests.getState().begin(key)) return
  try {
    await api.cancelNode(canvasId, id, { runId: expected })
  } catch (err) {
    if (useCanvas.getState().canvasId === canvasId) fail(err)
  } finally {
    useCancelRequests.getState().end(key)
  }
}

export async function cancelGroup(groupId: string) {
  await api.cancelGroup(groupId).catch(fail)
}

/** 整组运行 Frame，结束后提示结果；同一个 Frame 已在运行时不重复发起 */
export async function runFrame(
  frameId: string,
  name: string,
  opts: { video?: boolean; force?: boolean } = {},
) {
  const canvasId = remoteCanvas()
  if (!canvasId || !useGroupRuns.getState().begin(frameId)) return
  const signal = groupRunSignal()
  try {
    const r = await groups.runGroup(canvasId, frameId, {
      ...opts,
      signal,
      onStart: (groupId) => useGroupRuns.getState().started(frameId, groupId),
    })
    notify(groups.describeGroupRun(name, r))
  } catch (err) {
    if (!signal.aborted) fail(err)
  } finally {
    if (!signal.aborted) useGroupRuns.getState().end(frameId)
  }
}

/** 运行到此处 / 运行下游，结束后提示结果 */
export async function runFlowFrom(nodeId: string, scope: FlowRunOptions['scope'], name: string) {
  const canvasId = remoteCanvas()
  if (!canvasId) return
  const signal = groupRunSignal()
  try {
    const r = await groups.runFlow(canvasId, nodeId, scope, { signal })
    notify(groups.describeFlowRun(scope, name, r))
  } catch (err) {
    if (!signal.aborted) fail(err)
  }
}

/**
 * 批量运行（分镜的「批量出分镜图」）：节点 @ 到的卡片还没出定妆图时先出。
 * 返回实际排进去的节点数（含定妆图）；没能开始时返回 null（错误已提示）
 */
export async function runBatch(sourceId: string, nodes: string[]): Promise<number | null> {
  const canvasId = remoteCanvas()
  if (!canvasId) return null
  try {
    return (await api.runBatch(canvasId, sourceId, { nodes })).total
  } catch (err) {
    fail(err)
    return null
  }
}
