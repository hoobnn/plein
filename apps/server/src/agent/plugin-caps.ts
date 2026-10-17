import {
  type CapabilityDefinition,
  CapabilityError,
  type CapabilityRegistry,
  isContent,
} from '@plein/capabilities'
import {
  capabilityToolName,
  effectWithin,
  type PluginCapabilityContext,
  type PluginCapabilityDefinition,
} from '@plein/plugin-sdk'
import type { z } from 'zod'
import type { PluginHost } from '../plugins/host'
import { type ServerContext, viewOf } from './tools'

type Cap = CapabilityDefinition<z.ZodObject, ServerContext>

/** 插件能力单次调用的时长上限：要等很久的生成应该建节点再 run_node，不在能力里干等 */
const TIMEOUT_MS = 10 * 60_000

/**
 * 插件贡献的能力包装成服务端能力：和自带能力进同一个注册表，
 * 所以 ⌘K、MCP、内置智能体、确认规则都不用为插件另写一套。
 */
export function pluginCapabilities(host: PluginHost, builtin: CapabilityRegistry<ServerContext>) {
  const out: Cap[] = []
  for (const { def, plugin } of host.registry.capabilities.values()) {
    const manifest = host.pluginManifest(plugin)
    out.push({
      name: capabilityToolName(def.id),
      title: def.title,
      description: `${def.description}（来自插件 ${manifest.name}）`,
      group: 'plugin',
      where: 'server',
      effect: def.effect,
      input: def.input,
      run: async (ctx, input) => {
        ctx.env.execution?.assertOpen()
        const signal = AbortSignal.any([
          AbortSignal.timeout(TIMEOUT_MS),
          ...(ctx.env.execution ? [ctx.env.execution.abort.signal] : []),
        ])
        const services = host.services(manifest, { ownerId: ctx.env.ownerId, signal })
        const guardServices = <T extends object>(service: T): T =>
          new Proxy(service, {
            get(target, key) {
              const member = Reflect.get(target, key, target)
              return typeof member === 'function'
                ? (...args: unknown[]) => {
                    ctx.env.execution?.assertOpen()
                    return member.apply(target, args)
                  }
                : member
            },
          })
        const pctx: PluginCapabilityContext = {
          canvasId: ctx.env.canvasId,
          selection: ctx.env.selection ?? viewOf(ctx.env.rooms, ctx.env.canvasId)?.selection ?? [],
          signal,
          call: (name, raw) => callBuiltin(builtin, ctx, def, name, raw),
          log: (message, data) => console.log(`[plugin ${plugin}] ${message}`, data ?? ''),
          ...{
            providers: guardServices(services.providers),
            assets: guardServices(services.assets),
            media: guardServices(services.media),
          },
        }
        try {
          return await def.run(pctx, input)
        } catch (err) {
          if (err instanceof CapabilityError) throw err
          throw new CapabilityError(`插件「${manifest.name}」出错：${(err as Error).message}`)
        }
      },
    })
  }
  return out
}

/** 插件经 ctx.call 调自带能力：副作用不能超过插件能力声明的等级 */
async function callBuiltin(
  builtin: CapabilityRegistry<ServerContext>,
  ctx: ServerContext,
  def: PluginCapabilityDefinition,
  name: string,
  raw: Record<string, unknown> = {},
) {
  ctx.env.execution?.assertOpen()
  const cap = builtin.get(name)
  if (!cap) throw new CapabilityError(`没有自带能力 ${name}`)
  const parsed = cap.input.safeParse(raw)
  if (!parsed.success) throw new CapabilityError(`${name} 参数不对：${parsed.error.message}`)
  const effect = builtin.effectOf(cap, parsed.data, ctx)
  if (!effectWithin(effect, def.effect))
    throw new CapabilityError(
      `${def.id} 声明的副作用是 ${def.effect}，不能调用 ${effect} 级的 ${name}`,
    )
  const out = await cap.run(ctx, parsed.data)
  return isContent(out) ? { content: out.content } : out
}
