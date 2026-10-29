import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ProviderCredential {
  id: string
  label: string
  secrets: Record<string, string>
}

export function credentialFingerprint(secrets: Record<string, string>): string {
  const sorted = Object.fromEntries(
    Object.keys(secrets)
      .sort()
      .map((key) => [key, secrets[key]]),
  )
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16)
}

/** 一个平台的配置：开关、非敏感设置、密钥组（明文存在仅本用户可读的文件里，不进文档和日志） */
export interface ProviderConfig {
  enabled: boolean
  settings: Record<string, unknown>
  /** 当前生效组的密钥，由 credentials 派生 */
  secrets: Record<string, string>
  credentials: ProviderCredential[]
  activeCredential?: string
}

type StoredProviderConfig = Omit<ProviderConfig, 'secrets' | 'credentials'> & {
  secrets?: Record<string, string>
  credentials?: ProviderCredential[]
}

export interface ProviderConfigPatch {
  enabled?: boolean
  settings?: Record<string, unknown>
  secrets?: Record<string, string | null>
  credentials?: {
    add?: Array<{ label: string; secrets: Record<string, string> }>
    update?: Array<{
      id: string
      label?: string
      secrets?: Record<string, string | null>
    }>
    remove?: string[]
  }
  activeCredential?: string
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export class ProviderConfigStore {
  private file: string
  private data: Record<string, StoredProviderConfig>
  /** 每种模型能力的默认模型（`平台:模型` 引用），新建节点时写进节点 */
  private defaultsFile: string
  private defaults: Record<string, string>

  constructor(
    dataDir: string,
    /** 没有配置过时默认启用的平台（如开发用的 mock） */
    private enabledByDefault: ReadonlySet<string> = new Set(),
  ) {
    this.file = join(dataDir, 'providers.json')
    this.data = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, StoredProviderConfig>)
      : {}
    let migrated = false
    for (const config of Object.values(this.data)) {
      if (!config.credentials?.length) {
        config.credentials = []
        if (config.secrets && Object.keys(config.secrets).length) {
          const credential = { id: randomUUID(), label: '默认', secrets: { ...config.secrets } }
          config.credentials = [credential]
          config.activeCredential = credential.id
        }
        migrated = true
      }
      if (config.secrets) {
        delete config.secrets
        migrated = true
      }
    }
    if (migrated) this.save()
    this.defaultsFile = join(dataDir, 'models.json')
    this.defaults = existsSync(this.defaultsFile)
      ? (JSON.parse(readFileSync(this.defaultsFile, 'utf8')) as Record<string, string>)
      : {}
  }

  defaultModel(capability: string): string | undefined {
    return this.defaults[capability]
  }

  setDefaultModel(capability: string, ref: string) {
    if (this.defaults[capability] === ref) return
    this.defaults[capability] = ref
    write(this.defaultsFile, this.defaults)
  }

  get(id: string): ProviderConfig {
    const c = this.data[id]
    const active = c?.credentials?.find((credential) => credential.id === c.activeCredential)
    return {
      enabled: c?.enabled ?? this.enabledByDefault.has(id),
      settings: { ...c?.settings },
      secrets: { ...active?.secrets },
      credentials: (c?.credentials ?? []).map(cloneCredential),
      activeCredential: c?.activeCredential,
    }
  }

  /** 取指定密钥组；缺省取当前组 */
  credential(id: string, credentialId?: string): ProviderCredential | undefined {
    const c = this.data[id]
    const selected = credentialId ?? c?.activeCredential
    const credential = c?.credentials?.find((item) => item.id === selected)
    return credential ? cloneCredential(credential) : undefined
  }

  /** 在克隆上执行完整补丁，全部校验通过后一次落盘 */
  apply(id: string, patch: ProviderConfigPatch): ProviderConfig {
    const next = this.get(id)
    for (const credentialId of patch.credentials?.remove ?? []) removeCredential(next, credentialId)
    for (const credential of patch.credentials?.update ?? [])
      patchCredential(next, credential.id, credential)
    for (const credential of patch.credentials?.add ?? [])
      addCredential(next, credential.label, credential.secrets)
    if (patch.activeCredential !== undefined) setActiveCredential(next, patch.activeCredential)
    patchSecrets(next, patch.secrets)
    if (patch.enabled !== undefined) next.enabled = patch.enabled
    if (patch.settings) next.settings = patch.settings
    return this.commit(id, next)
  }

  /** 合并更新；扁平 secrets 作用于当前组，值为 null 或空串表示删除 */
  update(
    id: string,
    patch: {
      enabled?: boolean
      settings?: Record<string, unknown>
      secrets?: Record<string, string | null>
    },
  ): ProviderConfig {
    return this.apply(id, patch)
  }

  addCredential(id: string, label: string, secrets: Record<string, string>): ProviderConfig {
    const next = this.get(id)
    addCredential(next, label, secrets)
    return this.commit(id, next)
  }

  patchCredential(
    id: string,
    credentialId: string,
    patch: { label?: string; secrets?: Record<string, string | null> },
  ): ProviderConfig {
    const next = this.get(id)
    patchCredential(next, credentialId, patch)
    return this.commit(id, next)
  }

  removeCredential(id: string, credentialId: string): ProviderConfig {
    const next = this.get(id)
    removeCredential(next, credentialId)
    return this.commit(id, next)
  }

  setActiveCredential(id: string, credentialId: string): ProviderConfig {
    const next = this.get(id)
    setActiveCredential(next, credentialId)
    return this.commit(id, next)
  }

  private commit(id: string, config: ProviderConfig): ProviderConfig {
    this.data[id] = {
      enabled: config.enabled,
      settings: config.settings,
      credentials: config.credentials,
      activeCredential: config.activeCredential,
    }
    this.save()
    return this.get(id)
  }

  private save() {
    write(this.file, this.data)
  }
}

function cloneCredential(credential: ProviderCredential): ProviderCredential {
  return { ...credential, secrets: { ...credential.secrets } }
}

function patchSecrets(config: ProviderConfig, secrets?: Record<string, string | null>) {
  if (!secrets) return
  if (!config.credentials.length) {
    if (!Object.values(secrets).some(Boolean)) return
    const credential = { id: randomUUID(), label: '默认', secrets: {} }
    config.credentials = [credential]
    config.activeCredential = credential.id
  }
  const active = findCredential(
    config.credentials,
    config.activeCredential ?? '',
    '当前密钥组不存在',
  )
  for (const [k, v] of Object.entries(secrets)) {
    if (v) active.secrets[k] = v
    else delete active.secrets[k]
  }
}

function addCredential(config: ProviderConfig, label: string, secrets: Record<string, string>) {
  const credential = {
    id: randomUUID(),
    label: credentialLabel(config.credentials, label),
    secrets: { ...secrets },
  }
  config.credentials.push(credential)
  if (config.credentials.length === 1) config.activeCredential = credential.id
}

function patchCredential(
  config: ProviderConfig,
  credentialId: string,
  patch: { label?: string; secrets?: Record<string, string | null> },
) {
  const credential = findCredential(config.credentials, credentialId)
  if (patch.label !== undefined)
    credential.label = credentialLabel(config.credentials, patch.label, credentialId)
  for (const [k, v] of Object.entries(patch.secrets ?? {})) {
    if (v) credential.secrets[k] = v
    else delete credential.secrets[k]
  }
}

function removeCredential(config: ProviderConfig, credentialId: string) {
  findCredential(config.credentials, credentialId)
  config.credentials = config.credentials.filter((credential) => credential.id !== credentialId)
  if (config.activeCredential === credentialId) config.activeCredential = config.credentials[0]?.id
}

function setActiveCredential(config: ProviderConfig, credentialId: string) {
  findCredential(config.credentials, credentialId)
  config.activeCredential = credentialId
}

function findCredential(
  credentials: ProviderCredential[],
  id: string,
  message = '密钥组不存在',
): ProviderCredential {
  const credential = credentials.find((item) => item.id === id)
  if (!credential) throw new ConfigError(message)
  return credential
}

function credentialLabel(
  credentials: ProviderCredential[],
  label: string,
  excludeId?: string,
): string {
  const trimmed = label.trim()
  if (!trimmed || trimmed.length > 40) throw new ConfigError('密钥组标签须为 1–40 个字符')
  if (
    credentials.some(
      (credential) =>
        credential.id !== excludeId && credential.label.toLowerCase() === trimmed.toLowerCase(),
    )
  )
    throw new ConfigError('同一平台的密钥组标签不可重复')
  return trimmed
}

function write(file: string, data: unknown) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}
