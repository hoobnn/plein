/**
 * 平台图标：自绘的圆角方块 + 品牌色 + 一个字或字母，不引用官方商标素材。
 * 图标本身就是颜色标识，明暗主题下都保留同一底色，只把描边交给主题 token。
 */
interface Brand {
  /** 底色；有 to 时与它做对角渐变 */
  from: string
  to?: string
  glyph: string
}

const BRANDS: Record<string, Brand> = {
  'volc/ark': { from: '#3370FF', glyph: '火' },
  'volc/ark-plan': { from: '#3370FF', to: '#6E9BFF', glyph: '火' },
  'aliyun/bailian': { from: '#FF6A00', glyph: '百' },
  // 豆包与方舟同为蓝色系，用青色渐变拉开区分
  'doubao/speech': { from: '#1E6FFF', to: '#12C8C8', glyph: '豆' },
  'minimax/api': { from: '#E7336B', glyph: 'M' },
  'plein/compatible': { from: '#6B7280', glyph: '兼' },
  'plein/mock': { from: '#9CA3AF', glyph: 'M' },
}

/** 同厂商的其他平台沿用厂商品牌色（如 volc 的新平台） */
const VENDORS: Record<string, string> = {
  volc: 'volc/ark',
  aliyun: 'aliyun/bailian',
  doubao: 'doubao/speech',
  minimax: 'minimax/api',
}

/** 未知平台：按 id 哈希取一个稳定的颜色，同一个平台每次渲染都一致 */
const FALLBACK_COLORS = [
  '#64748B',
  '#0EA5E9',
  '#8B5CF6',
  '#D946EF',
  '#F59E0B',
  '#10B981',
  '#EF4444',
  '#6366F1',
]

export function providerBrand(provider: string): Brand {
  const known =
    BRANDS[provider] ?? BRANDS[VENDORS[provider.split('/')[0] ?? ''] ?? ''] ?? undefined
  if (known) return known
  let hash = 0
  for (let i = 0; i < provider.length; i++) hash = (hash * 31 + provider.charCodeAt(i)) >>> 0
  const tail = provider.split('/').at(-1) ?? provider
  return {
    from: FALLBACK_COLORS[hash % FALLBACK_COLORS.length]!,
    glyph: (tail.match(/[a-z0-9]/i)?.[0] ?? '·').toUpperCase(),
  }
}

/** 平台图标用于设置卡片、模型选择的分组标题和音色列表的平台前缀 */
export function ProviderIcon({ provider, size = 16 }: { provider: string; size?: number }) {
  const brand = providerBrand(provider)
  const gradientId = `provider-icon-${provider.replace(/[^\w-]/g, '-')}`
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className="inline-block flex-none"
      data-provider-icon={provider}
    >
      {brand.to && (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={brand.from} />
            <stop offset="1" stopColor={brand.to} />
          </linearGradient>
        </defs>
      )}
      <rect
        width="32"
        height="32"
        rx="8.5"
        fill={brand.to ? `url(#${gradientId})` : brand.from}
        stroke="var(--line-strong)"
        strokeWidth="1"
      />
      <text
        x="16"
        y="17"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={brand.glyph.length > 1 ? 12 : 17}
        fontWeight="600"
        fill="#fff"
      >
        {brand.glyph}
      </text>
    </svg>
  )
}
