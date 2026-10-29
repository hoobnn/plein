import { Readable } from 'node:stream'
import { ProviderError } from '@plein/plugin-sdk'
import type { Voice } from '@plein/protocol'
import { mockProvider } from '@plein/providers'
import { describe, expect, it, vi } from 'vite-plus/test'
import { bootServer, request } from '../testing'
import { credentialFingerprint } from '../plugins/config-store'

/** 一秒静音的 16 位单声道 WAV */
function wav() {
  const rate = 8000
  const data = Buffer.alloc(rate * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

async function setup() {
  const { server } = await bootServer()
  const sample = await server.assets.ingest('local', Readable.from([wav()]), {
    mime: 'audio/wav',
    name: 'sample.wav',
  })
  const post = (body: unknown) =>
    request(server, '/api/voices', { method: 'POST', body: JSON.stringify(body) })
  const list = async () => (await (await request(server, '/api/voices')).json()) as Voice[]
  return { server, sample, post, list }
}

describe('我的音色', () => {
  it('上传样本复刻：先记训练中，拉列表时向平台查到可用', async () => {
    const { sample, post, list } = await setup()
    const res = await post({
      provider: 'plein/mock',
      name: '林夏',
      sampleAssetId: sample.id,
      gender: 'female',
    })
    expect(res.status).toBe(201)
    const voice = (await res.json()) as Voice
    expect(voice).toMatchObject({
      provider: 'plein/mock',
      name: '林夏',
      status: 'training',
      sampleAssetId: sample.id,
      gender: 'female',
    })
    // 宿主生成的 ID 满足各家自定义音色 ID 的限制
    expect(voice.voiceId).toMatch(/^[a-z][a-z0-9]{7,}$/)
    // 刚提交过，短时间内不重复查
    expect((await list())[0]!.status).toBe('training')
  })

  it('立即刷新拿到平台状态；登记已有音色不调用平台', async () => {
    const { server, sample, post, list } = await setup()
    const voice = (await (
      await post({ provider: 'plein/mock', name: '旁白', sampleAssetId: sample.id })
    ).json()) as Voice
    const refreshed = await request(server, `/api/voices/${voice.id}/refresh`, { method: 'POST' })
    expect(await refreshed.json()).toMatchObject({ status: 'ready', message: null })
    const existing = await post({ provider: 'doubao/speech', name: '控制台音色', voiceId: 'S_abc' })
    expect(await existing.json()).toMatchObject({ status: 'ready', voiceId: 'S_abc' })
    expect((await list()).map((v) => v.name).sort()).toEqual(['控制台音色', '旁白'])
  })

  it('复刻记录创建时的密钥组，切换当前组后仍用原组查训练状态', async () => {
    const { server, sample, post } = await setup()
    const configs = server.plugins.configs
    configs.update('plein/mock', { secrets: { MOCK_API_KEY: 'one' } })
    const credentialId = configs.get('plein/mock').activeCredential!
    const voice = (await (
      await post({ provider: 'plein/mock', name: '旁白', sampleAssetId: sample.id })
    ).json()) as Voice
    expect(voice).toMatchObject({ credentialId, credentialLabel: '默认' })
    const withTeam = configs.addCredential('plein/mock', '团队', { MOCK_API_KEY: 'two' })
    configs.setActiveCredential('plein/mock', withTeam.credentials[1]!.id)
    const seen: Array<string | undefined> = []
    const status = vi
      .spyOn(mockProvider.voiceClone!, 'status')
      .mockImplementationOnce(async (_voiceId, ctx) => {
        seen.push(ctx.secret('MOCK_API_KEY'))
        return { status: 'ready' }
      })
    try {
      const refreshed = await request(server, `/api/voices/${voice.id}/refresh`, {
        method: 'POST',
      })
      expect(await refreshed.json()).toMatchObject({ status: 'ready', credentialId })
      expect(seen).toEqual(['one'])
    } finally {
      status.mockRestore()
    }
  })

  it('同组密钥修改后不查询音色训练状态', async () => {
    const { server, sample, post } = await setup()
    const configs = server.plugins.configs
    configs.update('plein/mock', { secrets: { MOCK_API_KEY: 'one' } })
    const credentialId = configs.get('plein/mock').activeCredential!
    const voice = (await (
      await post({ provider: 'plein/mock', name: '旁白', sampleAssetId: sample.id })
    ).json()) as Voice
    const fingerprint = credentialFingerprint({ MOCK_API_KEY: 'one' })
    expect(voice).toMatchObject({ credentialId, credentialFingerprint: fingerprint })
    const status = vi.spyOn(mockProvider.voiceClone!, 'status')
    try {
      configs.patchCredential('plein/mock', credentialId, { secrets: { MOCK_API_KEY: 'two' } })
      const refreshed = await request(server, `/api/voices/${voice.id}/refresh`, {
        method: 'POST',
      })
      expect(await refreshed.json()).toMatchObject({
        status: 'training',
        credentialId,
        credentialFingerprint: fingerprint,
        message: expect.stringContaining(
          'Key「默认」已被替换为其他内容，任务无法继续查询结果。为避免重复计费，没有自动重新提交；可恢复原 Key 后重试',
        ),
      })
      expect(status).not.toHaveBeenCalled()
    } finally {
      status.mockRestore()
    }
  })

  it('同一音色再登记覆盖原记录；改名、删除', async () => {
    const { server, post, list } = await setup()
    const first = (await (
      await post({ provider: 'doubao/speech', name: '甲', voiceId: 'S_abc' })
    ).json()) as Voice
    const again = (await (
      await post({ provider: 'doubao/speech', name: '乙', voiceId: 'S_abc' })
    ).json()) as Voice
    expect(again.id).toBe(first.id)
    const renamed = await request(server, `/api/voices/${first.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: '丙', age: 'mature' }),
    })
    expect(await renamed.json()).toMatchObject({ name: '丙', age: 'mature' })
    expect((await request(server, `/api/voices/${first.id}`, { method: 'DELETE' })).status).toBe(
      204,
    )
    expect(await list()).toEqual([])
  })

  it('不支持复刻的平台、非音频样本、缺音色 ID 都直接拒绝', async () => {
    const { server, sample, post } = await setup()
    expect(
      (await post({ provider: 'plein/nope', name: 'x', sampleAssetId: sample.id })).status,
    ).toBe(400)
    expect(
      (await post({ provider: 'plein/mock', name: 'x', sampleAssetId: 'f'.repeat(64) })).status,
    ).toBe(400)
    expect((await post({ provider: 'plein/mock', name: 'x' })).status).toBe(400)
    server.plugins.configs.update('plein/mock', { enabled: false })
    const disabled = await post({ provider: 'plein/mock', name: 'x', sampleAssetId: sample.id })
    expect(disabled.status).toBe(422)
    expect(await disabled.json()).toMatchObject({ message: expect.stringContaining('未启用') })
  })
})

it('音色设计走独立能力并持久保存试听资产；模式不混用', async () => {
  const { server, post, sample, list } = await setup()
  server.plugins.configs.update('plein/mock', { secrets: { MOCK_API_KEY: 'design' } })
  const credentialId = server.plugins.configs.get('plein/mock').activeCredential
  const response = await post({
    mode: 'design',
    provider: 'plein/mock',
    name: '设计女声',
    prompt: '清澈女声',
    previewText: '这是一段试听。',
  })
  expect(response.status).toBe(201)
  const voice = (await response.json()) as Voice
  expect(voice).toMatchObject({
    source: 'design',
    status: 'ready',
    sampleAssetId: null,
    previewAssetId: expect.any(String),
    credentialId,
  })
  expect(server.assets.get('local', voice.previewAssetId!)).toMatchObject({
    kind: 'audio',
    mime: 'audio/wav',
  })
  expect((await list())[0]).toMatchObject({
    previewAssetId: voice.previewAssetId,
    source: 'design',
    credentialId,
  })
  expect(
    (
      await post({
        mode: 'design',
        provider: 'plein/mock',
        name: '错误',
        sampleAssetId: sample.id,
        prompt: '男声',
        previewText: '试听',
      })
    ).status,
  ).toBe(400)
  expect((await post({ mode: 'clone', provider: 'plein/mock', name: '错误' })).status).toBe(400)
  expect(
    (await post({ mode: 'design', provider: 'plein/mock', name: '错误', prompt: '男声' })).status,
  ).toBe(400)
  server.plugins.configs.update('plein/mock', { enabled: false })
  expect(
    (
      await post({
        mode: 'design',
        provider: 'plein/mock',
        name: '错误',
        prompt: '男声',
        previewText: '试听',
      })
    ).status,
  ).toBe(422)
})

it('远端提交结果未知保留音色 ID，不自动重试；试听落库失败不丢失成功音色', async () => {
  const { server, post, list } = await setup()
  const call = vi
    .spyOn(server.plugins, 'designVoice')
    .mockRejectedValueOnce(new ProviderError('unavailable', '网络断开', { outcome: 'unknown' }))
  const response = await post({
    mode: 'design',
    provider: 'plein/mock',
    name: '待核查',
    prompt: '男声',
    previewText: '试听',
  })
  const pending = (await response.json()) as Voice
  expect(response.status).toBe(201)
  expect(pending).toMatchObject({
    status: 'training',
    voiceId: expect.stringMatching(/^plein/),
    message: expect.stringContaining('提交结果未知'),
  })
  expect(pending.message).toContain(pending.voiceId)
  expect(call).toHaveBeenCalledTimes(1)
  call.mockRestore()
  vi.spyOn(server.assets, 'ingest').mockRejectedValueOnce(new Error('disk full'))
  const ready = await post({
    mode: 'design',
    provider: 'plein/mock',
    name: '成功设计',
    prompt: '女声',
    previewText: '试听',
  })
  expect(ready.status).toBe(201)
  expect(await ready.json()).toMatchObject({
    status: 'ready',
    voiceId: expect.stringMatching(/^plein/),
    previewAssetId: null,
  })
  expect(await list()).toHaveLength(2)
})
