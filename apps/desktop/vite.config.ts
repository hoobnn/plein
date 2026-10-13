import { defineConfig } from 'vite-plus'

const common = {
  platform: 'node' as const,
  target: 'node24',
  outDir: 'dist',
  deps: { neverBundle: ['electron'] },
}

/** Electron 主进程与 preload 打包（vp pack，即 tsdown） */
export default defineConfig({
  pack: [
    { ...common, entry: ['src/main.ts'], format: 'esm' },
    // 开启沙箱的 preload 只能是 CommonJS
    { ...common, entry: ['src/preload.ts'], format: 'cjs' },
  ],
})
