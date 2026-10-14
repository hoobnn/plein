import { z } from 'zod'
import { AssetKind } from './assets'
import { CreateLibraryItem } from './library'

/**
 * 项目包：把一个项目迁到另一套本地安装的单文件归档（zip，扩展名 .plein）。
 * 根目录的 manifest.json 描述全部内容，其余文件只按清单里的路径读取：
 *
 * - canvases/<序号>.yjs   画布文档（Yjs 状态）
 * - assets/<sha256>       用到的原始素材（文件名即内容哈希，也就是资产 id）
 * - history/jobs.json     运行记录（只作历史，迁入后不续查、不重新提交）
 *
 * 不含平台密钥、登录与智能体凭据、智能体会话和任何本机绝对路径。
 */
export const PROJECT_PACKAGE_FORMAT = 'plein-project'
/** 当前写出、也是能读的最高格式版本；结构有不兼容变化时加一 */
export const PROJECT_PACKAGE_VERSION = 1
export const PROJECT_PACKAGE_EXT = '.plein'

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, '哈希不合法')
/** 项目、画布、资产库条目、任务的 id：迁入时原样作为主键，只允许安全字符 */
const recordId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, 'id 不合法')

/** 包里的一个文件：相对路径、内容哈希和字节数，导入时逐个校验 */
export const PackageFile = z.object({
  path: z.string().min(1).max(200),
  sha256,
  size: z.number().int().nonnegative(),
})
export type PackageFile = z.infer<typeof PackageFile>

/**
 * 候选范围：current 只带每个节点当前采用的那次运行的结果（默认），
 * all 带上全部历史候选
 */
export const PackageCandidates = z.enum(['current', 'all'])
export type PackageCandidates = z.infer<typeof PackageCandidates>

export const PackageCanvas = z.object({
  id: recordId,
  title: z.string().max(200),
  createdAt: z.number(),
  updatedAt: z.number(),
  file: PackageFile,
})
export type PackageCanvas = z.infer<typeof PackageCanvas>

export const PackageAsset = z.object({
  id: sha256,
  kind: AssetKind,
  mime: z.string().max(200),
  name: z.string().max(255),
  size: z.number().int().nonnegative(),
  width: z.number().optional(),
  height: z.number().optional(),
  duration: z.number().optional(),
  createdAt: z.number(),
  file: PackageFile,
})
export type PackageAsset = z.infer<typeof PackageAsset>

/** 资产库条目：字段同新建条目，另带原 id 和时间 */
export const PackageLibraryItem = CreateLibraryItem.extend({
  id: recordId,
  projectId: recordId.nullable(),
  favorite: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type PackageLibraryItem = z.infer<typeof PackageLibraryItem>

/** 一条运行记录：不含调用日志（远端任务号、结果地址），错误信息里的本机路径已抹掉 */
export const PackageJob = z.object({
  id: recordId,
  canvasId: recordId,
  nodeId: z.string().max(200),
  nodeType: z.string().max(200),
  status: z.enum(['succeeded', 'failed', 'canceled']),
  attempts: z.number().int().nonnegative(),
  cacheKey: z.string().max(200).nullable(),
  cacheOmit: z.string().max(10_000).nullable(),
  /** 提交时冻结的实际输入（PreparedInput） */
  input: z.unknown().optional(),
  error: z.string().max(10_000).nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
})
export type PackageJob = z.infer<typeof PackageJob>

/** 文档里用到、迁入后要在新安装里重新绑定的外部依赖 */
export const PackageDependencies = z.object({
  /** 节点参数里选定的模型（`provider:model`） */
  models: z.array(z.string().max(300)).default([]),
  /** 节点、角色卡和资产库条目绑定的音色 */
  voices: z.array(z.object({ provider: z.string().max(100), voiceId: z.string().max(200) })),
  /** 用到的节点类型与版本，plugin 是导出时提供它的插件 */
  nodes: z.array(
    z.object({
      type: z.string().max(200),
      version: z.number().int(),
      plugin: z.string().max(200).optional(),
    }),
  ),
})
export type PackageDependencies = z.infer<typeof PackageDependencies>

/** 文档引用了、但导出时本机没有文件的东西：迁入后仍然缺失，在这里明确记下 */
export const PackageMissing = z.object({
  kind: z.enum(['asset', 'library']),
  id: z.string().max(200),
  /** 在哪里被引用：画布标题 / 元素名，或资产库条目名 */
  where: z.string().max(300),
})
export type PackageMissing = z.infer<typeof PackageMissing>

export const ProjectPackageManifest = z.object({
  format: z.literal(PROJECT_PACKAGE_FORMAT),
  formatVersion: z.number().int().positive(),
  createdAt: z.number(),
  candidates: PackageCandidates,
  project: z.object({ id: recordId, title: z.string().max(200), createdAt: z.number() }),
  canvases: z.array(PackageCanvas).max(1000),
  assets: z.array(PackageAsset).max(100_000),
  library: z.array(PackageLibraryItem).max(10_000),
  history: PackageFile.nullable(),
  dependencies: PackageDependencies,
  missing: z.array(PackageMissing),
})
export type ProjectPackageManifest = z.infer<typeof ProjectPackageManifest>

/** 导出前的概要：导出对话框据此说明范围和大小 */
export interface ProjectPackageSummary {
  candidates: PackageCandidates
  canvases: number
  assets: number
  library: number
  jobs: number
  /** 包的大致字节数（素材原样存储，文档压缩前的大小） */
  bytes: number
  missing: PackageMissing[]
  /** 超过单个包的上限（4 GB），需要缩小范围或改用整目录备份 */
  tooLarge: boolean
}

// ── 导入 ──

/** 依赖在本机的状态：ok 可用；missing 没装；disabled 装了没启用；outdated 节点版本低于包里的；unverified 无法预先确认（如音色属于平台账户） */
export type DependencyStatus = 'ok' | 'missing' | 'disabled' | 'outdated' | 'unverified'

/** 导入预检：包已校验通过、放进暂存区，确认后才写入 */
export interface ProjectImportPreview {
  /** 确认导入或放弃时用的令牌，过期后需重新选择文件 */
  token: string
  expiresAt: number
  formatVersion: number
  title: string
  candidates: PackageCandidates
  counts: { canvases: number; assets: number; library: number; jobs: number; bytes: number }
  /** 本机已有同一个项目（同一个包导入过，或就是从这里导出的）：作为新副本导入，项目及其画布、条目、运行记录全部换新 id */
  copy: boolean
  /** 因为和本机已有记录冲突而换了 id 的数量；文档里的引用同步改写 */
  remapped: { canvases: number; library: number; jobs: number }
  models: Array<{ ref: string; status: DependencyStatus }>
  voices: Array<{ provider: string; voiceId: string; status: DependencyStatus }>
  nodes: Array<{ type: string; version: number; plugin?: string; status: DependencyStatus }>
  /** 导出时就缺的素材和资产库条目，导入后这些位置仍然缺失 */
  missing: PackageMissing[]
  /** 需要知道但不阻止导入的说明 */
  notices: string[]
}

export interface ProjectImportResult {
  projectId: string
  title: string
  /** 最近修改的画布，导入后直接打开它 */
  canvasId: string | null
}

/**
 * 项目包读不了时的错误码（HTTP 422，message 是给用户的处理建议）：
 * - not_a_package：不是 zip 或没有 manifest.json
 * - unsupported_version：格式版本高于本机支持的
 * - corrupt：清单或文档内容不合法、zip 结构损坏
 * - unsafe_path：条目路径越出包根目录或不在清单约定的位置
 * - missing_file：清单列出的文件不在包里
 * - hash_mismatch：文件内容和清单里的哈希或大小对不上
 */
export type ProjectImportErrorCode =
  | 'not_a_package'
  | 'unsupported_version'
  | 'corrupt'
  | 'unsafe_path'
  | 'missing_file'
  | 'hash_mismatch'
