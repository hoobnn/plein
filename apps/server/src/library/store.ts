import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { compositionAssetIds } from '@plein/doc'
import { CompositionSourceRef } from '@plein/plugin-sdk'
import { normalizeLibraryImages } from '@plein/nodes'
import {
  CreateLibraryItem,
  type LibraryItem,
  type LibraryKind,
  UpdateLibraryItem,
} from '@plein/protocol'
import { and, desc, eq } from 'drizzle-orm'
import type { z } from 'zod'
import type { AssetStore } from '../assets/store'
import type { DB } from '../storage/db'
import { canvases, libraryItems } from '../storage/schema'

type LibraryRow = typeof libraryItems.$inferSelect

/** data 列里存的字段 */
type LibraryData = Pick<
  LibraryItem,
  | 'description'
  | 'tags'
  | 'voice'
  | 'images'
  | 'video'
  | 'videoCompositionSource'
  | 'models'
  | 'profile'
  | 'sceneViews'
  | 'coverAssetId'
>

const toItem = (r: LibraryRow): LibraryItem => {
  const d = JSON.parse(r.data) as Partial<LibraryData>
  return {
    id: r.id,
    kind: r.kind as LibraryItem['kind'],
    name: r.name,
    projectId: r.project_id,
    description: d.description ?? '',
    tags: d.tags ?? {},
    voice: d.voice ?? null,
    images: normalizeLibraryImages(r.kind, d.images ?? []),
    video: d.video ?? null,
    ...(d.videoCompositionSource != null
      ? { videoCompositionSource: d.videoCompositionSource }
      : {}),
    models: d.models ?? [],
    profile: d.profile ?? null,
    sceneViews: d.sceneViews ?? [],
    coverAssetId: d.coverAssetId ?? null,
    favorite: r.favorite === 1,
    usedAt: r.used_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

const dataOf = (kind: LibraryKind, i: LibraryData): string =>
  JSON.stringify({
    description: i.description,
    tags: i.tags,
    voice: i.voice,
    images: normalizeLibraryImages(kind, i.images),
    video: i.video,
    videoCompositionSource: i.videoCompositionSource,
    models: i.models,
    profile: i.profile,
    sceneViews: i.sceneViews ?? [],
    coverAssetId:
      kind === 'character' && i.images.some((image) => image.assetId === i.coverAssetId)
        ? i.coverAssetId
        : null,
  })

export class LibrarySourceError extends Error {
  constructor() {
    super('参考视频的动态合成来源无效、缺失或不属于当前用户')
  }
}

/** 资产库条目的增删改查，按所有者隔离；HTTP 路由和智能体能力共用 */
export class LibraryStore {
  private listeners = new Set<(id: string) => void>()
  constructor(
    private db: DB,
    private assets?: AssetStore,
  ) {}

  /** 新来源是硬引用；同步完成校验与持久化，避免存档和绑定之间插入编辑。 */
  assertVideoSource(owner: string, video: unknown, value: unknown) {
    if (value === undefined || value === null) return
    try {
      const source = CompositionSourceRef.parse(value)
      if (typeof video !== 'string' || this.assets?.get(owner, video)?.kind !== 'video')
        throw new Error('missing video')
      for (const id of [video, ...compositionAssetIds(source)])
        if (!this.assets.get(owner, id) || !existsSync(this.assets.originalPath(id)))
          throw new Error('missing source')
    } catch {
      throw new LibrarySourceError()
    }
  }

  onChange(fn: (id: string) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private changed(id: string) {
    for (const fn of this.listeners) fn(id)
  }

  private mine(owner: string, id: string) {
    return and(eq(libraryItems.id, id), eq(libraryItems.owner_id, owner))
  }

  /** 画布所在的项目：新条目归到这个项目，同名条目优先用它的 */
  projectOf(owner: string, canvasId: string): string | null {
    const row = this.db
      .select({ project: canvases.project_id })
      .from(canvases)
      .where(and(eq(canvases.id, canvasId), eq(canvases.owner_id, owner)))
      .get()
    return row?.project ?? null
  }

  list(owner: string, kind?: LibraryKind): LibraryItem[] {
    return this.db
      .select()
      .from(libraryItems)
      .where(and(eq(libraryItems.owner_id, owner), kind ? eq(libraryItems.kind, kind) : undefined))
      .orderBy(desc(libraryItems.updated_at))
      .all()
      .map(toItem)
  }

  get(owner: string, id: string): LibraryItem | null {
    const row = this.db.select().from(libraryItems).where(this.mine(owner, id)).get()
    return row ? toItem(row) : null
  }

  create(
    owner: string,
    body: Omit<z.output<typeof CreateLibraryItem>, 'sceneViews'> & Pick<LibraryItem, 'sceneViews'>,
  ): LibraryItem {
    const { kind, name, projectId, sceneViews, ...rest } = body
    // 场景视角由全景采集路径单独校验；其余字段按 schema 归一
    const parsed = CreateLibraryItem.parse({ kind, name, projectId, ...rest })
    const data = {
      ...parsed,
      sceneViews: sceneViews ?? [],
      videoCompositionSource: parsed.videoCompositionSource ?? undefined,
    }
    this.assertVideoSource(owner, data.video, data.videoCompositionSource)
    const id = `lib_${randomBytes(9).toString('base64url')}`
    const now = Date.now()
    this.db
      .insert(libraryItems)
      .values({
        id,
        owner_id: owner,
        project_id: projectId,
        kind,
        name,
        data: dataOf(kind, data),
        created_at: now,
        updated_at: now,
      })
      .run()
    this.changed(id)
    return this.get(owner, id)!
  }

  /** 部分更新；只是收藏 / 取消收藏不算修改，列表顺序不跳 */
  update(owner: string, id: string, body: UpdateLibraryItem): LibraryItem | null {
    const cur = this.get(owner, id)
    if (!cur) return null
    const { name, projectId, favorite, ...patch } = UpdateLibraryItem.parse(body)
    const data = {
      ...cur,
      ...patch,
      videoCompositionSource:
        patch.videoCompositionSource !== undefined
          ? (patch.videoCompositionSource ?? undefined)
          : patch.video !== undefined
            ? undefined
            : cur.videoCompositionSource,
    }
    this.assertVideoSource(owner, data.video, data.videoCompositionSource)
    const edited = Object.keys(body).some((k) => k !== 'favorite')
    this.db
      .update(libraryItems)
      .set({
        name: name ?? cur.name,
        project_id: projectId === undefined ? cur.projectId : projectId,
        data: dataOf(cur.kind, data),
        favorite: (favorite ?? cur.favorite) ? 1 : 0,
        updated_at: edited ? Date.now() : cur.updatedAt,
      })
      .where(this.mine(owner, id))
      .run()
    this.changed(id)
    return this.get(owner, id)
  }

  markUsed(owner: string, id: string): boolean {
    const res = this.db
      .update(libraryItems)
      .set({ used_at: Date.now() })
      .where(this.mine(owner, id))
      .run()
    return res.changes > 0
  }

  remove(owner: string, id: string): boolean {
    const changed = this.db.delete(libraryItems).where(this.mine(owner, id)).run().changes > 0
    if (changed) this.changed(id)
    return changed
  }
}
