import { defaultStageScene, STAGE_BLOCKS, StageBlock, StageScene } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { stageObjectName, stageObjectPosition } from './placement'

describe('3D 新对象放置', () => {
  it('保留手动名称，跳过已占用编号并复用删除后的空号', () => {
    const scene = defaultStageScene()
    scene.figures.push({ ...scene.figures[0]!, id: 'third', name: '人物 3' })
    expect(stageObjectName(scene, '人物')).toBe('人物 2')
    scene.blocks.push(StageBlock.parse({ id: 'table', kind: 'table', name: ' 人物 2 ' }))
    expect(stageObjectName(scene, '人物')).toBe('人物 4')
  })

  it('连加 12 人保留站位间距，并保持场景可以解析', () => {
    const scene = defaultStageScene()
    for (let i = 1; i < 12; i++) {
      const at = stageObjectPosition(scene, { x: 0, z: 0, w: 0.68, d: 0.68 })!
      expect(at).toBeDefined()
      for (const f of scene.figures) {
        expect(Math.abs(at.x - f.x) >= 0.93 || Math.abs(at.z - f.z) >= 0.93).toBe(true)
      }
      scene.figures.push({
        ...scene.figures[0]!,
        id: `added-${i}`,
        name: stageObjectName(scene, '人物'),
        ...at,
      })
    }
    expect(scene.figures).toHaveLength(12)
    expect(new Set(scene.figures.map((f) => f.name)).size).toBe(12)
    expect(StageScene.safeParse(scene).success).toBe(true)
  })

  it.each(STAGE_BLOCKS.map((k) => [k.label, k] as const))(
    '连续添加两个%s时名称可区分且占地不重叠',
    (_, kind) => {
      const scene = defaultStageScene()
      const [w, h, d] = kind.size
      // 与面板添加场景件一致：默认落点在镜头前 1.5 米，名字按类型标签编号。
      for (let i = 0; i < 2; i++) {
        const at = stageObjectPosition(scene, { x: 0, z: -1.5, w, d })!
        expect(at).toBeDefined()
        scene.blocks.push(
          StageBlock.parse({
            id: `added-${i}`,
            kind: kind.id,
            name: stageObjectName(scene, kind.label),
            ...at,
            w,
            h,
            d,
          }),
        )
      }
      const [a, b] = scene.blocks
      expect([a!.name, b!.name]).toEqual([`${kind.label} 1`, `${kind.label} 2`])
      expect(
        Math.abs(a!.x - b!.x) >= (a!.w + b!.w) / 2 || Math.abs(a!.z - b!.z) >= (a!.d + b!.d) / 2,
      ).toBe(true)
      expect(StageScene.safeParse(scene).success).toBe(true)
    },
  )

  it('旋转墙的占地以及地面边缘均参与避让', () => {
    const scene = defaultStageScene()
    scene.figures = []
    scene.blocks = [
      StageBlock.parse({ id: 'wall', kind: 'wall', x: 50, z: 0, w: 4, d: 0.2, facing: 90 }),
    ]
    const at = stageObjectPosition(scene, { x: 50, z: 0, w: 0.68, d: 0.68 })!
    expect(Math.abs(at.x)).toBeLessThanOrEqual(50)
    expect(Math.abs(at.z)).toBeLessThanOrEqual(50)
    // 墙旋转后沿 z 延伸四米；人物不能放到它的包围盒里。
    expect(Math.abs(at.x - 50) >= 0.69 || Math.abs(at.z) >= 2.59).toBe(true)
  })

  it('地面被大场景件占满时不返回重叠落点', () => {
    const scene = defaultStageScene()
    scene.figures = []
    scene.blocks = [-45, -15, 15, 45].flatMap((x) =>
      [-45, -15, 15, 45].map((z) =>
        StageBlock.parse({ id: `${x},${z}`, kind: 'box', x, z, w: 30, d: 30 }),
      ),
    )
    expect(stageObjectPosition(scene, { x: 0, z: 0, w: 0.68, d: 0.68 })).toBeUndefined()
  })
})
