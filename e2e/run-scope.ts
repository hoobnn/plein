import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const repositoryId = createHash('sha256').update(repositoryRoot).digest('hex').slice(0, 12)
// 配置进程先分配，随后由所有 worker 继承；同一检出的并行运行也各自独占。
const runId = (process.env.PLEIN_E2E_RUN_ID ??= randomUUID())
const scope = `${repositoryId}-${runId}`

/** 覆盖的是父目录；本轮只认领并回收下面的独占目录。 */
export function dataPath(name: string) {
  return join(resolve(process.env.PLEIN_E2E_DATA_ROOT ?? tmpdir()), `plein-e2e-${scope}-${name}`)
}

/** 失败截图与 trace 也不能被另一轮的启动清理删除。 */
export function outputPath(name: string) {
  return join(repositoryRoot, 'test-results', `playwright-${name}-${scope}`)
}

// 各模式共用一个可覆盖的端口基准，避免 dev / creation 忽略并行运行的分配。
export const basePort = Number(process.env.PLEIN_E2E_BASE_PORT ?? 8800)
export const portSpan = 64

/** 配置的代理地址必须预先确定；默认选系统空闲端口，再由严格绑定发现抢占。 */
export async function configurationPort(name: string, offset = 0): Promise<number> {
  const configured =
    process.env[name] ?? (process.env.PLEIN_E2E_BASE_PORT ? String(basePort + offset) : undefined)
  if (configured && configured !== '0') return Number(configured)
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
  // worker 重新加载配置时复用本轮代理地址。
  process.env[name] = String(port)
  return port
}
