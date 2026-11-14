type CryptoLike = { randomUUID(): string }

/** 生成带前缀的唯一 id；doc 不依赖 DOM 类型，这里只取 randomUUID */
export function newId(prefix: 'el' | 'edge' | 'clip' | 'segment'): string {
  const { crypto } = globalThis as unknown as { crypto: CryptoLike }
  return `${prefix}-${crypto.randomUUID()}`
}

/**
 * 人工采用的版本记号。每次有效人工采用都换一个新的值。
 *
 * 它只是一个不透明的唯一串，不表示先后顺序：回答的是「现在这个采用是不是
 * 用户当时确认的那一次」。系统自动采用（addResults、缓存沿用）不写它。
 */
export function newAdoptionRevision(): string {
  const { crypto } = globalThis as unknown as { crypto: CryptoLike }
  return `adopt-${crypto.randomUUID()}`
}
