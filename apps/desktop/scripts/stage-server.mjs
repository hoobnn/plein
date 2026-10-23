// 打包前准备服务端：apps/server 整个打成一个 main.mjs，只有原生模块留在 node_modules。
// 原生模块直接从本机已安装的依赖里复制（版本即 lockfile 里的版本，平台即当前机器），不联网。
// 产物：apps/desktop/stage/server/{main.mjs,node_modules,package.json}
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite-plus/pack'

const desktop = fileURLToPath(new URL('..', import.meta.url))
const serverSrc = join(desktop, '../server')
const out = join(desktop, 'stage/server')
/** 带 .node 二进制或平台子包的依赖，不能打进 bundle */
const NATIVE = ['better-sqlite3', 'sharp']
const EXTERNAL = [
  ...NATIVE,
  '@hyperframes/producer',
  '@hyperframes/sdk',
  '@hyperframes/player',
  'gsap',
  '@fontsource/noto-sans-sc',
]
const isExternal = (id) =>
  id.startsWith('@hyperframes/') ||
  EXTERNAL.some((name) => id === name || id.startsWith(`${name}/`))

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await build({
  config: false,
  cwd: serverSrc,
  entry: {
    main: join(serverSrc, 'src/main.ts'),
    'motion/worker': join(serverSrc, 'src/motion/worker.ts'),
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: out,
  clean: false,
  dts: false,
  // HTML渲染依赖有运行时资源和独立worker，保留正式发布包，其余JS打进来
  deps: {
    alwaysBundle: (id) => !isExternal(id),
    neverBundle: [...EXTERNAL, /^@hyperframes\//],
  },
  // 打进 bundle 的 CommonJS 依赖里还有 require()，ESM 产物里补一个
  banner: {
    js: "import { createRequire as __pleinRequire } from 'node:module'; const require = __pleinRequire(import.meta.url);",
  },
  logLevel: 'warn',
})

/** 复制一个包及其（可选）依赖，平铺到 out/node_modules；跟随 pnpm 的符号链接 */
const copied = new Map()
function copyPackage(name, fromDir, dependentDir = out) {
  const pkgJson = findPackage(name, fromDir)
  if (!pkgJson) return // 可选依赖在当前平台没装
  const dir = realpathSync(dirname(pkgJson))
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'))
  const rootKey = `root:${name}`
  let target = join(out, 'node_modules', name)
  if (copied.has(rootKey)) {
    if (copied.get(rootKey) === pkg.version) return
    target = join(dependentDir, 'node_modules', name)
  } else copied.set(rootKey, pkg.version)
  const key = `${target}@${pkg.version}`
  if (copied.has(key)) return
  copied.set(key, pkg.version)
  cpSync(dir, target, {
    recursive: true,
    dereference: true,
    // 嵌套的 node_modules 单独处理；源码、测试和构建中间文件不带
    filter: (src) => {
      const rel = src.slice(dir.length)
      if (name === 'gsap' && rel === '/README.md') return true
      if (name === '@fontsource/noto-sans-sc') {
        if (rel.startsWith('/files/')) return /-(400|700)-normal\.woff2$/.test(rel)
        if (rel.endsWith('.css')) return rel === '/400.css' || rel === '/700.css'
      }
      return !/\/node_modules(\/|$)|\/(src|deps|test|docs)(\/|$)|\.(md|ts|map|gyp|cc|h)$|\/build\/(Release\/obj|deps)/.test(
        rel,
      )
    },
  })
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }))
    copyPackage(dep, dir, target)
}
/** 按 Node 的查找规则逐级往上找 node_modules/<name>（有的包不导出 package.json，不能用 require.resolve） */
function findPackage(name, fromDir) {
  for (let d = fromDir; ; d = dirname(d)) {
    const file = join(d, 'node_modules', name, 'package.json')
    if (existsSync(file)) return file
    if (dirname(d) === d) return null
  }
}

for (const name of EXTERNAL) copyPackage(name, serverSrc)

// better-sqlite3 自带所有平台的预编译文件（<平台>-<架构>.node，Linux 另有 linuxmusl-），只留当前平台和架构的
const prebuilds = join(out, 'node_modules/better-sqlite3/prebuilds')
const keep = new RegExp(`^${process.platform}(musl)?-${process.arch}\\.node$`)
if (existsSync(prebuilds))
  for (const f of readdirSync(prebuilds)) if (!keep.test(f)) rmSync(join(prebuilds, f))

const versions = Object.fromEntries(
  [...copied]
    .filter(([key]) => key.startsWith('root:'))
    .map(([key, version]) => [key.slice(5), version])
    .sort(([a], [b]) => a.localeCompare(b)),
)
writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify({ name: 'plein-server', private: true, type: 'module', main: 'main.mjs', dependencies: Object.fromEntries(EXTERNAL.map((n) => [n, versions[n]])) }, null, 2)}\n`,
)
for (const n of EXTERNAL)
  if (!existsSync(join(out, 'node_modules', n))) throw new Error(`没有找到原生模块 ${n}`)
console.log(`服务端已准备：${out}`)
console.log(
  `  运行时模块：${Object.entries(versions)
    .map(([n, v]) => `${n}@${v}`)
    .join('、')}`,
)
