import { defineConfig } from '@playwright/test'
import base from './playwright.config'
import { outputPath } from './run-scope'

/**
 * 发布指标的测量（不进 `pnpm e2e`）：同样起真服务 + mock 平台，跑 bench/ 下的 *.bench.ts，
 * 结果打印到控制台。对比改动前后时把这两个文件拷进另一个检出再跑。
 */
export default defineConfig({
  ...base,
  outputDir: outputPath('bench'),
  testDir: 'bench',
  testMatch: '*.bench.ts',
  timeout: 600_000,
})
