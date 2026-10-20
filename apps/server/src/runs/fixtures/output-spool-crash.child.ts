/** 仅供 output-spool-crash.test；假平台完全不联网，计数落在测试专属 dataDir。 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { mockPlugin, mockProvider } from '@plein/providers'
import { PluginHost } from '../../plugins/host'
import { PluginRegistry } from '../../plugins/registry'
import { ProviderConfigStore } from '../../plugins/config-store'
import { AssetStore } from '../../assets/store'
import { openDb } from '../../storage/db'
import { JobStore } from '../store'

const [dataDir, mode, gate] = process.argv.slice(2)
if (
  !dataDir ||
  !['start', 'recover'].includes(mode ?? '') ||
  !['ready', 'ingest'].includes(gate ?? '')
)
  throw new Error('invalid fixture arguments')
const db = openDb(dataDir),
  assets = new AssetStore(dataDir, db, 32 * 1024 * 1024)
await assets.init()
const configs = new ProviderConfigStore(dataDir, new Set(['plein/mock']))
const host = new PluginHost(new PluginRegistry(), configs, assets, {
  fetch: (async () => {
    throw new Error('network forbidden in spool fixture')
  }) as typeof fetch,
})
mockProvider.submit = async () => {
  appendFileSync(join(dataDir, 'fixture-submit-count'), 'submit\n')
  return {
    state: 'succeeded',
    outputs: [
      {
        type: 'file',
        kind: 'audio',
        mime: 'application/octet-stream',
        data: new Uint8Array(16 * 1024 * 1024 + 1).fill(7),
      },
    ],
  }
}
host.load([mockPlugin], true)
const keepAlive = setInterval(() => {}, 1000)
const store = new JobStore(db)
if (mode === 'start') {
  db.$client
    .prepare(
      "INSERT INTO canvases(id,owner_id,title,created_at,updated_at) VALUES('c','local','c',1,1)",
    )
    .run()
  store.insert({
    id: 'spool-crash-job',
    ownerId: 'local',
    canvasId: 'c',
    nodeId: 'n',
    nodeType: 'plein/speech',
  })
  if (gate === 'ready') {
    const write = assets.outputSpool.write.bind(assets.outputSpool)
    assets.outputSpool.write = async (...args) => {
      await write(...args)
      process.stdout.write('at-gate\n')
      return new Promise(() => {})
    }
  } else {
    assets.ingest = async () => {
      process.stdout.write('at-gate\n')
      return new Promise(() => {})
    }
  }
}
try {
  const result = await host.call(
    'audio.speech',
    'plein/mock:audio',
    { text: 'local fixture' },
    {
      ownerId: 'local',
      journal: { store: store.journal('spool-crash-job'), key: 'speech' },
    },
  )
  process.stdout.write(
    JSON.stringify({
      state: 'succeeded',
      assetId: result.assets[0]?.assetId,
      files: result.assets.length,
    }) + '\n',
  )
} catch (error) {
  process.stderr.write(JSON.stringify({ error: (error as Error).message }) + '\n')
  process.exitCode = 1
}
clearInterval(keepAlive)
db.$client.close()
