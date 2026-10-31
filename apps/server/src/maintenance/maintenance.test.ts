import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import {
  mkdtemp,
  mkdir,
  chmod,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createDoc, createElement } from '@plein/doc'
import { MaintenanceSettings } from '@plein/protocol'
import Database from 'better-sqlite3'
import * as Y from 'yjs'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { AssetStore } from '../assets/store'
import { storedOutputSpoolRefs } from '../assets/output-spool'
import { openDb } from '../storage/db'
import { Rooms, sqliteDocStore } from '../sync/rooms'
import { DataActivity } from './activity'
import { restoreBackup, backupManifest } from './backup'
import { atomicJson } from './files'
import { createMaintenanceService, type MaintenanceService } from './service'

const DAY = 86_400_000
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plein-maintenance-'))
  const db = openDb(root)
  const rooms = new Rooms(sqliteDocStore(db))
  const assets = new AssetStore(root, db, 10_000_000)
  await assets.init()
  let now = Date.now()
  const services: MaintenanceService[] = []
  const start = async () => {
    const s = await createMaintenanceService({ db, rooms, assets, dataDir: root, now: () => now })
    services.push(s)
    return s
  }
  cleanup.push(async () => {
    for (const s of services) await s.close()
    rooms.closeAll()
    db.$client.close()
    await rm(root, { recursive: true, force: true })
  })
  const service = await start()
  let seq = 0
  const asset = async (owner = 'local', age = 60) => {
    const item = await assets.ingest(owner, Readable.from([`asset-${seq++}`]), {
      name: '素材',
      mime: 'application/octet-stream',
    })
    db.$client.prepare('UPDATE assets SET created_at=? WHERE id=?').run(now - age * DAY, item.id)
    await utimes(assets.originalPath(item.id), new Date(now - age * DAY), new Date(now - age * DAY))
    return item
  }
  const canvas = (id = `canvas-${seq++}`) => {
    db.$client
      .prepare('INSERT INTO canvases(id,owner_id,title,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(id, 'local', '画布', now, now)
    return createDoc(rooms.get(id).doc, { schedule: () => {} })
  }
  return {
    root,
    db,
    rooms,
    assets,
    service,
    asset,
    canvas,
    start,
    now: () => now,
    advance: (n: number) => {
      now += n
    },
  }
}

describe('本机数据维护', () => {
  it('在线备份包含WAL和未落盘画布，恢复到新目录后数据库和素材均可读取，权限仅本用户', async () => {
    const f = await fixture(),
      asset = await f.asset(),
      doc = f.canvas('canvas')
    createElement(doc, { kind: 'image', assetId: asset.id, x: 0, y: 0, w: 10, h: 10 })
    await writeFile(join(f.root, 'providers.json'), '{"private":"local-secret"}', { mode: 0o600 })
    const audit = JSON.stringify([
      {
        id: 'audit',
        at: 1,
        callKey: 'call',
        kind: 'submit_unknown',
        requestId: 'original-request',
      },
    ])
    const calls = JSON.stringify({ call: { state: 'unknown', at: 1, message: 'retained' } })
    f.db.$client
      .prepare(`INSERT INTO jobs(id,owner_id,canvas_id,node_id,node_type,status,created_at,calls,call_history)
      VALUES('audit-job','local','canvas','n','plein/speech','failed',1,?,?)`)
      .run(calls, audit)
    const backup = await f.service.backup()
    expect(statSync(backup.path).mode & 0o777).toBe(0o700)
    expect(statSync(join(backup.path, 'providers.json')).mode & 0o777).toBe(0o600)
    const restored = await f.service.restoreCopy(backup.id)
    const db = new Database(join(restored.path, 'plein.db'), { readonly: true })
    try {
      expect(db.prepare('SELECT * FROM doc_updates').all()).toHaveLength(1)
      expect(db.prepare('SELECT * FROM assets').all()).toHaveLength(1)
      expect(db.prepare('SELECT calls,call_history FROM jobs WHERE id=?').get('audit-job')).toEqual(
        { calls, call_history: audit },
      )
    } finally {
      db.close()
    }
    expect(await readFile(join(restored.path, 'providers.json'), 'utf8')).toContain('local-secret')
    expect(
      createHash('sha256')
        .update(await readFile(join(restored.path, 'assets', asset.id.slice(0, 2), asset.id)))
        .digest('hex'),
    ).toBe(asset.id)
    await expect(restoreBackup(backup.path, restored.path)).rejects.toThrow('已存在')
    doc.destroy()
  })

  it('损坏备份不生成恢复副本，不完整新备份不挤掉旧备份，失败状态可读', async () => {
    const f = await fixture(),
      asset = await f.asset()
    await f.service.settings(MaintenanceSettings.parse({ keepBackups: 1 }))
    const backup = await f.service.backup()
    await writeFile(join(backup.path, 'plein.db'), 'corrupt')
    const dest = join(f.root, 'should-not-exist')
    await expect(restoreBackup(backup.path, dest)).rejects.toThrow('校验失败')
    expect(existsSync(dest)).toBe(false)
    await rm(f.assets.originalPath(asset.id))
    await expect(f.service.backup()).rejects.toThrow('素材文件缺失')
    const state = await f.service.status()
    expect(state.backups.map((b) => b.id)).toEqual([backup.id])
    expect(state.lastError).toContain('素材文件缺失')
  })

  it('定时备份失败保留最后成功备份并在15分钟后重试', async () => {
    const f = await fixture(),
      asset = await f.asset()
    await f.service.settings(MaintenanceSettings.parse({ intervalHours: 1, keepBackups: 1 }))
    const old = await f.service.backup()
    await rm(f.assets.originalPath(asset.id))
    f.advance(3_600_001)
    await f.service.tick()
    const status = await f.service.status()
    expect(status.lastError).toContain('素材文件缺失')
    expect(status.backups.map((b) => b.id)).toEqual([old.id])
    expect(status.nextBackupAt).toBe(f.now() + 15 * 60_000)
  })

  it('空库连续手动备份时间戳相同也始终保留刚完成的新备份', async () => {
    const f = await fixture()
    await f.service.settings(MaintenanceSettings.parse({ keepBackups: 1 }))
    await f.service.backup()
    const current = await f.service.backup()
    expect((await f.service.status()).backups.map((b) => b.id)).toEqual([current.id])
    expect(existsSync(current.path)).toBe(true)
  })

  it('未重新引用的回收批次到期后才永久清除', async () => {
    const f = await fixture(),
      asset = await f.asset()
    await f.service.settings(MaintenanceSettings.parse({ autoBackup: false, trashDays: 1 }))
    const result = await f.service.cleanup((await f.service.preview()).token)
    f.advance(DAY + 1)
    await f.service.tick()
    expect((await f.service.status()).trash).toHaveLength(0)
    expect(f.assets.get('local', asset.id)).toBeNull()
    expect(existsSync(join(f.root, 'maintenance', 'trash', result.id!))).toBe(false)
  })

  it('字幕unknown任务journal随备份恢复且保护无画布引用的音频', async () => {
    const f = await fixture(),
      asset = await f.asset()
    const path = join(f.root, 'subtitle-recognition', 'recognition.json')
    await mkdir(join(f.root, 'subtitle-recognition'))
    await f.assets.activity.run(async () =>
      atomicJson(path, {
        assetId: asset.id,
        record: {
          state: 'unknown',
          remoteId: 'remote-task',
          trace: { attemptId: 'asr-attempt', requestId: 'asr-request' },
        },
        audit: [
          {
            id: 'asr-event',
            at: 1,
            callKey: 'k',
            kind: 'submit_started',
            requestId: 'asr-request',
          },
        ],
        history: [
          {
            record: {
              state: 'unknown',
              at: 1,
              message: 'retained',
              trace: { attemptId: 'old-asr', requestId: 'old-asr-request' },
            },
            at: 2,
            action: 'confirmed_not_accepted',
          },
        ],
      }),
    )
    expect((await f.service.preview()).assets).toBe(0)
    const backup = await f.service.backup(),
      copy = await f.service.restoreCopy(backup.id)
    expect(
      await readFile(join(copy.path, 'subtitle-recognition', 'recognition.json'), 'utf8'),
    ).toContain('remote-task')
    const restored = JSON.parse(
      await readFile(join(copy.path, 'subtitle-recognition', 'recognition.json'), 'utf8'),
    )
    expect(restored.audit[0].requestId).toBe('asr-request')
    expect(restored.history[0].record.trace.requestId).toBe('old-asr-request')
  })

  it('平台输出ready随备份恢复、writing缺失事实保留；ready缺失或损坏拒绝不完整备份', async () => {
    const f = await fixture()
    f.canvas('spool-canvas')
    const binding = { ownerId: 'local', jobId: 'spool-run', callKey: 'generate', outputIndex: 0 }
    const bytes = new Uint8Array([1, 2, 3, 4])
    const ref = await f.assets.outputSpool.write(
      f.assets.outputSpool.describe(bytes, binding),
      bytes,
      binding,
    )
    const missing = f.assets.outputSpool.describe(bytes, { ...binding, outputIndex: 1 })
    const calls = {
      generate: {
        state: 'fetched',
        outputs: [
          { type: 'file', spool: ref },
          { type: 'file', spool: missing },
        ],
      },
    }
    f.db.$client
      .prepare(
        'INSERT INTO jobs(id,owner_id,canvas_id,node_id,node_type,status,calls,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        'spool-run',
        'local',
        'spool-canvas',
        'node',
        'plein/speech',
        'failed',
        JSON.stringify(calls),
        f.now(),
      )
    const backup = await f.service.backup(),
      copy = await f.service.restoreCopy(backup.id)
    expect(await readFile(join(copy.path, 'job-outputs', ref.id))).toEqual(Buffer.from(bytes))
    const copiedDb = openDb(copy.path)
    const restoredAssets = new AssetStore(copy.path, copiedDb, 10_000_000)
    try {
      await restoredAssets.init()
      const stream = await restoredAssets.outputSpool.read(ref, binding)
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes))
    } finally {
      copiedDb.$client.close()
    }
    await writeFile(join(f.root, 'job-outputs', ref.id), new Uint8Array([9, 9, 9, 9]))
    await expect(f.service.backup()).rejects.toThrow('暂存校验失败')
    await rm(join(f.root, 'job-outputs', ref.id))
    await expect(f.service.backup()).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('字幕历史record不pin旧spool：只备份当前record且恢复不误报历史缺失', async () => {
    const f = await fixture()
    const binding = {
      ownerId: 'local',
      jobId: 'recognition',
      callKey: 'transcribe',
      outputIndex: 0,
    }
    const bytes = new Uint8Array([1, 2, 3, 4])
    const current = await f.assets.outputSpool.write(
      f.assets.outputSpool.describe(bytes, binding),
      bytes,
      binding,
    )
    const old = await f.assets.outputSpool.write(
      f.assets.outputSpool.describe(bytes, binding),
      bytes,
      binding,
    )
    await atomicJson(join(f.root, 'subtitle-recognition', 'spool-recognition.json'), {
      record: { state: 'fetched', outputs: [{ type: 'file', spool: current }] },
      history: [
        {
          record: { state: 'fetched', outputs: [{ type: 'file', spool: old }] },
          action: 'resubmit',
        },
      ],
    })
    const refs = await storedOutputSpoolRefs(f.db.$client, f.root)
    expect(refs.map((ref) => ref.id)).toEqual([current.id])
    for (const ref of [current, old])
      await utimes(join(f.root, 'job-outputs', ref.id), new Date(0), new Date(0))
    await f.assets.outputSpool.prune(refs)
    expect(existsSync(join(f.root, 'job-outputs', current.id))).toBe(true)
    expect(existsSync(join(f.root, 'job-outputs', old.id))).toBe(false)
    const backup = await f.service.backup(),
      copy = await f.service.restoreCopy(backup.id)
    expect(await readFile(join(copy.path, 'job-outputs', current.id))).toEqual(Buffer.from(bytes))
    expect(existsSync(join(copy.path, 'job-outputs', old.id))).toBe(false)
  })

  it('定时配置跨重启保留到期时间，按间隔执行并只在成功后保留指定份数', async () => {
    const f = await fixture()
    await f.asset()
    await f.service.settings(MaintenanceSettings.parse({ intervalHours: 1, keepBackups: 1 }))
    const due = (await f.service.status()).nextBackupAt
    await f.service.close()
    f.advance(3_600_001)
    const second = await f.start()
    expect((await second.status()).nextBackupAt).toBe(due)
    await second.tick()
    expect((await second.status()).backups).toHaveLength(1)
    f.advance(3_600_001)
    await second.tick()
    const state = await second.status()
    expect(state.backups).toHaveLength(1)
    expect(state.lastBackupAt).toBe(f.now())
  })

  it('保护跨owner共享、画布历史、任务journal、资产库、模板和已删画布的检查点', async () => {
    const f = await fixture(),
      ids: string[] = []
    for (let i = 0; i < 7; i++) ids.push((await f.asset()).id)
    const doc = f.canvas('canvas')
    createElement(doc, { kind: 'image', assetId: ids[0], x: 0, y: 0, w: 10, h: 10 })
    createElement(doc, {
      kind: 'image',
      params: { history: { previous: ids[1] } },
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    f.db.$client
      .prepare(
        'INSERT INTO jobs(id,owner_id,canvas_id,node_id,node_type,status,calls,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        'job',
        'local',
        'canvas',
        'node',
        'core/video',
        'failed',
        JSON.stringify({ result: { assetId: ids[2] } }),
        f.now(),
      )
    f.db.$client
      .prepare(
        'INSERT INTO library_items(id,owner_id,kind,name,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        'lib',
        'other-owner',
        'style',
        '样式',
        JSON.stringify({ images: [{ assetId: ids[3] }] }),
        f.now(),
        f.now(),
      )
    f.db.$client
      .prepare('INSERT INTO templates(id,owner_id,title,data,created_at) VALUES(?,?,?,?,?)')
      .run('template', 'local', '模板', JSON.stringify({ assetId: ids[4] }), f.now())
    f.db.$client
      .prepare('INSERT INTO projects(id,owner_id,title,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run('project', 'local', '项目', f.now(), f.now())
    const checkpoint = f.canvas('checkpoint-source')
    createElement(checkpoint, { kind: 'image', assetId: ids[5], x: 0, y: 0, w: 10, h: 10 })
    const state = Y.encodeStateAsUpdate(f.rooms.get('checkpoint-source').doc)
    f.db.$client
      .prepare(
        'INSERT INTO canvas_checkpoints(id,owner_id,project_id,source_canvas_title,name,state,history,created_at,content_hash) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'checkpoint',
        'local',
        'project',
        'deleted',
        '命名检查点',
        Buffer.from(state),
        '[]',
        f.now(),
        'hash',
      )
    checkpoint.destroy()
    f.rooms.drop('checkpoint-source')
    f.db.$client.prepare('DELETE FROM canvases WHERE id=?').run('checkpoint-source')
    const preview = await f.service.preview()
    expect(preview.assets).toBe(1)
    expect(preview.protectedAssets).toBe(6)
    const space = await f.service.space()
    expect(space.unusedAssets).toBe(1)
    expect(space.total).toBe(
      space.database +
        space.originals +
        space.derivatives +
        space.temporary +
        space.backups +
        space.trash +
        space.restored +
        space.other,
    )
    doc.destroy()
  })

  it.each(['space', 'preview'] as const)(
    '%s在缓冲落盘和新引用穿插时重新取得完整快照',
    async (method) => {
      const f = await fixture(),
        existing = await f.asset(),
        added = await f.asset(),
        doc = f.canvas('canvas')
      createElement(doc, { kind: 'image', assetId: existing.id, x: 0, y: 0, w: 10, h: 10 })
      const pending = f.service[method]()
      // scan已读取该画布并让出事件循环：模拟正常的50ms缓冲落盘和并发编辑。
      createElement(doc, { kind: 'image', assetId: added.id, x: 0, y: 0, w: 10, h: 10 })
      f.rooms.get('canvas').flush()
      const result = await pending
      if ('unusedAssets' in result) {
        expect(result.unusedAssets).toBe(0)
        expect(result.referencedAssets).toBe(2)
      } else {
        expect(result.assets).toBe(0)
        expect(result.protectedAssets).toBe(2)
      }
      expect(existsSync(f.assets.originalPath(existing.id))).toBe(true)
      expect(existsSync(f.assets.originalPath(added.id))).toBe(true)
      doc.destroy()
    },
  )

  it('持续写入时空间扫描有界退出，不发放不一致的清理预检', async () => {
    const f = await fixture(),
      asset = await f.asset(),
      doc = f.canvas('canvas')
    const pending = f.service.preview()
    let writes = 0
    let timer: NodeJS.Immediate
    const write = () => {
      f.db.$client.prepare('UPDATE canvases SET updated_at=updated_at+1 WHERE id=?').run('canvas')
      writes++
      timer = setImmediate(write)
    }
    timer = setImmediate(write)
    try {
      await expect(pending).rejects.toMatchObject({ code: 'changed' })
      expect(writes).toBeGreaterThan(0)
      // 写入次数只反映扫描期间过了多少轮事件循环，满载跑覆盖率时会多一些；无界重试会一直写到超时
      expect(writes).toBeLessThan(1000)
      expect(existsSync(f.assets.originalPath(asset.id))).toBe(true)
    } finally {
      clearImmediate(timer)
      doc.destroy()
    }
  })

  it('预检后增加未落盘引用、即使删除集变化也拒绝执行，token不能复用', async () => {
    const f = await fixture(),
      asset = await f.asset(),
      doc = f.canvas()
    const preview = await f.service.preview()
    createElement(doc, { kind: 'image', assetId: asset.id, x: 0, y: 0, w: 10, h: 10 })
    await expect(f.service.cleanup(preview.token)).rejects.toMatchObject({ code: 'changed' })
    expect(existsSync(f.assets.originalPath(asset.id))).toBe(true)
    await expect(f.service.cleanup(preview.token)).rejects.toMatchObject({ code: 'expired' })
    doc.destroy()
  })

  it('最近上传和最近改过的文件不清理，回收后可恢复全部owner元数据与衍生物', async () => {
    const f = await fixture(),
      old = await f.asset(),
      recent = await f.asset('local', 1)
    const oldMeta = f.assets.get('local', old.id)!
    f.assets.insert(f.db, 'other', oldMeta)
    f.db.$client
      .prepare('UPDATE assets SET created_at=? WHERE id=?')
      .run(f.now() - 60 * DAY, old.id)
    const variant = f.assets.variantPath(old.id, 'poster')
    await writeFile(variant, 'poster')
    await utimes(variant, new Date(f.now() - 60 * DAY), new Date(f.now() - 60 * DAY))
    const preview = await f.service.preview()
    expect(preview.assets).toBe(1)
    const result = await f.service.cleanup(preview.token)
    expect(result.assets).toBe(1)
    expect(existsSync(f.assets.originalPath(old.id))).toBe(false)
    expect(f.assets.get('local', old.id)).toBeNull()
    expect(existsSync(f.assets.originalPath(recent.id))).toBe(true)
    await f.service.restoreTrash(result.id!)
    expect(await readFile(variant, 'utf8')).toBe('poster')
    expect(f.assets.get('local', old.id)).toBeTruthy()
    expect(f.assets.get('other', old.id)).toBeTruthy()
    expect((await f.service.status()).trash).toHaveLength(0)
  })

  it('文件在预检后变化时回滚，不移除已有素材', async () => {
    const f = await fixture(),
      asset = await f.asset()
    const preview = await f.service.preview()
    await writeFile(f.assets.originalPath(asset.id), 'changed')
    await expect(f.service.cleanup(preview.token)).rejects.toMatchObject({ code: 'changed' })
    expect(f.assets.get('local', asset.id)).toBeTruthy()
    expect(existsSync(f.assets.originalPath(asset.id))).toBe(true)
  })

  it('备份和清理不与正在写入的素材或导入竞争，exclusive期间新写入等待', async () => {
    const f = await fixture()
    await f.asset()
    let unblock!: () => void
    const activity = f.assets.activity.run(
      () =>
        new Promise<void>((resolve) => {
          unblock = resolve
        }),
    )
    await expect(f.service.backup()).rejects.toMatchObject({ code: 'maintenance_busy' })
    await expect(f.service.preview()).rejects.toMatchObject({ code: 'maintenance_busy' })
    unblock()
    await activity
    const gate = new DataActivity()
    let release!: () => void
    const exclusive = gate.exclusive(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    let entered = false
    const write = gate.run(async () => {
      entered = true
      await gate.run(async () => {})
    })
    expect(entered).toBe(false)
    release()
    await exclusive
    await write
    expect(entered).toBe(true)
  })

  it('到期回收前重新检查新引用：引用中的素材恢复，其他素材永久清除', async () => {
    const f = await fixture(),
      keep = await f.asset(),
      remove = await f.asset()
    await f.service.settings(MaintenanceSettings.parse({ autoBackup: false, trashDays: 1 }))
    const result = await f.service.cleanup((await f.service.preview()).token)
    const doc = f.canvas()
    createElement(doc, { kind: 'image', assetId: keep.id, x: 0, y: 0, w: 10, h: 10 })
    // 本例检查稳定引用的恢复；先落盘，避免 50ms 缓冲写入使扫描按设计中止。
    for (const id of f.rooms.loaded()) f.rooms.get(id).flush()
    f.advance(DAY + 1)
    await f.service.tick()
    // 批次里任一素材被新引用，整批恢复，宁可多留不误删。
    expect(f.assets.get('local', keep.id)).toBeTruthy()
    expect(f.assets.get('local', remove.id)).toBeTruthy()
    expect(existsSync(join(f.root, 'maintenance', 'trash', result.id!))).toBe(false)
    doc.destroy()
  })

  it('到期扫描遇到并发写入时保留回收站，下次稳定维护恢复新引用', async () => {
    const f = await fixture(),
      keep = await f.asset()
    await f.service.settings(MaintenanceSettings.parse({ autoBackup: false, trashDays: 1 }))
    const result = await f.service.cleanup((await f.service.preview()).token)
    const doc = f.canvas('canvas')
    createElement(doc, { kind: 'image', assetId: keep.id, x: 0, y: 0, w: 10, h: 10 })
    f.rooms.get('canvas').flush()
    f.advance(DAY + 1)
    let timer: NodeJS.Immediate
    const write = () => {
      f.db.$client.prepare('UPDATE canvases SET updated_at=updated_at+1 WHERE id=?').run('canvas')
      timer = setImmediate(write)
    }
    timer = setImmediate(write)
    try {
      await f.service.tick()
      expect((await f.service.status()).lastError).toContain('数据已变化')
      expect(existsSync(join(f.root, 'maintenance', 'trash', result.id!))).toBe(true)
    } finally {
      clearImmediate(timer)
    }
    await f.service.tick()
    expect(f.assets.get('local', keep.id)).toBeTruthy()
    expect(existsSync(f.assets.originalPath(keep.id))).toBe(true)
    doc.destroy()
  })

  it('过期token仍拒绝执行；符号链接不再停止维护，跳过后上报且不跟随目录外文件', async () => {
    const f = await fixture(),
      asset = await f.asset('local', 1)
    const preview = await f.service.preview()
    f.advance(11 * 60_000)
    await expect(f.service.cleanup(preview.token)).rejects.toMatchObject({ code: 'expired' })
    // 悬空链接：一旦被跟随就会因 ENOENT 而失败。
    await symlink(join(f.root, 'gone'), join(f.root, 'assets', 'external'))
    const status = await f.service.status()
    expect(status.skippedSymlinks).toEqual(['assets/external'])
    // 统计和预检照常完成：只算真实文件，链接与目标都不参与。
    const space = await f.service.space()
    expect(space.originals).toBe(statSync(f.assets.originalPath(asset.id)).size)
    expect((await f.service.preview()).assets).toBe(0)
  })

  it('备份跳过符号链接：不打包链接与目标，路径记入清单；恢复包内出现链接仍拒绝', async () => {
    const f = await fixture()
    await f.asset()
    await symlink('/private/tmp', join(f.root, 'assets', 'external'))
    await symlink('/private/tmp', join(f.root, 'secret.json'))
    const backup = await f.service.backup()
    expect(backup.skippedSymlinks).toEqual(['assets/external', 'secret.json'])
    const manifest = await backupManifest(backup.path)
    expect(manifest.skippedSymlinks).toEqual(['assets/external', 'secret.json'])
    expect(manifest.files.some((file) => file.path.includes('external'))).toBe(false)
    expect(existsSync(join(backup.path, 'secret.json'))).toBe(false)
    // 备份包里出现符号链接时恢复仍然拒绝，安全检查保持不变。
    await rm(join(backup.path, 'plein.db'))
    await symlink('/private/tmp', join(backup.path, 'plein.db'))
    const dest = join(f.root, 'restore-should-fail')
    await expect(restoreBackup(backup.path, dest)).rejects.toThrow('符号链接')
    expect(existsSync(dest)).toBe(false)
  })

  it('assets 整个目录是链接时不跟随：预检和清理都不碰链接目标里的文件', async () => {
    const f = await fixture(),
      asset = await f.asset()
    await f.service.settings(MaintenanceSettings.parse({ autoBackup: false }))
    // 常见外置盘做法：真实 assets 挪到 dataDir 外，原位置换成链接。
    const external = await mkdtemp(join(tmpdir(), 'plein-external-'))
    cleanup.push(async () => rm(external, { recursive: true, force: true }))
    const assetsDir = join(f.root, 'assets')
    await rename(assetsDir, join(external, 'assets'))
    await symlink(join(external, 'assets'), assetsDir)
    const target = join(external, 'assets', asset.id.slice(0, 2), asset.id)
    const preview = await f.service.preview()
    expect(preview.assets).toBe(0)
    expect((await f.service.cleanup(preview.token)).assets).toBe(0)
    // 目标文件留在原地，链接本身也保留
    expect(existsSync(target)).toBe(true)
    expect(existsSync(assetsDir)).toBe(true)
    expect((await f.service.status()).skippedSymlinks).toContain('assets')
  })

  it('数据库素材原文件是链接时备份跳过并登记缺失，恢复放行；未登记的缺失仍拒绝', async () => {
    const f = await fixture(),
      linked = await f.asset(),
      kept = await f.asset()
    const original = f.assets.originalPath(linked.id)
    await rm(original)
    await symlink('/private/tmp', original)
    const backup = await f.service.backup()
    expect(backup.missingAssets).toEqual([linked.id])
    expect(backup.skippedSymlinks).toContain(`assets/${linked.id.slice(0, 2)}/${linked.id}`)
    // 已登记的缺失允许恢复，并在结果里提示
    const copy = await f.service.restoreCopy(backup.id)
    expect(copy.missingAssets).toEqual([linked.id])
    // 未登记的缺失仍然拒绝：清单里抹掉一个正常素材（旧版备份的不一致事实）
    const manifest = JSON.parse(await readFile(join(backup.path, 'manifest.json'), 'utf8')) as {
      files: Array<{ path: string }>
    }
    manifest.files = manifest.files.filter(
      (file) => file.path !== `assets/${kept.id.slice(0, 2)}/${kept.id}`,
    )
    await atomicJson(join(backup.path, 'manifest.json'), manifest)
    const dest = join(f.root, 'restore-should-fail')
    await expect(restoreBackup(backup.path, dest)).rejects.toThrow('备份缺少数据库引用的素材')
    expect(existsSync(dest)).toBe(false)
  })

  it('平台输出暂存文件是链接时跳过并记录，备份与恢复照常完成', async () => {
    const f = await fixture()
    f.canvas('spool-canvas')
    const binding = { ownerId: 'local', jobId: 'spool-link', callKey: 'generate', outputIndex: 0 }
    const bytes = new Uint8Array([1, 2, 3])
    const ref = await f.assets.outputSpool.write(
      f.assets.outputSpool.describe(bytes, binding),
      bytes,
      binding,
    )
    f.db.$client
      .prepare(
        'INSERT INTO jobs(id,owner_id,canvas_id,node_id,node_type,status,calls,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        'spool-link',
        'local',
        'spool-canvas',
        'node',
        'plein/speech',
        'failed',
        JSON.stringify({ generate: { state: 'fetched', outputs: [{ type: 'file', spool: ref }] } }),
        f.now(),
      )
    await rm(join(f.root, 'job-outputs', ref.id))
    await symlink('/private/tmp', join(f.root, 'job-outputs', ref.id))
    const backup = await f.service.backup()
    expect(backup.skippedSymlinks).toContain(`job-outputs/${ref.id}`)
    const copy = await f.service.restoreCopy(backup.id)
    expect(copy.missingAssets).toEqual([])
  })

  // chmod 000 对 root 无效，跳过；参考 plugins/process.test.ts 的权限环境判断。
  const CAN_DENY =
    process.allowedNodeEnvironmentFlags.has('--permission') ||
    process.allowedNodeEnvironmentFlags.has('--experimental-permission') ||
    (typeof process.getuid === 'function' && process.getuid() !== 0)

  it.skipIf(!CAN_DENY)('不可读目录跳过并记入诊断，状态与空间统计不受影响', async () => {
    const f = await fixture(),
      asset = await f.asset()
    const locked = join(f.root, 'locked')
    await mkdir(locked)
    await writeFile(join(locked, 'x'), 'x')
    await chmod(locked, 0o000)
    try {
      const status = await f.service.status()
      expect(status.unreadableDirs).toEqual(['locked'])
      expect(status.skippedSymlinks).toEqual([])
      expect((await f.service.space()).originals).toBe(
        statSync(f.assets.originalPath(asset.id)).size,
      )
    } finally {
      await chmod(locked, 0o700)
    }
  })

  it('符号链接上报缓存 60 秒，维护操作后立即刷新', async () => {
    const f = await fixture()
    await f.asset()
    expect((await f.service.status()).skippedSymlinks).toEqual([])
    await symlink('/private/tmp', join(f.root, 'assets', 'late'))
    // 缓存期内状态不变
    expect((await f.service.status()).skippedSymlinks).toEqual([])
    // 备份等维护操作让缓存失效，立刻看到新链接；结果排序稳定
    await f.service.backup()
    expect((await f.service.status()).skippedSymlinks).toEqual(['assets/late'])
    await symlink('/private/tmp', join(f.root, 'assets', 'earlier'))
    await symlink('/private/tmp', join(f.root, 'assets', 'also'))
    expect((await f.service.status()).skippedSymlinks).toEqual(['assets/late'])
    f.advance(60_001)
    expect((await f.service.status()).skippedSymlinks).toEqual([
      'assets/also',
      'assets/earlier',
      'assets/late',
    ])
  })

  it('预检后 assets 被换成链接时清理拒绝，不搬走目录外的文件', async () => {
    const f = await fixture(),
      asset = await f.asset()
    const preview = await f.service.preview()
    // 预检之后、清理之前，assets 整目录被换成指向外部的链接。
    const external = await mkdtemp(join(tmpdir(), 'plein-external-'))
    cleanup.push(async () => rm(external, { recursive: true, force: true }))
    const assetsDir = join(f.root, 'assets')
    await rename(assetsDir, join(external, 'assets'))
    await symlink(join(external, 'assets'), assetsDir)
    // 末级 lstat 会穿过链接看到普通文件，必须在移动前逐层拒绝。
    await expect(f.service.cleanup(preview.token)).rejects.toThrow('符号链接')
    expect(existsSync(join(external, 'assets', asset.id.slice(0, 2), asset.id))).toBe(true)
  })

  it('清理后 assets 被换成链接时恢复回收站拒绝，文件不落目录外也不丢失', async () => {
    const f = await fixture(),
      asset = await f.asset()
    await f.service.settings(MaintenanceSettings.parse({ autoBackup: false, trashDays: 1 }))
    const result = await f.service.cleanup((await f.service.preview()).token)
    const external = await mkdtemp(join(tmpdir(), 'plein-external-'))
    cleanup.push(async () => rm(external, { recursive: true, force: true }))
    const assetsDir = join(f.root, 'assets')
    await rename(assetsDir, join(external, 'assets'))
    await symlink(join(external, 'assets'), assetsDir)
    // 恢复必须在 mkdir 之前拒绝，否则目录里已经落了文件。
    await expect(f.service.restoreTrash(result.id!)).rejects.toThrow('符号链接')
    expect(existsSync(join(external, 'assets', asset.id.slice(0, 2), asset.id))).toBe(false)
    // 回收站里的文件仍在：清单停在 pending，链接修复后重启即可恢复。
    expect(
      existsSync(
        join(f.root, 'maintenance', 'trash', result.id!, 'assets', asset.id.slice(0, 2), asset.id),
      ),
    ).toBe(true)
  })

  it('到期清除前发现回收站路径穿过链接时拒绝删除', async () => {
    const f = await fixture(),
      asset = await f.asset()
    await f.service.settings(MaintenanceSettings.parse({ autoBackup: false, trashDays: 1 }))
    const result = await f.service.cleanup((await f.service.preview()).token)
    const external = await mkdtemp(join(tmpdir(), 'plein-external-'))
    cleanup.push(async () => rm(external, { recursive: true, force: true }))
    // maintenance 整目录换成链接：清单仍然可见，但删除路径穿过了链接。
    const maintenanceDir = join(f.root, 'maintenance')
    await rename(maintenanceDir, join(external, 'maintenance'))
    await symlink(join(external, 'maintenance'), maintenanceDir)
    f.advance(DAY + 1)
    await f.service.tick()
    expect((await f.service.status()).lastError).toContain('符号链接')
    // 链接目标里的文件没有被删，链接本身也在。
    expect(
      existsSync(
        join(
          external,
          'maintenance',
          'trash',
          result.id!,
          'assets',
          asset.id.slice(0, 2),
          asset.id,
        ),
      ),
    ).toBe(true)
    expect(existsSync(maintenanceDir)).toBe(true)
  })

  it('字幕目录不可读时清理中止并提示，备份失败且不生成', async () => {
    const f = await fixture(),
      asset = await f.asset()
    // 素材仅由字幕 journal 里的 unknown 任务引用；目录不可读时若静默跳过，
    // 引用扫描会误判未使用并把素材清掉（codex 复现场景）。
    const dir = join(f.root, 'subtitle-recognition')
    await mkdir(dir)
    await atomicJson(join(dir, 'recognition.json'), {
      assetId: asset.id,
      record: { state: 'unknown', remoteId: 'remote', trace: {}, audit: [], history: [] },
    })
    await chmod(dir, 0o000)
    try {
      await expect(f.service.preview()).rejects.toThrow('不可读的子目录')
      await expect(f.service.preview()).rejects.toThrow('subtitle-recognition')
      const backupsBefore = (await f.service.status()).backups.length
      await expect(f.service.backup()).rejects.toThrow('不可读的子目录')
      expect((await f.service.status()).backups.length).toBe(backupsBefore)
    } finally {
      await chmod(dir, 0o700)
    }
    // 权限恢复后照常：journal 引用被保护，备份成功（lastError 保留上次失败记录）
    expect((await f.service.preview()).assets).toBe(0)
    await f.service.backup()
  })

  it('assets 分片目录是链接时备份登记缺失，不访问链接目标', async () => {
    const f = await fixture(),
      asset = await f.asset()
    // 分片目录整个换成悬空链接：跟随访问必然 ENOENT，只能靠已收集的链接路径判断。
    const shard = join(f.root, 'assets', asset.id.slice(0, 2))
    await rm(shard, { recursive: true })
    await symlink(join(f.root, 'gone-shard'), shard)
    const backup = await f.service.backup()
    expect(backup.skippedSymlinks).toEqual([`assets/${asset.id.slice(0, 2)}`])
    expect(backup.missingAssets).toEqual([asset.id])
    const copy = await f.service.restoreCopy(backup.id)
    expect(copy.missingAssets).toEqual([asset.id])
  })

  it('未完成的回收清单在重启时自动恢复，保留文件和登记信息', async () => {
    const f = await fixture(),
      asset = await f.asset()
    const result = await f.service.cleanup((await f.service.preview()).token)
    const manifest = join(f.root, 'maintenance', 'trash', result.id!, 'manifest.json')
    const trash = JSON.parse(await readFile(manifest, 'utf8')) as { state: string }
    trash.state = 'pending'
    await atomicJson(manifest, trash)
    await f.service.close()
    const second = await f.start()
    expect(f.assets.get('local', asset.id)).toBeTruthy()
    expect(existsSync(f.assets.originalPath(asset.id))).toBe(true)
    expect((await second.status()).trash).toHaveLength(0)
  })
})
