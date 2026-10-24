import { Readable } from 'node:stream'
import type { Voice } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { bootServer, request } from '../testing'

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
