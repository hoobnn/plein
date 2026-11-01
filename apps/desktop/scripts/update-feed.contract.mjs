import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { prepareUpdate } from './prepare-update.mjs'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const updaterRequire = createRequire(require.resolve('electron-updater'))
const { NodeHttpExecutor } = builderRequire('builder-util/out/nodeHttpExecutor.js')
const { CancellationToken } = updaterRequire('builder-util-runtime')
const { GenericDifferentialDownloader } = updaterRequire(
  './differentialDownloader/GenericDifferentialDownloader.js',
)
const { AppUpdater } = updaterRequire('./AppUpdater.js')
const { load } = builderRequire('js-yaml')
const logger = { info() {}, warn() {}, error() {}, debug() {} }
const sha = (bytes) => createHash('sha512').update(bytes).digest('base64')

void test('最终 ZIP 不变，索引匹配，updater 6 通过 HTTP Range 重建完整新版', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'plein-update-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  // 稳定的大文件与发生变化的小文件组成真实 ZIP，避免压缩随机性干扰断言。
  await writeFile(join(dir, 'runtime.bin'), randomBytes(1024 * 1024))
  const versions = ['1.0.0', '1.1.0', '1.2.0']
  const artifacts = []
  for (const version of versions) {
    await writeFile(join(dir, 'app.txt'), `Plein ${version}\n`)
    const zip = join(dir, `Plein-${version}-macOS-arm64.zip`)
    execFileSync('zip', ['-q', '-0', '-X', zip, 'runtime.bin', 'app.txt'], { cwd: dir })
    const bytes = await readFile(zip)
    const info = await prepareUpdate(zip, version)
    assert.deepEqual(await readFile(zip), bytes, '生成 sidecar 不得修改最终 ZIP')
    const feed = load(await readFile(info.feed, 'utf8'))
    assert.equal(feed.version, version)
    assert.equal(feed.files[0].sha512, sha(bytes))
    assert.equal(feed.files[0].size, bytes.length)
    assert.equal(feed.files[0].url, `Plein-${version}-macOS-arm64.zip`)
    assert.equal(feed.path, feed.files[0].url)
    assert.equal(feed.sha512, feed.files[0].sha512)
    const map = JSON.parse(gunzipSync(await readFile(info.blockmap)))
    assert.equal(map.version, '2')
    artifacts.push({ zip, bytes, info, map })
  }
  const target = artifacts[2]
  let transferred = 0
  let ranges = 0
  const server = createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
    if (!match) {
      res.writeHead(400).end('Range required')
      return
    }
    const start = Number(match[1])
    const end = Number(match[2])
    const chunk = target.bytes.subarray(start, end + 1)
    transferred += chunk.length
    ranges++
    res
      .writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${target.bytes.length}`,
        'Content-Length': chunk.length,
        'Accept-Ranges': 'bytes',
      })
      .end(chunk)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const url = new URL(`http://127.0.0.1:${server.address().port}/update.zip`)
  const executor = new NodeHttpExecutor()
  // 同时验证连续升级与跳过一个版本升级。
  for (const previous of artifacts.slice(0, 2)) {
    const output = join(
      dir,
      `reconstructed-${previous.info.sha512.slice(0, 8).replaceAll('/', '_')}.zip`,
    )
    const before = transferred
    await new GenericDifferentialDownloader(target.info, executor, {
      oldFile: previous.zip,
      newFile: output,
      newUrl: url,
      logger,
      requestHeaders: null,
      isUseMultipleRangeRequest: false,
      cancellationToken: new CancellationToken(),
    }).download(previous.map, target.map)
    assert.deepEqual(await readFile(output), target.bytes)
    assert.ok(transferred > before, '必须发起真实 Range 下载')
    assert.ok(transferred - before < target.bytes.length / 4, '应复用绝大多数旧包字节')
  }
  assert.ok(ranges > 0)

  // 真实 updater 的失败分支必须返回全量回退信号，不能阻断更新。
  const fallback = await AppUpdater.prototype.differentialDownloadInstaller.call(
    {
      _logger: logger,
      app: { version: '1.0.0' },
      downloadedUpdateHelper: { cacheDir: dir },
      listenerCount: () => 0,
      httpExecutor: { downloadToBuffer: async () => Buffer.from('invalid blockmap') },
    },
    { url, info: target.info },
    {
      updateInfoAndProvider: {
        info: { version: '1.2.0' },
        provider: { getBlockMapFiles: async () => [url, url] },
      },
      cancellationToken: new CancellationToken(),
    },
    join(dir, 'fallback.zip'),
    {},
    'update.zip',
  )
  assert.equal(fallback, true)
})
