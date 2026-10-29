import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vite-plus/test'
import { tempDir } from '../testing'
import { subtitleCredentialUsage, writeRecord } from './journal'

it('字幕密钥用量聚合、模型回退与坏 JSON 隔离', () => {
  const root = tempDir()
  writeRecord(join(root, 'fallback.json'), {
    assetId: 'a',
    model: 'plein/mock:audio',
    record: { state: 'pending', remoteId: 'r1', credentialId: 'one' },
  })
  writeRecord(join(root, 'explicit.json'), {
    assetId: 'b',
    model: 'acme/other:model',
    record: {
      state: 'fetched',
      outputs: [],
      provider: 'plein/mock',
      credentialId: 'one',
    },
  })
  writeRecord(join(root, 'unknown.json'), {
    assetId: 'c',
    model: 'acme/other:model',
    record: { state: 'unknown', at: 1, message: '未知', credentialId: 'two' },
  })
  writeRecord(join(root, 'done.json'), {
    assetId: 'd',
    model: 'plein/mock:audio',
    record: {
      state: 'done',
      result: { outputs: [], assets: [] },
      credentialId: 'one',
    },
  })
  writeFileSync(join(root, 'broken.json'), '{not json')

  expect(subtitleCredentialUsage(root)).toEqual({
    'plein/mock': { one: 2 },
    'acme/other': { two: 1 },
  })
})
