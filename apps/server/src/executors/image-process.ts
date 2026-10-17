import { imageProcessNode } from '@plein/nodes'
import { defineExecutor, inputAssets, ProviderError } from '@plein/plugin-sdk'

export const imageProcess = defineExecutor(imageProcessNode, async (ctx) => {
  const p = ctx.params
  const [image] = inputAssets(ctx.inputs, 'image')
  if (!image) throw new ProviderError('invalid_input', '请连入一张原图')
  if (!p.model) throw new ProviderError('invalid_input', '请选择图片精修模型')
  const model = ctx.providers.models('image.process').find((m) => m.ref === p.model)
  if (!model?.limits?.imageOperations?.includes(p.operation))
    throw new ProviderError('invalid_input', '当前模型不支持这项精修操作，请更换模型')
  const result = await ctx.providers.call('image.process', p.model, {
    image,
    operation: p.operation,
    prompt: p.prompt,
    ...(p.operation === 'upscale' ? { scale: p.scale } : {}),
    ...(p.operation === 'outpaint'
      ? { expansion: { top: p.top, bottom: p.bottom, left: p.left, right: p.right } }
      : {}),
  })
  return {
    images: result.assets
      .filter((a) => a.kind === 'image')
      .map((a) => ({ type: 'image' as const, ...a })),
    layers: result.outputs.flatMap((o) =>
      o.type === 'json' ? [{ type: 'json' as const, value: o.value }] : [],
    ),
  }
})
