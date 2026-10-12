/** 开关：开 = accent 底，圆钮弹性滑到右边；点它不会冒泡到所在的行 */
export function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange(next: boolean): void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className="ui-switch"
    >
      <span />
    </button>
  )
}
