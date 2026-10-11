type CryptoLike = { randomUUID(): string }

/** 生成带前缀的唯一 id；doc 不依赖 DOM 类型，这里只取 randomUUID */
export function newId(prefix: 'el' | 'edge'): string {
  const { crypto } = globalThis as unknown as { crypto: CryptoLike }
  return `${prefix}-${crypto.randomUUID()}`
}
