import {
  colorBitGl,
  compileHighShaderGlProgram,
  generateTextureBatchBitGl,
  getBatchSamplersUniformGroup,
  localUniformBitGl,
  Matrix,
  roundPixelsBitGl,
  Shader,
  UniformGroup,
} from 'pixi.js'

/**
 * 使用 Pixi 原有 Graphics 程序片段，保留变换、颜色、透明度和像素取整行为。
 * 预览底板只使用白色纹理及一张图片，两个采样器即可；通用多纹理图形仍走默认程序。
 */
export function createPreviewShader() {
  return new Shader({
    glProgram: compileHighShaderGlProgram({
      name: 'preview-graphics',
      bits: [colorBitGl, generateTextureBatchBitGl(2), localUniformBitGl, roundPixelsBitGl],
    }),
    resources: {
      localUniforms: new UniformGroup({
        uColor: { value: new Float32Array([1, 1, 1, 1]), type: 'vec4<f32>' },
        uTransformMatrix: { value: new Matrix(), type: 'mat3x3<f32>' },
        uRound: { value: 0, type: 'f32' },
      }),
      batchSamplers: getBatchSamplersUniformGroup(2),
    },
  })
}
