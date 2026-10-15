// 把插件和它用到的 SDK、zod 打成一个文件：子进程只能读插件自己的目录，不能从外面的 node_modules 加载
// 用法：node build.mjs [输出目录]，默认输出到本目录的 dist/
import { cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite-plus/pack'

const here = fileURLToPath(new URL('.', import.meta.url))
// 仓库里的示例直接用工作区的 SDK 源码；自己写插件时装 @plein/plugin-sdk 和 zod 即可
const sdk = join(here, '../../../packages/plugin-sdk')
const out = process.argv[2] ?? here
mkdirSync(join(out, 'dist'), { recursive: true })
await build({
  config: false,
  cwd: here,
  entry: { server: join(here, 'src/server.ts') },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: join(out, 'dist'),
  clean: false,
  dts: false,
  deps: { alwaysBundle: () => true },
  alias: {
    '@plein/plugin-sdk/child': join(sdk, 'src/child.ts'),
    '@plein/plugin-sdk': join(sdk, 'src/index.ts'),
    zod: join(sdk, 'node_modules/zod'),
  },
  logLevel: 'warn',
})
if (out !== here) cpSync(join(here, 'plein-plugin.json'), join(out, 'plein-plugin.json'))
