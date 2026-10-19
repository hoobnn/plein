import type { NodeRun, RunPhase } from '@plein/doc'

/**
 * 运行状态怎么给人看：节点卡片、任务面板共用一套说法。
 * 外部平台的调用分几步走（排队 → 提交 → 平台排队 → 生成 → 保存结果），
 * 每一步都说清在等谁、等了多久，出错时说清原因和该怎么办。
 */

/** 进度条上的四步：提交、平台排队、生成、保存结果 */
export const RUN_STEPS = ['提交', '排队', '生成', '保存'] as const

const PHASE_STEP: Record<RunPhase, number> = {
  waiting: 0,
  submitting: 0,
  queued: 1,
  generating: 2,
  saving: 3,
  retrying: 0,
}

export interface RunView {
  /** 短标签：“排队中”“平台排队”“生成中 42%”“3 秒后重试” */
  label: string
  /** 第二行说明：平台、等谁、出错原因 */
  detail?: string
  /** 平台长时间未响应时的非阻断说明，不表示失败或触发重试。 */
  notice?: string
  /** 0–1；没有时显示不确定进度 */
  progress?: number
  /** 当前在 RUN_STEPS 的第几步；不知道时不显示步骤 */
  step?: number
  /** 已用时长（毫秒），从开始运行算起 */
  elapsed?: number
  /** 等待重试的倒计时 */
  retrying: boolean
}

const pct = (p: number) => `${Math.round(p * 100)}%`

/** 平台名（via 的前半段），用在“火山方舟排队中”这类短句里 */
const platformOf = (via?: string) => via?.split(' · ')[0]

/** 运行中（queued / running）节点的展示 */
export function describeActive(run: NodeRun, now: number): RunView {
  if (run.status === 'queued')
    return {
      label: '排队中',
      detail: run.message ?? '等前面的任务跑完',
      retrying: false,
    }
  const elapsed = run.startedAt ? Math.max(0, now - run.startedAt) : undefined
  const platform = platformOf(run.via)
  const progress = run.progress || undefined
  const base = { elapsed, step: run.phase ? PHASE_STEP[run.phase] : undefined, retrying: false }
  switch (run.phase) {
    case 'retrying': {
      const left = Math.max(0, Math.ceil(((run.retryAt ?? now) - now) / 1000))
      return {
        ...base,
        label: left > 0 ? `${left} 秒后重试` : '正在重试',
        detail: run.message,
        retrying: true,
      }
    }
    case 'waiting':
      return { ...base, label: '等待空位', detail: `${platform ?? '平台'}并发已满，轮到就提交` }
    case 'submitting': {
      // 依据最近一次阶段／进度更新，不能把此前等待本地空位的时间算进平台响应。
      const idle = Math.max(0, now - Math.max(run.at, run.startedAt ?? run.at))
      const slow = idle >= 30_000
      return {
        ...base,
        label: slow ? '响应较慢' : '等待响应',
        detail: run.via,
        notice: slow ? '平台响应较慢，请继续等待；请求可能已受理，请勿重复生成。' : undefined,
      }
    }
    case 'queued':
      return { ...base, label: '平台排队', detail: run.via }
    case 'saving':
      return { ...base, label: '保存结果', detail: run.via, progress: 1 }
    default:
      return {
        ...base,
        label: progress ? `生成中 ${pct(progress)}` : '生成中',
        detail: run.message ?? run.via,
        progress,
      }
  }
}

/** 时长：“0:42”“12:05”“1:02:05”，等宽数字，跳秒时宽度不变 */
export function clock(ms: number) {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export interface FailureView {
  /** 一句话原因 */
  title: string
  /** 平台原话（和 title 重复时不给） */
  detail?: string
  /** 修好设置才能成功（密钥、余额），给“去设置” */
  settings: boolean
}

const FAILURE: Record<string, { title: string; settings?: boolean }> = {
  auth: { title: '密钥无效或没有权限', settings: true },
  quota: { title: '账户余额或额度不足', settings: true },
  rate_limit: { title: '请求太频繁，平台限流了' },
  content_policy: { title: '内容没有通过平台审核' },
  timeout: { title: '平台响应超时' },
  unavailable: { title: '平台暂时不可用' },
  missing_input: { title: '缺少输入' },
  not_installed: { title: '节点没有安装' },
  submit_unknown: { title: '提交结果未知，请在任务面板核查' },
  fetch_failed: { title: '平台已生成，结果没存到本地' },
  input_changed: { title: '输入已变，需要重新审查' },
}

/** 失败的展示：按错误类别给一句人话，平台原话放在下面 */
export function describeFailure(run: Pick<NodeRun, 'error' | 'errorCode'>): FailureView {
  const known = run.errorCode ? FAILURE[run.errorCode] : undefined
  const error = run.error?.trim()
  if (!known) return { title: error || '生成失败', settings: false }
  return {
    title: known.title,
    detail: error && error !== known.title ? error : undefined,
    settings: known.settings ?? false,
  }
}

/** 打开设置的模型平台一栏（节点卡片和任务面板上的“去设置”） */
export function openProviderSettings() {
  window.dispatchEvent(new CustomEvent('plein:open-settings', { detail: { section: 'providers' } }))
}
