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

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await build({
  config: false,
  cwd: serverSrc,
  entry: { main: join(serverSrc, 'src/main.ts') },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: out,
  clean: false,
  dts: false,
  // 除原生模块外全部打进来，安装包里不带上百 MB 的开发依赖
  deps: {
    alwaysBundle: (id) => !NATIVE.some((n) => id === n || id.startsWith(`${n}/`)),
    neverBundle: NATIVE,
  },
  // 打进 bundle 的 CommonJS 依赖里还有 require()，ESM 产物里补一个
  banner: {
    js: "import { createRequire as __pleinRequire } from 'node:module'; const require = __pleinRequire(import.meta.url);",
  },
  logLevel: 'warn',
})

/** 复制一个包及其（可选）依赖，平铺到 out/node_modules；跟随 pnpm 的符号链接 */
const copied = new Map()
function copyPackage(name, fromDir) {
  const pkgJson = findPackage(name, fromDir)
  if (!pkgJson) return // 可选依赖在当前平台没装
  const dir = realpathSync(dirname(pkgJson))
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'))
  if (copied.has(name)) {
    if (copied.get(name) !== pkg.version)
      throw new Error(`${name} 有两个版本（${copied.get(name)}、${pkg.version}），平铺不下`)
    return
  }
  copied.set(name, pkg.version)
  cpSync(dir, join(out, 'node_modules', name), {
    recursive: true,
    dereference: true,
    // 嵌套的 node_modules 单独处理；源码、测试和构建中间文件不带
    filter: (src) => {
      const rel = src.slice(dir.length)
      return !/\/node_modules(\/|$)|\/(src|deps|test|docs)(\/|$)|\.(md|ts|map|gyp|cc|h)$|\/build\/(Release\/obj|deps)/.test(
        rel,
      )
    },
  })
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }))
    copyPackage(dep, dir)
}
/** 按 Node 的查找规则逐级往上找 node_modules/<name>（有的包不导出 package.json，不能用 require.resolve） */
function findPackage(name, fromDir) {
  for (let d = fromDir; ; d = dirname(d)) {
    const file = join(d, 'node_modules', name, 'package.json')
    if (existsSync(file)) return file
    if (dirname(d) === d) return null
  }
}

for (const name of NATIVE) copyPackage(name, serverSrc)

// better-sqlite3 自带所有平台的预编译文件，只留当前平台的
const prebuilds = join(out, 'node_modules/better-sqlite3/prebuilds')
if (existsSync(prebuilds))
  for (const f of readdirSync(prebuilds))
    if (!f.startsWith(`${process.platform}-`)) rmSync(join(prebuilds, f))

const versions = Object.fromEntries([...copied].sort(([a], [b]) => a.localeCompare(b)))
writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify({ name: 'plein-server', private: true, type: 'module', main: 'main.mjs', dependencies: Object.fromEntries(NATIVE.map((n) => [n, versions[n]])) }, null, 2)}\n`,
)
for (const n of NATIVE)
  if (!existsSync(join(out, 'node_modules', n))) throw new Error(`没有找到原生模块 ${n}`)
console.log(`服务端已准备：${out}`)
console.log(
  `  原生模块：${Object.entries(versions)
    .map(([n, v]) => `${n}@${v}`)
    .join('、')}`,
)
