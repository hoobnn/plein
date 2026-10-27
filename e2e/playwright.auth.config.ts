import { defineConfig } from '@playwright/test'
import base from './playwright.config'
import development from './playwright.dev.config'

/**
 * 使用真实密码认证和隔离数据库；不改变其他浏览器回归的免登录模式。
 *
 * 后端由 worker 作用域的 fixture 起：每个 worker 一份，数据目录各自独立，
 * 密码认证由 PLEIN_E2E_AUTH 打开。
 */
if (process.env.PLEIN_E2E_AUTH_DEV !== '1') process.env.PLEIN_E2E_AUTH = '1'

const config = process.env.PLEIN_E2E_AUTH_DEV === '1' ? development : base

export default defineConfig({
  ...config,
  testMatch: 'auth-*.auth.ts',
})
