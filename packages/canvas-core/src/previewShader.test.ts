import { DOMAdapter, type Shader, type UniformGroup } from 'pixi.js'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { createPreviewShader } from './previewShader'

afterEach(() => vi.restoreAllMocks())

it('预览引擎共享同一程序源码，uniform 与 Shader 的销毁保持独立', () => {
  // CPU 合同只构造程序；浏览器像素和多引擎回归验证实际 WebGL 绑定。
  vi.spyOn(DOMAdapter.get(), 'createCanvas').mockReturnValue({
    getContext: () => null,
  } as unknown as HTMLCanvasElement)
  const shaders: Shader[] = []
  const create = () => {
    const shader = createPreviewShader()
    shaders.push(shader)
    return shader
  }
  try {
    const first = create(),
      second = create()
    const program = first.glProgram!
    const vertex = program.vertex,
      fragment = program.fragment
    expect(second.glProgram).toBe(program)
    const a = first.resources.localUniforms as UniformGroup
    const b = second.resources.localUniforms as UniformGroup
    expect(a).not.toBe(b)
    ;(a.uniforms.uColor as Float32Array)[0] = 0.25
    expect(Array.from(b.uniforms.uColor as Float32Array)).toEqual([1, 1, 1, 1])
    first.destroy()
    shaders.splice(shaders.indexOf(first), 1)
    expect(second.glProgram).toBe(program)
    expect(program.vertex).toBe(vertex)
    expect(program.fragment).toBe(fragment)
    second.destroy()
    shaders.splice(shaders.indexOf(second), 1)
    const reopened = create()
    expect(reopened.glProgram).toBe(program)
    expect(program.vertex).toBe(vertex)
    expect(program.fragment).toBe(fragment)
  } finally {
    for (const shader of shaders) shader.destroy()
  }
})
