import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 一个平台的配置：开关、非敏感设置、密钥（明文存在仅本用户可读的文件里，不进文档和日志） */
export interface ProviderConfig {
  enabled: boolean
  settings: Record<string, unknown>
  secrets: Record<string, string>
}

export class ProviderConfigStore {
  private file: string
  private data: Record<string, ProviderConfig>

  constructor(
    dataDir: string,
    /** 没有配置过时默认启用的平台（如开发用的 mock） */
    private enabledByDefault: ReadonlySet<string> = new Set(),
  ) {
    this.file = join(dataDir, 'providers.json')
    this.data = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, ProviderConfig>)
      : {}
  }

  get(id: string): ProviderConfig {
    const c = this.data[id]
    return {
      enabled: c?.enabled ?? this.enabledByDefault.has(id),
      settings: { ...(c?.settings ?? {}) },
      secrets: { ...(c?.secrets ?? {}) },
    }
  }

  /** 合并更新；secrets 里值为 null 或空串表示删除 */
  update(
    id: string,
    patch: {
      enabled?: boolean
      settings?: Record<string, unknown>
      secrets?: Record<string, string | null>
    },
  ): ProviderConfig {
    const next = this.get(id)
    if (patch.enabled !== undefined) next.enabled = patch.enabled
    if (patch.settings) next.settings = patch.settings
    for (const [k, v] of Object.entries(patch.secrets ?? {})) {
      if (v) next.secrets[k] = v
      else delete next.secrets[k]
    }
    this.data[id] = next
    this.save()
    return next
  }

  private save() {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
