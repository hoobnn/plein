/**
 * 远端模型列表的合并规则与缓存。
 * 内置目录的元数据（能力、参数、尺寸）是各家列表接口不返回的，永远以内置为准；
 * 远端列表只用来标记目录条目的可用性，并把目录没收录的新模型以通用能力展示。
 */
import type { Capability, ModelInfo, RemoteModel } from '@plein/plugin-sdk'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CatalogModel, RemoteModelsStatus } from '@plein/protocol'
import { credentialFingerprint } from './config-store'

/** TTL 之内且密钥没换才算新鲜 */
export const REMOTE_MODELS_TTL_MS = 24 * 60 * 60 * 1000

/** 占位模型槽（如方舟的「自定义模型」）不代表平台上真实存在的模型，不参与远端比对 */
const PSEUDO_MODEL_IDS = new Set(['custom-chat', 'custom-image', 'custom-video'])

/**
 * 按 id 前缀 / 平台类型提示推断通用能力；推断不出就归为对话（llm），
 * 与任务约定一致：宁可在生成器里以通用参数展示，也不静默丢掉平台确实返回的模型
 */
export function inferCapability(model: RemoteModel): Capability {
  if (model.kind) {
    const byKind: Record<NonNullable<RemoteModel['kind']>, Capability> = {
      llm: 'text.chat',
      image: 'image.generate',
      video: 'video.generate',
      speech: 'audio.speech',
      music: 'audio.music',
    }
    return byKind[model.kind]
  }
  const id = model.id.toLowerCase()
  if (/(seedream|image|flux|dall-e|wanx|qwen-image)/.test(id)) return 'image.generate'
  if (/(seedance|video|hailuo|kling|t2v|i2v|wan\d)/.test(id)) return 'video.generate'
  if (/(speech|tts|voice)/.test(id)) return 'audio.speech'
  if (/music/.test(id)) return 'audio.music'
  return 'text.chat'
}

/** 合并内置目录与远端列表；remote 为 undefined（没拉取过）时不加任何标记 */
export function applyRemoteModels(base: ModelInfo[], remote?: RemoteModel[]): CatalogModel[] {
  const remoteIds = new Set(remote?.map((m) => m.id) ?? [])
  const hasRemote = remote !== undefined
  // 占位槽保留原样（不标可用性），其余内置条目按远端返回与否标 available / unlisted
  const local = base.map<CatalogModel>((m) =>
    PSEUDO_MODEL_IDS.has(m.id)
      ? { ...m }
      : {
          ...m,
          ...(hasRemote
            ? { remote: remoteIds.has(m.id) ? ('available' as const) : ('unlisted' as const) }
            : {}),
        },
  )
  const known = new Set(base.map((m) => m.id))
  const extra = (remote ?? [])
    .filter((m) => !known.has(m.id))
    .map<CatalogModel>((m) => ({
      id: m.id,
      title: m.name ?? m.id,
      capabilities: [inferCapability(m)],
      description: '参数为通用默认，以平台列表为准',
      remoteOnly: true,
    }))
  return [...local, ...extra]
}

/** 一条缓存记录：fingerprint 标记是哪组密钥拉的，换密钥后旧记录不再适用 */
interface StoredRemoteModels {
  fingerprint?: string
  fetchedAt: number
  models: RemoteModel[]
  error?: string
}

/** 远端模型列表缓存：内存 + 落盘（数据目录 remote-models.json），按平台一份 */
export class RemoteModelCache {
  private file: string
  private data: Record<string, StoredRemoteModels>

  constructor(
    /** 数据目录；为空时只留在内存（测试或未接数据目录的宿主） */
    dataDir: string,
    private ttlMs = REMOTE_MODELS_TTL_MS,
    private now = Date.now,
  ) {
    this.file = dataDir ? join(dataDir, 'remote-models.json') : ''
    this.data =
      this.file && existsSync(this.file)
        ? (JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, StoredRemoteModels>)
        : {}
  }

  /** 指定平台当前密钥下的缓存状态；平台没实现拉取时不会写入，无需在这里区分 */
  status(id: string, fingerprint: string): RemoteModelsStatus {
    const entry = this.data[id]
    if (!entry || entry.fingerprint !== fingerprint) return { fetchedAt: null, status: 'idle' }
    const fresh = this.now() - entry.fetchedAt < this.ttlMs
    return {
      fetchedAt: entry.fetchedAt,
      status: fresh ? 'fresh' : 'stale',
      ...(entry.error && fresh ? { error: entry.error } : {}),
    }
  }

  /** 指定平台当前密钥下的远端列表；没拉取过、密钥已换或只有失败记录（无可信列表）为 undefined */
  models(id: string, fingerprint: string): RemoteModel[] | undefined {
    const entry = this.data[id]
    if (entry?.fingerprint !== fingerprint) return undefined
    return entry.models.length === 0 && entry.error ? undefined : entry.models
  }

  /** 记录一次拉取结果；失败也记（错误信息 + 不覆盖上一次成功的列表） */
  record(id: string, fingerprint: string, models: RemoteModel[], error?: string) {
    const previous = this.data[id]
    const keep = error && previous?.fingerprint === fingerprint ? previous.models : models
    this.data[id] = {
      fingerprint,
      fetchedAt: this.now(),
      models: keep,
      ...(error ? { error } : {}),
    }
    this.save()
  }

  /** 密钥更换或平台停用后清掉旧密钥的记录，避免落盘里留下过期数据 */
  invalidate(id: string) {
    if (!this.data[id]) return
    delete this.data[id]
    this.save()
  }

  private save() {
    if (!this.file) return
    writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }
}

/** 密钥指纹：与密钥组管理共用一套算法，换密钥后缓存自动失效 */
export const remoteModelsFingerprint = credentialFingerprint
