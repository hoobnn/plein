import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/main.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outDir: 'dist',
    deps: { neverBundle: ['electron'] },
  },
  {
    // 开启沙箱的 preload 只能是 CommonJS
    entry: ['src/preload.ts'],
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    outDir: 'dist',
    deps: { neverBundle: ['electron'] },
  },
])
