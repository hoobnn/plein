import bailianLogo from './provider-icons/bailian.svg'
import doubaoLogo from './provider-icons/doubao.svg'
import minimaxLogo from './provider-icons/minimax.svg'
import volcengineLogo from './provider-icons/volcengine.svg'

/**
 * 平台图标：有官方 logo 的平台用 logo 形状做 mask、填品牌色，并垫一层浅浅的品牌色圆角底；
 * 没有 logo 的平台画彩色字母/几何块，未知平台按 id 哈希取色。商标素材只在本目录，MIT 许可见其 LICENSE。
 */
interface Brand {
  /** 品牌主色；有 to 时与它做对角渐变 */
  from: string
  to?: string
  /** 没有 logo 的平台用这个字或字母 */
  glyph: string
  /** logo 的 SVG 地址；有值时不再画字母块 */
  logo?: string
}

const BRANDS: Record<string, Brand> = {
  'volc/ark': { from: '#3370FF', glyph: '火', logo: volcengineLogo },
  'volc/ark-plan': { from: '#3370FF', glyph: '火', logo: volcengineLogo },
  'aliyun/bailian': { from: '#FF6A00', glyph: '百', logo: bailianLogo },
  // 豆包与方舟同为蓝色系，用青色渐变拉开区分
  'doubao/speech': { from: '#1E6FFF', to: '#12C8C8', glyph: '豆', logo: doubaoLogo },
  'minimax/api': { from: '#E7336B', glyph: 'M', logo: minimaxLogo },
  'plein/compatible': { from: '#6B7280', glyph: '兼' },
  'plein/mock': { from: '#9CA3AF', glyph: 'M' },
}

/** 同厂商的其他平台沿用厂商品牌色和 logo（如 volc 的新平台） */
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
  const known = BRANDS[provider] ?? BRANDS[VENDORS[provider.split('/')[0] ?? ''] ?? ''] ?? undefined
  if (known) return known
  let hash = 0
  for (let i = 0; i < provider.length; i++) hash = (hash * 31 + provider.charCodeAt(i)) >>> 0
  const tail = provider.split('/').at(-1) ?? provider
  return {
    from: FALLBACK_COLORS[hash % FALLBACK_COLORS.length]!,
    glyph: (tail.match(/[a-z0-9]/i)?.[0] ?? '·').toUpperCase(),
  }
}

/** 品牌色的浅底与主题描边：明暗主题下都只借一点点品牌色，不抢内容 */
const tint = (brand: Brand) => `color-mix(in srgb, ${brand.from} 14%, transparent)`

/** 有 logo 的平台：浅色圆角底 + 品牌色（豆包带青色渐变）填充的 logo 形状 */
function LogoIcon({ provider, brand, size }: { provider: string; brand: Brand; size: number }) {
  const glyphSize = Math.round(size * 0.64)
  return (
    <span
      aria-hidden="true"
      className="inline-flex flex-none items-center justify-center"
      data-provider-icon={provider}
      style={{
        width: size,
        height: size,
        borderRadius: '30%',
        background: tint(brand),
        boxShadow: 'inset 0 0 0 1px var(--line-strong)',
      }}
    >
      <span
        className="inline-block"
        style={{
          width: glyphSize,
          height: glyphSize,
          background: brand.to ? `linear-gradient(135deg, ${brand.from}, ${brand.to})` : brand.from,
          maskImage: `url("${brand.logo}")`,
          maskSize: 'contain',
          maskRepeat: 'no-repeat',
          maskPosition: 'center',
          WebkitMaskImage: `url("${brand.logo}")`,
          WebkitMaskSize: 'contain',
          WebkitMaskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
        }}
      />
    </span>
  )
}

/** 没有 logo 的平台：自绘的彩色圆角块，叠一个字或字母 */
function GlyphIcon({ provider, brand, size }: { provider: string; brand: Brand; size: number }) {
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

/** 平台图标用于设置卡片、模型选择的分组标题和音色列表的平台前缀 */
export function ProviderIcon({ provider, size = 16 }: { provider: string; size?: number }) {
  const brand = providerBrand(provider)
  if (brand.logo) return <LogoIcon provider={provider} brand={brand} size={size} />
  return <GlyphIcon provider={provider} brand={brand} size={size} />
}
