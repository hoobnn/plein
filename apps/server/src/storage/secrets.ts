import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Secrets {
  /** 访问令牌：监听非本机地址时用于登录 */
  token: string
  /** 会话 Cookie 签名密钥 */
  cookieSecret: string
}

/** 首次启动时生成，保存在数据目录（仅本用户可读写） */
export function loadSecrets(dataDir: string): Secrets {
  const file = join(dataDir, 'secret.json')
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Secrets
  const secrets: Secrets = {
    token: randomBytes(18).toString('base64url'),
    cookieSecret: randomBytes(32).toString('base64url'),
  }
  writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 })
  return secrets
}
