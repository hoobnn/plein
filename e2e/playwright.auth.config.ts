import { defineConfig } from '@playwright/test'
import base from './playwright.config'
import development from './playwright.dev.config'

/** 使用真实密码认证和隔离数据库；不改变其他浏览器回归的免登录模式。 */
const config = process.env.PLEIN_E2E_AUTH_DEV === '1' ? development : base
const servers = Array.isArray(config.webServer) ? config.webServer : [config.webServer!]
export default defineConfig({
  ...config,
  testMatch: 'auth-lifecycle.auth.ts',
  webServer: servers.map((server, index) =>
    index === 0 ? { ...server, env: { ...server.env, PLEIN_AUTH: 'password' } } : server,
  ),
})
