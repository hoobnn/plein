import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { stableStringify } from '@plein/flow'
import { parseModelRef, ProviderError, type TranscriptSegment } from '@plein/plugin-sdk'
import {
  API,
  type CredentialLost,
  SubtitleRecognizeRequest,
  SubtitleRecognitionLookup,
  SubtitleRecoverRequest,
  type SubtitleRecognitionInfo,
  type SubtitleRecognizeResult,
  type SubmissionAudit,
} from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import type { AssetStore } from '../assets/store'
import { credentialFingerprint as fingerprintOf } from '../plugins/config-store'
import type { CallRecord, PluginHost } from '../plugins/host'
import type { DB } from '../storage/db'
import { legacySubtitleRecord } from './legacy'
import { readRecord, writeRecord } from './journal'

const hash = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex')

/** 音频内容哈希 + 平台插件版本 + 模型合同决定识别缓存；文案修订、混音、再次导出不重提。 */
export function subtitleRoutes({
  db,
  host,
  assets,
  dataDir,
}: {
  db: DB
  host: PluginHost
  assets: AssetStore
  dataDir: string
}) {
  const root = join(dataDir, 'subtitle-recognition')
  mkdirSync(root, { recursive: true })
  const pending = new Map<string, Promise<TranscriptSegment[]>>()
  const describe = (ownerId: string, assetId: string, model: string) => {
    const ref = parseModelRef(model)
    const provider = ref && host.registry.providers.get(ref.provider)
    const spec = provider?.def.models.find((m) => m.id === ref?.model)
    const version = provider && host.registry.plugin(provider.plugin)?.manifest.version
    if (!provider || !spec || !spec.capabilities.includes('audio.transcribe'))
      throw new ProviderError('invalid_input', '所选模型不支持带时间戳的语音识别')
    const key = createHash('sha256')
      .update(
        stableStringify({
          ownerId,
          assetId,
          model,
          version,
          spec,
          adapter: 'subtitle-recognition-v1',
        }),
      )
      .digest('hex')
    return { key, file: join(root, `${key}.json`), provider, spec, version }
  }
  const credentialLost = (providerId: string, record: CallRecord): CredentialLost | undefined => {
    if (!record.credentialId) return undefined
    const credential = host.configs.credential(providerId, record.credentialId)
    const voice = record.credentialSource === 'voice' ? record.credentialVoice : undefined
    if (!credential) return { reason: 'missing', ...(voice ? { voice } : {}) }
    if (
      record.credentialFingerprint &&
      fingerprintOf(credential.secrets) !== record.credentialFingerprint
    )
      return { reason: 'replaced', ...(voice ? { voice } : {}) }
    return undefined
  }
  const info = (
    ownerId: string,
    assetId: string,
    model: string,
  ): SubtitleRecognitionInfo | null => {
    const context = describe(ownerId, assetId, model)
    const stored = readRecord(context.file)
    const record = stored?.record
    if (!record || record.state === 'done' || stored?.dismissed) return null
    const lost = credentialLost(context.provider.def.id, record)
    const currentCredentialLabel = lost
      ? host.configs.credential(context.provider.def.id)?.label
      : undefined
    const credentialLabel = record.credentialLabel ?? record.credentialId?.slice(0, 8) ?? '默认'
    const state =
      record.state === 'pending'
        ? 'remote_pending'
        : record.state === 'fetched'
          ? 'fetch_failed'
          : 'submit_unknown'
    return {
      model,
      assetId,
      expected: hash(record),
      submissionHistory: (stored.audit ?? []).map((event) => ({
        id: event.id,
        at: event.at,
        callKey: event.callKey,
        kind: event.kind,
        attemptId: event.attemptId,
        requestId: event.requestId,
        logId: event.logId,
        httpStatus: event.httpStatus,
        remoteId: event.remoteId,
        previousState: event.previousState,
        previousAt: event.previousAt,
      })),
      recovery: {
        state,
        attachable: !!context.provider.def.poll,
        refetchable: record.state === 'pending' || record.state === 'fetched',
        ...(lost ? { credentialLost: lost, credentialLabel } : {}),
        ...(currentCredentialLabel ? { currentCredentialLabel } : {}),
        ...('remoteId' in record && record.remoteId ? { remoteId: record.remoteId } : {}),
        note: lost
          ? lost.reason === 'missing'
            ? `原来的 Key「${credentialLabel}」已删除，无法取回之前的结果。为避免重复计费没有自动重新提交。`
            : `原来的 Key「${credentialLabel}」已被替换，暂时无法取回结果。把这组 Key 改回原来的内容后可重新获取；不需要原结果的话，可以用当前 Key 重新提交（会再次计费）。`
          : state === 'submit_unknown'
            ? '提交状态未知，请先在平台核查；填平台任务 ID 续查，或确认未受理后再重新提交。'
            : '平台已受理，重新获取只续查或复用已返回结果。',
      },
    }
  }
  const recognize = (ownerId: string, assetId: string, model: string) => {
    const { key, file, spec, version } = describe(ownerId, assetId, model)
    const active = pending.get(key)
    if (active) return active
    const work = assets.activity
      .run(async () => {
        let stored = readRecord(file) ?? { assetId, model }
        let record = stored.record ?? undefined
        if (!record && !stored.confirmedReset && version) {
          const legacy = legacySubtitleRecord(db, {
            ownerId,
            assetId,
            model,
            modelVersion: spec.version,
            pluginVersion: version,
          })
          if (legacy) {
            stored = { assetId, model, record: legacy.record, migratedFrom: legacy.jobId }
            writeRecord(file, stored)
            record = legacy.record
          }
        }
        const result = await host.call(
          'audio.transcribe',
          model,
          {
            audio: { assetId, kind: 'audio' },
          },
          {
            ownerId,
            journal: {
              store: {
                id: `subtitle-${key}`,
                get: () => record,
                set: (_key, value, audit) => {
                  // 先落盘再确认状态；即使进程退出，submitting/remoteId 也不会被遗忘后重新提交。
                  const next = {
                    ...stored,
                    assetId,
                    model,
                    record: value,
                    ...(audit ? { audit: [...(stored.audit ?? []), audit] } : {}),
                  }
                  writeRecord(file, next)
                  stored = next
                  record = value
                },
                // host 只在平台明确拒绝、尚未受理时删除；unknown/pending 始终保留。
                delete: () => {
                  const next = { ...stored, record: null, confirmedReset: true }
                  writeRecord(file, next)
                  stored = next
                  record = undefined
                },
              },
              key,
            },
          },
        )
        const segments = result.outputs
          .flatMap((o) => {
            if (o.type !== 'json') return []
            const value = o.value as { segments?: unknown }
            return Array.isArray(value?.segments) ? value.segments : []
          })
          .filter(
            (s): s is TranscriptSegment =>
              typeof s?.start === 'number' &&
              Number.isFinite(s.start) &&
              s.start >= 0 &&
              typeof s?.end === 'number' &&
              Number.isFinite(s.end) &&
              s.end > s.start &&
              typeof s?.text === 'string' &&
              !!s.text.trim(),
          )
        if (!segments.length)
          throw new ProviderError(
            'unavailable',
            '语音识别没有返回有效时间戳；可切换模型，或按台词创建字幕后手动校时',
          )
        return segments
      })
      .finally(() => pending.delete(key))
    pending.set(key, work)
    return work
  }
  return new Hono<AuthEnv>()
    .get(API.subtitleRecognition, (c) => {
      const body = SubtitleRecognitionLookup.safeParse(c.req.query())
      if (!body.success) return c.json({ error: 'invalid', message: '查询参数不合法' }, 400)
      if (assets.get(c.var.principal.id, body.data.assetId)?.kind !== 'audio')
        return c.json({ error: 'not_found', message: '音频素材不存在' }, 404)
      try {
        return c.json(info(c.var.principal.id, body.data.assetId, body.data.model))
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error
        return c.json({ error: error.code, message: error.message }, 422)
      }
    })
    .post(API.subtitleRecover, async (c) => {
      const owner = c.var.principal.id
      if (c.var.principal.role === 'viewer')
        return c.json({ error: 'forbidden', message: '只读成员不能恢复识别任务' }, 403)
      const body = SubtitleRecoverRequest.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: '恢复参数不合法' }, 400)
      const { model, assetId, expected, operation, confirmedNotAccepted } = body.data
      if (assets.get(owner, assetId)?.kind !== 'audio')
        return c.json({ error: 'not_found', message: '音频素材不存在' }, 404)
      try {
        const context = describe(owner, assetId, model)
        if (pending.has(context.key))
          return c.json({ error: 'busy', message: '识别尚在进行，请等待结束后再恢复' }, 409)
        const result = await assets.activity.run(async () => {
          if (pending.has(context.key)) return 'busy' as const
          const stored = readRecord(context.file)
          const record = stored?.record
          if (!stored || !record || hash(record) !== expected) return 'changed' as const
          const audit = (kind: SubmissionAudit['kind']): SubmissionAudit => ({
            id: randomUUID(),
            at: Date.now(),
            callKey: context.key,
            kind,
            ...record.trace,
            previousState: record.state,
            ...('at' in record ? { previousAt: record.at } : {}),
            ...(operation.action === 'attach' ? { remoteId: operation.remoteId } : {}),
          })
          if (operation.action === 'attach') {
            if (
              !context.provider.def.poll ||
              (record.state !== 'unknown' && record.state !== 'submitting')
            )
              return 'invalid' as const
            writeRecord(context.file, {
              ...stored,
              record: {
                state: 'pending',
                remoteId: operation.remoteId,
                ...(record.trace ? { trace: record.trace } : {}),
                ...(record.provider ? { provider: record.provider } : {}),
                ...(record.credentialId ? { credentialId: record.credentialId } : {}),
                ...(record.credentialFingerprint
                  ? { credentialFingerprint: record.credentialFingerprint }
                  : {}),
                ...(record.credentialLabel ? { credentialLabel: record.credentialLabel } : {}),
                ...(record.credentialSource ? { credentialSource: record.credentialSource } : {}),
                ...(record.credentialVoice ? { credentialVoice: record.credentialVoice } : {}),
              },
              audit: [...(stored.audit ?? []), audit('manual_attach')],
              history: [...(stored.history ?? []), { record, at: Date.now(), action: 'attach' }],
            })
          } else if (operation.action === 'resubmit') {
            const unknownResubmit =
              confirmedNotAccepted && (record.state === 'unknown' || record.state === 'submitting')
            const credentialResubmit = credentialLost(context.provider.def.id, record)
            if (!unknownResubmit && !credentialResubmit) return 'invalid' as const
            writeRecord(context.file, {
              ...stored,
              record: null,
              confirmedReset: true,
              dismissed: undefined,
              audit: [...(stored.audit ?? []), audit('manual_resubmit')],
              history: [
                ...(stored.history ?? []),
                {
                  record,
                  at: Date.now(),
                  action: credentialResubmit ? 'credential_lost' : 'confirmed_not_accepted',
                },
              ],
            })
          } else if (operation.action === 'dismiss') {
            if (!credentialLost(context.provider.def.id, record)) return 'invalid' as const
            writeRecord(context.file, {
              ...stored,
              dismissed: true,
              audit: [...(stored.audit ?? []), audit('manual_dismiss')],
              history: [...(stored.history ?? []), { record, at: Date.now(), action: 'dismiss' }],
            })
          } else if (
            operation.action !== 'refetch' ||
            (record.state !== 'pending' && record.state !== 'fetched')
          )
            return 'invalid' as const
          return 'ok' as const
        })
        if (result === 'changed')
          return c.json({ error: 'conflict', message: '识别记录已变化，请重新查看状态' }, 409)
        if (result === 'busy')
          return c.json({ error: 'busy', message: '识别尚在进行，请稍后恢复' }, 409)
        if (result === 'invalid')
          return c.json(
            { error: 'invalid', message: '当前状态不支持此操作；重新提交须先确认平台未受理' },
            400,
          )
        return c.json({ ok: true })
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error
        return c.json({ error: error.code, message: error.message }, 422)
      }
    })
    .post(API.subtitleRecognize, async (c) => {
      const p = c.var.principal
      if (p.role === 'viewer')
        return c.json({ error: 'forbidden', message: '只读成员不能识别字幕' }, 403)
      const body = SubtitleRecognizeRequest.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: '识别参数不合法' }, 400)
      const ids = [...new Set(body.data.assetIds)]
      if (ids.some((id) => assets.get(p.id, id)?.kind !== 'audio'))
        return c.json({ error: 'not_found', message: '音频素材不存在' }, 404)
      let activeAsset: string | undefined
      try {
        // 顺序提交便于平台限流与逐条恢复；重复请求复用同一条在途 promise。
        const transcripts: SubtitleRecognizeResult['transcripts'] = {}
        for (const id of ids) {
          activeAsset = id
          transcripts[id] = await recognize(p.id, id, body.data.model)
        }
        return c.json({ transcripts } satisfies SubtitleRecognizeResult)
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error
        let recovery: SubtitleRecognitionInfo | null = null
        try {
          recovery = activeAsset ? info(p.id, activeAsset, body.data.model) : null
        } catch {
          /* 原始错误优先 */
        }
        return c.json(
          { error: error.code, message: error.message, outcome: error.outcome, recovery },
          422,
        )
      }
    })
}
