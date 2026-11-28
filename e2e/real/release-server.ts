import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { startWorkerServer } from '../worker-server'

/** 只认本次监护进程确认的监听地址，保留验收数据供重启、续跑与检查。 */
export function startReleaseServer(
  dir: string,
  port: number,
  logName: string,
  mediaEnv: Record<string, string> = {},
) {
  const logs = join(dir, 'logs')
  mkdirSync(logs, { recursive: true })
  return startWorkerServer({
    port,
    dataDir: dir,
    persistentData: true,
    serverCommand: 'apps/server/node_modules/.bin/tsx apps/server/src/main.ts',
    webDist: join(import.meta.dirname, '../../apps/web/dist-e2e'),
    logFile: join(logs, logName),
    extraEnv: {
      PLEIN_HOST: '127.0.0.1',
      PLEIN_MOCK_PROVIDER: process.env.PLEIN_MOCK_PROVIDER ?? '0',
      ...mediaEnv,
    },
  })
}
