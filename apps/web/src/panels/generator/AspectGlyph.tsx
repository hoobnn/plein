/** 画幅图标的画法与 ui/icons 一致：1.5px 线、圆角端点，跟随文字颜色 */
function Glyph({ size, children }: { size: 16 | 20; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="flex-none"
    >
      {children}
    </svg>
  )
}

/** 画幅图标：按比例画的圆角矩形，长边比框略短，宽窄两头都看得出比例 */
export function AspectGlyph({ ratio, size }: { ratio: number; size: 16 | 20 }) {
  const long = size * 0.85
  const w = ratio >= 1 ? long : Math.max(5, long * ratio)
  const h = ratio >= 1 ? Math.max(5, long / ratio) : long
  return (
    <Glyph size={size}>
      <rect
        x={(size - w) / 2 + 0.75}
        y={(size - h) / 2 + 0.75}
        width={w - 1.5}
        height={h - 1.5}
        rx={2.5}
      />
    </Glyph>
  )
}

/** 「智能」画幅图标：圆角方框里两个朝外的角，表示比例自适应 */
export function AutoAspectGlyph({ size }: { size: 16 | 20 }) {
  const k = size / 20
  return (
    <Glyph size={size}>
      <rect x={2.25 * k} y={2.25 * k} width={15.5 * k} height={15.5 * k} rx={4 * k} />
      <path
        d={`M${6.25 * k} ${9 * k}V${6.25 * k}H${9 * k}M${13.75 * k} ${11 * k}v${2.75 * k}H${11 * k}`}
      />
    </Glyph>
  )
}
