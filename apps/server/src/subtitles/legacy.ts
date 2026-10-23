import { createHash } from 'node:crypto'
import { stableStringify } from '@plein/flow'
import { sequenceNode } from '@plein/nodes'
import { ProviderError } from '@plein/plugin-sdk'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { CallRecord } from '../plugins/host'
import { cacheParams } from '../runs/runs'
import type { DB } from '../storage/db'
import { jobs } from '../storage/schema'

const frozenSchema = z.object({
  params: z.record(z.string(), z.unknown()),
  inputs: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  inputHash: z.string().startsWith('v2:'),
})
const doneSchema = z.object({
  state: z.literal('done'),
  remoteId: z.string().optional(),
  result: z.object({
    outputs: z.array(
      z.union([
        z.object({ type: z.literal('text'), text: z.string() }),
        z.object({ type: z.literal('json'), value: z.unknown() }),
      ]),
    ),
    assets: z.array(z.never()),
  }),
})
const parse = (raw: string | null): unknown => {
  try {
    return JSON.parse(raw ?? '')
  } catch {
    return undefined
  }
}
const hash = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex')

/**
 * 只读旧序列任务。v2 输入哈希必须按当前模型/Provider插件版本精确重算一致，
 * 兼容 v2 的两种来源编码（旧版省略 source，序列锚定修复后保留 source）；
 * 只使用冻结参数重算，不把新增默认值灌回历史快照。
 * 再按旧执行器的完整 audio 请求（含 mime）核对 call key；不从文件名或字幕文本猜测来源。
 */
export function legacySubtitleRecord(
  db: DB,
  request: {
    ownerId: string
    assetId: string
    model: string
    modelVersion?: string
    pluginVersion: string
  },
): { record: CallRecord; jobId: string } | undefined {
  const { ownerId, assetId, model, modelVersion, pluginVersion } = request
  let unresolved = false
  let unresolvedJob = ''
  const rows = db
    .select({ id: jobs.id, frozen: jobs.frozen, calls: jobs.calls, omit: jobs.cache_omit })
    .from(jobs)
    .where(and(eq(jobs.owner_id, ownerId), eq(jobs.node_type, 'plein/sequence')))
    .orderBy(desc(jobs.created_at))
    .all()
  for (const row of rows) {
    const frozen = frozenSchema.safeParse(parse(row.frozen))
    if (
      !frozen.success ||
      frozen.data.params.model !== model ||
      frozen.data.params.asrTiming !== true
    )
      continue
    const snapshot = frozen.data
    const omit = row.omit ? z.array(z.string()).safeParse(parse(row.omit)) : undefined
    if (omit && !omit.success) continue
    const inputEncodings = [
      snapshot.inputs,
      Object.fromEntries(
        Object.entries(snapshot.inputs).map(([port, values]) => [
          port,
          values.map(({ source: _source, ...v }) => v),
        ]),
      ),
    ]
    const matches = inputEncodings.some(
      (inputs) =>
        snapshot.inputHash ===
        `v2:${hash({
          type: 'plein/sequence',
          version: sequenceNode.version,
          params: cacheParams(snapshot.params, omit?.data ?? []),
          inputs,
          model: { ref: model, version: modelVersion, plugin: pluginVersion },
        })}`,
    )
    if (!matches) continue
    const calls = z.record(z.string(), z.unknown()).safeParse(parse(row.calls))
    if (!calls.success) continue
    for (const value of snapshot.inputs.dialogue ?? []) {
      if (value.type !== 'audio' || value.assetId !== assetId) continue
      const prefix = `${hash({
        capability: 'audio.transcribe',
        model,
        input: { audio: { assetId, kind: 'audio', mime: value.mime } },
      })}#`
      for (const [key, record] of Object.entries(calls.data)) {
        if (!key.startsWith(prefix) || !/^\d+$/.test(key.slice(prefix.length))) continue
        const done = doneSchema.safeParse(record)
        if (done.success) return { record: done.data, jobId: row.id }
        const state = (record as { state?: unknown } | null)?.state
        if (
          state === 'unknown' ||
          state === 'submitting' ||
          state === 'pending' ||
          state === 'fetched'
        ) {
          unresolved = true
          unresolvedJob = row.id
        }
      }
    }
  }
  if (unresolved)
    throw new ProviderError(
      'unknown',
      `这段音频有尚未核查完成的历史识别任务（${unresolvedJob}），请在任务面板核查该原任务；不会再次提交识别`,
      { outcome: 'unknown', retryable: false },
    )
  return undefined
}
