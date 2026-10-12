import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Secrets {
  /** Better Auth 的签名与加密密钥 */
  authSecret: string
}

/** 首次启动时生成，保存在数据目录（仅本用户可读写） */
export function loadSecrets(dataDir: string): Secrets {
  const file = join(dataDir, 'secret.json')
  const saved = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Partial<Secrets>) : {}
  if (saved.authSecret) return saved as Secrets
  const secrets: Secrets = { ...saved, authSecret: randomBytes(32).toString('base64url') }
  writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 })
  return secrets
}
