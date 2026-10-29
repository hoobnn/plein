import type { JobInfo, JobRecovery } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { describeRecovery, recoveryActions } from './recovery'

const job = (status: JobInfo['status'], recovery?: JobRecovery): JobInfo => ({
  id: 'recover-fixture',
  nodeId: 'node',
  nodeType: 'plein/image',
  status,
  attempts: 1,
  error: '请求没有完成',
  createdAt: 1,
  ...(recovery ? { recovery } : {}),
})

const none = {
  retry: false,
  refetch: false,
  attach: false,
  resubmit: false,
  dismiss: false,
  review: false,
}

it.each([
  [
    '已受理未取回且可重新获取',
    { state: 'remote_pending', refetchable: true },
    { ...none, refetch: true },
  ],
  [
    '已受理但取不回，只能标记已处理',
    { state: 'remote_pending', refetchable: false },
    { ...none, dismiss: true },
  ],
  [
    '原密钥失效时可重新获取、用当前组重提或标记已处理',
    { state: 'remote_pending', refetchable: true, credentialLost: { reason: 'missing' } },
    { ...none, refetch: true, resubmit: true, dismiss: true },
  ],
  [
    '配音音色所属密钥失效时不能改用当前组重提',
    {
      state: 'remote_pending',
      refetchable: true,
      credentialLost: { reason: 'replaced', voice: '旁白' },
    },
    { ...none, refetch: true, dismiss: true },
  ],
  ['输入已变', { state: 'review' }, { ...none, review: true }],
  ['提交结果未知', { state: 'submit_unknown' }, { ...none, resubmit: true, dismiss: true }],
  [
    '提交结果未知且可填平台任务 ID',
    { state: 'submit_unknown', attachable: true },
    { ...none, attach: true, resubmit: true, dismiss: true },
  ],
  ['平台明确失败', { state: 'remote_failed' }, { ...none, retry: true }],
  ['旧记录没有恢复状态', undefined, { ...none, retry: true }],
] as const)('恢复操作：%s', (_, recovery, expected) => {
  expect(recoveryActions(recovery as JobRecovery | undefined)).toEqual(expected)
})

it.each([
  [
    '失败的已受理任务可重新获取，不会重新提交',
    job('failed', { state: 'remote_pending', refetchable: true, remoteId: 'remote-existing' }),
    {
      title: '平台已受理，结果尚未取回',
      detail: '可以重新获取，不会重新提交 · 任务 ID remote-existing',
      tone: 'warning',
    },
  ],
  [
    '原 Key 删除后不再提示可以恢复取回',
    job('failed', {
      state: 'remote_pending',
      refetchable: true,
      credentialLost: { reason: 'missing' },
      credentialLabel: '默认',
    }),
    {
      title: '平台已受理，结果尚未取回',
      detail: '原来的 Key「默认」已删除，无法取回之前的结果。为避免重复计费没有自动重新提交。',
      tone: 'warning',
    },
  ],
  [
    '原 Key 替换后说明改回可获取及换组重提代价',
    job('failed', {
      state: 'remote_pending',
      refetchable: true,
      credentialLost: { reason: 'replaced' },
      credentialLabel: '默认',
    }),
    {
      title: '平台已受理，结果尚未取回',
      detail:
        '原来的 Key「默认」已被替换，暂时无法取回结果。把这组 Key 改回原来的内容后可重新获取；不需要原结果的话，可以用当前 Key 重新提交（会再次计费）。',
      tone: 'warning',
    },
  ],
  [
    '取消后平台可能仍在生成，取不回时只给说明',
    job('canceled', {
      state: 'remote_pending',
      refetchable: false,
      note: '平台不支持查询',
      remoteId: 'remote-existing',
    }),
    {
      title: '平台上的任务可能仍在生成',
      detail: '平台不支持查询 · 任务 ID remote-existing',
      tone: 'muted',
    },
  ],
  [
    '输入已变需要重新审查',
    job('canceled', { state: 'review' }),
    { title: '输入已变，需要重新审查', detail: '没有提交，不会产生费用', tone: 'warning' },
  ],
  [
    '提交结果未知时提醒先核对',
    job('failed', { state: 'submit_unknown' }),
    {
      title: '提交结果未知',
      detail: '没收到平台的确认，无法判断是否已受理。请先到平台控制台核对；重新提交可能重复计费',
      tone: 'warning',
    },
  ],
  ['平台明确失败不显示恢复提示', job('failed', { state: 'remote_failed' }), null],
  ['旧记录没有恢复状态时不显示恢复提示', job('failed'), null],
  [
    '标记已处理后不再显示恢复提示',
    job('canceled', { state: 'remote_pending', refetchable: false, dismissed: true }),
    null,
  ],
] as const)('恢复提示：%s', (_, input, expected) => {
  expect(describeRecovery(input)).toEqual(expected)
})
