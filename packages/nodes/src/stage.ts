import { defineNode } from '@plein/plugin-sdk'
import { z } from 'zod'

/**
 * 3D 构图（E1 实验）：简单场景、人物占位、基础姿态和一个机位，截图作为参考图往下游送。
 *
 * 场景存在节点参数里，跟着画布撤销与协同；截图是不可变的图片资产，作为节点结果写入，
 * 下游读当前采用的那张。之后再改场景不会动已有截图，重新截图产生新资产和新结果，
 * 每张截图在 snapshots 里记下当时的场景、机位、场景版本和渲染版本。
 */
export const STAGE_TYPE = 'plein/stage'

/** 截图渲染方式的版本：灰模材质、灯光或人偶比例变了就加一，记进每张截图的来源 */
export const STAGE_RENDER_VERSION = 1

/** 基础姿态：人偶的关节角度在网页端，这里只定 id 和名字 */
export const STAGE_POSES = [
  { id: 'stand', label: '站立' },
  { id: 'walk', label: '行走' },
  { id: 'run', label: '奔跑' },
  { id: 'sit', label: '坐' },
  { id: 'point', label: '指向' },
  { id: 'cross', label: '抱臂' },
  { id: 'kneel', label: '跪' },
  { id: 'reach', label: '伸手' },
] as const
export type StagePose = (typeof STAGE_POSES)[number]['id']
const POSE_IDS = STAGE_POSES.map((p) => p.id) as [StagePose, ...StagePose[]]

/** 场景件：都用盒子拼出来，尺寸可调 */
export const STAGE_BLOCKS = [
  { id: 'box', label: '方块', size: [1, 1, 1] },
  { id: 'wall', label: '墙', size: [4, 2.8, 0.2] },
  { id: 'table', label: '桌子', size: [1.4, 0.75, 0.8] },
  { id: 'chair', label: '椅子', size: [0.5, 0.9, 0.5] },
  { id: 'door', label: '门', size: [1, 2.1, 0.12] },
  { id: 'bed', label: '床', size: [1.6, 0.5, 2.1] },
] as const
export type StageBlockKind = (typeof STAGE_BLOCKS)[number]['id']
const BLOCK_IDS = STAGE_BLOCKS.map((b) => b.id) as [StageBlockKind, ...StageBlockKind[]]

/** 画幅：截图按这个比例出 */
export const STAGE_ASPECTS = ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'] as const
export type StageAspect = (typeof STAGE_ASPECTS)[number]

/** 截图长边像素 */
export const STAGE_SNAPSHOT_SIDE = 1536

const meters = (min: number, max: number) => z.number().min(min).max(max)
/** 地面上的位置（米），场景限定在 ±50 米内 */
const ground = () => meters(-50, 50)
/** 朝向（度），0 朝向镜头默认方向（+z） */
const facing = () => z.number().min(-360).max(360).default(0)

export const StageFigure = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(40).default('人物'),
  /** 灰模上用颜色区分人物 */
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .default('#9aa4b2'),
  x: ground().default(0),
  z: ground().default(0),
  facing: facing(),
  pose: z.enum(POSE_IDS).catch('stand').default('stand'),
  height: meters(0.5, 2.5).default(1.7),
})
export type StageFigure = z.infer<typeof StageFigure>

export const StageBlock = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(BLOCK_IDS).catch('box'),
  name: z.string().max(40).optional(),
  x: ground().default(0),
  z: ground().default(0),
  facing: facing(),
  w: meters(0.05, 30).default(1),
  h: meters(0.05, 10).default(1),
  d: meters(0.05, 30).default(1),
})
export type StageBlock = z.infer<typeof StageBlock>

/** 机位：位置、看向的点和焦距（全画幅等效毫米） */
export const StageCamera = z.object({
  x: ground().default(0),
  y: meters(0.05, 30).default(1.5),
  z: ground().default(4.5),
  tx: ground().default(0),
  ty: meters(-10, 30).default(1.2),
  tz: ground().default(0),
  focal: z.number().min(12).max(200).default(35),
})
export type StageCamera = z.infer<typeof StageCamera>

export const StageScene = z.object({
  aspect: z.enum(STAGE_ASPECTS).catch('16:9').default('16:9'),
  figures: z.array(StageFigure).max(12).default([]),
  blocks: z.array(StageBlock).max(60).default([]),
  camera: StageCamera.default(StageCamera.parse({})),
  /** 场景版本：每次在构图里改动加一，截图记下截的是哪一版 */
  rev: z.number().int().min(0).default(0),
})
export type StageScene = z.infer<typeof StageScene>

/** 一张截图的来源：对应的结果、当时完整的场景（含机位）、场景版本与渲染版本 */
export const StageSnapshot = z.object({
  resultId: z.string(),
  assetId: z.string(),
  rev: z.number().int(),
  render: z.number().int(),
  scene: StageScene,
  at: z.number(),
})
export type StageSnapshot = z.infer<typeof StageSnapshot>

/** 截图来源最多记这么多条，和节点结果上限一致 */
export const MAX_STAGE_SNAPSHOTS = 48

/** 新建时的场景：一个站着的人物，正面中景机位 */
export const defaultStageScene = (): StageScene =>
  StageScene.parse({
    figures: [{ id: 'fig-1', name: '人物 1', color: '#7aa2ff' }],
  })

/** 读节点参数里的场景：旧数据或坏数据回退成默认场景，不抛错 */
export function stageSceneOf(params: Record<string, unknown> | undefined): StageScene {
  const parsed = StageScene.safeParse(params?.scene)
  return parsed.success ? parsed.data : defaultStageScene()
}

export function stageSnapshotsOf(params: Record<string, unknown> | undefined): StageSnapshot[] {
  const parsed = z.array(StageSnapshot).safeParse(params?.snapshots)
  return parsed.success ? parsed.data : []
}

/**
 * 焦距换算垂直视场角（度）：画面长边按全画幅的 36 毫米算，
 * 横画幅和竖画幅用同一个焦距时取景宽窄一致
 */
export function verticalFov(focal: number, aspect: number) {
  const long = 2 * Math.atan(18 / focal)
  const v = aspect >= 1 ? 2 * Math.atan(Math.tan(long / 2) / aspect) : long
  return (v * 180) / Math.PI
}

export const aspectRatio = (a: StageAspect) => {
  const [w, h] = a.split(':').map(Number)
  return w! / h!
}

/** 3D 构图节点：截图从「构图」端口输出，接到图片 / 视频节点的参考图 */
export const stageNode = defineNode({
  type: STAGE_TYPE,
  version: 1,
  title: '3D 构图',
  description: '摆人物占位、姿态和机位，截一张灰模构图图作为参考图（实验）',
  category: 'story',
  inputs: [],
  outputs: [{ id: 'image', label: '构图', type: 'image' }],
  params: z.object({
    scene: StageScene.default(defaultStageScene).meta({ title: '场景', widget: 'hidden' }),
    snapshots: z.array(StageSnapshot).default([]).meta({ title: '截图来源', widget: 'hidden' }),
  }),
})
