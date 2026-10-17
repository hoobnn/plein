import { STAGE_BLOCKS, type StageScene } from '@plein/nodes'

type Footprint = { x: number; z: number; w: number; d: number }

/** 新对象的编号按现有名字找空缺，不依赖可能缩短的对象数组。 */
export function stageObjectName(scene: StageScene, base: string) {
  const names = new Set([
    ...scene.figures.map((f) => f.name.trim()),
    ...scene.blocks.map((b) => (b.name ?? STAGE_BLOCKS.find((k) => k.id === b.kind)!.label).trim()),
  ])
  let n = 1
  while (names.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/** 按地面占地找最近空位；旋转场景件用包围盒，人物保留约半米的站位。 */
export function stageObjectPosition(
  scene: StageScene,
  preferred: Footprint,
): { x: number; z: number } | undefined {
  const obstacles: Footprint[] = [
    ...scene.figures.map((f) => ({ x: f.x, z: f.z, w: f.height * 0.4, d: f.height * 0.4 })),
    ...scene.blocks.map((b) => {
      const r = (b.facing * Math.PI) / 180
      const c = Math.abs(Math.cos(r))
      const s = Math.abs(Math.sin(r))
      return { x: b.x, z: b.z, w: c * b.w + s * b.d, d: s * b.w + c * b.d }
    }),
  ]
  const xs = new Set([preferred.x])
  const zs = new Set([preferred.z])
  const round = (v: number) => Math.round(v * 100) / 100
  for (const o of obstacles) {
    for (const sign of [-1, 1]) {
      xs.add(round(o.x + sign * ((o.w + preferred.w) / 2 + 0.3)))
      zs.add(round(o.z + sign * ((o.d + preferred.d) / 2 + 0.3)))
    }
  }
  const candidates = [...xs].flatMap((x) => [...zs].map((z) => ({ x, z })))
  candidates.sort(
    (a, b) =>
      Math.hypot(a.x - preferred.x, a.z - preferred.z) -
        Math.hypot(b.x - preferred.x, b.z - preferred.z) ||
      Math.abs(a.z - preferred.z) - Math.abs(b.z - preferred.z),
  )
  return candidates.find(
    ({ x, z }) =>
      Math.abs(x) <= 50 &&
      Math.abs(z) <= 50 &&
      obstacles.every(
        (o) =>
          Math.abs(x - o.x) >= (preferred.w + o.w) / 2 + 0.25 ||
          Math.abs(z - o.z) >= (preferred.d + o.d) / 2 + 0.25,
      ),
  )
}
