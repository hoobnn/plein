import { randomBytes } from 'node:crypto'
import type { UpdateVoice, Voice, VoiceStatus } from '@plein/protocol'
import { and, desc, eq } from 'drizzle-orm'
import type { DB } from '../storage/db'
import { voices } from '../storage/schema'

type VoiceRow = typeof voices.$inferSelect

/** data 列里存的字段 */
type VoiceData = Pick<
  Voice,
  | 'message'
  | 'sampleAssetId'
  | 'gender'
  | 'age'
  | 'source'
  | 'previewAssetId'
  | 'credentialId'
  | 'credentialFingerprint'
  | 'credentialLabel'
>

const toVoice = (r: VoiceRow): Voice => {
  const d = JSON.parse(r.data) as Partial<VoiceData>
  return {
    id: r.id,
    provider: r.provider,
    voiceId: r.voice_id,
    name: r.name,
    status: r.status as VoiceStatus,
    message: d.message ?? null,
    source: d.source ?? (d.sampleAssetId ? 'clone' : 'register'),
    previewAssetId: d.previewAssetId ?? null,
    credentialId: d.credentialId ?? null,
    credentialFingerprint: d.credentialFingerprint ?? null,
    credentialLabel: d.credentialLabel ?? null,
    sampleAssetId: d.sampleAssetId ?? null,
    gender: d.gender ?? null,
    age: d.age ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

const dataOf = (v: VoiceData) =>
  JSON.stringify({
    message: v.message,
    source: v.source,
    previewAssetId: v.previewAssetId,
    credentialId: v.credentialId ?? null,
    credentialFingerprint: v.credentialFingerprint ?? null,
    credentialLabel: v.credentialLabel ?? null,
    sampleAssetId: v.sampleAssetId,
    gender: v.gender,
    age: v.age,
  })

/** 我的音色的增删改查，按所有者隔离；同一平台的同一音色 ID 只记一条 */
export class VoiceStore {
  constructor(private db: DB) {}

  private mine(owner: string, id: string) {
    return and(eq(voices.id, id), eq(voices.owner_id, owner))
  }

  list(owner: string): Voice[] {
    return this.db
      .select()
      .from(voices)
      .where(eq(voices.owner_id, owner))
      .orderBy(desc(voices.created_at))
      .all()
      .map(toVoice)
  }

  get(owner: string, id: string): Voice | null {
    const row = this.db.select().from(voices).where(this.mine(owner, id)).get()
    return row ? toVoice(row) : null
  }

  find(owner: string, provider: string, voiceId: string): Voice | null {
    const row = this.db
      .select()
      .from(voices)
      .where(
        and(
          eq(voices.owner_id, owner),
          eq(voices.provider, provider),
          eq(voices.voice_id, voiceId),
        ),
      )
      .get()
    return row ? toVoice(row) : null
  }

  /** 新建；同一音色已有记录时（如豆包同一槽位重新训练）覆盖那一条 */
  save(
    owner: string,
    v: Pick<Voice, 'provider' | 'voiceId' | 'name' | 'status'> & VoiceData,
  ): Voice {
    const now = Date.now()
    const existing = this.find(owner, v.provider, v.voiceId)
    if (existing) {
      this.db
        .update(voices)
        .set({ name: v.name, status: v.status, data: dataOf(v), updated_at: now })
        .where(this.mine(owner, existing.id))
        .run()
      return this.get(owner, existing.id)!
    }
    const id = `voice_${randomBytes(9).toString('base64url')}`
    this.db
      .insert(voices)
      .values({
        id,
        owner_id: owner,
        provider: v.provider,
        voice_id: v.voiceId,
        name: v.name,
        status: v.status,
        data: dataOf(v),
        created_at: now,
        updated_at: now,
      })
      .run()
    return this.get(owner, id)!
  }

  update(owner: string, id: string, patch: UpdateVoice): Voice | null {
    const cur = this.get(owner, id)
    if (!cur) return null
    const next = { ...cur, ...patch }
    this.db
      .update(voices)
      .set({ name: next.name, data: dataOf(next), updated_at: Date.now() })
      .where(this.mine(owner, id))
      .run()
    return this.get(owner, id)
  }

  /** 记下训练状态；message 为空表示清掉上次的错误 */
  setStatus(owner: string, id: string, status: VoiceStatus, message: string | null) {
    const cur = this.get(owner, id)
    if (!cur) return null
    this.db
      .update(voices)
      .set({ status, data: dataOf({ ...cur, message }), updated_at: Date.now() })
      .where(this.mine(owner, id))
      .run()
    return this.get(owner, id)
  }

  setPreview(owner: string, id: string, previewAssetId: string) {
    const cur = this.get(owner, id)
    if (!cur) return null
    this.db
      .update(voices)
      .set({ data: dataOf({ ...cur, previewAssetId }), updated_at: Date.now() })
      .where(this.mine(owner, id))
      .run()
    return this.get(owner, id)
  }

  /** 设置页统计全 owner 的音色；音色仍按平台隔离，避免不同平台的组 id 混算。 */
  credentialUsage(provider: string): Record<string, number> {
    const usage: Record<string, number> = {}
    const rows = this.db
      .select({ data: voices.data })
      .from(voices)
      .where(eq(voices.provider, provider))
      .all()
    for (const row of rows) {
      const credentialId = (JSON.parse(row.data) as Partial<VoiceData>).credentialId
      if (credentialId) usage[credentialId] = (usage[credentialId] ?? 0) + 1
    }
    return usage
  }

  remove(owner: string, id: string): boolean {
    return this.db.delete(voices).where(this.mine(owner, id)).run().changes > 0
  }
}

/**
 * 宿主生成的音色 ID：字母开头、只有小写字母和数字，
 * 满足各家对自定义音色 ID 的限制（如 MiniMax 要求 8–256 位、不以 - 或 _ 结尾）
 */
export function generatedVoiceId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(16)
  return `plein${[...bytes].map((b) => alphabet[b % alphabet.length]).join('')}`
}
