import { z } from 'zod'
import {
  type CapabilityContext,
  type CapabilityDefinition,
  CapabilityError,
  type Effect,
} from './define'

/** 能力注册表 + 调度：解析输入、判定副作用等级、执行 */
export class CapabilityRegistry<C extends CapabilityContext = CapabilityContext> {
  private caps = new Map<string, CapabilityDefinition<z.ZodObject, C>>()

  constructor(caps: Iterable<CapabilityDefinition<z.ZodObject, C>> = []) {
    for (const c of caps) this.add(c)
  }

  add(cap: CapabilityDefinition<z.ZodObject, C>) {
    if (this.caps.has(cap.name)) throw new Error(`能力 ${cap.name} 重复注册`)
    this.caps.set(cap.name, cap)
    return this
  }

  get(name: string) {
    return this.caps.get(name)
  }

  list() {
    return [...this.caps.values()]
  }

  effectOf(cap: CapabilityDefinition<z.ZodObject, C>, input: unknown, ctx: C): Effect {
    return typeof cap.effect === 'function' ? cap.effect(input as never, ctx) : cap.effect
  }

  /** 调用一个能力；输入不合法时抛 CapabilityError（带上 schema 报错，方便模型自己改） */
  async invoke(name: string, ctx: C, raw: unknown): Promise<unknown> {
    const cap = this.caps.get(name)
    if (!cap) throw new CapabilityError(`没有能力 ${name}`)
    const parsed = cap.input.safeParse(raw ?? {})
    if (!parsed.success) throw new CapabilityError(`参数不对：${z.prettifyError(parsed.error)}`)
    return cap.run(ctx, parsed.data)
  }
}
