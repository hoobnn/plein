import type { JobInfo } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { recoveryEvidence } from './recoveryEvidence'

it('补提交成功后核查信息仍包含原请求及人工操作，不复制输入正文', () => {
  const job = {
    id: 'run',
    nodeId: 'node',
    nodeType: 'plein/speech',
    status: 'succeeded',
    attempts: 2,
    createdAt: 1,
    input: {
      v: 1,
      nodeId: 'node',
      nodeType: 'plein/speech',
      preparedAt: 1,
      status: 'ready',
      prompt: 'private input text',
      params: { secret: 'private parameter' },
      inputs: {},
      refs: [],
      notices: [],
      blocked: [],
    },
    submissionHistory: [
      { id: '1', at: 1, callKey: 'k', kind: 'submit_started', requestId: 'original-request' },
      {
        id: '2',
        at: 2,
        callKey: 'k',
        kind: 'manual_resubmit',
        previousState: 'unknown',
        previousAt: 1,
        requestId: 'original-request',
      },
      { id: '3', at: 3, callKey: 'k', kind: 'submit_started', requestId: 'replacement-request' },
    ],
  } as JobInfo
  const text = recoveryEvidence(job)
  expect(text).toContain('original-request')
  expect(text).toContain('replacement-request')
  expect(text).toContain('manual_resubmit')
  expect(text).toContain('新请求成功不代表旧未知请求已核销')
  expect(text).not.toContain('private input text')
  expect(text).not.toContain('private parameter')
})
