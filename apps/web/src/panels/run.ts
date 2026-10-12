import type { FlowRunOptions } from '@plein/protocol'
import * as groups from '../canvas/groups'
import * as runner from '../canvas/runner'
import { useCanvas } from '../stores/canvas'
import { groupRunSignal, useGroupRuns } from '../stores/groupRuns'

/** 界面上的运行操作：取当前画布、发起请求，把结果和错误提示给用户 */

const notify = (msg: string) => useCanvas.getState().notify(msg)
const fail = (err: unknown) => notify((err as Error).message)

/** 当前远端画布；本地演示时提示并返回 null */
function remoteCanvas() {
  const { canvasId } = useCanvas.getState()
  if (!canvasId) notify(runner.DEMO_RUN_NOTICE)
  return canvasId
}

/** 返回这次运行的 id；没能开始时返回 null（错误已提示） */
export async function runNode(id: string): Promise<string | null> {
  const canvasId = remoteCanvas()
  if (!canvasId) return null
  try {
    return await runner.runNode(canvasId, id)
  } catch (err) {
    fail(err)
    return null
  }
}

export async function cancelNode(id: string) {
  const { canvasId } = useCanvas.getState()
  if (!canvasId) return
  await runner.cancelNode(canvasId, id).catch(fail)
}

export async function cancelGroup(groupId: string) {
  await groups.cancelGroup(groupId).catch(fail)
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
