/** stable-production.ts 的独立进程冷启动探针；不新增生成，不启动 HTTP。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createDoc, currentResult } from '@plein/doc'
import { createServer } from '../src/app'
import { loadConfig } from '../src/config'
import { builtinPlugins } from '../src/plugins/builtin'
import { sequenceEditState } from './stable-production-snapshot'

const [dataDir, canvasId, sequenceId, assetId] = process.argv.slice(2)
assert(dataDir && canvasId && sequenceId && assetId)
let providerAttempts = 0
let networkFetchAttempts = 0
// 在 createServer 恢复任务前安装拦截，覆盖所有内置平台 submit。
for (const plugin of builtinPlugins({ mock: false }))
  for (const provider of plugin.providers)
    provider.submit = async () => {
      providerAttempts++
      throw new Error('冷启动探针禁止新增提交')
    }
globalThis.fetch = async () => {
  networkFetchAttempts++
  throw new Error('冷启动探针禁止网络 fetch')
}
const server = await createServer({
  ...loadConfig({
    ...process.env,
    PLEIN_DATA_DIR: dataDir,
    PLEIN_PORT: '0',
    PLEIN_MOCK_PROVIDER: '0',
    PLEIN_AGENT: '0',
    PLEIN_MCP: '0',
  }),
  webDist: null,
})
try {
  const active = server.db.$client
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')")
    .get() as { n: number }
  assert.equal(active.n, 0)
  const doc = createDoc(server.rooms.get(canvasId).doc)
  assert.equal(
    (currentResult(doc.get(sequenceId)!)?.value as { assetId: string })?.assetId,
    assetId,
  )
  const rows = server.db.$client.prepare('SELECT DISTINCT id FROM assets').all() as Array<{
    id: string
  }>
  for (const { id } of rows) {
    const digest = createHash('sha256')
    for await (const bytes of createReadStream(server.assets.originalPath(id))) digest.update(bytes)
    assert.equal(digest.digest('hex'), id, '冷启动后素材仍必须存在且完整')
  }
  const adoption = Object.fromEntries(
    [...doc.elements()]
      .filter((el) => el.id !== sequenceId && el.results?.length)
      .map((el) => [
        el.id,
        { adopted: el.adopted, results: el.results, current: currentResult(el) },
      ]),
  )
  assert.equal(providerAttempts, 0)
  assert.equal(networkFetchAttempts, 0)
  console.log(
    JSON.stringify({
      pid: process.pid,
      providerAttempts,
      networkFetchAttempts,
      assetsChecked: rows.length,
      adoption,
      sequenceState: sequenceEditState(doc, sequenceId),
    }),
  )
} finally {
  await server.close()
}
