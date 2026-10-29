import { Readable } from 'node:stream'
import { type AssetRef, type VoiceCreationResult, ProviderError } from '@plein/plugin-sdk'
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

  async function savePreview(
    owner: string,
    voice: Voice,
    state: VoiceCreationResult,
  ): Promise<Voice> {
    if (!state.preview) return voice
    try {
      const asset = await assets.ingest(owner, Readable.from([state.preview.data]), {
        mime: state.preview.mime,
        name: `${voice.name}-试听`,
      })
      return voices.setPreview(owner, voice.id, asset.id) ?? voice
    } catch {
      // 音色已经在远端创建，试听保存失败不能丢失 ID 或诱发重复创建。
      return voice
    }
  }

  async function refresh(owner: string, voice: Voice, force = false): Promise<Voice> {
    if (
      voice.status !== 'training' &&
      !(force && voice.source !== 'register' && voice.provider === 'doubao/speech')
    )
      return voice
    const last = checkedAt.get(voice.id) ?? 0
    if (!force && Date.now() - last < STATUS_INTERVAL) return voice
    checkedAt.set(voice.id, Date.now())
    try {
      const state = await host.voiceStatus(
        voice.provider,
        owner,
        voice.voiceId,
        AbortSignal.timeout(20_000),
        voice.credentialId ?? undefined,
      )
      if (!state) return voice
      return savePreview(
        owner,
        voices.setStatus(
          owner,
          voice.id,
          state.status,
          state.status === 'failed' ? state.message : null,
        ) ?? voice,
        state,
      )
    } catch (err) {
      // 查不到状态不等于训练失败，保持训练中，把原因带给界面
      return (
        voices.setStatus(
          owner,
          voice.id,
          voice.status,
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
      const input = body.data
      const { provider, name, sampleAssetId, gender, age } = input
      const mode = input.mode ?? (sampleAssetId ? 'clone' : 'register')
      const fields = { provider, name, gender, age, sampleAssetId, source: mode }
      if (mode === 'register') {
        return c.json(
          voices.save(owner, { ...fields, voiceId: input.voiceId, status: 'ready', message: null }),
          201,
        )
      }
      const spec = mode === 'design' ? host.voiceDesign(provider) : host.voiceClone(provider)
      if (!spec)
        return c.json(
          {
            error: 'invalid',
            message: `平台 ${provider} 不支持${mode === 'design' ? '音色设计' : '声音复刻'}`,
          },
          400,
        )
      const custom = mode === 'clone' && input.idMode === 'custom'
      if (custom && !host.voiceClone(provider)?.customId)
        return c.json({ error: 'invalid', message: '该平台不支持此自定义 ID 模式' }, 400)
      const voiceId =
        spec.voiceId === 'slot' && !custom ? input.voiceId : input.voiceId || generatedVoiceId()
      if (!voiceId)
        return c.json({ error: 'invalid', message: '请填写控制台分配的音色槽位 ID' }, 400)
      const credentialId = host.configs.get(provider).activeCredential
      const ref = (id: string | null, kind: 'audio' | 'image'): AssetRef | undefined => {
        if (!id) return undefined
        const asset = assets.get(owner, id)
        if (!asset || asset.kind !== kind)
          throw new ProviderError(
            'invalid_input',
            kind === 'image' ? '角色图片不存在或无权访问' : '复刻样本须为资产库里的音频',
          )
        return { assetId: asset.id, kind, mime: asset.mime }
      }
      try {
        const signal = AbortSignal.timeout(180_000)
        const state =
          mode === 'design'
            ? await host.designVoice(
                provider,
                owner,
                {
                  voiceId,
                  prompt: input.prompt,
                  previewText: input.previewText,
                  image: ref(input.imageAssetId, 'image'),
                  language: input.language,
                },
                signal,
                credentialId,
              )
            : await host.cloneVoice(
                provider,
                owner,
                {
                  voiceId,
                  sample: ref(sampleAssetId, 'audio')!,
                  idMode: input.idMode,
                  noiseReduction: input.noiseReduction,
                  volumeNormalization: input.volumeNormalization,
                  language: input.language,
                  previewText: input.previewText,
                  promptSample: ref(input.promptSampleAssetId, 'audio'),
                  promptText: input.promptText,
                },
                signal,
                credentialId,
              )
        const voice = voices.save(owner, {
          ...fields,
          voiceId: state.voiceId ?? voiceId,
          status: state.status,
          message: state.status === 'failed' ? state.message : null,
          credentialId,
        })
        checkedAt.set(voice.id, Date.now())
        return c.json(await savePreview(owner, voice, state), 201)
      } catch (err) {
        const e = providerError(err)
        if (e.outcome === 'unknown') {
          const voice = voices.save(owner, {
            ...fields,
            voiceId,
            status: 'training',
            message: `提交结果未知，请先在平台核查音色 ID ${voiceId}，不要重复创建：${e.message}`,
            credentialId,
          })
          return c.json(voice, 201)
        }
        return c.json({ error: e.code, message: e.message }, e.code === 'invalid_input' ? 400 : 422)
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
