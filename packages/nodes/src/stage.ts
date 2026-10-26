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

/** 场景坐标的持久化边界，构图工具的交互写回也遵守同一范围。 */
export const STAGE_BOUNDS = {
  ground: { min: -50, max: 50 },
  cameraHeight: { min: 0.05, max: 30 },
  targetHeight: { min: -10, max: 30 },
} as const

const meters = (min: number, max: number) => z.number().min(min).max(max)
/** 地面上的位置（米），场景限定在 ±50 米内 */
const ground = () => meters(STAGE_BOUNDS.ground.min, STAGE_BOUNDS.ground.max)
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
  y: meters(STAGE_BOUNDS.cameraHeight.min, STAGE_BOUNDS.cameraHeight.max).default(1.5),
  z: ground().default(4.5),
  tx: ground().default(0),
  ty: meters(STAGE_BOUNDS.targetHeight.min, STAGE_BOUNDS.targetHeight.max).default(1.2),
  tz: ground().default(0),
  focal: z.number().min(12).max(200).default(35),
})
export type StageCamera = z.infer<typeof StageCamera>

export const STAGE_KEYFRAME_LIMIT = 60
const StageFigurePosition = StageFigure.pick({
  id: true,
  x: true,
  z: true,
  facing: true,
  pose: true,
})
export const StageKeyframe = z.object({
  id: z.string().min(1).max(64),
  time: z.number().min(0).max(60).multipleOf(0.001),
  camera: StageCamera,
  figures: z
    .array(StageFigurePosition)
    .max(12)
    .refine(
      (figures) => new Set(figures.map((f) => f.id)).size === figures.length,
      '关键帧人物不能重复',
    ),
})
export type StageKeyframe = z.infer<typeof StageKeyframe>
export const StageMotion = z
  .object({
    duration: z.number().min(1).max(60).multipleOf(0.001),
    keyframes: z.array(StageKeyframe).min(1).max(STAGE_KEYFRAME_LIMIT),
  })
  .refine(
    (motion) =>
      motion.keyframes.every((frame) => frame.time <= motion.duration) &&
      new Set(motion.keyframes.map((frame) => frame.time)).size === motion.keyframes.length &&
      new Set(motion.keyframes.map((frame) => frame.id)).size === motion.keyframes.length,
    '关键帧时间不能重复或超出时长',
  )
export type StageMotion = z.infer<typeof StageMotion>

export const StageScene = z.object({
  aspect: z.enum(STAGE_ASPECTS).catch('16:9').default('16:9'),
  figures: z.array(StageFigure).max(12).default([]),
  blocks: z.array(StageBlock).max(60).default([]),
  camera: StageCamera.default(StageCamera.parse({})),
  motion: StageMotion.optional(),
  /** 场景版本：每次在构图里改动加一，截图记下截的是哪一版 */
  rev: z.number().int().min(0).default(0),
})
export type StageScene = z.infer<typeof StageScene>

/** 一张截图的来源：对应的结果、当时完整的场景（含机位）、场景版本与渲染版本 */
export const StageSnapshot = z
  .object({
    resultId: z.string(),
    assetId: z.string(),
    rev: z.number().int(),
    render: z.number().int(),
    scene: StageScene,
    at: z.number(),
    /** 动态预演的截图时刻；旧静态截图没有此字段。 */
    time: z.number().min(0).max(60).optional(),
  })
  .refine(
    (snapshot) =>
      snapshot.time === undefined ||
      (!!snapshot.scene.motion && snapshot.time <= snapshot.scene.motion.duration),
    '截图时刻超出预演时长',
  )
export type StageSnapshot = z.infer<typeof StageSnapshot>

/** 新建时的场景：一个站着的人物，正面中景机位 */
export const defaultStageScene = (): StageScene =>
  StageScene.parse({
    figures: [{ id: 'fig-1', name: '人物 1', color: '#7aa2ff' }],
  })

/** 读节点参数里的场景：旧数据或坏数据回退成默认场景，不抛错 */
export function stageSceneOf(params: Record<string, unknown> | undefined): StageScene {
  const parsed = StageScene.safeParse(params?.scene)
  if (parsed.success) return parsed.data
  // 损坏的新增轨迹不应抹掉仍可读取的旧静态场景。
  const raw = params?.scene
  if (raw && typeof raw === 'object' && 'motion' in raw) {
    const fallback = StageScene.safeParse({ ...raw, motion: undefined })
    if (fallback.success) return fallback.data
  }
  return defaultStageScene()
}

export function stageTime(scene: StageScene, time: number) {
  return (
    Math.round(
      Math.max(0, Math.min(scene.motion?.duration ?? 0, Number.isFinite(time) ? time : 0)) * 1000,
    ) / 1000
  )
}

/** 纯采样，不写文档、不增加版本或触发生成；对象外观与场景件仍由基础场景管理。 */
export function sampleStageScene(scene: StageScene, time: number): StageScene {
  if (!scene.motion) return scene
  const frames = [...scene.motion.keyframes].sort((a, b) => a.time - b.time)
  const t = stageTime(scene, time)
  const left = [...frames].reverse().find((frame) => frame.time <= t) ?? frames[0]!
  const right = frames.find((frame) => frame.time > t) ?? left
  const amount =
    left === right ? 0 : Math.max(0, Math.min(1, (t - left.time) / (right.time - left.time)))
  const lerp = (a: number, b: number) => a + (b - a) * amount
  const camera = { ...left.camera }
  for (const key of Object.keys(camera) as (keyof StageCamera)[])
    camera[key] = lerp(left.camera[key], right.camera[key])
  return {
    ...scene,
    camera,
    figures: scene.figures.map((figure) => {
      const a = left.figures.find((value) => value.id === figure.id) ?? figure
      const b = right.figures.find((value) => value.id === figure.id) ?? figure
      const turn = ((((b.facing - a.facing + 540) % 360) + 360) % 360) - 180
      const facing = ((((a.facing + turn * amount + 180) % 360) + 360) % 360) - 180
      return { ...figure, x: lerp(a.x, b.x), z: lerp(a.z, b.z), facing, pose: a.pose }
    }),
  }
}

/** 只替换当前时刻，其他关键帧保持不变。 */
export function recordStageKeyframe(
  scene: StageScene,
  time: number,
  pose = sampleStageScene(scene, time),
): StageScene {
  const duration = scene.motion?.duration ?? 5
  const at =
    Math.round(Math.max(0, Math.min(duration, Number.isFinite(time) ? time : 0)) * 1000) / 1000
  const old = scene.motion?.keyframes ?? []
  const found = old.find((frame) => frame.time === at)
  if (!found && old.length >= STAGE_KEYFRAME_LIMIT) throw new Error('最多保存 60 个关键帧')
  const stem = `key-${Math.round(at * 1000)}`
  let frameId = found?.id ?? stem
  if (!found)
    for (let n = 2; old.some((frame) => frame.id === frameId); n++) frameId = `${stem}-${n}`
  const frame: StageKeyframe = {
    id: frameId,
    time: at,
    camera: { ...pose.camera },
    figures: pose.figures.map(({ id, x, z, facing, pose }) => ({ id, x, z, facing, pose })),
  }
  return StageScene.parse({
    ...scene,
    motion: {
      duration,
      keyframes: [...old.filter((value) => value.time !== at), frame].sort(
        (a, b) => a.time - b.time,
      ),
    },
  })
}

export function stageSnapshotsOf(params: Record<string, unknown> | undefined): StageSnapshot[] {
  if (!Array.isArray(params?.snapshots)) return []
  const seen = new Set<string>()
  const snapshots: StageSnapshot[] = []
  for (const value of params.snapshots) {
    const parsed = StageSnapshot.safeParse(value)
    if (!parsed.success || seen.has(parsed.data.resultId)) continue
    seen.add(parsed.data.resultId)
    snapshots.push(parsed.data)
  }
  return snapshots
}

/** 只读取指定候选的首条有效来源，避免尺寸监听反复解析其他历史场景。 */
export function stageSnapshotFor(params: Record<string, unknown> | undefined, resultId: string) {
  if (!Array.isArray(params?.snapshots)) return undefined
  for (const value of params.snapshots) {
    if (value?.resultId !== resultId) continue
    const parsed = StageSnapshot.safeParse(value)
    if (parsed.success) return parsed.data
  }
  return undefined
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
  description: '摆人物、姿态和机位，记录关键帧预演人物与运镜，按时刻截图作参考（实验）',
  category: 'story',
  inputs: [],
  outputs: [{ id: 'image', label: '构图', type: 'image' }],
  params: z.object({
    scene: StageScene.default(defaultStageScene).meta({ title: '场景', widget: 'hidden' }),
    snapshots: z.array(StageSnapshot).default([]).meta({ title: '截图来源', widget: 'hidden' }),
  }),
})
