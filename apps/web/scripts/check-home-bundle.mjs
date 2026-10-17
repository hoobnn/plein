import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const dist = resolve(import.meta.dirname, '../dist')
const manifest = JSON.parse(readFileSync(join(dist, '.vite/manifest.json'), 'utf8'))
const visited = new Set()
const visit = (key) => {
  if (visited.has(key)) return
  const item = manifest[key]
  if (!item) throw new Error(`Missing build manifest entry: ${key}`)
  visited.add(key)
  for (const dependency of item.imports ?? []) visit(dependency)
}
visit('index.html')
visit('src/pages/Home.tsx')
const files = [
  ...new Set([...visited].map((key) => manifest[key].file).filter((file) => file.endsWith('.js'))),
]
const bytes = files.reduce(
  (sum, file) => sum + gzipSync(readFileSync(join(dist, file))).byteLength,
  0,
)
const limit = 300 * 1024
console.log(
  `Home initial JS gzip: ${(bytes / 1024).toFixed(2)} KiB (${files.length} chunks; budget 300 KiB)`,
)
if (bytes > limit) throw new Error('Home initial JS exceeds its 300 KiB budget')
