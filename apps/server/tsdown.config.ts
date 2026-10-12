import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  // 工作区包打进产物；原生模块与较大的运行时依赖保持外部引用
  noExternal: [/^@plein\//],
  external: ['better-sqlite3', 'sharp', 'ws'],
})
