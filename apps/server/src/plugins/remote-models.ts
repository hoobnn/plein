/**
 * 远端模型列表的合并规则与缓存。
 * 内置目录的元数据（能力、参数、尺寸）是各家列表接口不返回的，永远以内置为准；
 * 远端列表只用来标记目录条目的可用性，并把目录没收录的新模型以通用能力展示。
 * 缓存按「密钥指纹 + 影响列表请求的设置」隔离：换密钥或改地域 / Base URL 后旧列表自动失效。
 */
import type { Capability, ModelInfo, RemoteModel } from '@plein/plugin-sdk'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CatalogModel, RemoteModelsStatus } from '@plein/protocol'
import { credentialFingerprint } from './config-store'

/** TTL 之内且密钥、相关设置都没变才算新鲜 */
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

/**
 * 合并内置目录与远端列表；remote 为 undefined（没拉取过）时不加任何标记。
 * 可用性只标在覆盖范围内的能力上（如 MiniMax 列表只覆盖对话，图片 / 视频内置模型保持未标记）；
 * 目录没收录的新模型全部以通用能力追加，其中只有对话类会进生成器，其余仅设置里展示
 */
export function applyRemoteModels(
  base: ModelInfo[],
  remote: RemoteModel[] | undefined,
  scope: Capability[],
): CatalogModel[] {
  const remoteIds = new Set(remote?.map((m) => m.id) ?? [])
  const hasRemote = remote !== undefined
  const inScope = (entry: ModelInfo) => entry.capabilities.some((c) => scope.includes(c))
  // 占位槽保留原样（不标可用性）；覆盖范围外的内置条目同样不标
  const local = base.map<CatalogModel>((m) =>
    PSEUDO_MODEL_IDS.has(m.id) || (hasRemote && !inScope(m))
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

/** 一条缓存记录：fingerprint + settings 一起构成缓存上下文，任一变化旧记录即不可见 */
interface StoredRemoteModels {
  fingerprint?: string
  /** 影响列表请求的规范化设置值（remoteModelsContextKey 的结果） */
  settings?: string
  fetchedAt: number
  models: RemoteModel[]
  error?: string
}

/** 记录结构校验：旧版本或损坏的缓存按不存在处理，重新拉取即可 */
function parseStored(value: unknown): Record<string, StoredRemoteModels> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, StoredRemoteModels> = {}
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Partial<StoredRemoteModels>
    if (
      typeof e.fetchedAt !== 'number' ||
      !Array.isArray(e.models) ||
      e.models.some((m) => typeof m?.id !== 'string')
    )
      continue
    out[id] = {
      fingerprint: e.fingerprint,
      settings: e.settings,
      fetchedAt: e.fetchedAt,
      models: e.models,
      ...(typeof e.error === 'string' ? { error: e.error } : {}),
    }
  }
  return out
}

function writeAtomic(file: string, data: unknown) {
  // 与 config-store 相同的原子写：临时文件 0600 + rename，进程中途退出不会留下半个文件
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
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
    // 缓存可随时重建：读取或校验失败就当空缓存，重新拉取，不影响服务启动
    this.data = {}
    if (this.file && existsSync(this.file)) {
      try {
        this.data = parseStored(JSON.parse(readFileSync(this.file, 'utf8')))
      } catch {
        this.data = {}
      }
    }
  }

  private matches(
    entry: StoredRemoteModels | undefined,
    fingerprint: string,
    settings: string,
  ): boolean {
    return entry !== undefined && entry.fingerprint === fingerprint && entry.settings === settings
  }

  /** 指定平台当前密钥与设置下的缓存状态 */
  status(id: string, fingerprint: string, settings: string): RemoteModelsStatus {
    const entry = this.data[id]
    if (!entry || !this.matches(entry, fingerprint, settings))
      return { fetchedAt: null, status: 'idle' }
    const fresh = this.now() - entry.fetchedAt < this.ttlMs
    return {
      fetchedAt: entry.fetchedAt,
      status: fresh ? 'fresh' : 'stale',
      ...(entry.error && fresh ? { error: entry.error } : {}),
    }
  }

  /** 指定平台当前密钥与设置下的远端列表；没拉取过、密钥或设置已变、只有失败记录为 undefined */
  models(id: string, fingerprint: string, settings: string): RemoteModel[] | undefined {
    const entry = this.data[id]
    if (!entry || !this.matches(entry, fingerprint, settings)) return undefined
    return entry.models.length === 0 && entry.error ? undefined : entry.models
  }

  /** 记录一次拉取结果；失败也记（错误信息 + 不覆盖上一次成功的列表） */
  record(id: string, fingerprint: string, settings: string, models: RemoteModel[], error?: string) {
    const previous = this.data[id]
    const keep =
      error && previous && this.matches(previous, fingerprint, settings)
        ? previous.models
        : models
    this.data[id] = {
      fingerprint,
      settings,
      fetchedAt: this.now(),
      models: keep,
      ...(error ? { error } : {}),
    }
    if (this.file) {
      try {
        writeAtomic(this.file, this.data)
      } catch {
        // 落盘失败只影响下次启动的缓存命中，内存里的结果照常生效
      }
    }
  }

  /** 密钥或设置被清空后丢弃旧记录，避免落盘里留下过期数据 */
  invalidate(id: string) {
    if (!this.data[id]) return
    delete this.data[id]
    if (this.file) {
      try {
        writeAtomic(this.file, this.data)
      } catch {
        // 同上：落盘失败不阻断
      }
    }
  }
}

/** 缓存上下文键：密钥 + 平台声明的相关设置值，规范化成字符串后参与比较 */
export function remoteModelsContextKey(
  keys: readonly string[] | undefined,
  settings: Record<string, unknown>,
): string {
  if (!keys?.length) return ''
  // 键序由声明顺序固定，字符串化后可直接比较
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, settings[key] ?? null])))
}

/** 密钥指纹：与密钥组管理共用一套算法，换密钥后缓存自动失效 */
export const remoteModelsFingerprint = credentialFingerprint
