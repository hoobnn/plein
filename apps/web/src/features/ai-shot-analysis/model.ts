import type { JobInfo } from '@plein/protocol'
import { ApiError } from '../../api/client'

export {
  sameReportOrigin,
  aiModels,
  createScenePlan,
  draftReference,
  createSummaryPlan,
  convertAiDrafts,
} from '@plein/capabilities'

/** 轮询间隔：与服务端任务面板的刷新节奏一致。 */
export const JOB_POLL_INTERVAL = 250
/** 作业连续读不到的次数上限：作业刚建好时可能还读不到，超过就按状态未知收场。 */
export const JOB_POLL_MISSING = 120

/** 作业还在排队或运行中 */
const pending = (job: JobInfo) => job.status === 'queued' || job.status === 'running'

export interface JobPollOptions {
  /** 按精确作业 ID 读取；作业还没建好时服务端回 404 */
  read(runId: string): Promise<JobInfo>
  /** 面板还在看这次运行时才继续轮询 */
  alive(): boolean
  /** 等待下一次轮询 */
  wait?(): Promise<void>
  /** 读不到作业时的次数上限 */
  missing?: number
}

/**
 * 按精确作业 ID 等它结束：返回终态作业。
 * 一直读不到（还没建好或已被清掉）时返回 undefined，调用方按状态未知处理，不再空转。
 */
export async function pollJob(
  runId: string,
  options: JobPollOptions,
): Promise<JobInfo | undefined> {
  const wait =
    options.wait ?? (() => new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL)))
  let missing = 0
  for (;;) {
    if (!options.alive()) return undefined
    let job: JobInfo | undefined
    try {
      job = await options.read(runId)
    } catch (error) {
      // 别的错误照实抛出；只有「还没有这条作业」才继续等。
      if (!(error instanceof ApiError) || error.status !== 404) throw error
      if (++missing > (options.missing ?? JOB_POLL_MISSING)) return undefined
    }
    if (job) {
      if (!pending(job)) return job
      missing = 0
    }
    await wait()
  }
}
