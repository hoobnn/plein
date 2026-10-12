import { MAX_RATING } from '@plein/doc'
import { useState } from 'react'
import { Icon, type IconSize } from './icons'

const STEPS = Array.from({ length: MAX_RATING }, (_, i) => i + 1)

/** 五星评级：悬停预览，点同一颗星清除评级；不传 onChange 时只读 */
export function Stars({
  value,
  onChange,
  size = 14,
}: {
  value: number | undefined
  onChange?(rating: number | null): void
  size?: IconSize
}) {
  const [hover, setHover] = useState(0)
  const shown = hover || value || 0
  if (!onChange)
    return (
      <span className="flex items-center text-warning" role="img" aria-label={`${value ?? 0} 星`}>
        {STEPS.filter((n) => n <= (value ?? 0)).map((n) => (
          <Icon key={n} name="star" size={size} fill />
        ))}
      </span>
    )
  return (
    <span className="flex items-center" onPointerLeave={() => setHover(0)}>
      {STEPS.map((n) => (
        <button
          key={n}
          type="button"
          aria-label={n === value ? `清除评级（当前 ${n} 星）` : `评为 ${n} 星`}
          aria-pressed={n === value}
          title={n === value ? '再点一次清除评级' : `${n} 星`}
          onPointerEnter={() => setHover(n)}
          onClick={(e) => {
            e.stopPropagation()
            onChange(n === value ? null : n)
          }}
          className={`flex items-center justify-center rounded-xs p-0.5 transition-colors ${
            n <= shown ? 'text-warning' : 'text-ink-subtle hover:text-ink-muted'
          }`}
        >
          <Icon name="star" size={size} fill={n <= shown} />
        </button>
      ))}
    </span>
  )
}
