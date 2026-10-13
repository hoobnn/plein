import { defineConfig } from 'vite-plus'

/** 服务端打包（vp pack，即 tsdown）：发布与 Docker 用 dist/main.mjs */
export default defineConfig({
  pack: {
    entry: ['src/main.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outDir: 'dist',
    deps: {
      // 工作区包打进产物；原生模块与较大的运行时依赖保持外部引用
      alwaysBundle: [/^@plein\//],
      neverBundle: ['better-sqlite3', 'sharp', 'ws'],
    },
  },
})
