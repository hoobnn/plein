import { Icon, type IconSize } from './icons'
import bailian from './provider-icons/bailian.svg'
import doubao from './provider-icons/doubao.svg'
import minimax from './provider-icons/minimax.svg'
import volcengine from './provider-icons/volcengine.svg'

const PROVIDER_ICONS: Record<string, string> = {
  'aliyun/bailian': bailian,
  'doubao/speech': doubao,
  'minimax/api': minimax,
  'volc/ark': volcengine,
}

/** 渠道品牌随文字配色，兼容明暗主题；未知插件使用通用接入图标。 */
export function ProviderIcon({ provider, size = 16 }: { provider: string; size?: IconSize }) {
  const source = PROVIDER_ICONS[provider]
  if (!source) return <Icon name={provider === 'plein/mock' ? 'cube' : 'plug'} size={size} />
  return (
    <span
      aria-hidden="true"
      className="inline-block flex-none bg-current"
      style={{
        width: size,
        height: size,
        maskImage: `url("${source}")`,
        maskSize: 'contain',
        maskRepeat: 'no-repeat',
        maskPosition: 'center',
      }}
    />
  )
}
