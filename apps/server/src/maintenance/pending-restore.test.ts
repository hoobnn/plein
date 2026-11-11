import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vite-plus/test'
import { bootServer, request } from '../testing'
import { applyPendingRestore, clearPendingRestore, readPendingRestore } from './pending-restore'

describe('应用内恢复', () => {
  it('登记恢复时先备份当前数据，运行中的数据不动，启动前换入并保留旧数据', async () => {
    const f = await bootServer()
    const { dataDir } = f
    const service = f.server.maintenance!
    await writeFile(join(dataDir, 'providers.json'), '{"v":"old"}')
    const backup = await service.backup()
    await writeFile(join(dataDir, 'providers.json'), '{"v":"new"}')
    f.server.db.$client
      .prepare(
        "INSERT INTO canvases(id,owner_id,title,created_at,updated_at) VALUES('c','local','后加',1,1)",
      )
      .run()
    const before = (await service.status()).backups.length

    const scheduled = await service.scheduleRestore(backup.id)
    expect(scheduled.restartRequired).toBe(true)
    // 恢复前自动多出一份当前数据的备份，且就是登记里记的那份
    const status = await service.status()
    expect(status.backups).toHaveLength(before + 1)
    expect(status.backups.some((b) => b.id === scheduled.preRestoreBackupId)).toBe(true)
    expect(status.pendingRestore?.backupId).toBe(backup.id)
    // 运行中的数据没有被改
    expect(await readFile(join(dataDir, 'providers.json'), 'utf8')).toBe('{"v":"new"}')

    // 模拟下次启动：先关掉服务，再在打开数据库之前替换
    await f.close()
    expect(await applyPendingRestore(dataDir, () => {})).toBe(true)
    expect(await readFile(join(dataDir, 'providers.json'), 'utf8')).toBe('{"v":"old"}')
    const db = new Database(join(dataDir, 'plein.db'), { readonly: true })
    try {
      expect(db.prepare("SELECT id FROM canvases WHERE id='c'").all()).toHaveLength(0)
    } finally {
      db.close()
    }
    expect(await readPendingRestore(dataDir)).toBeNull()
    const replaced = await readdir(
      join(dataDir, 'maintenance', 'replaced', String(scheduled.requestedAt)),
    )
    expect(replaced).toContain('plein.db')
    // 重复启动不再替换
    expect(await applyPendingRestore(dataDir, () => {})).toBe(false)
    expect(await readFile(join(dataDir, 'providers.json'), 'utf8')).toBe('{"v":"old"}')
  })

  it('非法或不存在的备份 id 被拒绝，不登记也不多出备份', async () => {
    const f = await bootServer()
    const service = f.server.maintenance!
    await expect(service.scheduleRestore('../../etc')).rejects.toMatchObject({ code: 'invalid' })
    await expect(
      service.scheduleRestore('00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect((await service.status()).backups).toHaveLength(0)
    expect(await readPendingRestore(f.dataDir)).toBeNull()
  })

  it('取消待恢复会清掉登记和暂存副本；暂存副本丢失时启动忽略恢复请求', async () => {
    const f = await bootServer()
    const service = f.server.maintenance!
    const backup = await service.backup()
    await service.scheduleRestore(backup.id)
    const pending = (await readPendingRestore(f.dataDir))!
    expect(existsSync(join(f.dataDir, 'maintenance', pending.stage))).toBe(true)
    await service.cancelRestore()
    expect(await readPendingRestore(f.dataDir)).toBeNull()
    expect(existsSync(join(f.dataDir, 'maintenance', pending.stage))).toBe(false)

    await service.scheduleRestore(backup.id)
    const again = (await readPendingRestore(f.dataDir))!
    await rm(join(f.dataDir, 'maintenance', again.stage), { recursive: true })
    expect(await applyPendingRestore(f.dataDir, () => {})).toBe(false)
    expect(await readPendingRestore(f.dataDir)).toBeNull()
  })

  it('HTTP 入口：登记返回 201，非法 id 返回 400，取消返回 204', async () => {
    const f = await bootServer()
    const backup = (await (
      await request(f.server, '/api/maintenance/backups', { method: 'POST' })
    ).json()) as { id: string }
    const ok = await request(f.server, `/api/maintenance/backups/${backup.id}/restore`, {
      method: 'POST',
    })
    expect(ok.status).toBe(201)
    expect(((await ok.json()) as { restartRequired: boolean }).restartRequired).toBe(true)
    expect(
      (await request(f.server, '/api/maintenance/backups/not-an-id/restore', { method: 'POST' }))
        .status,
    ).toBe(400)
    expect((await request(f.server, '/api/maintenance/restore', { method: 'DELETE' })).status).toBe(
      204,
    )
  })

  it('登记文件损坏时，取消会清掉 restored 下的孤儿暂存目录，其他目录不动', async () => {
    const f = await bootServer()
    const maintenance = join(f.dataDir, 'maintenance')
    const orphan = join(maintenance, 'restored', '11111111-1111-4111-8111-111111111111')
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, 'plein.db'), 'x')
    await writeFile(join(maintenance, 'pending-restore.json'), '{坏掉')
    await mkdir(join(maintenance, 'backups', 'keep'), { recursive: true })
    await f.server.maintenance!.cancelRestore()
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(join(maintenance, 'pending-restore.json'))).toBe(false)
    expect(existsSync(join(maintenance, 'backups', 'keep'))).toBe(true)
  })

  it('清理孤儿时保留调用方刚建好的暂存副本，登记里的暂存路径用 / 拼接', async () => {
    const f = await bootServer()
    const maintenance = join(f.dataDir, 'maintenance')
    const fresh = '22222222-2222-4222-8222-222222222222'
    await mkdir(join(maintenance, 'restored', fresh), { recursive: true })
    await writeFile(join(maintenance, 'pending-restore.json'), 'oops')
    await clearPendingRestore(f.dataDir, `restored/${fresh}`)
    expect(existsSync(join(maintenance, 'restored', fresh))).toBe(true)

    const backup = await f.server.maintenance!.backup()
    await f.server.maintenance!.scheduleRestore(backup.id)
    expect((await readPendingRestore(f.dataDir))!.stage).toMatch(/^restored\/[0-9a-f-]{36}$/)
  })

  it('恢复成功后 replaced 只保留最近 2 份', async () => {
    const f = await bootServer()
    const service = f.server.maintenance!
    const backup = await service.backup()
    const replacedRoot = join(f.dataDir, 'maintenance', 'replaced')
    for (const stamp of ['100', '200', '300'])
      await mkdir(join(replacedRoot, stamp), { recursive: true })
    const scheduled = await service.scheduleRestore(backup.id)
    await f.close()
    expect(await applyPendingRestore(f.dataDir, () => {})).toBe(true)
    const left = (await readdir(replacedRoot)).sort()
    expect(left).toEqual(['300', String(scheduled.requestedAt)].sort())
  })
})
