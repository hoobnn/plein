import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 把 drizzle-kit 生成的迁移（drizzle/）内嵌成 src/storage/migrations.gen.ts：
 * 服务端打包后（Docker、桌面端）不依赖运行目录下还有 drizzle/ 文件夹。
 * 由 `pnpm db:generate` 在 drizzle-kit generate 之后调用。
 */
const root = join(import.meta.dirname, '..')
const journal = JSON.parse(readFileSync(join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
  entries: Array<{ tag: string; when: number }>
}
const migrations = journal.entries.map((e) => {
  const sql = readFileSync(join(root, 'drizzle', `${e.tag}.sql`), 'utf8')
  return {
    tag: e.tag,
    when: e.when,
    // 与 drizzle-orm 自带迁移器相同：整份 SQL 的 sha256
    hash: createHash('sha256').update(sql).digest('hex'),
    statements: sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean),
  }
})
const out = `// 由 scripts/embed-migrations.ts 生成，不要手改；改 schema 后跑 pnpm --filter @plein/server db:generate
import type { Migration } from './migrate'

export const MIGRATIONS: Migration[] = ${JSON.stringify(migrations, null, 2)}
`
writeFileSync(join(root, 'src/storage/migrations.gen.ts'), out)
console.log(`内嵌 ${migrations.length} 个迁移 → src/storage/migrations.gen.ts`)
