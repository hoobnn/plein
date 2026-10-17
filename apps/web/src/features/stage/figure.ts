import type { StageBlock, StageBlockKind, StageFigure, StagePose } from '@plein/nodes'
import * as THREE from 'three'

/**
 * 灰模人偶与场景件：都由简单几何体拼成，不带外部模型文件。
 * 人偶按 1.73 米建模，再按人物身高整体缩放；姿态是各关节的角度表。
 */

/** 建模身高（米） */
const BASE_HEIGHT = 1.73
/** 站立时胯关节高度 */
const HIP_HEIGHT = 0.94

/** 关节角度（度）。swing 向前摆为正，raise / spread 向外张为正，bend 弯曲为正 */
interface Limb {
  swing?: number
  raise?: number
  /** 腿向外分开 */
  spread?: number
  /** 绕手臂自身方向内旋（抱臂时让前臂横过胸前） */
  twist?: number
  bend?: number
}
interface Pose {
  /** 胯部下沉（米），坐、跪时 */
  drop?: number
  /** 上身前倾（度） */
  lean?: number
  /** 头：转向（度，向左为正）与低头 */
  turn?: number
  nod?: number
  armL?: Limb
  armR?: Limb
  legL?: Limb
  legR?: Limb
}

const POSES: Record<StagePose, Pose> = {
  stand: { armL: { raise: 6 }, armR: { raise: 6 } },
  walk: {
    armL: { swing: -22, raise: 5, bend: 12 },
    armR: { swing: 22, raise: 5, bend: 12 },
    legL: { swing: 22, bend: 8 },
    legR: { swing: -18, bend: 18 },
  },
  run: {
    lean: 12,
    drop: 0.04,
    armL: { swing: -45, raise: 8, bend: 85 },
    armR: { swing: 55, raise: 8, bend: 85 },
    legL: { swing: 50, bend: 75 },
    legR: { swing: -28, bend: 45 },
  },
  sit: {
    drop: 0.44,
    armL: { swing: 25, raise: 8, bend: 55 },
    armR: { swing: 25, raise: 8, bend: 55 },
    legL: { swing: 90, spread: 4, bend: 90 },
    legR: { swing: 90, spread: 4, bend: 90 },
  },
  point: {
    turn: -10,
    armL: { raise: 6 },
    armR: { swing: 85, raise: 12 },
  },
  cross: {
    armL: { swing: 30, raise: 18, twist: 55, bend: 115 },
    armR: { swing: 30, raise: 18, twist: 55, bend: 115 },
  },
  kneel: {
    drop: 0.44,
    lean: 6,
    armL: { swing: 10, raise: 8, bend: 30 },
    armR: { swing: 10, raise: 8, bend: 30 },
    legL: { swing: 90, bend: 90 },
    legR: { swing: 0, bend: 90 },
  },
  reach: {
    lean: 10,
    nod: -10,
    armL: { swing: 55, raise: 10, bend: 20 },
    armR: { swing: 115, raise: 12, bend: 8 },
    legL: { swing: 18, bend: 10 },
    legR: { swing: -12, bend: 6 },
  },
}

const rad = THREE.MathUtils.degToRad

/** 灰模材质：哑光、不反光；人物按自己的颜色淡淡上色，方便分辨 */
function clay(color: string | number = 0xb8bcc4) {
  const c = new THREE.Color(color)
  // 往中性灰靠一些，颜色只用来区分人物，不抢构图
  c.lerp(new THREE.Color(0xb8bcc4), 0.35)
  return new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, metalness: 0 })
}

const capsule = (r: number, len: number, mat: THREE.Material, y: number) => {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 14), mat)
  m.position.y = y
  m.castShadow = true
  m.receiveShadow = true
  return m
}

const pivot = (x: number, y: number, z = 0) => {
  const g = new THREE.Group()
  g.position.set(x, y, z)
  g.rotation.order = 'YXZ'
  return g
}

interface Rig {
  pelvis: THREE.Group
  spine: THREE.Group
  neck: THREE.Group
  arms: Record<'L' | 'R', { shoulder: THREE.Group; elbow: THREE.Group }>
  legs: Record<'L' | 'R', { hip: THREE.Group; knee: THREE.Group }>
}

/** 人偶：根节点在脚下，朝向 +z；userData.rig 存关节，换姿态不用重建 */
export function buildFigure(fig: StageFigure): THREE.Group {
  const mat = clay(fig.color)
  const root = new THREE.Group()
  const body = new THREE.Group()
  root.add(body)

  const pelvis = pivot(0, HIP_HEIGHT)
  body.add(pelvis)
  const hips = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.12, 6, 14), mat)
  hips.rotation.z = Math.PI / 2
  hips.scale.set(1, 1, 0.8)
  hips.castShadow = true
  pelvis.add(hips)

  const spine = pivot(0, 0.05)
  pelvis.add(spine)
  const torso = capsule(0.14, 0.26, mat, 0.25)
  torso.scale.set(1.25, 1, 0.75)
  spine.add(torso)

  const neck = pivot(0, 0.5)
  spine.add(neck)
  neck.add(capsule(0.045, 0.06, mat, 0.04))
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 18), mat)
  head.position.y = 0.15
  head.scale.set(0.9, 1.05, 1)
  head.castShadow = true
  neck.add(head)
  // 鼻尖：截图里看得出人物朝哪边
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.05), mat)
  nose.position.set(0, 0.14, 0.11)
  neck.add(nose)

  const arm = (side: 1 | -1) => {
    const shoulder = pivot(0.2 * side, 0.45)
    spine.add(shoulder)
    shoulder.add(capsule(0.045, 0.22, mat, -0.14))
    const elbow = pivot(0, -0.3)
    shoulder.add(elbow)
    elbow.add(capsule(0.04, 0.18, mat, -0.12))
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.048, 14, 10), mat)
    hand.position.y = -0.28
    hand.scale.set(0.8, 1.1, 0.6)
    hand.castShadow = true
    elbow.add(hand)
    return { shoulder, elbow }
  }
  const leg = (side: 1 | -1) => {
    const hip = pivot(0.1 * side, 0)
    pelvis.add(hip)
    hip.add(capsule(0.07, 0.3, mat, -0.22))
    const knee = pivot(0, -0.44)
    hip.add(knee)
    knee.add(capsule(0.055, 0.32, mat, -0.22))
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.22), mat)
    foot.position.set(0, -0.47, 0.05)
    foot.castShadow = true
    knee.add(foot)
    return { hip, knee }
  }
  const rig: Rig = {
    pelvis,
    spine,
    neck,
    arms: { L: arm(1), R: arm(-1) },
    legs: { L: leg(1), R: leg(-1) },
  }
  root.userData.rig = rig
  root.userData.body = body
  updateFigure(root, fig)
  return root
}

/** 套用位置、朝向、身高和姿态 */
export function updateFigure(root: THREE.Group, fig: StageFigure) {
  root.position.set(fig.x, 0, fig.z)
  root.rotation.y = rad(fig.facing)
  const body = root.userData.body as THREE.Group
  body.scale.setScalar(fig.height / BASE_HEIGHT)
  const rig = root.userData.rig as Rig
  const p = POSES[fig.pose] ?? POSES.stand
  rig.pelvis.position.y = HIP_HEIGHT - (p.drop ?? 0)
  rig.spine.rotation.set(rad(p.lean ?? 0), 0, 0)
  rig.neck.rotation.set(rad(p.nod ?? 0), rad(p.turn ?? 0), 0)
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1
    const a = (side === 'L' ? p.armL : p.armR) ?? {}
    const { shoulder, elbow } = rig.arms[side]
    // 向前摆是绕 x 轴的负方向；向外张左臂绕 z 正转、右臂负转；内旋左右相反
    shoulder.rotation.set(-rad(a.swing ?? 0), -s * rad(a.twist ?? 0), s * rad(a.raise ?? 0))
    elbow.rotation.set(-rad(a.bend ?? 0), 0, 0)
    const l = (side === 'L' ? p.legL : p.legR) ?? {}
    const { hip, knee } = rig.legs[side]
    hip.rotation.set(-rad(l.swing ?? 0), 0, s * rad(l.spread ?? 0))
    knee.rotation.set(rad(l.bend ?? 0), 0, 0)
  }
}

const box = (
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
  m.position.set(x, y, z)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

/** 场景件的形状：桌椅床按尺寸拼几块板，其余就是一个盒子 */
function blockParts(kind: StageBlockKind, w: number, h: number, d: number, mat: THREE.Material) {
  const leg = Math.min(0.06, w / 8, d / 8)
  const legs = (top: number) =>
    [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ].map(([sx, sz]) => box(leg, top, leg, mat, sx! * (w / 2 - leg), top / 2, sz! * (d / 2 - leg)))
  switch (kind) {
    case 'table': {
      const t = Math.min(0.05, h / 6)
      return [box(w, t, d, mat, 0, h - t / 2, 0), ...legs(h - t)]
    }
    case 'chair': {
      const seat = Math.min(0.46, h * 0.5)
      const t = 0.04
      return [
        box(w, t, d, mat, 0, seat, 0),
        box(w, h - seat, t, mat, 0, seat + (h - seat) / 2, -d / 2 + t / 2),
        ...legs(seat - t / 2),
      ]
    }
    case 'bed': {
      const pillow = box(w * 0.6, 0.1, Math.min(0.4, d / 4), mat, 0, h + 0.05, -d / 2 + 0.3)
      return [box(w, h, d, mat, 0, h / 2, 0), pillow]
    }
    default:
      return [box(w, h, d, mat, 0, h / 2, 0)]
  }
}

/** 场景件：根节点在地面中心；尺寸变了要重建（userData.key 比对） */
export function buildBlock(b: StageBlock): THREE.Group {
  const root = new THREE.Group()
  // 墙浅、门深一点，门贴在墙上也分得出来
  const mat = clay(b.kind === 'wall' ? 0xc4c7cc : b.kind === 'door' ? 0x8c929c : 0xaeb2b9)
  root.add(...blockParts(b.kind, b.w, b.h, b.d, mat))
  root.userData.key = blockKey(b)
  updateBlock(root, b)
  return root
}

export const blockKey = (b: StageBlock) => `${b.kind}:${b.w}:${b.h}:${b.d}`

export function updateBlock(root: THREE.Group, b: StageBlock) {
  root.position.set(b.x, 0, b.z)
  root.rotation.y = rad(b.facing)
}

/** 释放一组网格的几何体和材质 */
export function disposeTree(obj: THREE.Object3D) {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose()
      const m = o.material as THREE.Material | THREE.Material[]
      for (const x of Array.isArray(m) ? m : [m]) x.dispose()
    }
  })
}
