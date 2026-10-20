/** 仅供 submission-crash.test 使用：平台请求强制转发到127.0.0.1，不允许外网。 */
import { PluginHost } from '../../plugins/host'
import { PluginRegistry } from '../../plugins/registry'
import { ProviderConfigStore } from '../../plugins/config-store'
import { AssetStore } from '../../assets/store'
import { openDb } from '../../storage/db'
import { JobStore } from '../store'
import { doubaoPlugin } from '@plein/providers'

const [dataDir, endpoint, mode] = process.argv.slice(2)
if (!dataDir || !endpoint || new URL(endpoint).hostname !== '127.0.0.1')
  throw new Error('loopback only')
const db = openDb(dataDir)
const assets = new AssetStore(dataDir, db, 1024 * 1024)
await assets.init()
const configs = new ProviderConfigStore(dataDir)
const host = new PluginHost(new PluginRegistry(), configs, assets, {
  fetch: (async (input: Request) =>
    fetch(endpoint, {
      method: input.method,
      headers: input.headers,
      body: await input.text(),
      signal: input.signal,
    })) as typeof fetch,
})
host.load([doubaoPlugin], true)
configs.update('doubao/speech', { enabled: true, secrets: { VOLC_SPEECH_API_KEY: 'local-only' } })
const store = new JobStore(db)
if (mode === 'start') {
  db.$client
    .prepare(
      "INSERT INTO canvases(id,owner_id,title,created_at,updated_at) VALUES('c','local','c',1,1)",
    )
    .run()
  store.insert({
    id: 'crash-job',
    ownerId: 'local',
    canvasId: 'c',
    nodeId: 'n',
    nodeType: 'plein/speech',
  })
}
try {
  await host.call(
    'audio.speech',
    'doubao/speech:seed-tts-2.0',
    { text: 'local only' },
    {
      ownerId: 'local',
      journal: { store: store.journal('crash-job'), key: 'speech' },
    },
  )
  process.stdout.write('unexpected-success\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ message: (error as Error).message }) + '\n')
}
db.$client.close()
