// 对签名、公证后的最终 ZIP 生成 sidecar；绝不能修改或重新打包 ZIP。
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
// 复用 lockfile 锁定的 builder 实现，生成 updater 6 可读取的 gzip JSON v2。
// 这是 builder 内部 API；下方格式校验及 contract 测试用于阻止升级后发布不兼容的格式。
const { buildBlockMap } = builderRequire('app-builder-lib/out/targets/blockmap/blockmap.js')
const { valid } = builderRequire('semver')

export async function prepareUpdate(zipPath, version) {
  if (!valid(version)) throw new Error('更新版本必须是合法的 semver')
  const zip = resolve(zipPath)
  if (!zip.endsWith('.zip')) throw new Error('更新文件必须是最终的 .zip')
  const size = (await stat(zip)).size
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(zip)) hash.update(chunk)
  const sha512 = hash.digest('base64')
  const blockmap = `${zip}.blockmap`
  const info = await buildBlockMap(zip, 'gzip', blockmap)
  if (info.sha512 !== sha512 || info.size !== size)
    throw new Error('生成 blockmap 时 ZIP 内容发生变化，停止发布')
  const map = JSON.parse(gunzipSync(await readFile(blockmap)).toString())
  if (
    map.version !== '2' ||
    map.files.reduce((n, f) => n + f.sizes.reduce((a, b) => a + b, 0), 0) !== size
  )
    throw new Error('blockmap 格式不兼容 updater 6 或未覆盖完整 ZIP')

  // JSON 字符串也是合法的 YAML 标量，避免文件名等字段被解释为 YAML 语法。
  const name = JSON.stringify(basename(zip))
  const feed = join(dirname(zip), 'latest-mac.yml')
  await writeFile(
    feed,
    `version: ${JSON.stringify(version)}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${size}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`,
  )
  return { blockmap, feed, sha512, size }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('用法：node prepare-update.mjs <最终 ZIP> <版本>')
  const result = await prepareUpdate(process.argv[2], process.argv[3])
  console.log(`更新文件已准备：${result.blockmap}、${result.feed}`)
}
