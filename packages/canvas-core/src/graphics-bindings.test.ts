import {
  DOMAdapter,
  GraphicsContext,
  GraphicsContextSystem,
  RendererType,
  Texture,
  TextureSource,
} from 'pixi.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

beforeEach(() => {
  // CPU 单测仅构建几何与绑定；浏览器回归负责实际 GL 绘制。
  vi.spyOn(DOMAdapter.get(), 'createCanvas').mockReturnValue({
    getContext: () => null,
  } as unknown as HTMLCanvasElement)
})
afterEach(() => vi.restoreAllMocks())

describe('图形纹理的渲染后端所有权', () => {
  it.each([RendererType.WEBGL, RendererType.WEBGPU])(
    '后端 %s 仅保留自己实际需要的纹理绑定',
    (type) => {
      const renderer = {
        uid: 100_000 + type,
        type,
        limits: { maxBatchableTextures: 4 },
        gc: { now: 0, addResourceHash() {} },
      } as unknown as ConstructorParameters<typeof GraphicsContextSystem>[0]
      const texture = new Texture({ source: new TextureSource({ width: 16, height: 16 }) })
      const context = new GraphicsContext()
      context.batchMode = 'no-batch'
      context.rect(0, 0, 100, 100).fill({ texture })
      const system = new GraphicsContextSystem(renderer)
      const listeners = texture.source.listenerCount('change')
      system.updateGpuContext(context)
      const data = system.getContextRenderData(context)
      const groups = data.batcher.batches
        .slice(0, data.batcher.batchIndex)
        .map((batch) => batch.bindGroup)
      try {
        expect(data.batcher.batchIndex).toBeGreaterThan(0)
        if (type === RendererType.WEBGL)
          expect(texture.source.listenerCount('change')).toBe(listeners)
        else {
          expect(texture.source.listenerCount('change')).toBeGreaterThan(listeners)
          expect(
            groups.every(
              (group) => group && Object.values(group.resources).includes(texture.source),
            ),
          ).toBe(true)
        }
      } finally {
        system.destroy()
        // GPU 对照显式释放绑定；测试不让外部缓存持有即将销毁的纹理。
        if (type === RendererType.WEBGPU) for (const group of groups) group?.destroy()
        context.destroy()
        texture.destroy(true)
      }
    },
  )
})
