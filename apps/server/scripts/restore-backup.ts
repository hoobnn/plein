import { resolve, sep } from 'node:path'
import { restoreBackup } from '../src/maintenance/backup'

const [source, target] = process.argv.slice(2)
if (!source || !target) {
  console.error(
    '用法：pnpm --filter @plein/server exec tsx scripts/restore-backup.ts <备份目录> <不存在的新数据目录>',
  )
  process.exitCode = 1
} else {
  const from = resolve(source),
    to = resolve(target)
  if (to === from || to.startsWith(`${from}${sep}`)) throw new Error('恢复目标必须在备份目录之外')
  await restoreBackup(from, to)
  console.log(`恢复完成：${to}`)
  console.log('先关闭 Plein，再以新目录作为 PLEIN_DATA_DIR 启动。')
}
