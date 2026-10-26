import { z } from 'zod'

/**
 * 资产库：把画布上的设定卡固化下来，跨画布、跨项目复用。
 * 条目只存设定和资产 id，二进制在资产存储里；用到画布上时展开成对应的卡片节点和参考图。
 */
export const LibraryKind = z.enum(['character', 'scene', 'prop', 'style', 'effect'])
export type LibraryKind = z.infer<typeof LibraryKind>

/**
 * 一张参考图的用途，见 @plein/nodes 的 LIBRARY_KINDS。
 * 角色核心槽位：full_body / portrait / character_3view / face_grid；extra 放其他参考。
 * 保持开放字符串，以无损读取旧槽位、项目包和扩展用途；兼容规范化由 nodes 与服务端完成。
 */
export const LibraryImage = z.object({
  slot: z.string().trim().min(1).max(40),
  assetId: z.string().regex(/^[0-9a-f]{64}$/, '资产 id 不合法'),
})
export type LibraryImage = z.infer<typeof LibraryImage>

const libraryVoice = z.object({
  provider: z.string().max(100).default(''),
  voiceId: z.string().max(200).default(''),
})

const libraryTags = z.record(z.string().max(40), z.string().max(40))

const libraryAssetId = z.string().regex(/^[0-9a-f]{64}$/, '资产 id 不合法')
const profileName = z.string().trim().min(1).max(20)
const profileAliases = z.array(z.string().trim().min(1).max(20)).max(8).default([])

/** 一套服饰造型或一个表情（与 @plein/nodes 的 ProfileLook 同构） */
const LibraryLook = z.object({
  id: z.string().min(1).max(40),
  name: profileName,
  aliases: profileAliases,
  description: z.string().max(1000).default(''),
  images: z.array(libraryAssetId).max(4).default([]),
})

/**
 * 角色档案：以时期为主线，每个时期一个主音色、若干状态次音色和多套服饰；表情跨时期通用。
 * 与 @plein/nodes 的 CharacterProfile 同构（protocol 不依赖 nodes），解析与引用规则见那里。
 */
export const LibraryProfile = z.object({
  periods: z
    .array(
      LibraryLook.extend({
        voice: libraryVoice.nullable().default(null),
        voiceStates: z
          .array(
            z.object({
              id: z.string().min(1).max(40),
              name: profileName,
              aliases: profileAliases,
              voice: libraryVoice,
            }),
          )
          .max(6)
          .default([]),
        outfits: z.array(LibraryLook).max(12).default([]),
      }),
    )
    .max(8)
    .default([]),
  expressions: z.array(LibraryLook).max(24).default([]),
})
export type LibraryProfile = z.infer<typeof LibraryProfile>

/** 同一地点的命名视角；旧条目缺省为空，不改变已有基础参考。 */
export const LibrarySceneView = z.object({
  id: z.string().min(1).max(40),
  name: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[^/@#\s]+$/, '视角名不能含空格或 / @ #'),
  aliases: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(20)
        .regex(/^[^/@#\s]+$/),
    )
    .max(8)
    .default([]),
  description: z.string().max(1000).default(''),
  images: z.array(libraryAssetId).max(4).default([]),
})
export const LibrarySceneViews = z
  .array(LibrarySceneView)
  .max(24)
  .superRefine((views, ctx) => {
    const ids = new Set<string>()
    const names = new Set<string>()
    for (const [index, view] of views.entries()) {
      if (ids.has(view.id))
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: '视角标识重复' })
      ids.add(view.id)
      for (const name of new Set([view.name, ...view.aliases])) {
        if (names.has(name))
          ctx.addIssue({ code: 'custom', path: [index, 'name'], message: '视角名或旧名重复' })
        names.add(name)
      }
    }
  })
export type LibrarySceneView = z.infer<typeof LibrarySceneView>

const libraryFields = {
  name: z.string().trim().min(1).max(60),
  /** 归属项目；null 表示不归属任何项目（全局可用） */
  projectId: z.string().max(100).nullable().default(null),
  /** 设定 / 风格提示词 / 运镜描述：用到画布上就是卡片的「设定」，@ 引用时并入提示词 */
  description: z.string().max(4000).default(''),
  /** 筛选用的标签，如角色的 gender / age / region / era，键与可选值见 LIBRARY_KINDS */
  tags: libraryTags.default({}),
  /** 角色音色，只有角色用 */
  voice: libraryVoice.nullable().default(null),
  images: z.array(LibraryImage).max(24).default([]),
  /** 特效 / 运镜的参考视频（只给人看，不送进模型） */
  video: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
  /** 适配模型（展示用，如 Seedance 2.0、Kling 3.0） */
  models: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  /** 角色档案（时期 / 服饰 / 表情 / 次音色），只有角色用 */
  profile: LibraryProfile.nullable().default(null),
  sceneViews: LibrarySceneViews.default([]),
}

export const CreateLibraryItem = z.object({ kind: LibraryKind, ...libraryFields })
export type CreateLibraryItem = z.input<typeof CreateLibraryItem>

/** 部分更新；kind 不能改 */
export const UpdateLibraryItem = z
  .object({
    name: libraryFields.name,
    projectId: z.string().max(100).nullable(),
    description: z.string().max(4000),
    tags: libraryTags,
    voice: libraryVoice.nullable(),
    images: z.array(LibraryImage).max(24),
    video: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    models: z.array(z.string().trim().min(1).max(60)).max(12),
    profile: LibraryProfile.nullable(),
    sceneViews: LibrarySceneViews,
    favorite: z.boolean(),
  })
  .partial()
export type UpdateLibraryItem = z.infer<typeof UpdateLibraryItem>

export interface LibraryItem {
  id: string
  kind: LibraryKind
  name: string
  projectId: string | null
  description: string
  tags: Record<string, string>
  voice: { provider: string; voiceId: string } | null
  images: LibraryImage[]
  video: string | null
  models: string[]
  profile: LibraryProfile | null
  sceneViews?: LibrarySceneView[]
  favorite: boolean
  /** 最近一次用到画布上的时间，「最近使用」按它排 */
  usedAt: number | null
  createdAt: number
  updatedAt: number
}
