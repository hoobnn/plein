import { ProviderError } from '@plein/plugin-sdk'
import { API, CreateVoice, UpdateVoice, type Voice } from '@plein/protocol'
import { Hono } from 'hono'
import type { AssetStore } from '../assets/store'
import type { AuthEnv } from '../auth'
import type { PluginHost } from '../plugins/host'
import { generatedVoiceId, type VoiceStore } from './store'

/** 同一音色两次查状态至少隔这么久，列表反复拉取时不刷平台接口 */
const STATUS_INTERVAL = 15_000

const providerError = (err: unknown) =>
  err instanceof ProviderError ? err : new ProviderError('unknown', (err as Error).message)

/**
 * 我的音色：上传样本在平台上复刻，或登记平台上已有的音色。
 * 训练状态不另起后台任务：拉列表时顺手查训练中的音色，重启后也能接着查。
 */
export function voiceRoutes(deps: { voices: VoiceStore; host: PluginHost; assets: AssetStore }) {
  const { voices, host, assets } = deps
  const notFound = { error: 'not_found', message: '音色不存在' }
  const forbidden = { error: 'forbidden', message: '只读成员不能修改音色' }
  const checkedAt = new Map<string, number>()

  async function refresh(owner: string, voice: Voice, force = false): Promise<Voice> {
    if (voice.status !== 'training') return voice
    const last = checkedAt.get(voice.id) ?? 0
    if (!force && Date.now() - last < STATUS_INTERVAL) return voice
    checkedAt.set(voice.id, Date.now())
    try {
      const state = await host.voiceStatus(
        voice.provider,
        owner,
        voice.voiceId,
        AbortSignal.timeout(20_000),
      )
      if (!state) return voice
      return (
        voices.setStatus(
          owner,
          voice.id,
          state.status,
          state.status === 'failed' ? state.message : null,
        ) ?? voice
      )
    } catch (err) {
      // 查不到状态不等于训练失败，保持训练中，把原因带给界面
      return (
        voices.setStatus(
          owner,
          voice.id,
          'training',
          `查询训练状态失败：${providerError(err).message}`,
        ) ?? voice
      )
    }
  }

  return new Hono<AuthEnv>()
    .get(API.voices, async (c) => {
      const owner = c.var.principal.id
      return c.json(await Promise.all(voices.list(owner).map((v) => refresh(owner, v))))
    })
    .post(API.voices, async (c) => {
      if (c.var.principal.role === 'viewer') return c.json(forbidden, 403)
      const body = CreateVoice.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const owner = c.var.principal.id
      const { provider, name, sampleAssetId, gender, age } = body.data
      const fields = { provider, name, gender, age, sampleAssetId }
      // 不带样本：只登记平台上已有的音色，不调用平台
      if (!sampleAssetId) {
        const voice = voices.save(owner, {
          ...fields,
          voiceId: body.data.voiceId,
          status: 'ready',
          message: null,
        })
        return c.json(voice, 201)
      }
      const spec = host.voiceClone(provider)
      if (!spec)
        return c.json({ error: 'invalid', message: `平台 ${provider} 不支持声音复刻` }, 400)
      const sample = assets.get(owner, sampleAssetId)
      if (!sample || sample.kind !== 'audio')
        return c.json({ error: 'invalid', message: '复刻样本须为资产库里的音频' }, 400)
      const voiceId = spec.voiceId === 'slot' ? body.data.voiceId : generatedVoiceId()
      if (!voiceId)
        return c.json({ error: 'invalid', message: '这个平台需要填写控制台分配的音色 ID' }, 400)
      try {
        const state = await host.cloneVoice(
          provider,
          owner,
          { voiceId, sample: { assetId: sample.id, kind: 'audio', mime: sample.mime } },
          AbortSignal.timeout(180_000),
        )
        const voice = voices.save(owner, {
          ...fields,
          voiceId,
          status: state.status,
          message: state.status === 'failed' ? state.message : null,
        })
        checkedAt.set(voice.id, Date.now())
        return c.json(voice, 201)
      } catch (err) {
        const e = providerError(err)
        return c.json({ error: e.code, message: e.message }, 422)
      }
    })
    .patch('/api/voices/:id', async (c) => {
      if (c.var.principal.role === 'viewer') return c.json(forbidden, 403)
      const body = UpdateVoice.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const voice = voices.update(c.var.principal.id, c.req.param('id'), body.data)
      return voice ? c.json(voice) : c.json(notFound, 404)
    })
    .post('/api/voices/:id/refresh', async (c) => {
      const owner = c.var.principal.id
      const voice = voices.get(owner, c.req.param('id'))
      if (!voice) return c.json(notFound, 404)
      return c.json(await refresh(owner, voice, true))
    })
    .delete('/api/voices/:id', (c) => {
      if (c.var.principal.role === 'viewer') return c.json(forbidden, 403)
      return voices.remove(c.var.principal.id, c.req.param('id'))
        ? c.body(null, 204)
        : c.json(notFound, 404)
    })
}
